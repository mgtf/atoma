import type { ToolInvocationInfo } from '../core/types.js';
import {
  PROBE_URL_REFUSAL_PREFIX,
  SMOKE_PREFLIGHT_REFUSAL_PREFIX,
  isPreflightRefusal,
  type ObservedDocument,
} from '../contracts/attestation.js';

/**
 * Did a tool invocation SUCCEED, as the transport saw it? One predicate for
 * the action witness, the skill-execution proof and the ledger below — the
 * historical import path `L1Atom.ts` re-exports it.
 */
export function toolInvocationSucceeded(info: ToolInvocationInfo): boolean {
  if (info.error !== undefined) return false;
  if (!info.result || typeof info.result !== 'object') return true;
  const result = info.result as Record<string, unknown>;
  if (result['unchanged'] === true) return false;
  if ('ok' in result && result['ok'] !== true) return false;
  if (typeof result['error'] === 'string' && result['error'].length > 0) return false;
  if (typeof result['exitCode'] === 'number' && result['exitCode'] !== 0) return false;
  return true;
}

/**
 * THE L1 VALIDATION LEDGER — what the molecule's own `validate_html` calls
 * proved about the artefact it is about to return.
 * =======================================================================
 * Before 2026-09-15 the L1 kept ONE bit: the `ok` flag of the LAST
 * `validate_html` call. That bit decided the `[INTERNAL VALIDATION FAILED`
 * banner, the banner decided a mechanical rejection at L2, and the rejection
 * decided a full replan → validate-plan → re-execute cycle. Measured on the
 * seeded counter (2026-09-14, run `6f81b406`): the document `index.html` was
 * observed OK three times — a self-driving smoke proving 0→3→0→1, then three
 * real clicks proving 0→3 — and its digest never moved again. The model then
 * sent the SAME impossible interaction shape twice more; both were refused
 * pre-flight, no browser ran, and because each refusal was the LAST call the
 * banner fired, the phase was rejected, and the L1 re-read the file, restarted
 * the server and re-validated from scratch. Twice. The 300 s deadline expired
 * on the replay of proof that already stood.
 *
 * The ledger applies the doctrine `proofCoverage.ts` already holds for the
 * supervisor's attestations: evidence is bound to the DOCUMENT it observed,
 * and only a contradiction retires it.
 *
 *  - A pre-flight refusal is not an observation. It says the request was
 *    malformed; it says nothing about the page, which was never opened
 *    (`isPreflightRefusal`, the contract's own predicate). It never retires
 *    standing evidence — and on its own it never establishes any.
 *  - An EXECUTED observation is the evidence. The most recent one decides:
 *    `ok:false` after `ok:true` is a real failure and the banner stands.
 *  - A successful write to the observed document AFTER its last successful
 *    observation retires that evidence: the bytes the browser saw are gone
 *    (`stale`). A write to any OTHER path does not — a digest over a guessed
 *    file set is the false-staleness `proofCoverage` refuses to produce, and
 *    the supervisor's own ground-truth probe re-runs the browser anyway.
 *  - An observation with no `document` binding cannot be shown stale, so it
 *    stands (absence is a weaker observation, never a failure).
 *
 * Zero LLM calls, zero file reads: the ledger sees the tool events in the
 * order the transport reported them. It weakens no requirement — every
 * disposition that fired before still fires, except the one that fired on a
 * refusal while a fresh observation of the unchanged artefact stood.
 */

export type ValidationDisposition =
  /** The molecule never called `validate_html`. */
  | { readonly kind: 'none' }
  /** The last executed observation is ok and its document is unchanged since. */
  | {
      readonly kind: 'standing';
      readonly document: ObservedDocument | null;
      readonly observations: number;
      readonly refusals: number;
    }
  /** The last EXECUTED observation was not ok. */
  | { readonly kind: 'failed'; readonly summary: string }
  /** Every call was refused pre-flight: nothing was ever observed. */
  | { readonly kind: 'refused-only'; readonly refusals: number; readonly lastRefusal: string }
  /** The observed document was written after its last successful observation. */
  | { readonly kind: 'stale'; readonly path: string };

interface ExecutedObservation {
  readonly ok: boolean;
  readonly summary: string;
  readonly document: ObservedDocument | null;
}

/** Paths as the tools spell them: workspace-relative, without a leading `./`. */
function normalisePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, '');
}

function observedDocument(result: Record<string, unknown>): ObservedDocument | null {
  const doc = result['document'];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const entry = doc as Record<string, unknown>;
  return typeof entry['path'] === 'string' && typeof entry['sha256'] === 'string'
    ? { path: entry['path'], sha256: entry['sha256'] }
    : null;
}

/** The one-line failure summary the banner has always carried. */
export function summariseValidateHtml(result: Record<string, unknown>): string {
  const ok = result['ok'] === true;
  const errors = Array.isArray(result['errors']) ? (result['errors'] as unknown[]) : [];
  const failedRequests = Array.isArray(result['failedRequests'])
    ? (result['failedRequests'] as unknown[])
    : [];
  const smokeResult = result['smokeResult'];
  const smokeErr =
    smokeResult && typeof smokeResult === 'object' && 'error' in smokeResult
      ? String((smokeResult as Record<string, unknown>)['error'])
      : null;
  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} console error(s)`);
  if (failedRequests.length > 0) parts.push(`${failedRequests.length} failed request(s)`);
  if (smokeErr) parts.push(`smoke: ${smokeErr.slice(0, 80)}`);
  return parts.length > 0 ? parts.join(', ') : ok ? 'clean load' : 'unknown failure';
}

/**
 * A refusal has no console and no requests — counting its error strings as
 * "console error(s)" would describe a browser that never ran. Its one fact is
 * the guard message, stripped of the shared prefix.
 */
function summariseRefusal(result: Record<string, unknown>): string {
  const errors = Array.isArray(result['errors']) ? (result['errors'] as unknown[]) : [];
  const first = errors.find((entry): entry is string => typeof entry === 'string') ?? '';
  const prefix = [SMOKE_PREFLIGHT_REFUSAL_PREFIX, PROBE_URL_REFUSAL_PREFIX].find((candidate) =>
    first.startsWith(candidate)
  );
  const start = prefix?.length ?? 0;
  return first.slice(start, start + 80);
}

const WRITING_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

export class ValidationLedger {
  private lastExecuted: ExecutedObservation | null = null;
  private observations = 0;
  private refusals = 0;
  private lastRefusal = '';
  /** Set when the last successful observation's document was written afterwards. */
  private staleSince: string | null = null;

  /** Feed every tool invocation the transport reports, in order. */
  observe(info: ToolInvocationInfo): void {
    if (WRITING_TOOLS.has(info.name)) {
      this.observeWrite(info);
      return;
    }
    if (info.name !== 'validate_html') return;
    const result = info.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    const record = result as Record<string, unknown>;
    if (isPreflightRefusal(record)) {
      this.refusals += 1;
      this.lastRefusal = summariseRefusal(record);
      return;
    }
    this.observations += 1;
    this.lastExecuted = {
      ok: record['ok'] === true,
      summary: summariseValidateHtml(record),
      document: observedDocument(record),
    };
    // A fresh observation supersedes any staleness the previous one carried.
    this.staleSince = null;
  }

  private observeWrite(info: ToolInvocationInfo): void {
    if (!toolInvocationSucceeded(info)) return;
    const path = info.args['path'];
    if (typeof path !== 'string') return;
    const standing = this.lastExecuted;
    if (!standing || !standing.ok || !standing.document) return;
    if (normalisePath(path) === normalisePath(standing.document.path)) {
      this.staleSince = standing.document.path;
    }
  }

  disposition(): ValidationDisposition {
    if (!this.lastExecuted) {
      if (this.refusals === 0) return { kind: 'none' };
      return { kind: 'refused-only', refusals: this.refusals, lastRefusal: this.lastRefusal };
    }
    if (!this.lastExecuted.ok) return { kind: 'failed', summary: this.lastExecuted.summary };
    if (this.staleSince !== null) return { kind: 'stale', path: this.staleSince };
    return {
      kind: 'standing',
      document: this.lastExecuted.document,
      observations: this.observations,
      refusals: this.refusals,
    };
  }
}

/**
 * The banner's DETAIL for a disposition that must fail the result, or null
 * when the evidence stands (or was never sought). The caller prefixes the
 * summary; the prefix constant stays where the gate reads it.
 */
export function internalValidationFailureDetail(d: ValidationDisposition): string | null {
  switch (d.kind) {
    case 'none':
    case 'standing':
      return null;
    case 'failed':
      return `last validate_html: ${d.summary}`;
    case 'refused-only':
      return `validate_html never executed: ${d.refusals} call(s) refused pre-flight, last: ${d.lastRefusal}`;
    case 'stale':
      return `${d.path} was modified after its last successful validate_html and not re-validated`;
  }
}
