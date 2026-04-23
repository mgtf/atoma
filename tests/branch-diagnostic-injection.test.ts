import { describe, it, expect } from 'vitest';
import { extractBranchDiagnostic } from '../src/atoms/capability.js';
import { buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';

/**
 * Regression tests for fix #1 (diagnostic injection into branched
 * atoms). Observed in the backgammon timeout run:
 *   - Hydrogen looped 16 validate_html calls and declared success
 *   - Supervisor's ground-truth probe rejected with a 404
 *   - branchOnEscalation created Beryllium with a generic "prior
 *     attempts failed" note — NO mention of the 404
 *   - Beryllium re-ran 23 identical validate_html cycles, timed out
 *
 * The fix pulls the last 1-2 negative verdict reasonings out of the
 * supervise-loop trace and embeds them verbatim in the narrow prompt
 * the branched atom sees, so the branch can target the specific
 * failure (the 404) instead of rewriting the whole deliverable.
 */

describe('extractBranchDiagnostic', () => {
  it('returns empty when trace has no negative verdicts', () => {
    const out = extractBranchDiagnostic([
      { kind: 'plan', payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' } },
      { kind: 'verdict-plan', payload: { approved: true, reasoning: 'looks good' } },
    ]);
    expect(out).toBe('');
  });

  it('extracts up to 2 most-recent negative verdict reasonings, newest first', () => {
    const out = extractBranchDiagnostic([
      { kind: 'verdict-result', payload: { approved: false, reasoning: 'first rejection: too narrow' } },
      { kind: 'plan', payload: {} },
      { kind: 'verdict-result', payload: { approved: false, reasoning: 'second rejection: 404 on GET /' } },
      { kind: 'applied-modifications', payload: { modifications: { additionalContext: 'fix the 404 please' } } },
      { kind: 'verdict-result', payload: { approved: false, reasoning: 'third rejection: still 404' } },
    ]);
    // Newest first
    expect(out).toMatch(/third rejection: still 404/);
    expect(out).toMatch(/second rejection: 404 on GET \//);
    // Only TWO verdicts (cap at 2)
    expect(out).not.toMatch(/first rejection: too narrow/);
    // Also includes the last applied-modifications additionalContext
    expect(out).toMatch(/Validator's prescription for the next attempt/);
    expect(out).toMatch(/fix the 404 please/);
  });

  it('caps the output at ~1500 chars so it does not flood the narrow prompt', () => {
    const longReason = 'x'.repeat(5000);
    const out = extractBranchDiagnostic([
      { kind: 'verdict-result', payload: { approved: false, reasoning: longReason } },
      { kind: 'verdict-result', payload: { approved: false, reasoning: longReason } },
    ]);
    expect(out.length).toBeLessThanOrEqual(1501); // +1 for ellipsis
  });

  it('skips applied-modifications entries with empty additionalContext', () => {
    const out = extractBranchDiagnostic([
      { kind: 'verdict-result', payload: { approved: false, reasoning: 'reject' } },
      { kind: 'applied-modifications', payload: { modifications: {} } },
    ]);
    expect(out).toMatch(/reject/);
    expect(out).not.toMatch(/Validator's prescription/);
  });
});

describe('buildNarrowL1Prompt with diagnostic', () => {
  it('omits the PRIOR ATTEMPT DIAGNOSIS block when diagnostic is empty', () => {
    const prompt = buildNarrowL1Prompt('build a thing', []);
    expect(prompt).not.toMatch(/PRIOR ATTEMPT DIAGNOSIS/);
  });

  it('injects the diagnostic as a clearly-labelled block when provided', () => {
    const diag =
      'Prior attempt was REJECTED.\n  [RESULT] GROUND-TRUTH EVIDENCE: validate_html reported 404';
    const prompt = buildNarrowL1Prompt('build a thing', [], diag);
    expect(prompt).toMatch(/== PRIOR ATTEMPT DIAGNOSIS \(act on this, do NOT ignore\) ==/);
    expect(prompt).toMatch(/GROUND-TRUTH EVIDENCE: validate_html reported 404/);
    // And the nudge towards a targeted fix
    expect(prompt).toMatch(/Your first move should diagnose and fix the exact issue/);
    expect(prompt).toMatch(/Do NOT rewrite the entire deliverable/);
  });
});

describe('buildNarrowL2Prompt with diagnostic', () => {
  it('injects the diagnostic as a block and nudges targeted decomposition', () => {
    const diag = 'Prior attempt was REJECTED.\n  [PLAN] Missing preferredChild on fan-out.';
    const prompt = buildNarrowL2Prompt('orchestrate a build', [], diag);
    expect(prompt).toMatch(/== PRIOR ATTEMPT DIAGNOSIS/);
    expect(prompt).toMatch(/Missing preferredChild on fan-out/);
    expect(prompt).toMatch(/Your decomposition should target the SPECIFIC failure/);
  });
});
