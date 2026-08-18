import type { Limits } from './types.js';

/**
 * Default supervise-loop budgets.
 *
 * `maxPlanIterations` dropped from 5 → 3 after post-mortem of a dashboard
 * build run: the validator rejected five plans in a row on drifting
 * "VISIBLE-DELIVERABLES" complaints, none of which pointed at a concrete
 * task-stated missing element. Five rounds burned ~4 min of L1 Haiku time
 * with zero progress before escalation. Three rounds is still enough slack
 * for a genuine "fix this one issue" loop, but caps run-away nitpicking.
 *
 * `maxExecIterations` is 5 but is CURRENTLY UNREACHABLE — read this before
 * tuning it. `superviseLoop` has a single loop body: a RESULT rejection falls
 * out of it and re-enters at `plan()`, which increments `planIter`. So the
 * invariant is `execIter <= planIter <= maxPlanIterations`, and the exec guard
 * can only ever fire if `maxExecIterations < maxPlanIterations`. The effective
 * budget for result retries is therefore 3, not 5.
 *
 * Two consequences worth knowing:
 *   - Escalations caused by repeated RESULT rejections are raised as
 *     `EscalationSignal('plan')`, so post-mortems mislabel their phase.
 *   - The previous version of this comment claimed "each retry makes real
 *     progress, so the longer leash is justified". Both halves were wrong: the
 *     leash was never granted, and on run 2026-07-25T22-10-42 the retries
 *     DEGRADED the artefact (README 1059 → 933 → 1731 bytes, one probe's
 *     evidence lost in the middle cycle). The accidental ceiling of 3 is
 *     benign — do NOT raise `maxPlanIterations` to "unlock" the 5.
 *
 * Making the exec budget real means restructuring the loop to re-execute
 * without re-planning. That is NOT a free change: `L2Atom.execute` /
 * `L3Atom.execute` consume-and-null `pendingStrategy` and silently fall back
 * to `selfExecute` when it is missing, which would collapse the tier (Opus
 * with a tool loop) while stamping `viaFallback: false`. See the F8 notes in
 * the engineering record linked from AGENTS.md before attempting it.
 */
export const DEFAULT_LIMITS: Limits = {
  maxPlanIterations: 3,
  maxExecIterations: 5,
};

/**
 * Conservative floor for one tool-loop iteration on the CLI transport that
 * exposed the mismatch (`docs/incidents/parallel-fanin-2026-08-16.md`):
 * ~26 s. Used only to CAP an already-declared iteration budget against the
 * run deadline — never as a new reject gate.
 */
export const MIN_TOOL_ITERATION_MS = 26_000;

/**
 * Shrink a tool-loop iteration cap so it cannot out-plan the remaining
 * run wall clock. Absent or invalid `deadlineAt` leaves `requested`
 * unchanged. A deadline already in the past still returns 1 so the
 * client can finalize instead of skipping `complete()` entirely; the
 * abort signal is what actually stops the call.
 */
export function capToolIterations(
  requested: number,
  deadlineAt?: number,
  now = Date.now()
): number {
  const want = Math.max(1, Math.floor(requested));
  if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return want;
  const remaining = deadlineAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 1;
  return Math.max(1, Math.min(want, Math.floor(remaining / MIN_TOOL_ITERATION_MS)));
}
