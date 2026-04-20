import { describe, it, expect } from 'vitest';
import {
  planSchema,
  subtaskSpecSchema,
  aggregationSpecSchema,
  parsePlanTolerant,
} from '../src/atoms/json.js';

/**
 * Phase 1 — schema tests.
 * Asserts that the FanOutPlan shape is accepted, the legacy shape is
 * coerced (with a single degenerate subtask), and invalid shapes are
 * rejected.
 */

describe('subtaskSpecSchema', () => {
  it('requires a description', () => {
    expect(subtaskSpecSchema.safeParse({}).success).toBe(false);
    expect(subtaskSpecSchema.safeParse({ description: 'do x' }).success).toBe(true);
  });

  it('accepts optional inputs and preferredChild', () => {
    const ok = subtaskSpecSchema.parse({
      description: 'do x',
      inputs: { k: 'v' },
      preferredChild: 'Hydrogen',
    });
    expect(ok.preferredChild).toBe('Hydrogen');
    expect(ok.inputs).toEqual({ k: 'v' });
  });
});

describe('aggregationSpecSchema', () => {
  it('rejects unknown modes', () => {
    expect(aggregationSpecSchema.safeParse({ mode: 'merge' }).success).toBe(false);
    expect(aggregationSpecSchema.safeParse({ mode: 'concat' }).success).toBe(true);
    expect(
      aggregationSpecSchema.safeParse({ mode: 'llm-synthesize', instruction: 'merge' }).success
    ).toBe(true);
  });
});

describe('planSchema — fan-out native shape', () => {
  it('accepts a multi-subtask plan with aggregation', () => {
    const plan = planSchema.parse({
      reasoning: 'decompose',
      subtasks: [
        { description: 'write layout', preferredChild: 'Hydrogen' },
        { description: 'write logic', preferredChild: 'Helium' },
      ],
      aggregation: { mode: 'llm-synthesize', instruction: 'assemble into one file' },
      expectedOutput: 'a live URL',
    });
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.aggregation.mode).toBe('llm-synthesize');
  });

  it('rejects a plan with an empty subtasks array', () => {
    expect(
      planSchema.safeParse({
        reasoning: 'r',
        subtasks: [],
        aggregation: { mode: 'concat' },
        expectedOutput: 'e',
      }).success
    ).toBe(false);
  });

  it('defaults aggregation to concat when omitted', () => {
    const plan = planSchema.parse({
      reasoning: 'r',
      subtasks: [{ description: 'a' }],
      expectedOutput: 'e',
    });
    expect(plan.aggregation).toEqual({ mode: 'concat' });
  });
});

describe('planSchema — legacy coercion', () => {
  it('coerces a legacy `{reasoning, proposedAction, expectedOutput}` into 1-subtask fan-out', () => {
    const plan = planSchema.parse({
      reasoning: 'r',
      proposedAction: 'write a file',
      expectedOutput: 'done',
    });
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]!.description).toBe('write a file');
    expect(plan.aggregation).toEqual({ mode: 'concat' });
    // Legacy fields are preserved for visibility.
    expect(plan.proposedAction).toBe('write a file');
  });

  it('falls back to expectedOutput when proposedAction is missing', () => {
    const plan = planSchema.parse({
      reasoning: 'r',
      expectedOutput: 'the deliverable',
    });
    expect(plan.subtasks[0]!.description).toBe('the deliverable');
  });
});

describe('parsePlanTolerant + fan-out', () => {
  it('round-trips a fan-out plan from JSON text', () => {
    const text = JSON.stringify({
      reasoning: 'decompose',
      subtasks: [
        { description: 'A', preferredChild: 'Hydrogen' },
        { description: 'B', preferredChild: 'Helium' },
      ],
      aggregation: { mode: 'concat' },
      expectedOutput: 'done',
    });
    const plan = parsePlanTolerant(text);
    expect(plan.subtasks.map((s) => s.description)).toEqual(['A', 'B']);
  });
});
