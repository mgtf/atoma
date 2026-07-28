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
 * CLAUDE.md before attempting it.
 */
export const DEFAULT_LIMITS: Limits = {
  maxPlanIterations: 3,
  maxExecIterations: 5,
};
