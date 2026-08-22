import { z } from 'zod';

/**
 * PLATFORM EVENTS — THE CONTROL-PLANE AUDIT CONTRACT.
 * ===================================================
 *
 * One append-only journal of what happens on the deployment: who logged in,
 * which organisation appeared, which publication failed, which webhook was
 * refused. Two consumers, one shape: the admin audit surface reads it, and
 * the notification router turns a subset of it into Web Push.
 *
 * WHY NOT THE LIFECYCLE LEDGER. `lifecycle_events` (src/core/ledger.ts) is a
 * product-internal journal of atom-type and skill TRUST COUNTERS, with an
 * order-sensitive projection (`projectCounters`) and its own integrity
 * checker (`ledger check`). It has no actor, no organisation and no severity,
 * because it answers "what did the catalogue learn", not "what happened on
 * the platform". Widening it would put HTTP-shaped rows inside a counter
 * projection and make one table answer two questions badly. The two are read
 * side by side in the admin tab and never joined.
 *
 * SEVERITY IS A PROPERTY OF THE KIND, not a per-call-site argument: emitters
 * name a kind, `severityForKind` decides. The same kind can therefore never
 * be journaled at two severities by two call sites — the
 * one-concept-two-definitions drift AGENTS.md warns about. It is still
 * PERSISTED on the row so a reader filters without importing this map, and so
 * history stays honest if the map is later revised.
 *
 * PAYLOAD DISCIPLINE. `summary` is English, bounded, control-character free
 * and written for a human scanning a list. `detail` is a small bounded JSON
 * object. NEITHER may carry a secret: no session token, no invitation token
 * (not even hashed), no provider credential, no model-authored trace prose.
 * The journal is read by an operator and a subset of it crosses a third-party
 * push service on its way to a lock screen.
 */

/** Same codepoint test as `projects.ts` — a regex here trips no-control-regex. */
function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export const PLATFORM_EVENT_SUMMARY_MAX_CHARS = 200;
export const PLATFORM_EVENT_DETAIL_MAX_CHARS = 2_000;

/**
 * The closed vocabulary. Adding a kind is a deliberate act: `severityForKind`
 * and the router's audience table are both `Record<PlatformEventKind, …>`, so
 * a new kind does not compile until its severity and its audience are stated.
 */
export const platformEventKindSchema = z.enum([
  // --- Client-facing: the run and its delivery.
  'run.started',
  'run.finished',
  'run.cancelled',
  'publication.published',
  'publication.failed',
  // --- Organisation lifecycle.
  'org.created',
  'org.member_joined',
  'principal.renamed',
  'project.created',
  'github.installation_linked',
  'github.installation_status',
  /**
   * The sentinel saw something wrong with a run IN FLIGHT: a cost threshold
   * crossed, a stalled identical-call streak, a duration outlier, a recurring
   * tool error. A flag, never a judgment — the standing rule is that a
   * heuristic never decides alone, and the sentinel's only possible power is a
   * journaled cancel, which is a separate decision from this row existing.
   */
  'run.anomaly',
  /**
   * The sentinel matched an injection signature in an ELEMENT RESULT — where
   * untrusted content enters the system. The row carries a bounded excerpt so
   * an operator can judge; the excerpt is data, never an instruction, and
   * nothing downstream may act on it automatically.
   */
  'security.flagged',
  // --- Platform and security.
  /**
   * A project run was allowed to spend the HOST's subscription instead of a
   * per-run credential, because the requester holds the platform-admin flag.
   * Journaled, never pushed: it is routine for a single-operator instance and
   * noise as a notification, but it must be answerable after the fact —
   * "which runs did this instance bill to its own login session, and who
   * asked for them".
   */
  'run.host_subscription',
  'admin.granted',
  'admin.revoked',
  'invitation.created',
  'auth.rate_limited',
  'auth.state_flood',
  'webhook.rejected',
  'server.recovered',
  'push.subscribed',
  'push.unsubscribed',
]);

export const platformEventSeveritySchema = z.enum(['info', 'warning', 'error', 'security']);

/**
 * Who caused the event.
 * - `principal`: a signed-in browser session; `actorId` is the principal id.
 * - `cli`: the operator CLI, a separate process (audited, never pushed).
 * - `webhook`: an unauthenticated third-party delivery.
 * - `system`: the server itself (boot recovery, sweeps).
 */
export const platformEventActorTypeSchema = z.enum(['principal', 'system', 'cli', 'webhook']);

const scopeIdSchema = z.string().min(1).max(64);

const summarySchema = z
  .string()
  .min(1)
  .max(PLATFORM_EVENT_SUMMARY_MAX_CHARS)
  .refine((value) => !hasAsciiControl(value), {
    message: 'summary must not contain ASCII control characters',
  });

const detailSchema = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= PLATFORM_EVENT_DETAIL_MAX_CHARS, {
    message: `detail must serialise to at most ${PLATFORM_EVENT_DETAIL_MAX_CHARS} characters`,
  });

const eventScopeFields = {
  kind: platformEventKindSchema,
  actorType: platformEventActorTypeSchema,
  /** The principal id when `actorType` is `principal`; null otherwise. */
  actorId: scopeIdSchema.nullable().default(null),
  orgId: scopeIdSchema.nullable().default(null),
  projectId: scopeIdSchema.nullable().default(null),
  runId: scopeIdSchema.nullable().default(null),
  summary: summarySchema,
  detail: detailSchema.optional(),
};

/** A `principal` actor without an id would make the row unattributable. */
function requirePrincipalId(
  event: { actorType: string; actorId: string | null },
  ctx: z.RefinementCtx
): void {
  if (event.actorType === 'principal' && !event.actorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actorId'],
      message: 'a principal actor requires actorId',
    });
  }
}

/** What an emitter supplies. `seq`, `at` and `severity` are host-owned. */
export const platformEventInputSchema = z
  .object(eventScopeFields)
  .strict()
  .superRefine(requirePrincipalId);

/** What the store holds and every reader receives. */
export const platformEventSchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.string().datetime(),
    severity: platformEventSeveritySchema,
    ...eventScopeFields,
  })
  .strict()
  .superRefine(requirePrincipalId);

export type PlatformEventKind = z.infer<typeof platformEventKindSchema>;
export type PlatformEventSeverity = z.infer<typeof platformEventSeveritySchema>;
export type PlatformEventActorType = z.infer<typeof platformEventActorTypeSchema>;
/** Caller-facing: the nullable scope fields may simply be omitted. */
export type PlatformEventInput = z.input<typeof platformEventInputSchema>;
export type PlatformEvent = z.infer<typeof platformEventSchema>;

export const EVENT_LABEL_MAX_CHARS = 48;

/**
 * Make an untrusted string safe to interpolate into a `summary`.
 *
 * LOAD-BEARING, not cosmetic. Display names, organisation names and error
 * strings reach summaries from OAuth providers, GitHub and model-adjacent
 * failures. An unbounded one blows the 200-char cap and a newline trips the
 * control-character refusal — and because the log is FAIL-OPEN, either one
 * would silently DROP the audit event rather than shorten it. Every call
 * site that interpolates text it did not author goes through this.
 */
export function eventLabel(value: string, maxChars = EVENT_LABEL_MAX_CHARS): string {
  const flattened = [...value.trim()]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return '(unnamed)';
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

/** One declarative table: kind → severity. Exhaustive by construction. */
export const PLATFORM_EVENT_SEVERITY: Record<PlatformEventKind, PlatformEventSeverity> = {
  'run.started': 'info',
  'run.finished': 'info',
  'run.cancelled': 'info',
  'publication.published': 'info',
  // A delivered run whose artifacts never reached GitHub: the deliverable
  // exists and is unreachable. That is an error, not a warning.
  'publication.failed': 'error',
  'org.created': 'info',
  'org.member_joined': 'security',
  // A display name is what every other member of the organisation sees in the
  // directory and in these very summaries. Changing it is an
  // identity-presentation change, not a cosmetic preference.
  'principal.renamed': 'security',
  'project.created': 'info',
  'github.installation_linked': 'info',
  // Suspended or deleted installations break the publication pipeline.
  'github.installation_status': 'warning',
  'run.anomaly': 'warning',
  'security.flagged': 'security',
  'run.host_subscription': 'security',
  'admin.granted': 'security',
  'admin.revoked': 'security',
  'invitation.created': 'security',
  'auth.rate_limited': 'warning',
  'auth.state_flood': 'security',
  'webhook.rejected': 'security',
  // A prior process died mid-run. Recovery worked; the crash still happened.
  'server.recovered': 'warning',
  'push.subscribed': 'info',
  'push.unsubscribed': 'info',
};

export function severityForKind(kind: PlatformEventKind): PlatformEventSeverity {
  return PLATFORM_EVENT_SEVERITY[kind];
}

/**
 * The emitter side of the layer. Deep domain modules (`src/projects/`,
 * `src/github/`) take one of these optionally instead of importing a store,
 * so the dependency arrow keeps pointing from the server at the domain.
 * Implementations are FAIL-OPEN: a sink never throws into a caller.
 */
export type PlatformEventSink = (input: PlatformEventInput) => void;

/** Schema-validated examples, parsed at module load (contracts convention). */
export const EXAMPLE_PLATFORM_EVENT_INPUT: PlatformEventInput =
  platformEventInputSchema.parse({
    kind: 'publication.failed',
    actorType: 'principal',
    actorId: '8f1c6f9e-1c2b-4f1a-9a3e-6d5b4c3a2b10',
    orgId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    projectId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    runId: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
    summary: 'Publication to GitHub failed after a delivered run',
    detail: { attempt: 1, retryable: true },
  });

export const EXAMPLE_PLATFORM_EVENT: PlatformEvent = platformEventSchema.parse({
  seq: 1,
  at: '2026-08-21T10:00:00.000Z',
  severity: severityForKind('org.created'),
  kind: 'org.created',
  actorType: 'principal',
  actorId: '8f1c6f9e-1c2b-4f1a-9a3e-6d5b4c3a2b10',
  orgId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  summary: 'New organisation created by its first login',
  detail: { provider: 'github' },
});
