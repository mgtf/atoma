import { z } from 'zod';
import type { httpObservationSchema } from './attestation.js';

/**
 * THE ACCEPTANCE CHECKLIST — what a run says, before planning, it will prove.
 * docs/acceptance-checklist-2026-09-25.md.
 *
 * Drafted once per run from the goal by the cheapest tier, handed to the
 * planner through the root task's `inputs`, and covered at root acceptance
 * from the HOST's own attempt-scoped observations. It has no authority to
 * accept: it can only add things the acceptor looks for.
 */

export const MAX_CHECKLIST_ITEMS = 12;
export const MAX_CHECKLIST_BEHAVIOUR_CHARS = 160;

const httpMethodSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']));

/** A path the goal itself names: absolute, no scheme, no host, no fragment. */
const checklistPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('#') && !/\s/.test(value), {
    message: 'path must be an absolute request path',
  });

const httpCheckObject = z.object({
  kind: z.literal('http'),
  method: httpMethodSchema,
  path: checklistPathSchema,
  status: z.number().int().min(100).max(599).optional(),
});
const reviewCheckObject = z.object({ kind: z.literal('review') });
const behaviourSchema = z.string().trim().min(1).max(MAX_CHECKLIST_BEHAVIOUR_CHARS);

export const checklistCheckSchema = z.discriminatedUnion('kind', [httpCheckObject, reviewCheckObject]);
export type ChecklistCheck = z.infer<typeof checklistCheckSchema>;

export const checklistItemSchema = z.object({
  id: z.string().regex(/^c\d{1,2}$/),
  behaviour: behaviourSchema,
  check: checklistCheckSchema,
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const acceptanceChecklistSchema = z.array(checklistItemSchema).max(MAX_CHECKLIST_ITEMS);
export type AcceptanceChecklist = z.infer<typeof acceptanceChecklistSchema>;

/**
 * WHO WROTE THE LIST. A `drafted` list is the model's reading of the goal and
 * may only add what the acceptor looks for. A `user` list is what the person
 * who launched the run approved before it started: the host captured it,
 * digested it and carried it to the child, and no model output replaces it.
 */
export const checklistSourceSchema = z.enum(['drafted', 'user']);
export type ChecklistSource = z.infer<typeof checklistSourceSchema>;

/**
 * THE USER-APPROVED LIST, as a caller submits it — docs/acceptance-contract-2026-09-14.md.
 *
 * STRICT where the drafted parse is lenient: an unknown key, a malformed item
 * or a thirteenth item refuses the whole request instead of being dropped,
 * because silently losing a criterion the user approved is exactly what the
 * contract forbids. Ids are not accepted: the host assigns `c1..cN` in the
 * submitted order at capture.
 */
const approvedCheckSchema = z.discriminatedUnion('kind', [httpCheckObject.strict(), reviewCheckObject.strict()]);
export const approvedChecklistItemInputSchema = z.object({
  behaviour: behaviourSchema,
  check: approvedCheckSchema,
}).strict();
export const approvedChecklistInputSchema = z.array(approvedChecklistItemInputSchema).min(1).max(MAX_CHECKLIST_ITEMS)
  // The coordinator hands the child the captured spec in ONE environment
  // variable bounded to `MAX_ACCEPTANCE_SPEC_BYTES`. Per-field limits alone let
  // a list escape-heavy enough to pass here fail the run AFTER it started
  // (2026-09-25 review, 2.3); the whole encoded size is checked at the door.
  .superRefine((items, ctx) => {
    const bytes = encodedSpecBytes(items);
    if (bytes > MAX_ACCEPTANCE_SPEC_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the criteria are too long together (${bytes} bytes encoded; at most ${MAX_ACCEPTANCE_SPEC_BYTES})` });
    }
  });
export type ApprovedChecklistInput = z.input<typeof approvedChecklistInputSchema>;

/** The captured specification: numbered items and the digest the host computed over them. */
export const acceptanceSpecSchema = z.object({
  version: z.literal(1),
  items: z.array(checklistItemSchema.extend({ check: approvedCheckSchema }).strict()).min(1).max(MAX_CHECKLIST_ITEMS),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AcceptanceSpec = z.infer<typeof acceptanceSpecSchema>;

/** Environment variable carrying the captured spec from the coordinator to the child runner. */
export const ACCEPTANCE_SPEC_ENV = 'ATOMA_ACCEPTANCE_SPEC';
/**
 * Who wrote the carried spec. Absent is a USER list, every spec carried before
 * 2026-09-25; `drafted` is a comparison rerun carrying the list its origin
 * drafted for itself, judged as a draft is judged (`withAcceptanceChecklist`).
 */
export const ACCEPTANCE_SOURCE_ENV = 'ATOMA_ACCEPTANCE_SOURCE';
export const MAX_ACCEPTANCE_SPEC_BYTES = 16_384;

/** The UTF-8 size of the spec the host would capture from `items`, digest included. */
function encodedSpecBytes(items: ReadonlyArray<z.infer<typeof approvedChecklistItemInputSchema>>): number {
  const canonical = items.map((item, index) => ({ id: `c${index + 1}`, behaviour: item.behaviour, check: item.check }));
  return new TextEncoder().encode(JSON.stringify({ version: 1, items: canonical, digest: '0'.repeat(64) })).length;
}

/**
 * The items in their ONE canonical order and key order, the bytes the digest
 * is computed over. Numbered here, from the submitted order.
 */
export function canonicalAcceptanceItems(input: ApprovedChecklistInput): AcceptanceSpec['items'] {
  return approvedChecklistInputSchema.parse(input).map((item, index) => ({
    id: `c${index + 1}`,
    behaviour: item.behaviour,
    check: item.check.kind === 'http'
      ? { kind: 'http' as const, method: item.check.method, path: item.check.path,
          ...(item.check.status !== undefined ? { status: item.check.status } : {}) }
      : { kind: 'review' as const },
  }));
}

// The status directly after the path: `404`, `→ 404` / `-> 404` (the notation
// the host itself renders, `describeCheck`) or `(404)`.
const LINE_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)(?:(?:\s*(?:→|->)\s*|\s+)([1-5]\d\d)\b|\s+\(\s*([1-5]\d\d)\s*\))?(?:\s*(?:—|–|-|:)\s*|\s+|$)(.*)$/;
/** A standalone 1xx–5xx number: a status the line NAMES, wherever it was written. */
const STATUS_IN_TEXT = /(?<![\d.])[1-5]\d\d(?![\d.])/;

/**
 * THE LINE GRAMMAR a person types, one criterion per line — deterministic,
 * written by the user, never inferred from the goal:
 *
 *   GET /api/notes/:id 404 — an unknown id is refused
 *   The monthly total is shown under the chart
 *
 * A line that starts with an UPPERCASE HTTP method and an absolute path is an
 * `http` criterion (status optional; without one, any 2xx); every other line
 * is a `review` criterion with its text kept as written. Blank lines and a
 * leading `- ` or `* ` bullet are ignored. Errors are reported per line, and
 * the caller refuses the whole list while any remain.
 *
 * An HTTP line whose status is not where the grammar reads it but which still
 * NAMES one (`POST /api/notes returns 400 for invalid input`) is REFUSED:
 * read as written it would accept any 2xx and show OBSERVED on the happy path
 * for an error the run never provoked (2026-09-25 review, 1.5).
 */
export function parseChecklistLines(text: string): {
  readonly items: ApprovedChecklistInput;
  readonly errors: ReadonlyArray<{ readonly line: number; readonly message: string }>;
} {
  const items: Array<z.input<typeof approvedChecklistItemInputSchema>> = [];
  const errors: Array<{ line: number; message: string }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim().replace(/^[-*]\s+/, '').trim();
    if (!line) return;
    const http = LINE_METHOD.exec(line);
    // A trailing `:` ends the path, so `POST /api/notes: creates one` separates
    // like a dash; a `:name` segment inside the path is untouched.
    const path = http?.[2]!.replace(/:$/, '');
    const status = http ? http[3] ?? http[4] : undefined;
    const rest = http ? http[5]!.trim() : '';
    const named = http && status === undefined ? STATUS_IN_TEXT.exec(rest)?.[0] : undefined;
    if (named) {
      errors.push({ line: index + 1, message:
        `this HTTP criterion names ${named} but not where its status is read, so it would accept any 2xx. ` +
        `If ${named} is the expected status, write it right after the path ("${http![1]} ${path} ${named} — ..."); ` +
        'otherwise drop the method to make it a review criterion' });
      return;
    }
    const candidate = http
      ? {
          behaviour: rest || `${http[1]} ${path}${status ? ` ${status}` : ''}`,
          check: { kind: 'http' as const, method: http[1]!, path: path!,
            ...(status ? { status: Number(status) } : {}) },
        }
      : { behaviour: line, check: { kind: 'review' as const } };
    const parsed = approvedChecklistItemInputSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({ line: index + 1, message: parsed.error.issues[0]?.message ?? 'invalid criterion' });
      return;
    }
    items.push(candidate);
  });
  if (items.length > MAX_CHECKLIST_ITEMS) {
    errors.push({ line: 0, message: `at most ${MAX_CHECKLIST_ITEMS} criteria` });
  }
  return { items, errors };
}

/**
 * Parse a drafted checklist. The model's ids are ignored and renumbered, and
 * a malformed ITEM is dropped rather than failing the list: one bad line must
 * not cost the run its other checks. Returns [] for anything unusable.
 */
export function parseAcceptanceChecklist(raw: unknown): AcceptanceChecklist {
  const items = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['items']
    : raw;
  if (!Array.isArray(items)) return [];
  const parsed: ChecklistItem[] = [];
  for (const item of items) {
    if (parsed.length >= MAX_CHECKLIST_ITEMS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = checklistItemSchema.safeParse({ ...(item as Record<string, unknown>), id: `c${parsed.length + 1}` });
    if (candidate.success) parsed.push(candidate.data);
  }
  return parsed;
}

/** What the host observed of one request to a server this run started. */
export type HttpObservation = z.infer<typeof httpObservationSchema>;

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** Segments decoded ONE BY ONE (an encoded `/` stays inside its segment), and the query. */
function splitPath(path: string): { segments: string[]; query: URLSearchParams | null } {
  const q = path.indexOf('?');
  const pathname = q >= 0 ? path.slice(0, q) : path;
  return {
    segments: pathname.split('/').filter((segment) => segment.length > 0).map(decodeSegment),
    query: q >= 0 ? new URLSearchParams(path.slice(q + 1)) : null,
  };
}

/** Every named parameter present with the same values, in any order. */
function queryIncludes(want: URLSearchParams, got: URLSearchParams | null): boolean {
  for (const key of new Set(want.keys())) {
    const expected = want.getAll(key).sort();
    const actual = (got?.getAll(key) ?? []).sort();
    if (expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) return false;
  }
  return true;
}

/**
 * Does an observed request satisfy an http check? Same method; the path
 * matches segment by segment, case-insensitively (the default of the routers
 * runs build on), where a `:name` segment matches any one segment; a
 * trailing slash is not significant; the query is compared only when the
 * check names one, parameter by parameter; the status is the named one, or
 * any 2xx when none is named.
 */
export function httpCheckMatches(check: Extract<ChecklistCheck, { kind: 'http' }>, observed: HttpObservation): boolean {
  if (observed.method.toUpperCase() !== check.method) return false;
  if (check.status !== undefined ? observed.status !== check.status : observed.status < 200 || observed.status > 299) {
    return false;
  }
  const want = splitPath(check.path);
  const got = splitPath(observed.path);
  if (want.segments.length !== got.segments.length) return false;
  for (let i = 0; i < want.segments.length; i += 1) {
    const segment = want.segments[i]!;
    if (segment.startsWith(':') && segment.length > 1) continue;
    if (segment.toLowerCase() !== got.segments[i]!.toLowerCase()) return false;
  }
  return want.query === null || queryIncludes(want.query, got.query);
}

export const checklistCoverageSchema = z.object({
  id: z.string(),
  behaviour: z.string(),
  kind: z.enum(['http', 'review']),
  status: z.enum(['covered', 'uncovered', 'review']),
  observationRefs: z.array(z.string()),
});
export type ChecklistCoverage = z.infer<typeof checklistCoverageSchema>;

/** Mechanical coverage of each item from this attempt's HTTP observations. */
export function coverAcceptanceChecklist(
  checklist: AcceptanceChecklist,
  observations: ReadonlyArray<{ readonly eventId: string; readonly http: HttpObservation }>
): ChecklistCoverage[] {
  return checklist.map((item) => {
    if (item.check.kind === 'review') {
      return { id: item.id, behaviour: item.behaviour, kind: 'review', status: 'review', observationRefs: [] };
    }
    const check = item.check;
    const refs = observations.filter((o) => httpCheckMatches(check, o.http)).map((o) => o.eventId);
    return { id: item.id, behaviour: item.behaviour, kind: 'http', status: refs.length > 0 ? 'covered' : 'uncovered', observationRefs: refs };
  });
}

function describeCheck(check: ChecklistCheck): string {
  if (check.kind === 'review') return 'judged by review';
  return `${check.method} ${check.path} → ${check.status ?? '2xx'}`;
}

/** The lines the PLANNER receives, in the root task's inputs. */
export function checklistPlanningLines(checklist: AcceptanceChecklist): string[] {
  return checklist.map((item) => `${item.id}: ${item.behaviour} (${describeCheck(item.check)})`);
}

/**
 * The block the ROOT ACCEPTOR reads beside the delivery proof, or '' when a
 * DRAFTED checklist names no HTTP check: a model's list of REVIEW items alone
 * adds no observation and would only read as extra requirements. A USER list
 * always renders, because its review items are requirements the person who
 * launched the run approved, not a model's reading of the goal. On a LANDED
 * result the phases that never ran could not be observed, and the block says
 * so, because the landing guidance tells the acceptor not to refuse for that.
 */
export function renderChecklistCoverage(
  checklist: AcceptanceChecklist,
  coverage: readonly ChecklistCoverage[],
  options: { readonly landed?: boolean; readonly source?: ChecklistSource } = {}
): string {
  const user = options.source === 'user';
  if (coverage.length === 0 || (!user && !coverage.some((entry) => entry.kind === 'http'))) return '';
  const lines = coverage.map((entry, i) => {
    const label = entry.status === 'covered' ? 'OBSERVED' : entry.status === 'uncovered' ? 'NOT OBSERVED' : 'REVIEW';
    return `- [${label}] ${entry.id} ${entry.behaviour} (${describeCheck(checklist[i]!.check)})`;
  });
  return [
    user
      ? 'ACCEPTANCE CRITERIA — approved by the user before launch; the host captured them and no model wrote them.\n' +
        'They are what the user asked this delivery to show. This block decides nothing by itself: judge each one.'
      : 'ACCEPTANCE CHECKLIST — drafted from the goal before planning. It adds nothing the goal did not ask\n' +
        'for and decides nothing by itself.',
    'OBSERVED / NOT OBSERVED are mechanical: whether THIS attempt made',
    'that request through fetch_url to a server it started, and got that status. OBSERVED is status only,',
    'not bound to the current bytes. NOT OBSERVED means no such request was seen — a request made with',
    'run_shell is invisible here — not that the behaviour is broken; weigh it with the rest of the evidence.',
    ...(options.landed
      ? ['This result LANDED before all its phases ran: NOT OBSERVED items from unfinished phases are expected.']
      : []),
    'REVIEW items are yours to judge against the evidence.',
    ...lines,
  ].join('\n');
}
