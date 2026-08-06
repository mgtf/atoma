import { describe, it, expect } from 'vitest';
import { parseVerdict, REMEDIATION_FEEDBACK_MAX_CHARS } from '../src/atoms/json.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';

/**
 * Bounded remediation feedback (SPOQ's ≤20-actionable-lines practice):
 * the validator is TOLD to keep additionalContext short and concrete,
 * and the parse boundary truncates oversized feedback mechanically —
 * observed on the 2026-07-25 run, ballooning diagnostics coached the
 * retries into DEGRADING the artefact cycle over cycle.
 */

describe('REMEDIATION FEEDBACK CONTRACT', () => {
  it('is taught by the validation system prompt', () => {
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/REMEDIATION FEEDBACK CONTRACT/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/SHORT and ACTIONABLE/);
    expect(VALIDATION_SYSTEM_PROMPT).toMatch(/naming the exact/);
  });

  it('truncates oversized additionalContext at the parse boundary, with a marker', () => {
    const v = parseVerdict(
      JSON.stringify({
        approved: false,
        reasoning: 'no',
        scope: 'ephemeral',
        modifications: { additionalContext: 'A'.repeat(REMEDIATION_FEEDBACK_MAX_CHARS + 500) },
      })
    );
    expect(v.approved).toBe(false);
    if (!v.approved) {
      const ac = v.modifications.additionalContext!;
      expect(ac.length).toBeLessThan(REMEDIATION_FEEDBACK_MAX_CHARS + 100);
      expect(ac).toMatch(/remediation feedback truncated/);
      expect(ac.startsWith('A'.repeat(50))).toBe(true); // head survives — the diagnosis leads
    }
  });

  it('leaves bounded feedback untouched', () => {
    const v = parseVerdict(
      JSON.stringify({
        approved: false,
        reasoning: 'no',
        scope: 'ephemeral',
        modifications: { additionalContext: 'fix the 404 on /health: the route is registered after listen()' },
      })
    );
    if (!v.approved) {
      expect(v.modifications.additionalContext).toBe(
        'fix the 404 on /health: the route is registered after listen()'
      );
    }
  });
});
