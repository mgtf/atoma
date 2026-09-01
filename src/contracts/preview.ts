import { z } from 'zod';
import {
  organisationIdSchema,
  principalIdSchema,
  projectIdSchema,
  projectRunIdSchema,
} from './projects.js';

/**
 * RESULT PREVIEW — the shapes, once.
 * =================================
 *
 * A result preview is an authenticated organisation member opening the
 * application a DELIVERED project run produced, inside an isolated iframe, and
 * USING it. Design: `docs/result-preview-design-2026-08-28.md`.
 *
 * "Sandbox" is deliberately not this feature's word: it belongs to
 * `ToolSandbox`, which is in-process L1 tool confinement and NOT an isolation
 * boundary. The iframe `sandbox` attribute is a browser mechanism, not a name.
 *
 * THREE ROW SHAPES AND ONE PROJECTION, and the split is the safety property:
 *
 *   - a DESCRIPTOR is what delivery observed — immutable, one per delivered
 *     run, written from machine-observed facts (the probe manifest and the
 *     tool arguments that actually ran), never from model prose;
 *   - an INSTANCE is what is running right now — mutable, at most one per run,
 *     compare-and-set only, monotonic generation;
 *   - an EGRESS APPROVAL is what an org admin permitted, per project;
 *   - a SUMMARY is the only one of the four a browser ever receives.
 *
 * NOTHING here may carry a host filesystem path, a container or runtime id, a
 * token, a grant, an app log or an upstream body. `project_runs.error` already
 * leaked an absolute host path once (`src/contracts/AGENTS.md`); these rows are
 * served to tenants on the same surface.
 */

const instantSchema = z.string().datetime();

/* ─────────────────────────── deliverable identity ─────────────────────────── */

/**
 * What kind of thing the run delivered, as far as previewing goes.
 *
 * `static` is served by the gateway from a filtered copy with no container at
 * all; `node` needs the isolate. There is deliberately no third value: a
 * deliverable that is neither is `unavailable` with a reason, which is a
 * different axis and must not hide inside the kind.
 */
export const previewKindSchema = z.enum(['static', 'node']);

export const previewAvailabilitySchema = z.enum(['available', 'unavailable']);

/**
 * WHY a delivered run has no preview. Closed, bounded, and free of any path:
 * every value is renderable to a tenant as-is.
 *
 * `legacy-run` is the one value the WRITER never emits. It is what a READER
 * synthesises for a run delivered before this contract existed — there is no
 * backfill (design §12), so the absence of a row is itself the answer, and
 * naming it here keeps one vocabulary instead of two.
 */
export const previewUnavailableReasonSchema = z.enum([
  'legacy-run',
  'unsupported-deliverable',
  'not-runnable',
  'manifest-unreadable',
  'workspace-unreadable',
]);

/**
 * A workspace-relative entry file, e.g. `server.js` or `src/app.js`.
 *
 * LAST-LINE REFUSAL, NOT THE CANONICALISER. `normalizeArtifactPath`
 * (`src/projects/artifacts.ts`) owns the path rule and every writer passes
 * through it before persisting; this schema refuses the subset that must never
 * reach a row even if a future writer forgets. Keeping it a strict subset is
 * what stops it becoming a second definition of the same rule.
 */
export const previewEntrySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'entry must not be padded with whitespace')
  .refine((value) => !value.includes('\0') && !value.includes('\\'), 'entry must be a portable POSIX path')
  .refine((value) => !value.startsWith('/'), 'entry must be workspace-relative')
  .refine((value) => !value.endsWith('/'), 'entry must name a file')
  .refine((value) => !value.split('/').includes('..'), 'entry must not traverse')
  .refine((value) => !value.split('/').includes('.'), 'entry must be canonical')
  .refine((value) => !value.split('/').includes(''), 'entry must not contain empty segments');

/* ───────────────────────────── egress hostnames ───────────────────────────── */

const IPV4_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Suffixes that never name a public HTTPS service. Refused before persistence
 * so an approval can never be recorded for a destination that only exists
 * inside the deployment's own networks — the sidecar denies these ranges too,
 * and agreeing at both ends is the point (`src/tools/egressPolicy.ts` refuses
 * IP literals for the same reason: an allowlist is a list of NAMES).
 */
const RESERVED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.onion', '.arpa'];

/**
 * ONE exact, lower-case, public DNS name. No wildcards, no `.domain` subdomain
 * form, no ports, no scheme, no IP literal.
 *
 * The run REQUESTS these; only an org admin or owner APPROVES them (design §9).
 * Deliberately narrower than `DEFAULT_EGRESS_ALLOWLIST`'s two forms: a run's
 * dependency fetch is an operator-chosen allowlist, while this is a tenant
 * admin approving what generated code may reach from a member's browser, and a
 * subdomain wildcard there is a much larger promise than anyone means to make.
 */
export const previewEgressHostSchema = z
  .string()
  .min(4)
  .max(253)
  .refine((value) => value === value.toLowerCase(), 'host must be lower-case')
  .refine((value) => !value.endsWith('.'), 'host must not carry a trailing dot')
  .refine((value) => !IPV4_LIKE.test(value), 'host must be a name, never an IP literal')
  .refine((value) => !value.includes(':'), 'host must carry no port and no IPv6 literal')
  .refine((value) => {
    const labels = value.split('.');
    // At least two labels: a single label is a search-domain-relative name,
    // which resolves to something different on every host it is resolved from.
    return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
  }, 'host must be a dotted ASCII DNS name')
  .refine(
    (value) => !/^\d+$/.test(value.split('.').at(-1) ?? ''),
    'the last label must not be numeric'
  )
  .refine(
    (value) => !RESERVED_SUFFIXES.some((suffix) => value.endsWith(suffix)),
    'host must not use a reserved or private-network suffix'
  );

/** Requested hosts, as a set: unique, ordered, and bounded at sixteen. */
export const previewEgressHostsSchema = z
  .array(previewEgressHostSchema)
  .max(16)
  .refine((hosts) => new Set(hosts).size === hosts.length, 'requested hosts must be unique');

/* ──────────────────────────────── descriptor ──────────────────────────────── */

/**
 * What delivery observed about a run's deliverable. Immutable: written once,
 * inside the delivery path, and never revised — a preview that changed its
 * mind about what a run produced would be describing a workspace that has not
 * changed, and the run corpus is evidence.
 */
export const previewDescriptorSchema = z
  .object({
    projectRunId: projectRunIdSchema,
    projectId: projectIdSchema,
    orgId: organisationIdSchema,
    availability: previewAvailabilitySchema,
    kind: previewKindSchema.nullable(),
    entry: previewEntrySchema.nullable(),
    unavailableReason: previewUnavailableReasonSchema.nullable(),
    requestedHosts: previewEgressHostsSchema,
    createdAt: instantSchema,
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    if (descriptor.availability === 'available') {
      if (descriptor.kind === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['kind'],
          message: 'an available preview must name its kind',
        });
      }
      if (descriptor.unavailableReason !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailableReason'],
          message: 'an available preview carries no unavailability reason',
        });
      }
      // A static preview has no start command at all, so an entry on one would
      // be a value nothing reads — and a value nothing reads is a value that
      // drifts.
      if (descriptor.kind === 'node' && descriptor.entry === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entry'],
          message: 'a node preview must resolve its entry at delivery time',
        });
      }
      if (descriptor.kind === 'static' && descriptor.entry !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entry'],
          message: 'a static preview has no entry',
        });
      }
      return;
    }
    if (descriptor.unavailableReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailableReason'],
        message: 'an unavailable preview must say why',
      });
    }
    if (descriptor.kind !== null || descriptor.entry !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'an unavailable preview names neither kind nor entry',
      });
    }
  });

/* ───────────────────────────────── instance ───────────────────────────────── */

/**
 * Closed and monotonic WITHIN a generation (design §10):
 *
 *   stopped -> starting -> ready -> stopping -> stopped
 *                       \-> failed -> stopped on the next explicit open
 */
export const previewStateSchema = z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']);

/** Why a preview stopped. Measured per cause (design §16), so it is closed. */
export const previewStopReasonSchema = z.enum([
  'idle',
  'hard-expiry',
  'manual',
  'restart',
  'crash',
  'logout',
  'policy-change',
]);

/**
 * What the member is told when a start does not reach `ready`. Bounded codes
 * only — never raw Docker output, container logs, upstream bodies or paths.
 */
export const previewErrorCodeSchema = z.enum([
  'copy-limit',
  'readiness-timeout',
  'server-exited',
  'wrong-port',
  'runtime-unavailable',
  'launcher-unavailable',
  'image-unavailable',
  'gateway-unavailable',
  'internal',
]);

/**
 * WHICH ISOLATION ACTUALLY SERVED A GENERATION.
 *
 * `runsc` is the production requirement and `runc` is reachable only through
 * the loud dev-only escape hatch that refuses to boot behind the auth gate
 * (design §15). Recording which one ran is not bookkeeping: the two are
 * different security boundaries, and a row that does not say which it was
 * cannot answer the question afterwards.
 */
export const previewRuntimeSchema = z.enum(['runsc', 'runc']);

/**
 * WHAT THIS GENERATION IS SHOWING.
 *
 * `delivered` is the immutable deliverable a finished run produced, described
 * once by its descriptor. `in-flight` is a SNAPSHOT of a run still building,
 * taken at the moment it was opened — a different thing, and a surface that
 * could not tell them apart would let a member read unfinished work as
 * finished. See `docs/in-flight-preview-2026-09-02.md`.
 */
export const previewSourceSchema = z.enum(['delivered', 'in-flight']);

/** A pinned image, by digest. A mutable tag is not an identity. */
export const previewImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * The live row. At most one per run, compare-and-set only.
 *
 * `generation` is monotonic and is the browser ORIGIN's identity: a restart
 * mints a new one so stale service workers, storage and caches from a previous
 * generation can never control the next (design §8).
 *
 * IT CARRIES ITS OWN ATTRIBUTION, and that is the Lovable rollout lesson
 * applied here rather than deferred: the review of 2026-08-26 measured that
 * `atoma-worker:latest` gives "ni artefact immuable ni rollback attribuable",
 * and asked every unit of work to persist the exact runtime that served it
 * (`docs/lovable-lessons-atoma-2026-08-26.md` §2). Without `imageDigest` and
 * `runtime` on the row, an operator can roll a preview image back but cannot
 * say what served the generation a member is complaining about. Both stay
 * server-side: `previewSummarySchema` deliberately does not carry them.
 */
export const previewInstanceSchema = z
  .object({
    projectRunId: projectRunIdSchema,
    orgId: organisationIdSchema,
    state: previewStateSchema,
    generation: z.number().int().positive(),
    /** Null for a static preview, which runs no container at all. */
    imageDigest: previewImageDigestSchema.nullable(),
    runtime: previewRuntimeSchema.nullable(),
    source: previewSourceSchema.default('delivered'),
    /** When the snapshot was taken. Null for a delivered preview. */
    snapshotAt: instantSchema.nullable().default(null),
    startedAt: instantSchema.nullable(),
    readyAt: instantSchema.nullable(),
    lastActivityAt: instantSchema.nullable(),
    expiresAt: instantSchema.nullable(),
    errorCode: previewErrorCodeSchema.nullable(),
    lastStopReason: previewStopReasonSchema.nullable(),
    updatedAt: instantSchema,
  })
  .strict()
  .superRefine((instance, ctx) => {
    if (instance.state !== 'failed' && instance.errorCode !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'only a failed preview carries an error code',
      });
    }
    if (instance.state === 'failed' && instance.errorCode === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'a failed preview must name a bounded error code',
      });
    }
    if (instance.state === 'ready' && instance.readyAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readyAt'],
        message: 'a ready preview records when it became ready',
      });
    }
  });

/* ────────────────────────────── egress approval ───────────────────────────── */

/** One host an org admin or owner approved for one project. Attributable. */
export const previewEgressApprovalSchema = z
  .object({
    projectId: projectIdSchema,
    orgId: organisationIdSchema,
    host: previewEgressHostSchema,
    approvedByPrincipalId: principalIdSchema,
    approvedAt: instantSchema,
  })
  .strict();

/* ─────────────────────────────── public summary ───────────────────────────── */

/**
 * THE ONLY SHAPE A BROWSER RECEIVES. An explicit allowlist rather than a
 * projection of the rows above, because a projection acquires whatever a row
 * gains next — which is how `projectRunPublicSchema` came to need an audit.
 */
export const previewSummarySchema = z
  .object({
    availability: previewAvailabilitySchema,
    kind: previewKindSchema.nullable(),
    reason: previewUnavailableReasonSchema.nullable(),
    state: previewStateSchema,
    generation: z.number().int().nonnegative(),
    source: previewSourceSchema.default('delivered'),
    /**
     * When the snapshot behind an in-flight preview was taken. Null for a
     * delivered one. A surface that cannot say "as of 14:32" lets a member
     * read a snapshot as the present.
     */
    snapshotAt: instantSchema.nullable().default(null),
    readyAt: instantSchema.nullable(),
    expiresAt: instantSchema.nullable(),
    errorCode: previewErrorCodeSchema.nullable(),
    /** What the run asked to reach. */
    requestedHosts: previewEgressHostsSchema,
    /** The intersection with what this project's admins approved. */
    allowedHosts: previewEgressHostsSchema,
    /** Requested but not approved: visible, and not a reason to refuse a start. */
    blockedHosts: previewEgressHostsSchema,
  })
  .strict();

export type PreviewKind = z.infer<typeof previewKindSchema>;
export type PreviewAvailability = z.infer<typeof previewAvailabilitySchema>;
export type PreviewUnavailableReason = z.infer<typeof previewUnavailableReasonSchema>;
export type PreviewState = z.infer<typeof previewStateSchema>;
export type PreviewStopReason = z.infer<typeof previewStopReasonSchema>;
export type PreviewErrorCode = z.infer<typeof previewErrorCodeSchema>;
export type PreviewRuntime = z.infer<typeof previewRuntimeSchema>;
export type PreviewSource = z.infer<typeof previewSourceSchema>;
export type PreviewDescriptor = z.infer<typeof previewDescriptorSchema>;
export type PreviewInstance = z.infer<typeof previewInstanceSchema>;
export type PreviewEgressApproval = z.infer<typeof previewEgressApprovalSchema>;
export type PreviewSummary = z.infer<typeof previewSummarySchema>;

/**
 * Parsed at module load, like every other contract example in this directory:
 * a schema whose own example stopped parsing must fail the suite immediately,
 * not at the first row a deployment writes.
 */
export const EXAMPLE_NODE_DESCRIPTOR: PreviewDescriptor = previewDescriptorSchema.parse({
  projectRunId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  availability: 'available',
  kind: 'node',
  entry: 'server.js',
  unavailableReason: null,
  requestedHosts: ['api.example.com'],
  createdAt: '2026-08-31T12:00:00.000Z',
});

export const EXAMPLE_UNAVAILABLE_DESCRIPTOR: PreviewDescriptor = previewDescriptorSchema.parse({
  projectRunId: '44444444-4444-4444-8444-444444444444',
  projectId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  availability: 'unavailable',
  kind: null,
  entry: null,
  unavailableReason: 'unsupported-deliverable',
  requestedHosts: [],
  createdAt: '2026-08-31T12:00:00.000Z',
});
