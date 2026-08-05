import type { Plan, Result, RunContext } from '../core/types.js';

type Subtask = Plan['subtasks'][number];

/**
 * SHARED DISPATCH SHAPE (structural: L2/L3 mirror helper).
 * ========================================================
 * The aggregation.mode → dispatch mapping was duplicated verbatim in
 * L2Atom and L3Atom (the files even said "mirror of" each other):
 *   - sequential  → one at a time, threading the previous step's summary
 *                   into the next subtask's inputs (narrative state; the
 *                   sandbox filesystem carries the bytes implicitly);
 *   - concat / llm-synthesize → parallel Promise.all (orthogonal fan-out).
 * ONE implementation, parameterised by the per-subtask runner — the only
 * thing that genuinely differs between the tiers. Alias-map clearing and
 * child resolution stay with the callers: resolution runs in the
 * synchronous prefix of each runner, which is what keeps the parallel
 * branch race-free.
 */
export async function dispatchWithAggregation(
  subtasks: readonly Subtask[],
  plan: Plan,
  ctx: RunContext,
  runOne: (subtask: Subtask, idx: number) => Promise<Result>
): Promise<Result[]> {
  void ctx;
  if (plan.aggregation.mode === 'sequential') {
    const out: Result[] = [];
    let previousSummary: string | undefined;
    for (let idx = 0; idx < subtasks.length; idx++) {
      const baseSubtask = subtasks[idx]!;
      const subtask =
        previousSummary !== undefined
          ? {
              ...baseSubtask,
              inputs: {
                ...(baseSubtask.inputs ?? {}),
                previousStepSummary: previousSummary,
                previousStepIndex: idx - 1,
              },
            }
          : baseSubtask;
      const r = await runOne(subtask, idx);
      out.push(r);
      previousSummary = r.summary;
    }
    return out;
  }
  return Promise.all(subtasks.map((subtask, idx) => runOne(subtask, idx)));
}
