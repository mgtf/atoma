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
import { makeCtx, jsonText, jsonTextPair , nsOf} from './helpers.js';

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
    // Force the trust fast-path on Water so the supervise loop
    // skips the LLM validators — that lets us assert ONLY the calls
    // the skill prefilter and the L1 plan/execute introduce.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
  }

  it('does NOT call any LLM when the L1 has no skills (no skill prefilter pass)', async () => {
    ensureChildIsTrusted();
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Skeletal-plan path: prefilter picks Water, viaPrefilter,
    // trust fast-path approves the L1 plan. No skill LLM call expected
    // because skills.loadFor("Water") is empty.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'matches' })
    );
    // L1.plan + L1.execute responses
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    const result = await neuron.handleDirect({ description: 'build a thing' }, ctx);
    expect(result.summary).toBe('ok');
    // Exactly 3 calls: prefilter, L1.plan, L1.execute. No skill prefilter slot.
    expect(ctx.llm.calls).toHaveLength(3);
  });

  it('runs a skill prefilter when the L1 has skills, injects the matched body via injectContext', async () => {
    ensureChildIsTrusted();
    skills.save(nsOf(reg, 'Water'), {
      id: 'web-build-loop',
      description: 'write index.html, serve, validate',
      whenToUse: 'when the subtask is a single-file web artefact',
      kind: 'llm',
      body: 'STEP 1: write_file index.html.\nSTEP 2: start_static_server.',
    });

    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter (picks Water).
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'matches' })
    );
    // Skill prefilter (picks web-build-loop).
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 'fits the task' })
    );
    // L1.plan + L1.execute.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await neuron.handleDirect({ description: 'single-file web build' }, ctx);

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
    skills.save(nsOf(reg, 'Water'), {
      id: 'unrelated-skill',
      description: 'totally unrelated',
      whenToUse: 'never',
      kind: 'llm',
      body: 'unused',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'tier' })
    );
    // Skill prefilter says escalate — the skill body must NOT be injected.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    // L1.plan + L1.execute on a clean prompt.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await neuron.handleDirect({ description: 'a different kind of task' }, ctx);
    expect(ctx.llm.calls[2]!.systemPrompt).not.toMatch(/== ACTIVE SKILL/);
    expect(ctx.llm.calls[2]!.systemPrompt).not.toMatch(/unused/);
  });

  it('bumps the skill success counter through the onApproved hook on a clean run', async () => {
    ensureChildIsTrusted();
    skills.save(nsOf(reg, 'Water'), {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });

    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 's' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);
    const refreshed = skills.loadFor(nsOf(reg, 'Water'));
    expect(refreshed[0]!.successes).toBe(1);
    expect(refreshed[0]!.failures).toBe(0);
  });

  it('bumps the skill failure counter through the onFailed hook when the run escalates', async () => {
    skills.save(nsOf(reg, 'Water'), {
      id: 'web-build-loop',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    // No trust fast-path here — we want the full validate cycle so we
    // can drive a rejection cascade and trigger the onFailed hook.
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter -> Water.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
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

    await neuron.handleDirect({ description: 'task' }, ctx);

    const refreshed = skills.loadFor(nsOf(reg, 'Water'));
    expect(refreshed[0]!.failures).toBeGreaterThanOrEqual(1);
    expect(refreshed[0]!.successes).toBe(0);

    // The revision prompt must carry the same generality constraint as the
    // distillation prompt: "fix the failure" is an invitation to hardcode
    // the failing run's specifics into a body reused by the whole class.
    const improveCall = ctx.llm.calls.find((c) => c.userContent.includes('IMPROVED body'));
    expect(improveCall).toBeDefined();
    const improvePrompt = improveCall!.userContent;
    expect(improvePrompt).toMatch(/KEEP IT GENERAL/);
    expect(improvePrompt).toMatch(/PLACEHOLDERS/);
  });

  it('does NOT distill a "novel" skill when a recipe matched but an escalation branch delivered', async () => {
    // Regression (timers run, 2026-08-07): the C3 learner was gated on the
    // INSTANCE tag (child.activeSkillId()) — an escalation branch returns a
    // fresh instance with no tag, so a skill-driven-but-escalated run read
    // as novel and distilled near-duplicates of the very recipe that had
    // matched (4 replay-twins in 2 days, all operator-merged). The gate now
    // also checks the SUBTASK-scoped match fact.
    const envBefore = process.env['ATOMA_SKILL_LEARN'];
    process.env['ATOMA_SKILL_LEARN'] = '1';
    try {
      skills.save(nsOf(reg, 'Water'), {
        id: 'web-build-loop', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b',
      });
      const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
      const ctx = makeCtx();
      // Tier prefilter -> Water; skill prefilter -> web-build-loop.
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'web-build-loop', confidence: 'high', reasoning: 's' }));
      // Three identical plan rejections -> escalation.
      for (let i = 0; i < 3; i++) {
        ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
        ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'no good', scope: 'ephemeral' }));
      }
      // Skill-update path: Sonnet returns the body UNCHANGED -> "not a
      // revision" -> falls through to the REGISTRY-BRANCH path (fresh type,
      // fresh instance, NO active-skill tag — the leak's precondition).
      ctx.llm.enqueueText('b');
      // The branched instance gets one clean validated cycle.
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'built by branch' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'result ok' }));
      // Defensive extras (harmless if unconsumed).
      for (let i = 0; i < 4; i++) {
        ctx.llm.enqueueText(jsonText({ output: 'x', summary: 'extra' }));
      }

      await neuron.handleDirect({ description: 'task' }, ctx);

      // The subtask's recipe MATCHED, so the run is not novel — the C3
      // TASK-skill distillation must not fire. (The EVENT-skill learner —
      // 'You are distilling a RECOVERED run' — legitimately may: rejections
      // happened and the run recovered; that channel is gated separately.)
      expect(
        ctx.llm.calls.some((c) => c.userContent.startsWith('You are distilling a successful run'))
      ).toBe(false);
      expect(skills.loadFor(nsOf(reg, 'Water')).filter((s) => !s.trigger).map((s) => s.id)).toEqual([
        'web-build-loop',
      ]);
      // R2 kill-shot: the registry branch delivered WITHOUT the recipe — the
      // untagged fresh instance must credit nothing. (The failure recorded
      // during the tagged instance's escalation is EARNED and stays.)
      const after = skills.loadFor(nsOf(reg, 'Water')).find((s) => s.id === 'web-build-loop')!;
      expect(after.successes).toBe(0);
    } finally {
      if (envBefore === undefined) delete process.env['ATOMA_SKILL_LEARN'];
      else process.env['ATOMA_SKILL_LEARN'] = envBefore;
    }
  });

  it('does NOT bump skill counters when no skill was active (orthogonal pathway)', async () => {
    ensureChildIsTrusted();
    // No skills saved — counters file shouldn't be created at all.
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);
    expect(skills.loadFor(nsOf(reg, 'Water'))).toEqual([]);
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

describe('skill revision: an UNCHANGED body is not a revision', () => {
  it('does not save, does not clear the refusal stamp, does not retry', async () => {
    // improveSkillBody is TOLD to return the body unchanged when the failure
    // was environmental. Saving it anyway would clear the promotion-refusal
    // stamp (save() assumes the body changed) and retry an identical recipe
    // against an identical diagnosis — a guaranteed-identical outcome.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-unchanged-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    const BODY = '1. do the thing\n2. verify it';
    skills.save(nsOf(reg, 'Water'), {
      id: 'stable', description: 'd', whenToUse: 'w', kind: 'llm', body: BODY,
    });
    skills.markPromotionRefused(nsOf(reg, 'Water'), 'stable', 'irreducible', 'somegen');

    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'stable', confidence: 'high', reasoning: 'fit' }));
    // Three plan/reject cycles → escalation.
    for (let i = 0; i < 3; i++) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'no', scope: 'ephemeral' }));
    }
    // The revision call returns the SAME body (with incidental whitespace).
    ctx.llm.enqueueText('  ' + BODY + '  ');
    // What happens AFTER the revision decision (registry-branch path, parent
    // fallback) is not what this test is about — the assertion is on the
    // skill store, so letting the mock run dry there is fine and keeps the
    // test from encoding an unrelated call sequence.
    await neuron.handleDirect({ description: 'task' }, ctx).catch(() => undefined);

    const after = skills.loadFor(nsOf(reg, 'Water'))[0]!;
    // Body untouched AND the stamp survived — the anti-thrash guard holds.
    expect(after.body.trim()).toBe(BODY);
    expect(after.promotionRefusedAt).toBeTruthy();
    expect(after.promotionRefusedGeneration).toBe('somegen');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('active skill survives a patch verdict (audit rank-7)', () => {
  it('the fresh L1 instance keeps the injected skill AND the attribution id', async () => {
    // patch/branch return a brand-new L1Atom.fromType instance: no injected
    // context, activeSkillId null. A skill-driven run continued WITHOUT its
    // recipe after a mid-loop patch, and the skill's trust counters were
    // never bumped (onApproved reads activeSkillId from the CURRENT child).
    const dir = mkdtempSync(join(tmpdir(), 'atoma-carry-'));
    const skills = new SkillRegistry(dir);
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, { description: 'l2', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    reg.create(1, { description: 'l1', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    skills.save(nsOf(reg, 'Water'), {
      id: 'the-recipe', description: 'd', whenToUse: 'w', kind: 'llm', body: 'step 1: do it',
    });

    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'the-recipe', confidence: 'high', reasoning: 'f' }));
    // Plan → validator PATCHES (not approve): fresh instance replaces child.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({ approved: false, reasoning: 'tighten prompt', scope: 'patch', modifications: { systemPromptAppend: 'be precise' } })
    );
    // Retry on the patched instance: plan → approve → execute → approve.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'did it' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await neuron.handleDirect({ description: 'task' }, ctx);

    // The attribution held: the skill's counter bumped despite the patch.
    const after = skills.loadFor(nsOf(reg, 'Water'))[0]!;
    expect(after.successes).toBe(1);
    // And the patched instance's prompts carried the recipe forward.
    const post = ctx.llm.calls.slice(4);
    expect(post.some((c) => (c.systemPrompt ?? '').includes('ACTIVE SKILL: the-recipe'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
