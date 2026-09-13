import type { Atom } from '../core/atom.js';
import { setMaxListeners } from 'node:events';
import type { Result, RunContext, Task, ToolExecutor } from '../core/types.js';
import { attestingExecutor, createAttestationLog } from '../core/attestation.js';
import { acceptRootResult } from '../atoms/rootAcceptance.js';
import type { AcceptanceInfo, DepthMode, PhaseCoverageRecord, ProofFloor, TopologyInfo } from '../contracts/depthRouting.js';

export class DeepeningSignal extends Error {
  constructor() { super('Entry cell exhausted supervision; deepen once.'); this.name = 'DeepeningSignal'; }
}
export class RootAcceptanceError extends Error {
  constructor(readonly acceptance: AcceptanceInfo) { super(`Root acceptance rejected: ${acceptance.reasoning}`); }
}

/** The existing atom protocol executes each attempt; this owns only their lifetime. */
export async function runDepthTask(args: {
  mode: DepthMode; task: Task; ctx: RunContext; floor: ProofFloor;
  createExecutor: (mode: DepthMode) => { actor: Atom; handle: (task: Task, ctx: RunContext) => Promise<Result> };
  restart: () => Promise<ToolExecutor>;
  onTopology: (info: TopologyInfo) => void;
  onAcceptance: (info: AcceptanceInfo) => void;
}): Promise<Result> {
  const { ctx, task } = args;
  const attestations = (ctx.attestations ??= createAttestationLog());
  const phaseCoverage: PhaseCoverageRecord[] = [];
  let tools = ctx.tools;
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
      const result = await handle(task, attemptCtx);
      attemptCtx.signal.throwIfAborted();
      const acceptance = await acceptRootResult({ actor, task, result, ctx: attemptCtx,
        floor: args.floor, phaseCoverage });
      attemptCtx.signal.throwIfAborted();
      args.onAcceptance(acceptance);
      if (!acceptance.approved) throw new RootAcceptanceError(acceptance);
      return result;
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
