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

export const checklistCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    method: httpMethodSchema,
    path: checklistPathSchema,
    status: z.number().int().min(100).max(599).optional(),
  }),
  z.object({ kind: z.literal('review') }),
]);
export type ChecklistCheck = z.infer<typeof checklistCheckSchema>;

export const checklistItemSchema = z.object({
  id: z.string().regex(/^c\d{1,2}$/),
  behaviour: z.string().trim().min(1).max(MAX_CHECKLIST_BEHAVIOUR_CHARS),
  check: checklistCheckSchema,
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const acceptanceChecklistSchema = z.array(checklistItemSchema).max(MAX_CHECKLIST_ITEMS);
export type AcceptanceChecklist = z.infer<typeof acceptanceChecklistSchema>;

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
 * The block the ROOT ACCEPTOR reads beside the delivery proof, or '' when the
 * checklist names no HTTP check: a list of REVIEW items alone adds no
 * observation and would only read as extra requirements. On a LANDED result
 * the phases that never ran could not be observed, and the block says so,
 * because the landing guidance tells the acceptor not to refuse for that.
 */
export function renderChecklistCoverage(
  checklist: AcceptanceChecklist,
  coverage: readonly ChecklistCoverage[],
  options: { readonly landed?: boolean } = {}
): string {
  if (!coverage.some((entry) => entry.kind === 'http')) return '';
  const lines = coverage.map((entry, i) => {
    const label = entry.status === 'covered' ? 'OBSERVED' : entry.status === 'uncovered' ? 'NOT OBSERVED' : 'REVIEW';
    return `- [${label}] ${entry.id} ${entry.behaviour} (${describeCheck(checklist[i]!.check)})`;
  });
  return [
    'ACCEPTANCE CHECKLIST — drafted from the goal before planning. It adds nothing the goal did not ask',
    'for and decides nothing by itself. OBSERVED / NOT OBSERVED are mechanical: whether THIS attempt made',
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
