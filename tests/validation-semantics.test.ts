import { describe, it, expect } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { VALIDATION_SYSTEM_PROMPT, llmVerdict } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Regression tests for the validator prompt rework.
 *
 * Earlier build-app runs showed Haiku validators rejecting perfectly valid
 * L3/L2 plans with hallucinated rules ("tier 2 cannot delegate to tier 1",
 * "supervisor must retain orchestration", "plan is aspirational — no
 * execution evidence"). These tests lock in:
 *   1. The validator prompt now explicitly states the tiering contract
 *      AND the PLAN-vs-RESULT distinction, so downstream changes cannot
 *      silently regress the semantics.
 *   2. `llmVerdict` injects a "Subject kind: PLAN|RESULT" hint in the user
 *      message so the validator cannot confuse the two bars.
 */

const baseSeed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('VALIDATION_SYSTEM_PROMPT — tier contract and PLAN/RESULT rubric', () => {
  it('states the tiering contract explicitly', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/TIERING CONTRACT/);
    // Tier responsibilities must be enumerated.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /L1 elements are the ONLY tier allowed to invoke tools/
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/L2 molecules plan and delegate/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/L3 cells plan and delegate/);
  });

  it('forbids rejecting a plan for legitimate downward delegation', () => {
    // The earlier bug rejected "L2 delegates to L1" as a violation. The
    // prompt must now explicitly state that downward delegation is the
    // protocol, not a defect.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /Delegation DOWN the tiers is the protocol/
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /Never reject a plan for "delegating to a lower tier"/
    );
  });

  it('separates PLAN and RESULT acceptance bars', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/PLAN vs RESULT/);
    // PLAN bar: no execution evidence required.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /Aspirational language[\s\S]*is NEVER grounds for rejection/
    );
    // RESULT bar: check deliverable against success criteria.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/claims the work is DONE/);
  });

  it('keeps the patch/branch non-empty-modifications hard rule intact', () => {
    // This was previously added for the Fluorine no-op issue; make sure the
    // rewrite didn't drop it on the floor.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/HARD RULE/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /scope "patch" and scope "branch" MUST carry at least one non-empty field/
    );
  });

  it('teaches validators to heal description drift via descriptionReplace', () => {
    // Description drift is a real observed cost sink — stale "Mario
    // platformer" descriptions on a type now used for Minesweeper confused
    // the prefilter. The prompt must explicitly permit (and name) the fix.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/DESCRIPTION DRIFT/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/descriptionReplace/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/prefilter/);
  });
});

describe('llmVerdict — userContent carries a Subject-kind hint', () => {
  function makeChild(): L1Atom {
    return new L1Atom({
      name: 'Hydrogen',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
  }

  it('PLAN verdicts include a hint telling the validator not to demand execution evidence', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Neuron',
      supervisorTier: 3,
      subject: 'PLAN',
      child: makeChild(),
      task: { description: 't' },
      payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
    });

    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/Subject kind: PLAN/);
    expect(content).toMatch(/do NOT demand execution evidence yet/);
  });

  it('RESULT verdicts include a hint telling the validator to check deliverable vs success criteria', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'RESULT',
      child: makeChild(),
      task: { description: 't' },
      payload: { output: 'o', summary: 's' },
    });

    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/Subject kind: RESULT/);
    expect(content).toMatch(/claims the work is DONE/);
  });

  it('supervisor + child tier labels remain in userContent for traceability', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Neuron',
      supervisorTier: 3,
      subject: 'PLAN',
      child: makeChild(),
      task: { description: 't' },
      payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
    });

    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/Supervisor: "Neuron" \(tier 3\)/);
    expect(content).toMatch(/Child: "Hydrogen" \(tier 1\)/);
  });
});

describe('L2/L3 validators wire the rewritten prompt into every call', () => {
  it('L2.validatePlan uses the full rewritten VALIDATION_SYSTEM_PROMPT', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, baseSeed);
    const l2Type = reg.create(2, baseSeed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l2.validatePlan(
      l1,
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      { description: 'task' },
      ctx
    );

    expect(ctx.llm.calls[0]!.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
    // And the userContent must now carry the Subject-kind hint.
    expect(ctx.llm.calls[0]!.userContent).toMatch(/Subject kind: PLAN/);
  });
});
