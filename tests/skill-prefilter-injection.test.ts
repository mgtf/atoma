import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, skillContextBlock } from '../src/atoms/L2Atom.js';
import {
  PREFILTER_SYSTEM_PROMPT,
  SKILL_PREFILTER_SYSTEM_PROMPT,
  TRUST_THRESHOLD_SUCCESSES,
} from '../src/atoms/cost.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * Tests for C2a — L2 runs a Haiku skill-prefilter against the
 * resolved L1's skills, injects the matched skill body into the L1's
 * effective system prompt via injectContext, and bumps the skill
 * trust counters via the supervise-loop hooks.
 *
 * Tests use mocked LLM responses (Haiku verdicts + plan JSON) so the
 * machinery is exercised end-to-end without network calls.
 */

const seed = {
  description: 'web orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('skillContextBlock', () => {
  it('renders a clearly-delimited block with the skill body inside', () => {
    const out = skillContextBlock({ id: 'web-build', body: 'Step 1.\nStep 2.' });
    expect(out).toMatch(/== ACTIVE SKILL: web-build ==/);
    expect(out).toMatch(/Step 1\./);
    expect(out).toMatch(/== END ACTIVE SKILL ==/);
  });
});

describe('SKILL_PREFILTER_SYSTEM_PROMPT — dedicated skill-matching contract', () => {
  it('is a distinct constant from the atom-catalog prefilter prompt', () => {
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).not.toBe(PREFILTER_SYSTEM_PROMPT);
  });

  it('drops the atom-specific clauses that are meaningless (or harmful) for skills', () => {
    // The single-candidate HARD RULE is the regression this prompt exists to
    // fix: under the atom prompt, an L1 with exactly ONE learned skill (the
    // nominal early-life case) was pushed toward escalate, losing the
    // injection AND triggering a redundant Sonnet learn call.
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).not.toMatch(/HARD RULE/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).not.toMatch(/REACHABLE L1 CHILDREN/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).not.toMatch(/decomposable/i);
  });

  it('explicitly permits single-candidate matching', () => {
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/Single-candidate catalogs are NORMAL/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/NOT a reason to escalate/);
  });

  it('keeps the shared confidence contract so the low→escalate guard applies unchanged', () => {
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/"high"/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/"low"/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/Missing confidence is treated as "low"/);
    // Same JSON envelope as prefilterResponseSchema expects.
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/"kind": "reuse"/);
    expect(SKILL_PREFILTER_SYSTEM_PROMPT).toMatch(/"kind": "escalate"/);
  });
});

describe('L2.runSubtask — skill prefilter + injection (C2a)', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-skill-pf-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ensureChildIsTrusted(): void {
    // Force the trust fast-path on Hydrogen so the supervise loop
    // skips the LLM validators — that lets us assert ONLY the calls
    // the skill prefilter and the L1 plan/execute introduce.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Hydrogen');
  }

  it('does NOT call any LLM when the L1 has no skills (no skill prefilter pass)', async () => {
    ensureChildIsTrusted();
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    // Skeletal-plan path: prefilter picks Hydrogen, viaPrefilter,
    // trust fast-path approves the L1 plan. No skill LLM call expected
    // because skills.loadFor("Hydrogen") is empty.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'matches' })
    );
    // L1.plan + L1.execute responses
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await water.handleDirect({ description: 'build a thing' }, ctx);
    expect(result.summary).toBe('ok');
    // Exactly 3 calls: prefilter, L1.plan, L1.execute. No skill prefilter slot.
    expect(ctx.llm.calls).toHaveLength(3);
  });

  it('runs a skill prefilter when the L1 has skills, injects the matched body via injectContext', async () => {
    ensureChildIsTrusted();
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'write index.html, serve, validate',
      whenToUse: 'when the subtask is a single-file web artefact',
      kind: 'llm',
      body: 'STEP 1: write_file index.html.\nSTEP 2: start_static_server.',
    });

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter (picks Hydrogen).
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'matches' })
    );
    // Skill prefilter (picks web-build-loop).
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fits the task' })
    );
    // L1.plan + L1.execute.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'single-file web build' }, ctx);

    // 4 calls total = tier prefilter + skill prefilter + L1.plan + L1.execute.
    expect(ctx.llm.calls).toHaveLength(4);
    // The tier prefilter (call #1) keeps the atom-catalog prompt; the skill
    // prefilter (call #2) runs on its DEDICATED prompt — the atom prompt's
    // single-candidate HARD RULE made Haiku escalate on one-skill catalogs.
    expect(ctx.llm.calls[0]!.systemPrompt).toBe(PREFILTER_SYSTEM_PROMPT);
    expect(ctx.llm.calls[1]!.systemPrompt).toBe(SKILL_PREFILTER_SYSTEM_PROMPT);
    // Skill prefilter (call #2) sees the skill catalog in its userContent.
    expect(ctx.llm.calls[1]!.userContent).toMatch(/web-build-loop/);
    expect(ctx.llm.calls[1]!.userContent).toMatch(/single-file web artefact/);
    // L1.plan (call #3) gets the skill body injected via the system prompt.
    expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/== ACTIVE SKILL: web-build-loop ==/);
    expect(ctx.llm.calls[2]!.systemPrompt).toMatch(/STEP 1: write_file index\.html/);
  });

  it('skips the skill body injection when the prefilter escalates (low-confidence guard)', async () => {
    ensureChildIsTrusted();
    skills.save('Hydrogen', {
      id: 'unrelated-skill',
      description: 'totally unrelated',
      whenToUse: 'never',
      kind: 'llm',
      body: 'unused',
    });
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 'tier' })
    );
    // Skill prefilter says escalate — the skill body must NOT be injected.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    // L1.plan + L1.execute on a clean prompt.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'a different kind of task' }, ctx);
    expect(ctx.llm.calls[2]!.systemPrompt).not.toMatch(/== ACTIVE SKILL/);
    expect(ctx.llm.calls[2]!.systemPrompt).not.toMatch(/unused/);
  });

  it('bumps the skill success counter through the onApproved hook on a clean run', async () => {
    ensureChildIsTrusted();
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });

    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 's' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'task' }, ctx);
    const refreshed = skills.loadFor('Hydrogen');
    expect(refreshed[0]!.successes).toBe(1);
    expect(refreshed[0]!.failures).toBe(0);
  });

  it('bumps the skill failure counter through the onFailed hook when the run escalates', async () => {
    skills.save('Hydrogen', {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    // No trust fast-path here — we want the full validate cycle so we
    // can drive a rejection cascade and trigger the onFailed hook.
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter -> Hydrogen.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    // Skill prefilter -> web-build-loop.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 's' })
    );
    // viaPrefilter is set on the L2 skeletal plan, so the L3-side
    // validatePlan would short-circuit — but here we're at the L2
    // tier so superviseLoop calls L2.validatePlan(L1, plan). plan
    // is L1's plan (no viaPrefilter), Haiku validates normally.
    // Three identical "reject plan" cycles to trip the
    // repeat-rejection escalation tracker.
    for (let i = 0; i < 3; i++) {
      // L1.plan
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      // L2.validatePlan: REJECT
      ctx.llm.enqueueText(
        jsonText({ approved: false, reasoning: 'no good', scope: 'ephemeral' })
      );
    }
    // After 3 identical rejections the supervise loop escalates.
    // branchOnEscalation runs the C2b skill-update path FIRST: a
    // Sonnet `improveSkillBody` call generates an updated body, the
    // SkillRegistry overwrites the file (preserving counters), and a
    // fresh L1 instance is returned for the supervise loop's one-shot
    // branch retry. We stub that Sonnet call here.
    ctx.llm.enqueueText(
      'STEP 1: write_file index.html (updated to address the validator\'s diagnosis).\n' +
      'STEP 2: start_static_server.\nSTEP 3: validate_html.'
    );
    // The fresh L1 (with updated skill body) gets ONE clean cycle.
    // We script another reject loop so we ultimately fall through to
    // parent fallback (L2.selfPlan + L2.selfExecute).
    for (let i = 0; i < 3; i++) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(
        jsonText({ approved: false, reasoning: 'no good', scope: 'ephemeral' })
      );
    }
    // Parent fallback path: L2.selfPlan + L2.selfExecute.
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'create', seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} }, reasoning: 'fb' },
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
    ));
    ctx.llm.enqueueText(jsonText({ output: 'fallback', summary: 'fallback ok' }));
    // Defensive extras in case the flow asks for more than expected
    // (e.g. the supervise loop adds an iteration we didn't account
    // for); if they're never consumed it's a harmless overcount.
    for (let i = 0; i < 4; i++) {
      ctx.llm.enqueueText(jsonText({ output: 'fallback', summary: 'extra' }));
    }

    await water.handleDirect({ description: 'task' }, ctx);

    const refreshed = skills.loadFor('Hydrogen');
    expect(refreshed[0]!.failures).toBeGreaterThanOrEqual(1);
    expect(refreshed[0]!.successes).toBe(0);
  });

  it('does NOT bump skill counters when no skill was active (orthogonal pathway)', async () => {
    ensureChildIsTrusted();
    // No skills saved — counters file shouldn't be created at all.
    const water = L2Atom.fromType(reg.getByName('Water')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await water.handleDirect({ description: 'task' }, ctx);
    expect(skills.loadFor('Hydrogen')).toEqual([]);
  });
});

describe('L1Atom.activeSkillId', () => {
  it('starts as null', () => {
    const atom = new L1Atom({
      name: 'X',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
    expect(atom.activeSkillId()).toBeNull();
  });

  it('round-trips via setActiveSkill', () => {
    const atom = new L1Atom({
      name: 'X',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
    atom.setActiveSkill('web-build-loop');
    expect(atom.activeSkillId()).toBe('web-build-loop');
    atom.setActiveSkill(null);
    expect(atom.activeSkillId()).toBeNull();
  });
});
