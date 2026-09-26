import type { Atom } from '../core/atom.js';
import { setMaxListeners } from 'node:events';
import type { Result, RunContext, Task, ToolExecutor } from '../core/types.js';
import { attestingExecutor, createAttestationLog } from '../core/attestation.js';
import { abortedByDeadline, finalizationSignal, landingSignal, withinSignal } from '../atoms/cost.js';
import { acceptRootResult } from '../atoms/rootAcceptance.js';
import { outOfPhaseBudget } from '../core/limits.js';
import type { AcceptanceInfo, DepthMode, PhaseCoverageRecord, ProofFloor, TopologyInfo } from '../contracts/depthRouting.js';
import { checklistPlanningLines, type AcceptanceChecklist, type ChecklistSource } from '../contracts/acceptanceChecklist.js';

export class DeepeningSignal extends Error {
  constructor() { super('Entry cell exhausted supervision; deepen once.'); this.name = 'DeepeningSignal'; }
}
/**
 * Stamp a refused result so no reader downstream can mistake it for a
 * delivery — the same job `markLanded` does for a deadline landing, and
 * deliberately the same shape.
 *
 * The summary is prefixed because three readers explain a run to a person from
 * prose alone, and one typed field they do not read would leave them saying
 * the run delivered. The two reasons COMPOSE: a result that already landed on
 * its budget keeps its `INCOMPLETE —` prefix and its phase list, and gains
 * this one, because a reader that reports only the phases drops the refusal.
 */
export function markRefused(result: Result, acceptance: Pick<AcceptanceInfo, 'reasoning'>): Result {
  const reasoning = acceptance.reasoning.trim() || 'the root acceptor gave no reason';
  return {
    ...result,
    summary: `REFUSED AT DELIVERY — the run completed its plan and the root acceptor did not accept it: ${reasoning}. Reported so far: ${result.summary}`,
    refusal: reasoning,
  };
}

/**
 * How many times one attempt may be handed its refusal and sent back.
 *
 * ONE. The refusal names what went unverified, so the second pass is aimed;
 * a third would be the same conversation with no new information, and every
 * pass is a full supervise loop against the tenant's wall clock. Measured
 * 2026-09-23: the same goal refused twice named FEWER gaps the second time
 * once the plan was told to verify, so the loop converges — which is the
 * argument for one more pass and equally the argument against many.
 */
export const MAX_ROOT_REMEDIATIONS = 1;

/**
 * The refused task, restated with the acceptor's own reasons attached.
 *
 * The reasons ride in `inputs`, never appended to `description`: the
 * description is what the plan and the skill matcher key on, and rewriting it
 * would make a remediated run look like a different task to everything
 * downstream. It is the same shape sequential dispatch already uses to thread
 * a previous step's summary into the next one.
 *
 * ROOT ACCEPTANCE PROSE IS MODEL-AUTHORED. It reaches a planner as data about
 * this run, exactly as a validator's rejection already does, and nothing here
 * executes it.
 */
export function remediationTask(task: Task, acceptance: AcceptanceInfo): Task {
  return {
    ...task,
    inputs: {
      ...(task.inputs ?? {}),
      rootAcceptanceRefusal: acceptance.reasoning,
      rootAcceptanceAttempt: (Number(task.inputs?.['rootAcceptanceAttempt'] ?? 0) || 0) + 1,
    },
  };
}

/**
 * The root task with the run's acceptance checklist in its `inputs` — the
 * channel `rootAcceptanceRefusal` uses, never the description, which planning
 * and skill matching key on. The note says what the list is for, because
 * planners receive `inputs` as raw JSON with no other guidance.
 */
export function withAcceptanceChecklist(task: Task, checklist: AcceptanceChecklist, source: ChecklistSource = 'drafted'): Task {
  if (checklist.length === 0) return task;
  return {
    ...task,
    inputs: {
      ...(task.inputs ?? {}),
      acceptanceChecklist: {
        note: source === 'user'
          ? 'Approved by the user before launch: the root acceptor will judge the delivery against each criterion. ' +
            'Plan work that satisfies every one and exercises every HTTP item with fetch_url against the server ' +
            'this run starts.'
          : 'Drafted from the goal: the root acceptor will look for evidence of each behaviour. Plan work that ' +
            'exercises every HTTP item with fetch_url against the server this run starts; it adds no requirement ' +
            'the goal did not state.',
        items: checklistPlanningLines(checklist),
      },
    },
  };
}

/** The existing atom protocol executes each attempt; this owns only their lifetime. */
export async function runDepthTask(args: {
  mode: DepthMode; task: Task; ctx: RunContext; floor: ProofFloor;
  createExecutor: (mode: DepthMode) => { actor: Atom; handle: (task: Task, ctx: RunContext) => Promise<Result> };
  restart: () => Promise<ToolExecutor>;
  onTopology: (info: TopologyInfo) => void;
  onAcceptance: (info: AcceptanceInfo) => void;
  /** Drafted once by the caller, before the attempt loop; a deepening keeps it. */
  checklist?: AcceptanceChecklist;
  /**
   * Set when `checklist` is the USER's approved list. It is held HERE, by the
   * host, and handed to every root acceptance: never re-read from
   * `task.inputs`, which the planners see and remediation re-spreads.
   */
  checklistOrigin?: { readonly source: ChecklistSource; readonly digest?: string };
}): Promise<Result> {
  const { ctx } = args;
  const task = withAcceptanceChecklist(args.task, args.checklist ?? [], args.checklistOrigin?.source);
  const attestations = (ctx.attestations ??= createAttestationLog());
  const phaseCoverage: PhaseCoverageRecord[] = [];
  let tools = ctx.tools;
  // BOUNDED PER RUN, not per attempt. A deepening is already this run's second
  // chance at a structural failure; a remediation is its second chance at an
  // unfinished verification. Counting them separately would let one run spend
  // four full supervise loops against the tenant's wall clock, so the budget
  // is one extra pass for the whole run, wherever it falls.
  let remediations = 0;
  for (const attempt of [1, 2]) {
    ctx.signal.throwIfAborted();
    const mode = attempt === 1 ? args.mode : 'deep';
    args.onTopology({ at: attempt === 1 ? 'entry' : 'deepening', mode,
      reason: attempt === 1 ? 'arm' : 'fallback-moment', attempt });
    const { actor, handle } = args.createExecutor(mode);
    const cancellation = new AbortController();
    const attemptSignal = AbortSignal.any([ctx.signal, cancellation.signal]);
    setMaxListeners(0, attemptSignal);
    const deepen = new DeepeningSignal();
    let requested = false;
    const attemptCtx: RunContext = {
      ...ctx, attempt, attestations,
      signal: attemptSignal,
      // A fresh workspace gets fresh coaching; forks within this attempt
      // share these same sets through supervisor replans and branch retries.
      mechanicalPlanRejections: new Set(), mechanicalResultRejections: new Set(),
      dispatchedScriptSignatures: new Map(),
      ...(tools ? { tools: attestingExecutor(tools, attestations, undefined,
        (message) => ctx.logger.warn(message), attempt)! } : {}),
      recordPhaseCoverage: (record) => { phaseCoverage.push(record); ctx.recordPhaseCoverage?.(record); },
      beforeFallback: (parent) => {
        // A mutualized peer is still the entry supervisor in the short
        // topology. Its fallback must deepen just like the selected cell's.
        if (mode === 'short' && parent.tier === 2) {
          requested = true;
          cancellation.abort(deepen);
          throw deepen;
        }
      },
    };
    try {
      // REMEDIATION LIVES INSIDE THE ATTEMPT, and that is the whole design.
      // The workspace is not archived and `attempt` does not move, so the
      // attestations the first pass earned still cover their deliverables —
      // `rootProofCoverage` re-reads each file and compares its digest, so a
      // proof survives exactly as long as the bytes it was made against. A new
      // attempt, as deepening uses, would discard all of it, which is right
      // when the workspace is replaced and wrong when it is being completed.
      let currentTask = task;
      // The last REFUSED pass. A remediation the deadline cuts before it accepts
      // a phase lands on it instead of taking it down (2026-09-25 review, 1.2b):
      // the dispatch of a pass that accepted nothing throws, and until
      // 2026-09-26 that discarded a complete first result as `failed`.
      let refused: { readonly result: Result; readonly acceptance: AcceptanceInfo } | null = null;
      for (;;) {
        let result: Result;
        try {
          result = await handle(currentTask, attemptCtx);
        } catch (error) {
          if (refused && !cancellation.signal.aborted && abortedByDeadline(ctx.signal)) {
            const reasoning = refused.acceptance.reasoning.trim() || 'the root acceptor gave no reason';
            return markRefused(refused.result, {
              reasoning: `${reasoning} — the remediation pass was cut by the run deadline before it completed a phase`,
            });
          }
          throw error;
        }
        // WORK IN HAND leaves the execution clock for the finalization window,
        // landed or complete (2026-09-25 review, 1.2a): a complete result whose
        // root acceptance straddled the deadline used to be thrown away while a
        // landed one was kept. Deepening and explicit cancellation still abort.
        cancellation.signal.throwIfAborted();
        const landed = Boolean(result.unfinishedPhases?.length);
        if (!abortedByDeadline(ctx.signal)) attemptCtx.signal.throwIfAborted();
        const explicitCancellation = new AbortController();
        const forwardCancellation = () => {
          if (!abortedByDeadline(ctx.signal)) explicitCancellation.abort(ctx.signal.reason);
        };
        ctx.signal.addEventListener('abort', forwardCancellation, { once: true });
        // Deadline + grace, absolute. Without a run deadline a landed result keeps
        // the post-approval cap and a complete one only its cancellations.
        const bound = finalizationSignal(ctx.deadlineAt) ?? (landed ? landingSignal() : undefined);
        const acceptanceCtx: RunContext = { ...attemptCtx,
          signal: AbortSignal.any([...(bound ? [bound] : []), cancellation.signal, explicitCancellation.signal]),
        };
        let acceptance: AcceptanceInfo;
        try {
          acceptance = await withinSignal(acceptRootResult({ actor, task: currentTask, result, ctx: acceptanceCtx,
            floor: args.floor, phaseCoverage, ...(args.checklist ? { checklist: args.checklist } : {}),
            ...(args.checklistOrigin ? { checklistOrigin: args.checklistOrigin } : {}) }), acceptanceCtx.signal);
          acceptanceCtx.signal.throwIfAborted();
        } catch (error) {
          cancellation.signal.throwIfAborted();
          explicitCancellation.signal.throwIfAborted();
          // A real error before the deadline is still an error. Once the clock
          // is involved — the window closed, or the run deadline passed — the
          // work in hand is kept, never delivered, and no new pass is opened.
          if (!acceptanceCtx.signal.aborted && !abortedByDeadline(ctx.signal)) throw error;
          return markRefused(result, { reasoning: 'Root acceptance could not finish within the landing budget' });
        } finally {
          ctx.signal.removeEventListener('abort', forwardCancellation);
        }
        args.onAcceptance(acceptance);
        if (acceptance.approved) return result;
        // A refusal LANDS when there is no pass left to spend, or when the
        // wall clock cannot pay for one. `outOfPhaseBudget` is the floor
        // landing already uses: opening work the deadline will truncate buys
        // nothing, and here it would also cost the refusal's own diagnosis.
        //
        // It used to throw. The run then recorded `failed`, and every byte the
        // molecule had written seeded nothing, because `previousSeedRun` skips
        // a failed run on its status filter — thirty minutes and 0.42 USD of
        // real work discarded on production run `6ab0ae3b`.
        if (ctx.signal.aborted || remediations >= MAX_ROOT_REMEDIATIONS || outOfPhaseBudget(ctx.deadlineAt)) {
          return markRefused(result, acceptance);
        }
        remediations += 1;
        refused = { result, acceptance };
        ctx.recordRunStat?.('root-remediation');
        ctx.logger.warn(
          `[root] delivery refused; one more pass with the acceptor's reasons (${remediations}/${MAX_ROOT_REMEDIATIONS})`
        );
        currentTask = remediationTask(currentTask, acceptance);
      }
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (!requested || mode !== 'short') throw error;
      // Parallel dispatch drains cancelled siblings before the handle rejects.
      // The backend must reap processes before it archives and replaces the workspace.
      tools = await args.restart();
      ctx.recordRunStat?.('deepening');
    }
  }
  throw new Error('Depth attempt limit reached');
}
