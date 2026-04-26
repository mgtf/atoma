import { describe, it, expect } from 'vitest';
import { planSchema, parseTwoJson } from '../src/atoms/json.js';

/**
 * Regression for the SSR-LoL crash: an Opus PHASED plan with 3 detailed
 * phases blew past the supervisor STRATEGY_MAX_TOKENS cap (then 1500),
 * stopped mid-subtask-3, and never emitted the trailing `aggregation` /
 * `expectedOutput` fields. Result: planSchema rejected the parsed object
 * with `expectedOutput: Required` and the whole run crashed at L3.plan.
 *
 * The fix is twofold:
 *   1. The cap was raised so this is unlikely in practice (cost.ts).
 *   2. planSchema treats `expectedOutput` as optional with a '' default
 *      (defence in depth) so a future truncation never crashes again.
 *
 * These tests pin both halves of the contract.
 */

describe('planSchema — robust to missing expectedOutput', () => {
  it('accepts a plan with expectedOutput omitted, defaults to empty string', () => {
    const parsed = planSchema.parse({
      reasoning: 'phased build',
      subtasks: [
        { description: 'phase 1', preferredChild: 'Methane' },
        { description: 'phase 2', preferredChild: 'Methane' },
      ],
      aggregation: { mode: 'sequential' },
      // expectedOutput intentionally omitted — simulates a truncated
      // Opus response where the field never got written.
    });
    expect(parsed.expectedOutput).toBe('');
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.aggregation.mode).toBe('sequential');
  });

  it('still accepts a plan WITH expectedOutput (back-compat)', () => {
    const parsed = planSchema.parse({
      reasoning: 'r',
      subtasks: [{ description: 'd' }],
      aggregation: { mode: 'concat' },
      expectedOutput: 'a running URL',
    });
    expect(parsed.expectedOutput).toBe('a running URL');
  });

  it('accepts a plan with both aggregation AND expectedOutput omitted (everything past subtasks truncated)', () => {
    // The most degenerate truncation: the model stopped right after
    // closing the subtasks array, before writing aggregation OR
    // expectedOutput. With both fields defaulted, the plan is still
    // parseable — the run can keep going on `concat` (parallel) by
    // default. For PHASED plans this isn't ideal but it beats crashing.
    const parsed = planSchema.parse({
      reasoning: 'r',
      subtasks: [{ description: 'd' }],
    });
    expect(parsed.expectedOutput).toBe('');
    expect(parsed.aggregation.mode).toBe('concat');
  });

  it('parsePlanTolerant survives an Opus-shaped JSON-pair where the second object is missing expectedOutput', () => {
    // The bug shape verbatim: parseTwoJson finds two balanced JSON
    // objects, the second has subtasks + aggregation but no
    // expectedOutput. Before the fix this threw ValidationError.
    const text = JSON.stringify([
      { strategy: 'reuse', target: 'Methane', reasoning: 'fits' },
      {
        reasoning: 'phased',
        subtasks: [{ description: 'p1', preferredChild: 'Methane' }],
        aggregation: { mode: 'sequential' },
        // no expectedOutput
      },
    ]);
    const [, plan] = parseTwoJson(text);
    const parsed = planSchema.parse(plan);
    expect(parsed.expectedOutput).toBe('');
    expect(parsed.subtasks).toHaveLength(1);
  });
});
