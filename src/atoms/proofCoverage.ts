import { createHash } from 'node:crypto';
import type { RunContext } from '../core/types.js';
import {
  establishesDomInteraction,
  renderObservation,
  type AttestationRecord,
  type ProofObligation,
} from '../contracts/attestation.js';

/**
 * PROOF COVERAGE — does a transport-observed attestation cover what the plan
 * declared?
 * =======================================================================
 * Read-only, zero LLM calls. The supervisor reads the attestation log for
 * the PHASE'S BRANCH and answers one mechanical question per declared
 * obligation. It never authors an interaction, never replays one, and never
 * rejects: an uncovered obligation forces validator review and withholds the
 * method-level consequences of approval (`PositiveVerdict.proofUncovered`).
 *
 * The failure direction is deliberate and asymmetric. Where the evidence is
 * ABSENT (an observation with no document binding) coverage is GRANTED,
 * because a digest over a guessed file set produces false staleness, which
 * withholds credit silently — and silence is the failure mode this contract
 * exists to remove. Where the evidence is PRESENT AND CONTRADICTORY (a
 * document whose digest moved) coverage is REFUSED.
 */

export interface ProofCoverage {
  readonly obligation: ProofObligation;
  readonly covered: boolean;
  /** One line, written for a validator and for an operator reading a trace. */
  readonly reason: string;
  /** Attestation ids the coverage decision rests on. */
  readonly eventIds: readonly string[];
}

/** Effective obligations for a subtask: its own, plus the parent's. */
export function effectiveObligations(
  subtask: { proofObligations?: readonly ProofObligation[] } | undefined,
  parent: { proofObligations?: readonly ProofObligation[] } | undefined
): ProofObligation[] {
  const merged = [...(subtask?.proofObligations ?? []), ...(parent?.proofObligations ?? [])];
  return [...new Set(merged)];
}

async function documentStillMatches(
  ctx: RunContext,
  record: AttestationRecord
): Promise<{ ok: boolean; detail: string }> {
  const doc = record.observation.document;
  // No binding: the observation cannot be shown stale, so it is not refused.
  if (!doc) return { ok: true, detail: 'no document binding' };
  const tools = ctx.tools;
  if (!tools || !tools.has('read_file')) {
    return { ok: true, detail: 'no reader available to re-check the document' };
  }
  try {
    const raw = await tools.execute('read_file', { path: doc.path });
    const content =
      raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['content'] === 'string'
        ? ((raw as Record<string, unknown>)['content'] as string)
        // A bare string reader is accepted too — the read-back probe already
        // tolerates both shapes.
        : typeof raw === 'string'
          ? raw
          : null;
    if (content === null) return { ok: true, detail: 'document unreadable' };
    // Hashed as UTF-8 to match the tool-side digest, which hashes the file
    // bytes. Identical for any well-formed UTF-8 artefact, which is what a
    // served HTML document is.
    const now = createHash('sha256').update(content, 'utf8').digest('hex');
    return now === doc.sha256
      ? { ok: true, detail: `${doc.path} unchanged since the observation` }
      : {
          ok: false,
          detail: `${doc.path} was MUTATED after the observation — the proof is stale`,
        };
  } catch {
    // A missing file is not evidence the proof was stale; the read-back probe
    // owns the missing-artefact contradiction.
    return { ok: true, detail: 'document could not be re-read' };
  }
}

/**
 * One coverage answer per declared obligation. Empty when the plan declared
 * none, which is the unchanged path: no obligation, no gate, no cost.
 */
export async function checkProofCoverage(args: {
  ctx: RunContext;
  obligations: readonly ProofObligation[];
}): Promise<ProofCoverage[]> {
  const { ctx, obligations } = args;
  if (obligations.length === 0) return [];
  const records = ctx.attestations?.forBranch(ctx.currentBranchId) ?? [];
  const out: ProofCoverage[] = [];
  for (const obligation of obligations) {
    if (obligation !== 'dom-interaction') continue;
    const browserRecords = records.filter((r) => r.observation.kind === 'browser');
    const executed = browserRecords.filter(establishesDomInteraction);
    if (executed.length === 0) {
      const filtered = browserRecords.reduce(
        (total, r) => total + r.observation.ignoredInteractions,
        0
      );
      const seen =
        browserRecords.length === 0
          ? 'no browser observation was attested for this phase'
          : `${browserRecords.length} browser observation(s), none with an executed interaction` +
            (filtered > 0
              ? ` — ${filtered} requested interaction(s) were filtered because the smoke drives its own state`
              : '');
      out.push({
        obligation,
        covered: false,
        reason: `dom-interaction NOT covered: ${seen}.`,
        eventIds: browserRecords.map((r) => r.eventId),
      });
      continue;
    }
    const checks = await Promise.all(
      executed.map(async (record) => ({ record, freshness: await documentStillMatches(ctx, record) }))
    );
    const fresh = checks.filter((c) => c.freshness.ok);
    if (fresh.length === 0) {
      out.push({
        obligation,
        covered: false,
        reason:
          `dom-interaction NOT covered: real interactions were executed, but ` +
          `${checks.map((c) => c.freshness.detail).join('; ')}.`,
        eventIds: checks.map((c) => c.record.eventId),
      });
      continue;
    }
    out.push({
      obligation,
      covered: true,
      reason:
        `dom-interaction covered by ${fresh.length} transport-observed interaction(s): ` +
        fresh.map((c) => renderObservation(c.record)).join(' | '),
      eventIds: fresh.map((c) => c.record.eventId),
    });
  }
  return out;
}

/** The block appended to the ground-truth evidence the validator reads. */
export function renderProofCoverage(coverage: readonly ProofCoverage[]): string {
  if (coverage.length === 0) return '';
  return [
    '',
    '== DECLARED PROOF OBLIGATIONS (supervisor-held attestation) ==',
    'These lines are MACHINE-OBSERVED at the tool transport, not reported by the child.',
    ...coverage.map((c) => `${c.covered ? 'COVERED' : 'UNCOVERED'} — ${c.reason}`),
    ...(coverage.some((c) => !c.covered)
      ? [
          'An UNCOVERED obligation is not by itself a reason to reject: judge the',
          'deliverable on its merits. It does mean the METHOD is unproven, which the',
          'supervisor handles separately.',
        ]
      : []),
  ].join('\n');
}

/** True when at least one declared obligation went uncovered. */
export function anyUncovered(coverage: readonly ProofCoverage[]): boolean {
  return coverage.some((c) => !c.covered);
}
