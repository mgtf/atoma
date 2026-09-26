import { createHash } from 'node:crypto';
import {
  ACCEPTANCE_SOURCE_ENV,
  ACCEPTANCE_SPEC_ENV,
  MAX_ACCEPTANCE_SPEC_BYTES,
  acceptanceSpecSchema,
  canonicalAcceptanceItems,
  type AcceptanceSpec,
  type ApprovedChecklistInput,
  type ChecklistSource,
} from '../contracts/acceptanceChecklist.js';

/**
 * THE HOST HALF of a user-approved acceptance list — the digest and the
 * coordinator → child transport. It lives outside `src/contracts/` because the
 * browser imports that directory and `node:crypto` does not exist there.
 *
 * docs/acceptance-contract-2026-09-14.md: the host validates and captures the
 * specification before paid work, and the captured version is the
 * authoritative one. Everything here REFUSES rather than repairs, because a
 * criterion the user approved and the run silently lost is the one failure
 * the contract names.
 */

function digestItems(items: AcceptanceSpec['items']): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** Number, canonicalise and digest a submitted list. Throws on anything the strict schema refuses. */
export function captureAcceptanceSpec(input: ApprovedChecklistInput): AcceptanceSpec {
  const items = canonicalAcceptanceItems(input);
  return acceptanceSpecSchema.parse({ version: 1, items, digest: digestItems(items) });
}

/** A stored or transported spec, re-parsed and re-digested: a mismatch is corruption, never a hint. */
export function parseAcceptanceSpec(raw: unknown): AcceptanceSpec {
  const spec = acceptanceSpecSchema.parse(raw);
  if (digestItems(spec.items) !== spec.digest) throw new Error('acceptance specification digest does not match its items');
  return spec;
}

export function encodeAcceptanceSpec(spec: AcceptanceSpec): string {
  const encoded = JSON.stringify(parseAcceptanceSpec(spec));
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ACCEPTANCE_SPEC_BYTES) {
    throw new Error(`acceptance specification exceeds ${MAX_ACCEPTANCE_SPEC_BYTES} bytes`);
  }
  return encoded;
}

/**
 * The child's read. Absent means no user list (the run drafts its own);
 * present and unreadable THROWS, so the run fails before any model call
 * instead of running against a list nobody approved.
 */
export function readAcceptanceSpec(env: NodeJS.ProcessEnv): AcceptanceSpec | null {
  const raw = env[ACCEPTANCE_SPEC_ENV];
  if (raw === undefined || raw === '') return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_ACCEPTANCE_SPEC_BYTES) {
    throw new Error(`${ACCEPTANCE_SPEC_ENV} exceeds ${MAX_ACCEPTANCE_SPEC_BYTES} bytes`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${ACCEPTANCE_SPEC_ENV} is not valid JSON`); }
  try { return parseAcceptanceSpec(parsed); }
  catch (error) { throw new Error(`${ACCEPTANCE_SPEC_ENV} is invalid: ${(error as Error).message}`); }
}

/**
 * Who wrote the carried spec. Anything but absent, `drafted` or `none` THROWS,
 * and so does `drafted` without a spec or `none` beside one: a label the child
 * cannot place is a list it would judge by the wrong rule.
 */
export function readAcceptanceSource(env: NodeJS.ProcessEnv): ChecklistSource | 'none' {
  const raw = env[ACCEPTANCE_SOURCE_ENV];
  if (raw === undefined || raw === '') return 'user';
  // `none`: a comparison rerun of an origin that was judged WITHOUT a list
  // (it predates the checklist, or its draft came back empty). The rerun is
  // judged the same way, so it drafts nothing either — a spec beside it would
  // contradict the label.
  if (raw === 'none') {
    if (env[ACCEPTANCE_SPEC_ENV]) throw new Error(`${ACCEPTANCE_SOURCE_ENV}=none is set beside ${ACCEPTANCE_SPEC_ENV}`);
    return 'none';
  }
  if (raw !== 'drafted') throw new Error(`${ACCEPTANCE_SOURCE_ENV} must be 'drafted' or 'none' when set`);
  if (!env[ACCEPTANCE_SPEC_ENV]) throw new Error(`${ACCEPTANCE_SOURCE_ENV} is set without ${ACCEPTANCE_SPEC_ENV}`);
  return 'drafted';
}
