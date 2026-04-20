import { describe, it, expect } from 'vitest';
import { VALIDATION_SYSTEM_PROMPT, llmVerdict } from '../src/atoms/L2Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Regression tests for the tier-aware plan-checklist rewrite.
 *
 * Background: earlier runs saw Neuron (L3) repeatedly reject perfectly valid
 * Glucose (L2) delegation plans for "missing VISIBLE deliverables" — a rule
 * that should only apply to the L1 plan (the tier that actually builds the
 * artefact). The rework:
 *   1. injects a "Plan kind" hint (DIRECT vs DELEGATION) into userContent
 *      based on child.tier;
 *   2. rewrites the system prompt so the visible-deliverables enumeration is
 *      scoped to DIRECT plans only.
 *
 * These tests lock in both sides of the contract.
 */

function makeL1(): L1Atom {
  return new L1Atom({
    name: 'Hydrogen',
    ordinal: 1,
    systemPrompt: 's',
    tools: [],
    params: {},
  });
}

describe('llmVerdict — injects Plan-kind hint based on child tier', () => {
  it('child tier 1 → Plan kind DIRECT', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'PLAN',
      child: makeL1(),
      task: { description: 'build a Minesweeper' },
      payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
    });

    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/Plan kind: DIRECT/);
    expect(content).toMatch(/apply the VISIBLE-deliverables checklist/);
  });

  it('child tier 2 → Plan kind DELEGATION with explicit "do NOT demand" wording', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, {
      description: 'd',
      systemPrompt: 's',
      tools: [],
      params: {},
      createdBy: 't',
    });
    const l2Child = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Neuron',
      supervisorTier: 3,
      subject: 'PLAN',
      child: l2Child,
      task: { description: 'build a Minesweeper' },
      payload: {
        reasoning: 'r',
        proposedAction: 'delegate leaf task to L1 "Fluorine"',
        expectedOutput: 'build a Minesweeper',
      },
    });

    const content = ctx.llm.calls[0]!.userContent;
    expect(content).toMatch(/Plan kind: DELEGATION/);
    expect(content).toMatch(/do NOT demand visible-deliverable enumeration/);
  });
});

describe('VALIDATION_SYSTEM_PROMPT — tier-scoped visible-deliverables rule', () => {
  it('defines DIRECT and DELEGATION as distinct plan kinds', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/VISIBLE-DELIVERABLES RULE \(tier-aware[^)]*\)/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/If Plan kind is DIRECT/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/If Plan kind is DELEGATION/);
  });

  it('tells validators not to apply the enumeration checklist to delegation plans', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /checklist does\s*NOT apply here/i
    );
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /Do NOT reject a DELEGATION plan for "missing VISIBLE deliverables"/
    );
  });

  it('keeps the DIRECT-plan rule narrow: reject on concrete missing element, not mere absence of enumeration', () => {
    // Post-softening the DIRECT rule no longer demands prose enumeration of
    // every affordance — it rejects only when the plan commits to a
    // materially WRONG artefact (colored shapes in place of task-stated
    // numbers/icons, etc.). Narrow the tests accordingly.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/materially WRONG artefact/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/name the CONCRETE task-stated element/);
    // Fallback-supervisor scope is still called out.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/supervisor acting[\s\S]*in fallback/);
  });

  it('explicitly bans rejecting DIRECT plans for polish / enumeration / smoke nits', () => {
    // These are the anti-patterns the soften pass added — each one burned a
    // Haiku round on a production run with zero progress. Lock them in.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/DO NOT reject a plan because/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/omits prose enumeration/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/smoke[\s-]*test snippet could be slightly more thorough/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/could "go further" on feedback polish/);
  });

  it('RESULT validation narrows visible-deliverables check to DIRECT plans too', () => {
    // The old phrasing applied the RESULT-side checklist to every interactive
    // artefact, which caused the same false-rejection pattern on delegated
    // RESULTs. The rewrite explicitly scopes it to DIRECT and trusts
    // DELEGATION results subject to ground-truth evidence.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /When Plan kind is DELEGATION, trust the downstream L1's RESULT/
    );
  });
});

describe('VALIDATION_SYSTEM_PROMPT — brevity discipline', () => {
  it('tells the validator to keep reasoning under 120 words', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/reasoning.*under 120 words/i);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/truncated mid-sentence/);
  });
});
