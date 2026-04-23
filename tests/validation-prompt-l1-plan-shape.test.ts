import { describe, it, expect } from 'vitest';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/L2Atom.js';

/**
 * Regression test for fix #10: the VALIDATION_SYSTEM_PROMPT must
 * explicitly endorse the L1 plan shape (pre-declared toolCalls), so
 * Haiku stops rejecting Node/REST L1 plans with hallucinated
 * "supervisor-proposes-tools" complaints.
 *
 * Root cause observed in the live run: the prompt used to say only
 * that L2/L3 supervisors cannot invoke tools; nothing about what an
 * L1 plan looks like. Haiku generalised from the L2/L3 rule and
 * rejected L1 plans that carried a toolCalls array as "tier
 * violations", causing a repeat-rejection escalation cascade (3x
 * identical gripes -> escalate). The fix appends an explicit
 * L1 PLAN SHAPE clause.
 */

describe('VALIDATION_SYSTEM_PROMPT — L1 plan shape clause (#10)', () => {
  it('includes a named section clarifying that L1 plans MAY carry toolCalls', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/L1 PLAN SHAPE/);
  });

  it('names `toolCalls` as a valid L1 plan field (not a tier violation)', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/toolCalls/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /DO NOT reject an L1 plan for "proposing tool invocations directly"/
    );
  });

  it('tells Haiku that aspirational toolCalls at plan time are expected', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Aspirational .toolCalls/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/executor phase carries them out/);
  });

  it('tolerates placeholder/runtime-data references in L1 plan tool calls', () => {
    // The plan cannot know the OS-assigned port or the URL
    // start_node_server will return until execute time. Haiku was
    // rejecting plans with {{PORT}} placeholders — the prompt now
    // explicitly permits them.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/runtime\s+data the plan cannot yet know/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/Placeholders/);
  });

  it('preserves the original "L2/L3 must delegate" rule — the fix clarifies, does not retract', () => {
    // Regression guard: the #10 clarification lives ALONGSIDE the
    // existing L2/L3-must-delegate clause, not instead of it.
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(
      /If a supervisor at L2 or L3 proposes calling tools directly, THAT is the violation/
    );
  });

  it('stays above the Haiku cache threshold (4096 tokens) — line count is a cheap proxy', () => {
    // Anthropic prompt caching requires >=4096 tokens for Haiku 4.5.
    // Our prompt sits at ~5000 tokens; the #10 append adds ~20 lines,
    // nudging it safely away from the threshold. This test flags any
    // future trim that might push us below the cacheable boundary.
    const lines = VALIDATION_SYSTEM_PROMPT.split('\n').length;
    expect(lines).toBeGreaterThan(150);
  });
});
