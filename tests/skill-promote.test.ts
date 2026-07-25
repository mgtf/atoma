import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_PROMOTE_THRESHOLD_SUCCESSES, TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
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
    // Counters preserved across promotion.
    expect(after.failures).toBe(0);
    expect(after.successes).toBe(TRUST_PROMOTE_THRESHOLD_SUCCESSES + 1);
    // The original llm body was stashed in the fallback sidecar so a
    // future demotion can restore it verbatim.
    expect(after.fallbackBody).toMatch(/start_static_server/);
    expect(existsSync(join(dir, 'Hydrogen', 'web-build-loop', '_fallback.md'))).toBe(true);
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
