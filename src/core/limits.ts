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
 * `maxExecIterations` stays at 5 — result-rejection cycles usually carry
 * real ground-truth evidence (console errors, failed requests) and each
 * retry makes real progress, so the longer leash is justified.
 */
export const DEFAULT_LIMITS: Limits = {
  maxPlanIterations: 3,
  maxExecIterations: 5,
};
