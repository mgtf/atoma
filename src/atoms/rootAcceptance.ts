import { createHash } from 'node:crypto';
import type { Atom } from '../core/atom.js';
import type { Result, RunContext, Task } from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { establishesDomInteraction } from '../contracts/attestation.js';
import type { AcceptanceInfo, PhaseCoverageRecord, ProofFloor } from '../contracts/depthRouting.js';
import { buildResultGateEnv, renderResultGateFindings, runResultGates } from './resultGates.js';
import { checkGroundTruth } from './groundTruth.js';
import { llmVerdict } from './verdict.js';
import { LANDED_RESULT_GUIDANCE } from './prompts.js';
import {
  coverAcceptanceChecklist,
  renderChecklistCoverage,
  type AcceptanceChecklist,
  type ChecklistCoverage,
} from '../contracts/acceptanceChecklist.js';

/**
 * Cover the checklist from the attempt's HTTP observations, taken BEFORE the
 * acceptor's own ground-truth probe runs: that probe fetches through the same
 * attesting executor, and the root must not cover a behaviour by looking.
 */
function checklistCoverage(ctx: RunContext, checklist: AcceptanceChecklist): ChecklistCoverage[] {
  const observations = (ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? []).flatMap((record) =>
    record.observation.kind === 'execution' && record.observation.http
      ? [{ eventId: record.eventId, http: record.observation.http }]
      : []);
  return coverAcceptanceChecklist(checklist, observations);
}

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
    const matches = records.filter((record) => record.observation.kind === 'browser' && establishesDomInteraction(record) &&
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
  checklist?: AcceptanceChecklist;
}): Promise<AcceptanceInfo> {
  const { actor, task, result, ctx, floor } = args;
  const checklist = args.checklist ?? [];
  const coverage = checklistCoverage(ctx, checklist);
  const checklistBlock = renderChecklistCoverage(checklist, coverage,
    { landed: Boolean(result.unfinishedPhases?.length) });
  const gates = await runResultGates(buildResultGateEnv({ task, result, ctx,
    childName: actor.name, childToolNames: actor.toolNames() }), ctx.mechanicalResultRejections, 'delegated');
  const probe = await checkGroundTruth({ ctx, subject: 'RESULT',
    payload: { output: result.output, summary: result.summary }, child: actor,
    ...(result.evidence ? { evidence: result.evidence } : {}) });
  const floorCoverage = await rootProofCoverage(ctx, floor);
  const review = floor.length === 0 || gates.reviewFindings.length > 0 || probe.requiresReview ||
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
      proofCoverageBlock: 'ROOT DELIVERY PROOF (no effect on phase credits):\n' + JSON.stringify(floorCoverage) +
        (checklistBlock ? `\n\n${checklistBlock}` : ''),
      // A landed run always reaches here through a validation call, because it
      // stopped before it could prove the floor. Saying what a landing IS costs
      // one block and decides whether the phases it did complete survive.
      ...(result.unfinishedPhases?.length ? { landingBlock: LANDED_RESULT_GUIDANCE } : {}),
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
    ...(coverage.length > 0 ? { checklist: coverage } : {}),
    basis: review && !gates.rejection ? 'validation-call' : 'mechanical',
  };
}
