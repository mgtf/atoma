import { describe, it, expect } from 'vitest';
import {
  planSchema,
  subtaskSpecSchema,
  aggregationSpecSchema,
  parsePlanTolerant,
} from '../src/atoms/json.js';

/**
 * Phase 1 — schema tests.
 * Asserts that the FanOutPlan shape is accepted, the single-action shape is
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
      preferredChild: 'Water',
    });
    expect(ok.preferredChild).toBe('Water');
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

  it('normalises instruction: null to undefined (Sonnet emits null on concat mode)', () => {
    const parsed = aggregationSpecSchema.parse({ mode: 'concat', instruction: null });
    expect(parsed.instruction).toBeUndefined();
    expect(parsed.mode).toBe('concat');
  });

  it('accepts a full planSchema with aggregation.instruction: null without throwing', () => {
    // This is the exact shape observed in production crashing the Leukocyte
    // L2 replan on the Node/REST run — Sonnet emitted {mode: "concat",
    // instruction: null} and zod rejected it before the schema tolerated
    // null.
    const plan = {
      reasoning: 'decompose',
      subtasks: [{ description: 'x' }],
      aggregation: { mode: 'concat', instruction: null },
      expectedOutput: 'done',
    };
    const parsed = aggregationSpecSchema.safeParse(plan.aggregation);
    expect(parsed.success).toBe(true);
  });
});

describe('planSchema — fan-out native shape', () => {
  it('accepts a multi-subtask plan with aggregation', () => {
    const plan = planSchema.parse({
      reasoning: 'decompose',
      subtasks: [
        { description: 'write layout', preferredChild: 'Water' },
        { description: 'write logic', preferredChild: 'Methane' },
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

describe('planSchema — single-action coercion', () => {
  it('coerces a single-action `{reasoning, proposedAction, expectedOutput}` into 1-subtask fan-out', () => {
    const plan = planSchema.parse({
      reasoning: 'r',
      proposedAction: 'write a file',
      expectedOutput: 'done',
    });
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]!.description).toBe('write a file');
    expect(plan.aggregation).toEqual({ mode: 'concat' });
    // The single-action fields are preserved for visibility.
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
        { description: 'A', preferredChild: 'Water' },
        { description: 'B', preferredChild: 'Methane' },
      ],
      aggregation: { mode: 'concat' },
      expectedOutput: 'done',
    });
    const plan = parsePlanTolerant(text);
    expect(plan.subtasks.map((s) => s.description)).toEqual(['A', 'B']);
  });
});

/**
 * MEASURED 2026-08-23, project run `d771d166` (expenses-node-api): the L3's
 * second-phase plan said `"preferredChild": null` — the model's spelling of
 * "omit", which the verdict guidance itself recommends when no catalog name
 * fits — and the direct `planSchema.parse` at L3Atom killed the run: $0.51 and
 * 22 tool calls of delivered server work discarded on a nullable-vs-optional
 * mismatch. The null-tolerance pattern was already DOCUMENTED twice in the
 * same schema object (`outputs`, `proofObligations`); these tests extend it to
 * the two fields it missed. The fixture below is the run's own subtask,
 * trimmed.
 */
describe('subtaskSpecSchema — null-tolerance on the fields the pattern missed', () => {
  const runD771Subtask = {
    description:
      'Validate index.html and app.js against the running server; iterate until zero console.error.',
    preferredChild: null,
    outputs: ['index.html', 'app.js'],
    proofObligations: ['dom-interaction'],
  };

  it('parses the exact shape that killed run d771d166, through the same entry point', () => {
    const plan = planSchema.parse({
      reasoning: 'phase 2',
      subtasks: [runD771Subtask],
      aggregation: { mode: 'concat' },
    });
    expect(plan.subtasks[0]!.preferredChild).toBeUndefined();
  });

  it('normalises null and blank to the documented meaning: omitted', () => {
    expect(subtaskSpecSchema.parse({ description: 'x', preferredChild: null }).preferredChild)
      .toBeUndefined();
    expect(subtaskSpecSchema.parse({ description: 'x', preferredChild: '  ' }).preferredChild)
      .toBeUndefined();
    expect(subtaskSpecSchema.parse({ description: 'x', inputs: null }).inputs).toBeUndefined();
  });

  it('keeps a real routing hint byte-identical', () => {
    expect(
      subtaskSpecSchema.parse({ description: 'x', preferredChild: 'Chlorophyll' }).preferredChild
    ).toBe('Chlorophyll');
    expect(
      subtaskSpecSchema.parse({ description: 'x', inputs: { port: 8000 } }).inputs
    ).toEqual({ port: 8000 });
  });
});
