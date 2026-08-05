import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom, COMPILE_PROMPT_GENERATION } from '../src/atoms/L2Atom.js';
import {
  shouldTrustSkill,
  TRUST_PROMOTE_THRESHOLD_SUCCESSES,
  TRUST_THRESHOLD_SUCCESSES,
} from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Tests for #C2c — skill PROMOTION llm→script + DEMOTION script→llm.
 *
 * Promotion fires when, on an approved skilled run, the matched
 * skill has crossed `TRUST_PROMOTE_THRESHOLD_SUCCESSES` with zero
 * recorded failures AND `ATOMA_SKILL_PROMOTE=1` is set. The L2 then
 * makes ONE Sonnet call to compile the llm body into a deterministic
 * Node script; on a clean compile the registry stashes the original
 * llm body in `_fallback.md` and rewrites SKILL.md with `kind: script`.
 *
 * Demotion fires when a `kind: script` skill drives a run that
 * escalates: the failure counter has been bumped via `recordFailure`
 * upstream, and the supervise-loop's `onFailed` hook restores the
 * fallback as the new body + flips kind back to 'llm'. The
 * `failures > 0` clause inside `tryPromoteSkill` then blocks
 * accidental re-promotion until counters are reset.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('L2 onApproved — skill promotion (#C2c)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-promote-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
    envBefore = process.env['ATOMA_SKILL_PROMOTE'];
    // Pre-seed a mature skill on Hydrogen: 5 successes / 0 failures,
    // kind:llm. That's the eligibility line for promotion.
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'write index.html, serve, validate',
      whenToUse: 'when the subtask is a single-file web artefact build',
      kind: 'llm',
      body: '1. write_file index.html\n2. start_static_server\n3. validate_html',
    });
    for (let i = 0; i < TRUST_PROMOTE_THRESHOLD_SUCCESSES; i++) {
      skills.recordSuccess('Hydrogen', 'web-build-loop');
    }
    // Trust the L1 type so its validators short-circuit.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Hydrogen');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env['ATOMA_SKILL_PROMOTE'];
    else process.env['ATOMA_SKILL_PROMOTE'] = envBefore;
  });

  it('does NOT attempt promotion when ATOMA_SKILL_PROMOTE is unset (default off)', async () => {
    delete process.env['ATOMA_SKILL_PROMOTE'];
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter -> Hydrogen.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter -> reuse web-build-loop.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    // L1.plan + L1.execute.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    // NB: we do NOT enqueue a Sonnet compile response — promotion must NOT fire.

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('llm');
    expect(after.successes).toBe(TRUST_PROMOTE_THRESHOLD_SUCCESSES + 1);
  });

  it('promotes the skill to kind:script when env is on, threshold is met, and Sonnet compiles', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    // Sonnet compile call → emits a clean promotable response.
    const SCRIPT_BODY =
      'const arg = JSON.parse(process.argv[2] || "{}");\nconsole.log(JSON.stringify({output: "ok", summary: "done\\n== GROUND TRUTH ==\\nschema/state: nothing"}));\n';
    ctx.llm.enqueueText(
      JSON.stringify({ promotable: true, language: 'node', body: SCRIPT_BODY })
    );

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('script');
    expect(after.language).toBe('node');
    expect(after.body).toMatch(/process\.argv\[2\]/);
    // Counters are RESET by promotion, so the never-yet-executed script form
    // is NOT immediately trusted by the no-validator deterministic dispatch
    // (shouldTrustSkill needs 3 successes / 0 failures). It has to earn them
    // through the validated LLM loop first.
    expect(after.failures).toBe(0);
    expect(after.successes).toBe(0);
    expect(shouldTrustSkill(after)).toBe(false);
    // The original llm body was stashed in the fallback sidecar so a
    // future demotion can restore it verbatim.
    expect(after.fallbackBody).toMatch(/start_static_server/);
    expect(existsSync(join(dir, 'Hydrogen', 'web-build-loop', '_fallback.md'))).toBe(true);

    // The compile prompt must forbid baking task-specific literals into the
    // script. Observed defect: a promoted documentation script carried
    // `invocations = ['node index.js sample.txt']` from the file-analyzer task
    // it was learned on, so a later Caesar-cipher CLI shipped a README whose
    // documented examples printed the usage message instead of ciphering — and
    // every validator approved it, because the artefact itself was fine. A
    // markdown recipe adapts; a compiled literal cannot.
    const compileCall = ctx.llm.calls.at(-1)!;
    expect(compileCall.userContent).toMatch(/NO TASK-SPECIFIC LITERALS/);
    expect(compileCall.userContent).toMatch(/Never hardcode a filename/);
    expect(compileCall.userContent).toMatch(/exit NON-ZERO rather than/);
    // Robust extraction: the slugify rehearsal's compiled script truncated
    // commands at quotes, deduped four invocations into one, and reported a
    // phantom mismatch. Compiled scripts must survive formatting variance.
    expect(compileCall.userContent).toMatch(/INPUT VARIANCE/);
    expect(compileCall.userContent).toMatch(/ARGUMENTS ARE PART OF THE COMMAND/);
    // The probe manifest is the deterministic interface: verification
    // scripts read it as PRIMARY input instead of parsing prose, and
    // scripts that verify invocations must write/merge it.
    expect(compileCall.userContent).toMatch(/PROBE MANIFEST/);
    expect(compileCall.userContent).toContain('.atoma-probes.json');
    // TWO manifest shapes (shell + http) must be spelled out: a compiled
    // HTTP verifier crashed reading entry.cmd on http-shaped entries.
    // THREE shapes, all present — the prompt used to say "TWO SHAPES" while
    // listing three, and the old assertion froze the lie (audit finding): a
    // literal-minded compiler could legitimately ignore web entries.
    expect(compileCall.userContent).toMatch(/THREE SHAPES/);
    expect(compileCall.userContent).toMatch(/"cmd"/);
    expect(compileCall.userContent).toMatch(/"probe": "http"/);
    expect(compileCall.userContent).toMatch(/"probe": "web"/);
    expect(compileCall.userContent).toMatch(/entry ORDER as significant/);
    // effort is pinned because the claude-cli transport cannot enforce
    // maxTokens: at the default 'high' a compile ran ~7 min and got killed
    // by the run deadline (rehearsal runs 4 and 5).
    expect(compileCall.params?.effort).toBe('medium');
  });

  it('does NOT promote when the skill has any failures recorded (gate prevents thrash after demotion)', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    // One failure puts the skill out of promotion eligibility even
    // though successes >= threshold. Simulates the "demoted earlier,
    // operator hasn't reset counters" state.
    skills.recordFailure('Hydrogen', 'web-build-loop');

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    // No compile response queued — the gate must short-circuit before
    // the Sonnet call. If the gate were broken, the test would hang
    // waiting for an LLM response, which surfaces as a queue-empty
    // throw from the mock client.

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('llm');
    expect(after.failures).toBe(1);
  });

  it('does NOT promote when Sonnet refuses (promotable: false)', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    // Sonnet declines — recipe is too LLM-shaped to compile.
    ctx.llm.enqueueText(
      JSON.stringify({ promotable: false, reason: 'recipe contains schema-design reasoning that cannot be encoded statically' })
    );

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('llm');
    // Original body still present, no fallback sidecar created.
    expect(after.body).toMatch(/start_static_server/);
    expect(existsSync(join(dir, 'Hydrogen', 'web-build-loop', '_fallback.md'))).toBe(false);
  });

  it('STAMPS promotionRefusedAt on Sonnet refusal so the next success short-circuits without a new Sonnet call', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);

    // First run: refusal triggers the stamp.
    const ctx1 = makeCtx();
    ctx1.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx1.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx1.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx1.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    ctx1.llm.enqueueText(JSON.stringify({ promotable: false, reason: 'too LLM-shaped' }));
    await water.handleDirect({ description: 'first run' }, ctx1);

    const stamped = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(stamped.promotionRefusedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Sonnet's verbatim WHY is persisted next to the stamp — the operator
    // reads it via `skills show` instead of grepping run traces.
    expect(stamped.promotionRefusedReason).toBe('too LLM-shaped');

    // Second run on the same skill: the gate must short-circuit BEFORE
    // any compile call. We do not enqueue a 5th LLM response — if the
    // gate were broken, the mock client would throw queue-empty.
    const water2 = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx2 = makeCtx();
    ctx2.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx2.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx2.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx2.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    await water2.handleDirect({ description: 'second run' }, ctx2);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('llm');
    expect(after.successes).toBe(TRUST_PROMOTE_THRESHOLD_SUCCESSES + 2);
    // Stamp persisted across the bump.
    expect(after.promotionRefusedAt).toBe(stamped.promotionRefusedAt);
  });

  it('does NOT promote when Sonnet returns malformed JSON', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    // Sonnet emits prose; JSON parse fails inside compileSkillToScript.
    ctx.llm.enqueueText('Sure, here is a script for you: console.log("hi")');

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const after = skills.loadFor('Hydrogen').find((s) => s.id === 'web-build-loop')!;
    expect(after.kind).toBe('llm');
    // Run is still APPROVED — promotion failure is opportunistic.
    expect(after.successes).toBe(TRUST_PROMOTE_THRESHOLD_SUCCESSES + 1);
  });

  it('writes the original llm body verbatim to _fallback.md so demotion can restore it', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fit' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    ctx.llm.enqueueText(
      JSON.stringify({ promotable: true, language: 'node', body: 'console.log("hi")' })
    );

    await water.handleDirect({ description: 'build a small web thing' }, ctx);

    const fallbackPath = join(dir, 'Hydrogen', 'web-build-loop', '_fallback.md');
    expect(existsSync(fallbackPath)).toBe(true);
    const fallbackContent = readFileSync(fallbackPath, 'utf8');
    expect(fallbackContent).toMatch(/write_file index\.html/);
    expect(fallbackContent).toMatch(/start_static_server/);
    expect(fallbackContent).toMatch(/validate_html/);
  });
});

describe('post-approval bookkeeping — decoupled from the run deadline', () => {
  it('the compile call carries its OWN signal, not the run signal', async () => {
    // Three separate live incidents of the run deadline landing mid-compile
    // under claude-cli, the last leaving a run hung with no endedAt. By
    // compile time the deliverable is approved — the run budget protects
    // nothing there.
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-decouple-'));
    const skills = new SkillRegistry(dir);
    const db = openDb(':memory:');
    const reg = new AtomRegistry(db);
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Hydrogen');
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    for (let i = 0; i < 5; i++) skills.recordSuccess('Hydrogen', 'web-build-loop');

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const runSignal = new AbortController().signal;
    const ctx = { ...makeCtx(), signal: runSignal };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'http://localhost:8000/', summary: 'built' }));
    ctx.llm.enqueueText(JSON.stringify({ promotable: false, reason: 'nope' }));

    await water.handleDirect({ description: 'task' }, ctx);
    const compileCall = ctx.llm.calls.at(-1)!;
    expect(compileCall.signal).toBeDefined();
    expect(compileCall.signal).not.toBe(runSignal);
    expect(compileCall.signal!.aborted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('refusal stamps expire with the compile-prompt generation', () => {
  it('a stamp from an older generation is cleared and the compile retried', async () => {
    // The manual-reset case, automated: when the compile PROMPT evolves (e.g.
    // the probe-manifest contract landed), a stamp written under the old
    // prompt no longer justifies skipping — its premise ("same body → same
    // script") assumed a fixed compiler.
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-gen-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Hydrogen');
    skills.save('Hydrogen', {
      id: 'web-build-loop', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b',
    });
    for (let i = 0; i < 5; i++) skills.recordSuccess('Hydrogen', 'web-build-loop');
    // Stamp from a DIFFERENT (stale) generation.
    skills.markPromotionRefused('Hydrogen', 'web-build-loop', 'old verdict', 'deadbeef');

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'built' }));
    // A compile response IS enqueued — if the stale stamp still blocked, the
    // mock would end with this reply unconsumed.
    ctx.llm.enqueueText(JSON.stringify({ promotable: false, reason: 'still no' }));

    await water.handleDirect({ description: 'task' }, ctx);
    expect(ctx.llm.calls).toHaveLength(5); // the 5th IS the retried compile
    const after = skills.loadFor('Hydrogen')[0]!;
    // Re-stamped with the CURRENT generation, so the next success skips.
    expect(after.promotionRefusedGeneration).toBe(COMPILE_PROMPT_GENERATION);
    expect(after.promotionRefusedReason).toMatch(/still no/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stamp from the CURRENT generation still short-circuits (no wasted compile)', async () => {
    process.env['ATOMA_SKILL_PROMOTE'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'atoma-gen2-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    for (let i = 0; i < 3; i++) reg.recordSuccess('Hydrogen');
    skills.save('Hydrogen', {
      id: 'web-build-loop', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b',
    });
    for (let i = 0; i < 5; i++) skills.recordSuccess('Hydrogen', 'web-build-loop');
    skills.markPromotionRefused('Hydrogen', 'web-build-loop', 'current verdict', COMPILE_PROMPT_GENERATION);

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'f' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'built' }));
    // NO compile reply enqueued: the gate must not call.
    await water.handleDirect({ description: 'task' }, ctx);
    expect(ctx.llm.calls).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('demotion stamps the COMPILING generation, not the current one', () => {
  it('a script compiled by an older compiler leaves a STALE stamp when it fails', () => {
    // The trap this closes: the two-shape manifest fix landed, the old
    // script failed once more, and stamping the CURRENT generation re-parked
    // the skill against the very compiler that would have fixed it. A script
    // produced by compiler A failing says nothing about compiler B's output.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-compgen-'));
    const skills = new SkillRegistry(dir);
    skills.save('Hydrogen', {
      id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'recipe',
    });
    skills.promoteToScript({
      l1Name: 'Hydrogen',
      skillId: 's',
      language: 'node',
      scriptBody: 'console.log(1)',
      compiledGeneration: 'oldgen01',
    });
    const promoted = skills.loadFor('Hydrogen')[0]!;
    expect(promoted.compiledGeneration).toBe('oldgen01');

    // Demotion path stamps the compiling generation…
    skills.markPromotionRefused('Hydrogen', 's', 'auto-demoted: …', promoted.compiledGeneration);
    const stamped = skills.loadFor('Hydrogen')[0]!;
    expect(stamped.promotionRefusedGeneration).toBe('oldgen01');
    // …which differs from today's compiler, so the gate treats it as stale.
    expect(stamped.promotionRefusedGeneration).not.toBe(COMPILE_PROMPT_GENERATION);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('compiledGeneration + provenance survive the counter lifecycle (audit rank-3)', () => {
  it('bump and reset preserve them; demotion drops the script generation', () => {
    // The verified audit finding: bump() rebuilt the meta field-by-field and
    // omitted compiledGeneration, so the FIRST success after a promotion
    // erased it — and the demotion path then stamped the CURRENT compiler
    // generation, re-parking the skill against the very compiler that would
    // have fixed it. The whole iteration-9 mechanism was dead on arrival
    // for any script that succeeded at least once before failing.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-lifecycle-gen-'));
    const skills = new SkillRegistry(dir);
    skills.save(
      'Hydrogen',
      { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'recipe' },
      { mechanism: 'distilled', model: 'claude-sonnet-5' }
    );
    expect(skills.loadFor('Hydrogen')[0]!.provenance).toMatchObject({
      mechanism: 'distilled',
      model: 'claude-sonnet-5',
    });

    skills.promoteToScript({
      l1Name: 'Hydrogen', skillId: 's', language: 'node',
      scriptBody: 'console.log(1)', compiledGeneration: 'oldgen01',
    });
    // The killer sequence: successes BETWEEN promotion and failure.
    skills.recordSuccess('Hydrogen', 's');
    skills.recordSuccess('Hydrogen', 's');
    expect(skills.loadFor('Hydrogen')[0]!.compiledGeneration).toBe('oldgen01');

    // Operator reset keeps body facts too (counters ≠ body history).
    skills.resetCounters('Hydrogen', 's');
    const afterReset = skills.loadFor('Hydrogen')[0]!;
    expect(afterReset.compiledGeneration).toBe('oldgen01');

    // Demotion restores the llm body — the script generation goes with it.
    const demoted = skills.demoteToLlm('Hydrogen', 's');
    expect(demoted!.kind).toBe('llm');
    expect(skills.loadFor('Hydrogen')[0]!.compiledGeneration).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
