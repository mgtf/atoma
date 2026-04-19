import { EscalationSignal } from './errors.js';
import type { Atom, Supervisor } from './atom.js';
import type {
  NegativeVerdict,
  Result,
  RunContext,
  Task,
  TraceEntry,
} from './types.js';

export interface SupervisionHooks<C extends Atom> {
  /**
   * Apply a negative verdict's modifications honoring its scope.
   * - 'ephemeral' — mutate the current instance, return same instance
   * - 'patch'     — update the canonical type in the registry, return fresh instance of patched type
   * - 'branch'    — create a new type, return instance of the new type
   */
  applyByScope(child: C, verdict: NegativeVerdict): Promise<C>;

  /**
   * Called once when the supervision loop escalates. Implementations typically
   * synthesize lessons from the trace and create a branched type in the registry.
   */
  branchOnEscalation(child: C, trace: readonly TraceEntry[], reason: string): Promise<void>;

  /**
   * Optional: invoked exactly once when the loop exits with an approved result.
   * Use it to bump the child type's success counter in the registry so that
   * trusted types can short-circuit future validator calls.
   */
  onApproved?(child: C, result: Result): Promise<void>;

  /**
   * Optional: invoked exactly once at the moment the loop decides to escalate,
   * BEFORE `branchOnEscalation` fires. Use it to bump the child type's failure
   * counter so trust is revoked.
   */
  onFailed?(child: C, reason: string): Promise<void>;
}

const now = (): string => new Date().toISOString();

/**
 * How many consecutive rejections with the SAME normalized reasoning we
 * tolerate before short-circuiting to escalation. Rationale: if the validator
 * keeps emitting the identical gripe and the child keeps regenerating
 * structurally similar output, no new information is being produced —
 * continuing just burns budget. Empirically three strikes is a good balance
 * between resilience to transient LLM wiggle and wasted spend: earlier runs
 * saw five consecutive identical rejects eating ~$0.05-0.10 and ~20s.
 */
export const MAX_SAME_REASON_REJECTS = 3;

/**
 * Normalize a verdict's reasoning for repeat-detection comparisons:
 * lowercase, strip punctuation, collapse whitespace. Exported so tests and
 * tooling can assert the normalization the supervisor actually applies.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Small bounded tracker: holds the last `window` normalized reasoning keys
 * and reports when the most recent entry has been repeated `window` times in
 * a row. Used to detect "the validator is stuck on the same complaint".
 */
function makeRepeatTracker(window: number): {
  push: (reasoning: string) => { repeated: boolean; streakKey: string | null };
  reset: () => void;
} {
  const buf: string[] = [];
  return {
    push(reasoning: string): { repeated: boolean; streakKey: string | null } {
      const key = normalizeReason(reasoning);
      buf.push(key);
      if (buf.length > window) buf.shift();
      if (buf.length === window && buf.every((k) => k === key && k.length > 0)) {
        return { repeated: true, streakKey: key };
      }
      return { repeated: false, streakKey: null };
    },
    reset(): void {
      buf.length = 0;
    },
  };
}

export async function superviseLoop<C extends Atom>(
  parent: Atom & Supervisor<C>,
  child: C,
  task: Task,
  ctx: RunContext,
  hooks: SupervisionHooks<C>
): Promise<Result> {
  const trace: TraceEntry[] = [];
  let planIter = 0;
  let execIter = 0;
  let current: C = child;
  // Separate trackers for plan-rejects and result-rejects: "same gripe three
  // times in a row on the plan" and "same gripe three times in a row on the
  // result" are independent stuck-conditions and should each escalate.
  const planRepeat = makeRepeatTracker(MAX_SAME_REASON_REJECTS);
  const resultRepeat = makeRepeatTracker(MAX_SAME_REASON_REJECTS);

  try {
    while (true) {
      if (planIter >= ctx.limits.maxPlanIterations) {
        throw new EscalationSignal('plan');
      }
      planIter++;

      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');

      const plan = await current.plan(task, ctx);
      trace.push({ kind: 'plan', ts: now(), atom: current.name, payload: plan });

      const v1 = await parent.validatePlan(current, plan, task, ctx);
      trace.push({ kind: 'verdict-plan', ts: now(), atom: parent.name, payload: v1 });

      if (!v1.approved) {
        const hit = planRepeat.push(v1.reasoning ?? '');
        if (hit.repeated) {
          trace.push({
            kind: 'repeat-rejection',
            ts: now(),
            atom: parent.name,
            payload: {
              phase: 'plan',
              streakKey: hit.streakKey,
              window: MAX_SAME_REASON_REJECTS,
            },
          });
          throw new EscalationSignal('repeat');
        }
        current = await hooks.applyByScope(current, v1);
        trace.push({
          kind: 'applied-modifications',
          ts: now(),
          atom: current.name,
          payload: { phase: 'plan', scope: v1.scope },
        });
        continue;
      }
      // Plan approved → reset the plan streak; a fresh rejection cycle
      // should not inherit old identical-reasoning history.
      planRepeat.reset();

      if (execIter >= ctx.limits.maxExecIterations) {
        throw new EscalationSignal('exec');
      }
      execIter++;

      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');

      const result = await current.execute(task, plan, ctx);
      trace.push({ kind: 'execute', ts: now(), atom: current.name, payload: result });

      const v2 = await parent.validateResult(current, result, task, ctx);
      trace.push({ kind: 'verdict-result', ts: now(), atom: parent.name, payload: v2 });

      if (v2.approved) {
        if (hooks.onApproved) await hooks.onApproved(current, result);
        return { ...result, trace };
      }

      const hit = resultRepeat.push(v2.reasoning ?? '');
      if (hit.repeated) {
        trace.push({
          kind: 'repeat-rejection',
          ts: now(),
          atom: parent.name,
          payload: {
            phase: 'result',
            streakKey: hit.streakKey,
            window: MAX_SAME_REASON_REJECTS,
          },
        });
        throw new EscalationSignal('repeat');
      }

      current = await hooks.applyByScope(current, v2);
      trace.push({
        kind: 'applied-modifications',
        ts: now(),
        atom: current.name,
        payload: { phase: 'result', scope: v2.scope },
      });
    }
  } catch (e) {
    if (!(e instanceof EscalationSignal)) throw e;

    trace.push({
      kind: 'escalated',
      ts: now(),
      atom: parent.name,
      payload: { phase: e.phase, failingChild: current.name },
    });

    if (hooks.onFailed) await hooks.onFailed(current, `escalation-${e.phase}`);
    await hooks.branchOnEscalation(current, trace, `escalation-${e.phase}`);

    parent.injectContext(renderTraceForContext(trace, current.name));
    parent.setFallbackMode(true);
    try {
      const plan = await parent.plan(task, ctx);
      trace.push({ kind: 'plan', ts: now(), atom: parent.name, payload: plan });

      const result = await parent.execute(task, plan, ctx);
      trace.push({ kind: 'execute', ts: now(), atom: parent.name, payload: result });

      return {
        ...result,
        trace,
        producedBy: { ...result.producedBy, viaFallback: true },
      };
    } finally {
      parent.setFallbackMode(false);
    }
  }
}

export function renderTraceForContext(trace: readonly TraceEntry[], failedChild: string): string {
  const lines: string[] = [
    `The atom "${failedChild}" could not satisfy the supervision protocol after repeated iterations.`,
    `Here is the trace of what was attempted:`,
  ];
  for (const e of trace) {
    lines.push(`- [${e.ts}] ${e.atom} ${e.kind}: ${safeJson(e.payload)}`);
  }
  lines.push(
    `You are now taking over the task directly. Use the lessons above to avoid the same pitfalls.`
  );
  return lines.join('\n');
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}
