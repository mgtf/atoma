import path from 'node:path';
import type { Plan, RunContext, Task } from '../core/types.js';

/**
 * L3 root-plan check: declared-output collision on a PARALLEL plan.
 *
 * Why this is not a `validatePlan` call. `superviseLoop` validates the
 * CHILD's plan. The L3 root has no parent (`L3Atom.handle` is plan →
 * execute), so the FAN-OUT artefact-collision rule in `verdict.ts` never
 * sees this plan. Coercing `concat` → `sequential` is also forbidden:
 * an explicit concat is honoured (`L3Atom` routeCrossBucket comment;
 * `l3-truncated-plan-aggregation`). The remaining actor who can fix the
 * plan is Opus itself.
 *
 * Disposition: reject-once-then-honour. The first collision coaches one
 * replan (constraints, same task description). Whatever comes back is
 * executed — a second look would be a validator we do not have, or an
 * unbounded loop. Memoised on `ctx.mechanicalPlanRejections` under a
 * single class key so a repeat cannot spend another strategy call. The
 * replan is FAIL-OPEN: if it throws, the original plan runs, because a
 * race that still delivers beats a run that never starts.
 *
 * Channel: DECLARED `outputs` only. The lexical grammar is a fallback
 * for skill/dispatch gates, not a trigger here — a planner that omitted
 * the field has no collision to detect. The prompt makes `outputs`
 * mandatory on mutating phases so the channel exists.
 */

export const L3_PARALLEL_OUTPUT_COLLISION_KEY = 'l3-parallel-declared-outputs';

export interface ParallelOutputCollision {
  readonly mode: 'concat' | 'llm-synthesize';
  readonly paths: readonly string[];
}

export function normalizeDeclaredOutput(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return null;
  const normalized = path.posix.normalize(trimmed.replace(/^\.\//, ''));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

export function parallelDeclaredOutputCollision(plan: Plan): ParallelOutputCollision | null {
  const mode = plan.aggregation.mode;
  if (mode !== 'concat' && mode !== 'llm-synthesize') return null;
  if (plan.subtasks.length < 2) return null;
  const owners = new Map<string, Set<number>>();
  plan.subtasks.forEach((subtask, idx) => {
    for (const raw of subtask.outputs ?? []) {
      const declared = normalizeDeclaredOutput(raw);
      if (!declared) continue;
      const seen = owners.get(declared) ?? new Set<number>();
      seen.add(idx);
      owners.set(declared, seen);
    }
  });
  const paths = [...owners.entries()]
    .filter(([, idxs]) => idxs.size > 1)
    .map(([p]) => p)
    .sort();
  if (paths.length === 0) return null;
  return { mode, paths };
}

export function l3ParallelOutputCoaching(hit: ParallelOutputCollision): string {
  return (
    `MECHANICAL: your previous plan used parallel aggregation "${hit.mode}" ` +
    `but two or more phases declared the same output path(s): ${hit.paths.join(', ')}. ` +
    `Parallel lanes share one workspace and will race. Give each orthogonal ` +
    `phase DISTINCT outputs, or set aggregation.mode to "sequential" so phases ` +
    `share an evolving artefact. Do not silently drop the outputs field — ` +
    `a mutating phase must declare the files it writes.`
  );
}

export async function acceptL3RootPlan(args: {
  readonly plan: Plan;
  readonly task: Task;
  readonly ctx: RunContext;
  readonly replan: (task: Task) => Promise<Plan>;
}): Promise<Plan> {
  const hit = parallelDeclaredOutputCollision(args.plan);
  if (!hit) return args.plan;
  const memo = (args.ctx.mechanicalPlanRejections ??= new Set());
  if (memo.has(L3_PARALLEL_OUTPUT_COLLISION_KEY)) {
    args.ctx.logger.warn(
      `[l3] honouring parallel ${hit.mode} plan after one coached replan; ` +
        `declared outputs still collide: ${hit.paths.join(', ')}`
    );
    return args.plan;
  }
  memo.add(L3_PARALLEL_OUTPUT_COLLISION_KEY);
  args.ctx.logger.warn(
    `[l3] parallel ${hit.mode} plan collides on ${hit.paths.join(', ')} — one coached replan`
  );
  const coached: Task = {
    ...args.task,
    constraints: [...(args.task.constraints ?? []), l3ParallelOutputCoaching(hit)],
  };
  // FAIL-OPEN. The plan in hand is already executable — racy, but it
  // delivers. A replan that throws (transport error, unparsable pair, or the
  // watchdog abort firing on `ctx.signal` near the deadline, where an
  // unguarded top-tier strategy call is likeliest to be cut) must not turn
  // "delivers with a race" into "no run at all" — strictly worse than the
  // defect being coached. The memo is already set, so the honour-the-repeat
  // path stays coherent whichever branch we leave by.
  try {
    return await args.replan(coached);
  } catch (err) {
    args.ctx.logger.warn(
      `[l3] coached replan failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `executing the original parallel ${hit.mode} plan; declared outputs collide: ` +
        hit.paths.join(', ')
    );
    return args.plan;
  }
}
