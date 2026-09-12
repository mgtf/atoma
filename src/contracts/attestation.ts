import { z } from 'zod';

/**
 * PROOF ATTESTATION — transport-observed evidence, and what it covers.
 * ====================================================================
 * This module owns three shapes and nothing else: the typed observation a
 * tool call produces, the record the runtime appends for it, and the closed
 * vocabulary of proof obligations a plan may declare.
 *
 * WHY it exists (measured, cold `web-counter` run 2026-08-22): the browser
 * tool already distinguishes interactions the model REQUESTED from
 * interactions Puppeteer EXECUTED, and that distinction was lost after the
 * tool returned. The result kept content-free `{name, ok}` pairs, the witness
 * extractor only recognised shell commands, and the web probe manifest was
 * written by the model from its own intent. A run whose eight requested
 * clicks were all filtered away was approved on its own narration, and the
 * skill distilled from it taught the next run to drive state through
 * `window.__*` hooks. See
 * `docs/supervisor-attestation-a1-review-2026-08-22.md` for the contract and
 * `docs/incidents/supervisor-attestation-evidence-2026-08-22.md` for the
 * evidence.
 *
 * The invariant: an observation is only ever OBSERVED here, never claimed. A
 * model-authored payload cannot enter this module; the only writer is the
 * runtime seam that saw the raw tool result.
 */

/**
 * The obligation vocabulary is CLOSED and currently has exactly one member.
 * Coverage is a semantic match between a task claim and an observation;
 * every generalisation of it is either a vocabulary-frozen detector or
 * another paid, spoofable model call. One mechanical member refuses to
 * generalise before it is measured. A second member is a new review.
 */
export const PROOF_OBLIGATIONS = ['dom-interaction'] as const;
export type ProofObligation = (typeof PROOF_OBLIGATIONS)[number];

export function isProofObligation(value: unknown): value is ProofObligation {
  return typeof value === 'string' && (PROOF_OBLIGATIONS as readonly string[]).includes(value);
}

/**
 * The document a browser observation was taken against: the workspace file
 * the static server actually served, plus its content digest AT OBSERVATION
 * TIME. The digest is what relates an observation to an artifact revision —
 * without it a later `write_file` and an earlier proof are mechanically
 * unrelated, and a stale proof reads exactly like a fresh one.
 *
 * Scope, deliberately narrow: ONE served file. Import trees, assets and
 * bundles are NOT covered, so a deliverable whose behaviour lives in a
 * sibling module can go stale unnoticed. That under-detection is chosen over
 * the alternative — a digest over a guessed file set produces FALSE
 * staleness, which withholds credit silently, and silence is the failure
 * mode this contract exists to remove.
 */
export const observedDocumentSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
});

/**
 * What the browser tool observed. `requestedInteractions` and
 * `executedInteractions` are SEPARATE FACTS: the smoke filter
 * (`smokeDrivesOwnState`) removes every external interaction when the smoke
 * expression drives its own state, so a call can return `ok: true` having
 * executed none of the input the task named.
 */
export const browserObservationSchema = z.object({
  kind: z.literal('browser'),
  ok: z.boolean(),
  url: z.string().optional(),
  /** How many interactions the caller asked for. */
  requestedInteractions: z.number().int().nonnegative(),
  /** How many the runtime removed before opening the page. */
  ignoredInteractions: z.number().int().nonnegative(),
  /** One entry per interaction Puppeteer actually performed, in order. */
  executedInteractions: z.array(z.string()),
  smoke: z.string().optional(),
  smokeResult: z.unknown().optional(),
  consoleErrors: z.number().int().nonnegative(),
  failedRequests: z.number().int().nonnegative(),
  document: observedDocumentSchema.optional(),
});

export type ObservedDocument = z.infer<typeof observedDocumentSchema>;
export type BrowserObservation = z.infer<typeof browserObservationSchema>;

/** The observation union. One member today; the discriminant is `kind`. */
export type ToolObservation = BrowserObservation;

/**
 * One appended record. `branchId` is the ADDRESS: it comes from the fork
 * wrapper that saw the call, never from ambient "current actor" state, which
 * would race the moment two fan-out lanes run at once.
 */
export interface AttestationRecord {
  readonly eventId: string;
  readonly branchId?: string;
  readonly tool: string;
  readonly observation: ToolObservation;
}

/**
 * Run-scoped, append-only, memory-only. NOT a new product store: nothing
 * here needs to outlive the run, and `src/core/stores.ts` stays the one
 * product store. Cross-run proof reuse is therefore out of scope by
 * construction.
 */
export interface AttestationLog {
  append(record: AttestationRecord): void;
  /** Records observed under one branch, in append order. */
  forBranch(branchId: string | undefined): readonly AttestationRecord[];
  readonly size: number;
}

/**
 * Does this record establish that real user input reached the page?
 * A non-empty EXECUTED log is the whole test: `ok: true` with an empty one
 * is the cold counter case, and it must not cover.
 */
export function establishesDomInteraction(record: AttestationRecord): boolean {
  return (
    record.observation.kind === 'browser' &&
    record.observation.executedInteractions.length > 0
  );
}

/**
 * Parse a raw browser tool result into the typed observation. Returns null
 * for anything that is not a browser result — the caller then has no
 * attestation, which is the correct outcome: absence of proof, not proof of
 * absence.
 *
 * `args` supplies the REQUESTED count because the request is the caller's
 * fact and the result is the runtime's; reading both from one side would
 * lose exactly the distinction this module exists for.
 */
export function parseBrowserObservation(
  args: Record<string, unknown>,
  raw: unknown
): BrowserObservation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ok'] !== 'boolean') return null;
  // The interaction log is the load-bearing field. A result without one is
  // not a browser observation we can reason about (a pre-flight rejection,
  // or another tool's payload).
  const log = r['interactionLog'];
  if (!Array.isArray(log)) return null;
  const requestedFromArgs = Array.isArray(args['interactions'])
    ? (args['interactions'] as unknown[]).length
    : 0;
  const requested =
    typeof r['requestedInteractions'] === 'number'
      ? r['requestedInteractions']
      : requestedFromArgs;
  const ignored = typeof r['ignoredInteractions'] === 'number' ? r['ignoredInteractions'] : 0;
  const errors = Array.isArray(r['errors']) ? r['errors'].length : 0;
  const failed = Array.isArray(r['failedRequests']) ? r['failedRequests'].length : 0;
  const parsed = browserObservationSchema.safeParse({
    kind: 'browser',
    ok: r['ok'],
    ...(typeof r['url'] === 'string' ? { url: r['url'] } : {}),
    requestedInteractions: Math.max(0, Math.floor(requested)),
    ignoredInteractions: Math.max(0, Math.floor(ignored)),
    executedInteractions: log.filter((entry): entry is string => typeof entry === 'string'),
    ...(typeof args['smoke'] === 'string' ? { smoke: args['smoke'] } : {}),
    ...(r['smokeResult'] !== undefined ? { smokeResult: r['smokeResult'] } : {}),
    consoleErrors: errors,
    failedRequests: failed,
    ...(r['document'] !== undefined ? { document: r['document'] } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** The one-line rendering the supervisor shows a validator. */
export function renderObservation(record: AttestationRecord): string {
  const o = record.observation;
  const bits = [
    `ok=${o.ok}`,
    `requested=${o.requestedInteractions}`,
    `executed=${o.executedInteractions.length}`,
  ];
  if (o.ignoredInteractions > 0) bits.push(`FILTERED=${o.ignoredInteractions}`);
  if (o.document) bits.push(`doc=${o.document.path}`);
  bits.push(`consoleErrors=${o.consoleErrors}`, `failedRequests=${o.failedRequests}`);
  if (o.smokeResult !== undefined) {
    try {
      const smoke = JSON.stringify(o.smokeResult) ?? '[not JSON serializable]';
      bits.push(`smokeResult=${smoke.length > 1200 ? `${smoke.slice(0, 1200)} [truncated]` : smoke}`);
    } catch {
      bits.push('smokeResult=[not JSON serializable]');
    }
  }
  return `${record.tool}: ${bits.join(', ')}`;
}
