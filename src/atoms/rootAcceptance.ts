import { createHash } from 'node:crypto';
import type { Atom } from '../core/atom.js';
import type { Result, RunContext, Task } from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { establishesDomInteraction } from '../contracts/attestation.js';
import type { AcceptanceInfo, PhaseCoverageRecord, ProofFloor } from '../contracts/depthRouting.js';
import { buildResultGateEnv, renderResultGateFindings, runResultGates } from './resultGates.js';
import { checkGroundTruth } from './groundTruth.js';
import { llmVerdict } from './verdict.js';

/** Root proof is stricter than phase proof: no binding or unreadable bytes never cover. */
export async function rootProofCoverage(ctx: RunContext, floor: ProofFloor): Promise<AcceptanceInfo['floorCoverage']> {
  const records = ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? [];
  const reads = new Map<string, Promise<string | undefined>>();
  const digest = (path: string): Promise<string | undefined> => {
    if (!reads.has(path)) reads.set(path, (async () => {
      try {
        if (!ctx.tools?.has('read_file')) return undefined;
        const read: unknown = await ctx.tools.execute('read_file', { path });
        const content = typeof read === 'string' ? read : read && typeof read === 'object' &&
          'content' in read && typeof read.content === 'string' ? read.content : undefined;
        return content === undefined ? undefined : createHash('sha256').update(content).digest('hex');
      } catch { return undefined; }
    })());
    return reads.get(path)!;
  };
  return Promise.all(floor.map(async ({ obligation, deliverable }) => {
    const current = await digest(deliverable);
    const matches = records.filter((record) => establishesDomInteraction(record) &&
      record.observation.document?.path === deliverable && current !== undefined &&
      record.observation.document.sha256 === current);
    return { kind: obligation, deliverable, status: matches.length ? 'covered' : 'uncovered',
      observationRefs: matches.map((record) => record.eventId) };
  }));
}

/** A delivery verdict only: no registry, learning hook, or remediation lives here. */
export async function acceptRootResult(args: {
  actor: Atom; task: Task; result: Result; ctx: RunContext; floor: ProofFloor;
  phaseCoverage: readonly PhaseCoverageRecord[];
}): Promise<AcceptanceInfo> {
  const { actor, task, result, ctx, floor } = args;
  const gates = await runResultGates(buildResultGateEnv({ task, result, ctx,
    childName: actor.name, childToolNames: actor.toolNames() }), ctx.mechanicalResultRejections, 'delegated');
  const probe = await checkGroundTruth({ ctx, subject: 'RESULT',
    payload: { output: result.output, summary: result.summary }, child: actor,
    ...(result.evidence ? { evidence: result.evidence } : {}) });
  const floorCoverage = await rootProofCoverage(ctx, floor);
  const review = gates.reviewFindings.length > 0 || probe.requiresReview ||
    floorCoverage.some((item) => item.status === 'uncovered');
  const verdict = gates.rejection
    ? { approved: false, reasoning: gates.rejection.reasoning }
    : review ? await llmVerdict({
      ctx, model: modelForTier(1), supervisorName: 'run-root', supervisorTier: 3,
      subject: 'RESULT', child: actor, task,
      payload: { output: result.output, summary: result.summary, producedBy: result.producedBy },
      ...(result.evidence ? { evidence: result.evidence } : {}),
      groundTruthBlock: probe.block,
      mechanicalFindingsBlock: renderResultGateFindings(gates.reviewFindings),
      proofCoverageBlock: 'ROOT DELIVERY PROOF (no effect on phase credits):\n' + JSON.stringify(floorCoverage),
    }) : { approved: true, reasoning: 'No mechanical finding requires review.' };
  const produced = result.producedBy;
  return {
    attempt: ctx.attempt ?? 1, approved: verdict.approved, reasoning: verdict.reasoning ?? '',
    acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
    executor: { name: produced?.name ?? actor.name, tier: produced?.tier ?? actor.tier,
      viaFallback: produced?.viaFallback ?? false },
    gates: [...gates.reviewFindings, ...(gates.rejection ? [gates.rejection] : [])]
      .map((finding) => ({ id: finding.gateId, disposition: finding.disposition })),
    probe: { requiresReview: probe.requiresReview, contradiction: probe.contradiction },
    floorCoverage, phaseCoverage: [...args.phaseCoverage],
    basis: review && !gates.rejection ? 'validation-call' : 'mechanical',
  };
}
