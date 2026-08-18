import { describe, it, expect } from 'vitest';
import { capToolIterations, MIN_TOOL_ITERATION_MS } from '../src/core/limits.js';

/**
 * The 2026-08-16 fan-in incident: a 40-iteration validator loop at ~26 s
 * each is ~1040 s, longer than the 900 s run. The cap is the remaining
 * wall clock divided by that floor — not a new reject gate.
 */
describe('capToolIterations', () => {
  it('leaves the request untouched when no deadline is set', () => {
    expect(capToolIterations(40)).toBe(40);
    expect(capToolIterations(24)).toBe(24);
  });

  it('caps a 40-iteration validator loop so it cannot out-plan a 900s run', () => {
    const now = 1_000_000;
    const deadlineAt = now + 900_000;
    expect(capToolIterations(40, deadlineAt, now)).toBe(
      Math.floor(900_000 / MIN_TOOL_ITERATION_MS)
    );
    expect(capToolIterations(40, deadlineAt, now)).toBeLessThan(40);
  });

  it('shrinks a late phase that starts with little time left', () => {
    const now = 1_000_000;
    const deadlineAt = now + 80_000;
    expect(capToolIterations(40, deadlineAt, now)).toBe(
      Math.floor(80_000 / MIN_TOOL_ITERATION_MS)
    );
  });

  it('returns 1 when the deadline is already in the past', () => {
    expect(capToolIterations(40, 100, 200)).toBe(1);
  });

  it('never raises the caller above what they asked for', () => {
    const now = 1_000_000;
    expect(capToolIterations(2, now + 900_000, now)).toBe(2);
  });
});
