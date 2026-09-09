import type { RetrievalCampaignResult, RetrievalRegistration } from '../contracts/retrievalCampaign.js';

/** Descriptive paired screening. Synthetic questions within one project are correlated. */
export function pairedRetrievalDecision(registration: RetrievalRegistration, rows: readonly RetrievalCampaignResult[]) {
  const spec = registration.spec;
  if (spec.kind !== 'bm25-development') return null;
  const pairs = registration.schedule.filter(e => e.arm === 'atoma').map(entry => {
    const matching = rows.filter(r => r.entry.questionId === entry.questionId && r.entry.repetition === entry.repetition);
    const a = matching.find(r => r.entry.arm === 'atoma');
    const b = matching.find(r => r.entry.arm === 'atoma-bm25');
    return { questionId: entry.questionId, repetition: entry.repetition,
      kind: matching.some(r => r.score.checks.some(c => c.id.startsWith('maintenance-'))) ? 'maintenance' : 'retrieval',
      complete: !!a && !!b, a: a?.full ?? false, b: b?.full ?? false,
      elapsedA: a?.elapsedMs ?? null, elapsedB: b?.elapsedMs ?? null,
      priceA: a?.runner?.costUsd ?? null, priceB: b?.runner?.costUsd ?? null };
  });
  const complete = pairs.every(p => p.complete);
  const campaignComplete = registration.schedule.every(entry => rows.some(r =>
    r.entry.ordinal === entry.ordinal && r.entry.arm === entry.arm && !r.infrastructureFailure));
  const difference = pairs.reduce((n, p) => n + Number(p.b) - Number(p.a), 0) / pairs.length;
  const ratio = (a: (number | null)[], b: (number | null)[]) => {
    if (a.some(v => v === null) || b.some(v => v === null)) return null;
    const totalA = a.reduce<number>((n, v) => n + v!, 0);
    const totalB = b.reduce<number>((n, v) => n + v!, 0);
    return totalA > 0 ? totalB / totalA : totalB === 0 ? 1 : null;
  };
  const elapsedRatio = ratio(pairs.map(p => p.elapsedA), pairs.map(p => p.elapsedB));
  const priceEquivalentRatio = ratio(pairs.map(p => p.priceA), pairs.map(p => p.priceB));
  const rule = spec.decision!;
  const meetsScreen = complete && elapsedRatio !== null && priceEquivalentRatio !== null &&
    difference >= rule.minimumGain && elapsedRatio <= rule.maxElapsedRatio && priceEquivalentRatio <= rule.maxPriceEquivalentRatio;
  return {
    pairs, plannedPairs: pairs.length, completePairs: pairs.filter(p => p.complete).length,
    aFull: pairs.filter(p => p.a).length, bFull: pairs.filter(p => p.b).length,
    wins: pairs.filter(p => p.complete && p.b && !p.a).length,
    losses: pairs.filter(p => p.complete && p.a && !p.b).length,
    pairedFullPassDifference: complete ? difference : null, elapsedRatio, priceEquivalentRatio,
    uncertainty: 'No population confidence interval: questions and repetitions within the development project are correlated. A new project-family sample is required.',
    decision: !complete || !campaignComplete || elapsedRatio === null || priceEquivalentRatio === null ? 'inconclusive' :
      meetsScreen ? 'advance-to-new-confirmation' : 'screen-not-met',
    rule,
  };
}
