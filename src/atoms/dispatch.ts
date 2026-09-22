import { outOfPhaseBudget } from '../core/limits.js';
import type { Plan, Result, RunContext } from '../core/types.js';

type Subtask = Plan['subtasks'][number];

/**
 * What a dispatch produced, and what it did not.
 *
 * `unfinished` is non-empty only when the RUN DEADLINE landed the dispatch:
 * the results are real, accepted work, and the named subtasks never produced
 * one. It exists because the alternative — returning a short array — is
 * indistinguishable from a complete dispatch of fewer phases, and the caller
 * would aggregate it into something that looks exactly like a delivery. A
 * landed dispatch must be able to say so; see `Result.unfinishedPhases`.
 */
export interface DispatchOutcome {
  readonly results: Result[];
  readonly unfinished: readonly Subtask[];
}

/**
 * SHARED DISPATCH SHAPE (structural: L2/L3 mirror helper).
 * ========================================================
 * The aggregation.mode → dispatch mapping was duplicated verbatim in
 * L2Atom and L3Atom (the files even said "mirror of" each other):
 *   - sequential  → one at a time, threading the previous step's summary
 *                   AND its declared `outputs` into the next subtask's
 *                   inputs (narrative + structured paths; the sandbox
 *                   filesystem still carries the bytes implicitly);
 *   - concat / llm-synthesize → parallel allSettled (orthogonal fan-out).
 * ONE implementation, parameterised by the per-subtask runner — the only
 * thing that genuinely differs between the tiers. Alias-map clearing and
 * child resolution stay with the callers: resolution runs in the
 * synchronous prefix of each runner, which is what keeps the parallel
 * branch race-free.
 *
 * LANDING ON THE RUN DEADLINE. Reaching the deadline used to discard every
 * completed phase: `out` lived on the stack and left with it. Measured twice
 * on production runs of 2026-09-21 (`cc894dad`, `d3098d25` —
 * docs/incidents/progressive-runs-2026-09-21.md), where three of four phases
 * were finished, validated and CREDITED before the fourth was aborted
 * mid-flight; 2.83 USD and 3.50 USD bought nothing, and a run that completed
 * three phases delivered exactly as much as one that completed none. Both
 * branches now land instead, by the two routes the deadline actually arrives
 * by:
 *   - sequential: refuse to OPEN a phase the remaining wall clock cannot pay
 *     for (`outOfPhaseBudget`), and keep the earlier phases when a phase that
 *     was opened is aborted mid-flight;
 *   - parallel: keep the branches that settled when the deadline cut their
 *     siblings.
 * A dispatch that completed NO phase never lands — it throws, as before. There
 * is nothing to deliver, and a landing that reported zero phases would be a
 * failure wearing a softer word.
 *
 * `ctx.signal` is the run's deadline signal and nothing else: operator
 * cancellation reaches a run as process teardown, not as an abort on this
 * signal (`runTask`). So `signal.aborted` unambiguously means "the deadline
 * fired", which is what makes the distinction below safe to draw.
 */
export async function dispatchWithAggregation(
  subtasks: readonly Subtask[],
  plan: Plan,
  ctx: RunContext,
  runOne: (subtask: Subtask, idx: number) => Promise<Result>
): Promise<DispatchOutcome> {
  if (plan.aggregation.mode === 'sequential') {
    const out: Result[] = [];
    let previousSummary: string | undefined;
    let previousOutputs: readonly string[] | undefined;
    for (let idx = 0; idx < subtasks.length; idx++) {
      // The floor is checked BEFORE the phase is built, and never on a
      // dispatch that has produced nothing yet: a run with no accepted phase
      // has nothing to land on, so it spends what it has left trying.
      if (out.length > 0 && outOfPhaseBudget(ctx.deadlineAt)) {
        ctx.logger.warn(
          `[dispatch] landing on ${out.length}/${subtasks.length} phase(s): too little run budget left to open the next one`
        );
        return { results: out, unfinished: subtasks.slice(idx) };
      }
      const baseSubtask = subtasks[idx]!;
      const subtask =
        previousSummary !== undefined
          ? {
              ...baseSubtask,
              inputs: {
                ...(baseSubtask.inputs ?? {}),
                previousStepSummary: previousSummary,
                previousStepIndex: idx - 1,
                ...(previousOutputs && previousOutputs.length > 0
                  ? { previousStepOutputs: previousOutputs }
                  : {}),
              },
            }
          : baseSubtask;
      let r: Result;
      try {
        r = await runOne(subtask, idx);
      } catch (err) {
        // The deadline landing INSIDE a phase — the exact shape of both
        // 2026-09-21 runs. Everything already accepted still lands; anything
        // else rethrows unchanged, including a deadline that arrived before
        // the first phase closed.
        if (out.length > 0 && ctx.signal.aborted) {
          ctx.logger.warn(
            `[dispatch] landing on ${out.length}/${subtasks.length} phase(s): the run deadline aborted phase #${idx + 1}`
          );
          return { results: out, unfinished: subtasks.slice(idx) };
        }
        throw err;
      }
      out.push(r);
      previousSummary = r.summary;
      // Declared writes of THIS phase become the next phase's structured
      // handover. Do not merge them into the next subtask's `outputs`:
      // that field is what THIS phase creates, and skill/promotion gates
      // must keep reading the current phase only.
      previousOutputs = baseSubtask.outputs;
    }
    return { results: out, unfinished: [] };
  }
  const pending = subtasks.map((subtask, idx) => runOne(subtask, idx));
  // `allSettled` unconditionally, where it used to be reserved for depth
  // transitions (which archive the workspace and so need every sibling
  // settled first). Partial landing needs the same guarantee for the same
  // reason — you cannot keep the branches that succeeded without waiting to
  // learn which those are — and a fail-fast `Promise.all` left its siblings
  // running unobserved anyway. The cost is that a genuine error surfaces once
  // its siblings have settled rather than immediately.
  const settled = await Promise.allSettled(pending);
  const fulfilled: Result[] = [];
  const unfinished: Subtask[] = [];
  let failure: unknown;
  let failed = false;
  for (let idx = 0; idx < settled.length; idx++) {
    const item = settled[idx]!;
    if (item.status === 'fulfilled') {
      fulfilled.push(item.value);
      continue;
    }
    unfinished.push(subtasks[idx]!);
    if (!failed) {
      failed = true;
      failure = item.reason;
    }
  }
  if (!failed) return { results: fulfilled, unfinished: [] };
  // A rejection that is NOT the deadline is a real failure and keeps its
  // original meaning, whatever else settled. Only the deadline lands.
  if (!ctx.signal.aborted || fulfilled.length === 0) throw failure;
  ctx.logger.warn(
    `[dispatch] landing on ${fulfilled.length}/${subtasks.length} branch(es): the run deadline cut the rest`
  );
  return { results: fulfilled, unfinished };
}

/**
 * Stamp a landed dispatch's aggregate so no reader downstream can mistake it
 * for a complete one. Phases that never ran are named, and the summary says
 * INCOMPLETE in its first word — the validators, the trace and the operator
 * all read that string, and the previous behaviour's whole defect was that
 * nothing distinguished "three phases of four" from "four of four".
 *
 * A complete dispatch passes through untouched, so call sites need no branch.
 */
export function markLanded(result: Result, unfinished: readonly Subtask[]): Result {
  if (unfinished.length === 0) return result;
  const phases = unfinished.map((subtask) => subtask.description);
  return {
    ...result,
    summary:
      `INCOMPLETE — the run deadline landed this plan with ${phases.length} phase(s) never run: ` +
      `${phases.join(' | ')}. Delivered so far: ${result.summary}`,
    // Union with what came from below: an L2 that landed inside one L3 phase
    // makes the whole run partial, and its unfinished phases must survive the
    // aggregate that wraps it.
    unfinishedPhases: [...(result.unfinishedPhases ?? []), ...phases],
  };
}
