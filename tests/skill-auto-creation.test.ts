import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom, parseSkillDraft, parseSkillDrafts, isSafeSkillId } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { makeCtx, jsonText , nsOf} from './helpers.js';

/**
 * Tests for C3 — when an L1 successfully completes a NOVEL task
 * (skill prefilter ran but found nothing) AND the env flag
 * ATOMA_SKILL_LEARN=1 is set, L2 distills the run into a new skill
 * via Sonnet and persists it. Direct library consumers opt in explicitly;
 * runTask sets the flag on by default unless its CLI/env kill switch is used.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

function enqueueExecutedResult(
  ctx: ReturnType<typeof makeCtx>,
  payload: unknown
): void {
  ctx.llm.enqueue((req) => {
    req.onToolInvocation?.({
      name: 'write_file',
      args: { path: 'artefact.txt' },
      result: { ok: true },
      durationMs: 1,
      startedAt: Date.now(),
    });
    return {
      text: jsonText(payload),
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  });
}

describe('parseSkillDraft / isSafeSkillId', () => {
  it('parses a minimal valid draft (snake_case when_to_use)', () => {
    const text = JSON.stringify({
      id: 'write-package-json',
      description: 'creates a Node package.json',
      when_to_use: 'when the subtask is a Node package descriptor',
      body: '1. write_file package.json\n2. validate JSON\n3. return summary',
    });
    const out = parseSkillDraft(text);
    expect(out).not.toBeNull();
    expect(out!.id).toBe('write-package-json');
    expect(out!.whenToUse).toMatch(/Node package descriptor/);
  });

  it('also accepts camelCase whenToUse for forwards-compat', () => {
    const text = JSON.stringify({
      id: 'x',
      description: 'd',
      whenToUse: 'w',
      body: 'b',
    });
    const out = parseSkillDraft(text);
    expect(out!.whenToUse).toBe('w');
  });

  it('returns null on missing required fields', () => {
    expect(parseSkillDraft(JSON.stringify({ id: 'x' }))).toBeNull();
    expect(parseSkillDraft(JSON.stringify({ description: 'x' }))).toBeNull();
    expect(parseSkillDraft('not json')).toBeNull();
    expect(parseSkillDraft('')).toBeNull();
  });

  it('extracts JSON from a fenced/prefixed wrapper (Sonnet sometimes adds it)', () => {
    const wrapped = 'Here is the skill:\n```json\n{"id":"x","description":"d","when_to_use":"w","body":"b"}\n```';
    expect(parseSkillDraft(wrapped)).not.toBeNull();
  });

  it('parseSkillDrafts: single object stays a single draft (backward compat)', () => {
    const text = JSON.stringify({
      id: 'build-cli',
      description: 'd',
      when_to_use: 'w',
      body: 'b',
    });
    const out = parseSkillDrafts(text);
    expect(out.map((d) => d.id)).toEqual(['build-cli']);
  });

  it('parseSkillDrafts: extracts the optional nested verification skill', () => {
    const text = JSON.stringify({
      id: 'build-cli',
      description: 'build a Node CLI from a spec',
      when_to_use: 'building a small CLI',
      body: '1. write <entry>\n2. verify\n3. document',
      verification: {
        id: 'verify-cli-invocations',
        description: 'run every documented invocation and compare outputs',
        when_to_use: 'a CLI exists and its documented behaviour must be checked',
        body: '1. read README for invocations\n2. run_shell each\n3. compare exit/stderr\n4. ground truth block',
      },
    });
    const out = parseSkillDrafts(text);
    expect(out.map((d) => d.id)).toEqual(['build-cli', 'verify-cli-invocations']);
    expect(out[1]!.body).toMatch(/run_shell each/);
  });

  it('parseSkillDrafts: a bad primary does not discard a valid verification draft', () => {
    const text = JSON.stringify({
      id: 'build-cli',
      // description missing → primary invalid
      when_to_use: 'w',
      body: 'b',
      verification: {
        id: 'verify-cli-invocations',
        description: 'd',
        when_to_use: 'w',
        body: 'b',
      },
    });
    expect(parseSkillDrafts(text).map((d) => d.id)).toEqual(['verify-cli-invocations']);
  });

  it('parseSkillDrafts: drops a verification draft that reuses the primary id', () => {
    const text = JSON.stringify({
      id: 'same-id',
      description: 'd',
      when_to_use: 'w',
      body: 'b',
      verification: { id: 'same-id', description: 'd2', when_to_use: 'w2', body: 'b2' },
    });
    expect(parseSkillDrafts(text).map((d) => d.id)).toEqual(['same-id']);
  });

  it('isSafeSkillId enforces kebab-case + length bounds', () => {
    expect(isSafeSkillId('write-file')).toBe(true);
    expect(isSafeSkillId('a-b-c-d-e')).toBe(true);
    expect(isSafeSkillId('a')).toBe(false); // too short
    expect(isSafeSkillId('Write-File')).toBe(false); // case
    expect(isSafeSkillId('write file')).toBe(false); // space
    expect(isSafeSkillId('../escape')).toBe(false); // dots / slashes
    expect(isSafeSkillId('-leading')).toBe(false);
    expect(isSafeSkillId('trailing-')).toBe(false);
    expect(isSafeSkillId('a'.repeat(61))).toBe(false); // too long
  });
});

describe('L2 onApproved — skill auto-creation (C3)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-c3-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
      // The F2 toolset filter rejects drafts teaching tools the host cannot
      // call — fixtures must declare the tools their drafts mention, like
      // any real L1 would.
      tools: ['write_file', 'read_file', 'run_shell', 'start_static_server', 'validate_html'].map(
        (name) => ({ name, description: name, inputSchema: { type: 'object' } })
      ),
    });
    envBefore = process.env['ATOMA_SKILL_LEARN'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_LEARN'];
    else process.env['ATOMA_SKILL_LEARN'] = envBefore;
  });

  function ensureChildIsTrusted(): void {
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
  }

  it('does NOT learn when ATOMA_SKILL_LEARN is unset (default off)', async () => {
    delete process.env['ATOMA_SKILL_LEARN'];
    ensureChildIsTrusted();
    // Pre-seed a skill that the prefilter will escalate on, so we
    // exercise the "match attempted but no fit" code path AND the
    // env-flag-off branch in one shot.
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated',
      description: 'something else',
      whenToUse: 'never matches our task',
      kind: 'llm',
      body: 'b',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter -> Water.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter -> escalate (no fit).
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    // L1.plan + L1.execute (success).
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'http://localhost:8000/', summary: 'built' });

    await neuron.handleDirect({ description: 'build a thing' }, ctx);
    // Still ONE pre-existing skill (no auto-creation).
    const after = skills.loadFor(nsOf(reg, 'Water'));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('unrelated');
  });

  it('learns a new skill when ATOMA_SKILL_LEARN=1 and the run was approved', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ensureChildIsTrusted();
    // Same pattern: pre-seed an unrelated skill so the skill-
    // prefilter LLM call actually fires (and escalates), exercising
    // the "match was attempted, no fit" branch that auto-creation
    // gates on. With zero skills, matchSkill short-circuits and
    // skillMatchAttempted is still true (#runSubtask sets it
    // before the loadFor check), but the prefilter LLM slot is
    // skipped entirely — keep the test queue aligned by including
    // a scarecrow skill.
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated',
      description: 'something else',
      whenToUse: 'never matches our task',
      kind: 'llm',
      body: 'b',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter -> escalate (no fit).
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    // L1.plan + L1.execute (success).
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, {
      output: 'http://localhost:8000/',
      summary: 'built a clean web app',
    });
    // C3 Sonnet learn call → emits skill draft JSON.
    ctx.llm.enqueueText(
      JSON.stringify({
        id: 'web-build-loop',
        description: 'write index.html, serve, validate',
        when_to_use: 'when the subtask is a single-file web artefact build',
        body: '1. write_file index.html\n2. start_static_server\n3. validate_html with smoke',
      })
    );

    await neuron.handleDirect({ description: 'build a small web thing' }, ctx);
    const learned = skills.loadFor(nsOf(reg, 'Water')).sort((a, b) => a.id.localeCompare(b.id));
    expect(learned.map((s) => s.id)).toEqual(['unrelated', 'web-build-loop']);
    const created = learned.find((s) => s.id === 'web-build-loop')!;
    expect(created.body).toMatch(/start_static_server/);
    expect(created.successes).toBe(0);
    expect(created.failures).toBe(0);
    expect(existsSync(join(dir, nsOf(reg, 'Water'), 'web-build-loop', 'SKILL.md'))).toBe(true);

    // The distillation prompt must constrain the BODY to generalise, not
    // just `when_to_use`. A learned body that bakes in this run's literal
    // filenames/arguments is silently wrong on every later task in the
    // class — and passes every validator, because the artefact is fine.
    const learnCall = ctx.llm.calls.find((c) => c.userContent.includes('"when_to_use"'));
    expect(learnCall).toBeDefined();
    const learnPrompt = learnCall!.userContent;
    expect(learnPrompt).toMatch(/BODY MUST GENERALISE/);
    expect(learnPrompt).toMatch(/PLACEHOLDERS/);
    expect(learnPrompt).toMatch(/Never copy a concrete filename/);
    expect(learnPrompt).toMatch(/SUBTASK'S output scope/);
    expect(learnPrompt).toMatch(/"type":"module" requires ESM imports/);
    // The verification-split contract: mechanical verification distills as a
    // SEPARATE skill — the compilable half of a build+verify run.
    expect(learnPrompt).toMatch(/SPLIT OUT MECHANICAL VERIFICATION/);
    expect(learnPrompt).toMatch(/"verification" key/);
    expect(learnPrompt).toMatch(/DERIVABLE from the\s+workspace alone/);
    // The F2 toolset-scope contract.
    expect(learnPrompt).toMatch(/DECLARED TOOLS \(this atom's ONLY executable surface\)/);
    expect(learnPrompt).toMatch(/HARD RULE — TOOLSET SCOPE/);

    // `when_to_use` is matched against the SUBTASK TEXT ALONE. Measured on the
    // 2026-08-10 benchmark: the two verification recipes phrased as disk state
    // ("a probe manifest already exists in the workspace") drew 2 prefilter
    // matches over 19 runs against their build siblings' 14 and 15, and ended
    // one success short of compiling — so the zero-cost dispatch path never
    // armed. The prefilter never sees the workspace, so that phrasing is not
    // merely weak, it is unevaluable. This is the single line that produced
    // the whole defect, and the rule must not drift back out of the prompt.
    expect(learnPrompt).toMatch(/MATCHED AGAINST THE SUBTASK TEXT ALONE/);
    expect(learnPrompt).toMatch(/never sees the workspace/i);
    expect(learnPrompt).toMatch(/DISK\s+STATE/);
    // …and the split block must repeat it, because a verification recipe acts
    // on a previous phase's artefacts and is the one most tempted to describe
    // itself by them. Both measured casualties were verification recipes.
    expect(learnPrompt).toMatch(/WHERE THIS SPLIT USUALLY DIES/);
  });

  it('F2: rejects a draft whose body teaches a tool the host cannot call', async () => {
    // Regression (app-task-tracker run, 2026-08-07): two skills taught
    // "validate_html" on an HTTP-bucket atom that cannot declare it — the
    // plan had demanded it, the run never executed it, and the recipes
    // encoded the phantom. The mechanical filter is the code half of F2.
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ensureChildIsTrusted();
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated',
      description: 'something else',
      whenToUse: 'never matches our task',
      kind: 'llm',
      body: 'b',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'built and probed' });
    // The draft teaches start_node_server — NOT in this Water's toolset
    // (write/read/run_shell/static/validate_html).
    ctx.llm.enqueueText(
      JSON.stringify({
        id: 'phantom-recipe',
        description: 'boot a node server and probe it',
        when_to_use: 'server tasks',
        body: '1. write_file server.js\n2. start_node_server on it\n3. fetch_url every route',
      })
    );

    await neuron.handleDirect({ description: 'build a small web thing' }, ctx);
    // The phantom draft was skipped; only the scarecrow remains.
    expect(skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id)).toEqual(['unrelated']);
  });

  it('saves BOTH skills when the draft carries a verification split', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ensureChildIsTrusted();
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated',
      description: 'something else',
      whenToUse: 'never matches our task',
      kind: 'llm',
      body: 'b',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'built and verified a CLI' });
    // Learn call → primary + verification split.
    ctx.llm.enqueueText(
      JSON.stringify({
        id: 'build-node-cli',
        description: 'build a dependency-free Node CLI from a spec',
        when_to_use: 'when the subtask builds a small standalone CLI',
        body: '1. write <entry>.\n2. run_shell the real invocations.\n3. document.',
        verification: {
          id: 'verify-documented-invocations',
          description: 'run every invocation documented in the README, compare outputs',
          when_to_use: 'a CLI and its README exist; documented behaviour must be re-checked',
          body: '1. read README, enumerate documented commands.\n2. run_shell each.\n3. compare exit codes + stderr.\n4. emit == GROUND TRUTH == block.',
        },
      })
    );

    await neuron.handleDirect({ description: 'build a small CLI' }, ctx);
    const learned = skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id).sort();
    expect(learned).toEqual(['build-node-cli', 'unrelated', 'verify-documented-invocations']);
    // Both are born kind:llm — the verification skill earns its compile at
    // the promotion threshold like any other, it is just SHAPED to pass it.
    const verify = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'verify-documented-invocations')!;
    expect(verify.kind).toBe('llm');
    expect(verify.successes).toBe(0);
  });

  it('an unsafe verification id skips ONLY the verification draft', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ensureChildIsTrusted();
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated',
      description: 'something else',
      whenToUse: 'never matches our task',
      kind: 'llm',
      body: 'b',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });
    ctx.llm.enqueueText(
      JSON.stringify({
        id: 'good-primary',
        description: 'd',
        when_to_use: 'w',
        body: 'b',
        verification: { id: '../escape', description: 'd', when_to_use: 'w', body: 'b' },
      })
    );

    await neuron.handleDirect({ description: 'task' }, ctx);
    const learned = skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id).sort();
    expect(learned).toEqual(['good-primary', 'unrelated']);
  });

  it('does NOT overwrite an existing skill with the same id (counter preservation)', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    // Pre-seed a skill that the prefilter will NOT match (different
    // description) so we still hit the no-match branch.
    skills.save(nsOf(reg, 'Water'), {
      id: 'web-build-loop',
      description: 'pre-existing canonical recipe',
      whenToUse: 'when the subtask references narrow vendor patterns',
      kind: 'llm',
      body: 'pre-existing body — must NOT be overwritten by the auto-creation.',
    });
    skills.recordSuccess(nsOf(reg, 'Water'), 'web-build-loop');
    skills.recordSuccess(nsOf(reg, 'Water'), 'web-build-loop');

    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter: escalate (low fit).
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    // L1.plan + L1.execute success.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    // Sonnet emits a draft with the SAME id — should be skipped.
    ctx.llm.enqueueText(
      JSON.stringify({
        id: 'web-build-loop',
        description: 'NEW (would overwrite)',
        when_to_use: 'never',
        body: 'NEW body — must NOT land',
      })
    );

    await neuron.handleDirect({ description: 'a different task' }, ctx);
    const after = skills.loadFor(nsOf(reg, 'Water'));
    expect(after).toHaveLength(1);
    expect(after[0]!.body).toMatch(/pre-existing body/);
    expect(after[0]!.body).not.toMatch(/NEW body/);
    // Counters preserved unchanged.
    expect(after[0]!.successes).toBe(2);
  });

  // MEASURED 2026-08-21: one 6-task burn-in batch learned 11 skills of which
  // 6 were three semantic twin pairs on the same molecule. The only duplicate
  // guard is exact-id equality, and the distiller was never SHOWN the ids it
  // had to avoid — so every twin was created by a model that could not have
  // known better. Promotion needs N clean successes on ONE id; two
  // half-credited twins never get there.
  it('shows the molecule OWNED skills in the distill prompt and forbids twins', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    skills.save(nsOf(reg, 'Water'), {
      id: 'recheck-recorded-cli-probes',
      description: 'Re-run documented invocations and confirm recorded exit codes hold.',
      whenToUse: 'Task asks to re-check a built CLI still produces the recorded stdout',
      kind: 'llm',
      body: '1. read_file .atoma-probes.json\n2. run_shell each command',
    });
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    ctx.llm.enqueueText('not json — the prompt is what this test reads');

    await neuron.handleDirect({ description: 'confirm the CLI still behaves' }, ctx);

    const distill = ctx.llm.calls.find((c) =>
      c.userContent.includes('SPLIT OUT MECHANICAL VERIFICATION')
    );
    expect(distill).toBeDefined();
    const prompt = distill!.userContent;
    expect(prompt).toContain('== SKILLS THIS MOLECULE ALREADY OWNS');
    // id AND when_to_use, because the model judges overlap by trigger shape.
    expect(prompt).toContain(
      '- recheck-recorded-cli-probes: Task asks to re-check a built CLI still produces the recorded stdout'
    );
    expect(prompt).toContain('HARD RULE \u2014 NO SEMANTIC TWINS');
  });

  it('omits the owned-skills section entirely when the molecule owns none', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    // No skills on disk: matchSkill short-circuits, so no prefilter LLM slot.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    ctx.llm.enqueueText('not json');

    await neuron.handleDirect({ description: 'build a thing' }, ctx);

    const distill = ctx.llm.calls.find((c) =>
      c.userContent.includes('SPLIT OUT MECHANICAL VERIFICATION')
    );
    expect(distill).toBeDefined();
    expect(distill!.userContent).not.toContain('SKILLS THIS MOLECULE ALREADY OWNS');
    expect(distill!.userContent).not.toContain('NO SEMANTIC TWINS');
  });

  it('rejects an unsafe skill id (path-traversal guard)', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    skills.save(nsOf(reg, 'Water'), {
      id: 'scarecrow',
      description: 'unrelated',
      whenToUse: 'never',
      kind: 'llm',
      body: 'b',
    });
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    // Sonnet emits a malicious id.
    ctx.llm.enqueueText(
      JSON.stringify({
        id: '../escape',
        description: 'd',
        when_to_use: 'w',
        body: 'b',
      })
    );

    await neuron.handleDirect({ description: 'task' }, ctx);
    // Only the scarecrow remains — no auto-created skill from a bad id.
    const after = skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id);
    expect(after).toEqual(['scarecrow']);
  });

  it('skips silently when Sonnet returns malformed JSON (run remains approved)', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    skills.save(nsOf(reg, 'Water'), {
      id: 'scarecrow',
      description: 'unrelated',
      whenToUse: 'never',
      kind: 'llm',
      body: 'b',
    });
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    // Sonnet returns prose without a JSON object.
    ctx.llm.enqueueText('I would learn a skill but cannot generalise this run.');

    const result = await neuron.handleDirect({ description: 'task' }, ctx);
    expect(result.summary).toBe('built');
    // Still only the scarecrow.
    expect(skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id)).toEqual(['scarecrow']);
  });

  it('does NOT learn when a skill DID match (no novelty signal to act on)', async () => {
    process.env['ATOMA_SKILL_LEARN'] = '1';
    skills.save(nsOf(reg, 'Water'), {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fits' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    enqueueExecutedResult(ctx, { output: 'ok', summary: 'built' });
    // No Sonnet learn call expected — skill was matched, so the
    // run is NOT novel by the C3 definition.

    await neuron.handleDirect({ description: 'task' }, ctx);
    // Still exactly the one pre-seeded skill. No new auto-created entries.
    const after = skills.loadFor(nsOf(reg, 'Water'));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('web-build-loop');
    expect(after[0]!.successes).toBe(1); // existing skill was used and approved
  });
});

describe('draft parsing survives real distillation formatting (audit rank-3)', () => {
  it('fenced JSON followed by prose containing a brace no longer loses the learn event', () => {
    // The old first-{-to-last-} regex sliced across the prose brace and
    // JSON.parse failed — silently discarding a PAID Sonnet distillation.
    const text = [
      'Here is the skill:',
      '```json',
      '{"id": "verify-cli-invocations", "description": "d", "when_to_use": "w", "body": "1. do"}',
      '```',
      'Note: apply `{caution}` when reusing.',
    ].join('\n');
    const draft = parseSkillDraft(text);
    expect(draft).not.toBeNull();
    expect(draft!.id).toBe('verify-cli-invocations');
  });

  it('a truncated draft is repaired instead of dropped', () => {
    const text = '{"id": "probe-http-routes", "description": "d", "when_to_use": "w", "body": "1. boot\n2. fetch';
    const draft = parseSkillDraft(text);
    expect(draft).not.toBeNull();
    expect(draft!.id).toBe('probe-http-routes');
  });
});

describe('distillation steers verification recipes at MACHINE input', () => {
  // A verification recipe whose step 1 reads a free-form README cannot
  // compile — the compiler refuses it as irreducible judgment, and it is
  // right to. Measured twice: once on the CLI family (documented in
  // AGENTS.md) and once live on Methane/probe-crud-json-api-lifecycle,
  // which reached 5 successes and was refused with exactly that reason.
  it('names the manifest as the authority and prose as a mere fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-distill-input-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    process.env['ATOMA_SKILL_LEARN'] = '1';
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    enqueueExecutedResult(ctx, { output: 'done', summary: 'ok' });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText('not json — skip the distillation itself');
    await neuron.handleDirect({ description: 'task' }, ctx);

    const distill = ctx.llm.calls.find((c) => c.userContent.includes('SPLIT OUT MECHANICAL VERIFICATION'));
    expect(distill).toBeDefined();
    const p = distill!.userContent;
    expect(p).toMatch(/INPUT PRECEDENCE/);
    expect(p).toMatch(/\.atoma-probes\.json/);
    expect(p).toMatch(/README is at best a named fallback, never the\s+authority/);
    // The old blanket licence for prose sources must be gone.
    expect(p).not.toMatch(/invocations documented in the README/);
    rmSync(dir, { recursive: true, force: true });
  });
});
