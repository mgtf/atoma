import { updateOrgModels } from '../auth/orgModels.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthStore, Viewer } from '../auth/store.js';
import { platformEventKindSchema, PLATFORM_EVENT_FAMILIES } from '../contracts/platformEvents.js';
import { SUPPORTED_LOCALES } from '../contracts/locales.js';
import type { LedgerEventKind } from '../core/ledger.js';
import type { PlatformEventLog } from '../platform/events.js';
import type { PreviewHttpService } from '../preview/httpService.js';
import { ProjectHttpError, roleAtLeast, type ProjectService } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { resolveProjectRunTraceFile } from '../projects/store.js';
import type { SentinelHealth } from '../sentinel/resident.js';
import { sentinelRuleTable } from '../sentinel/rules.js';
import type { ResidentAnalystHealth } from '../supervisor/resident.js';
import type { PushLocale } from '../viz/push/routes.js';
import type { TrayPage } from '../viz/push/tray.js';
import { callerTier, tierAllows, type McpCaller, type McpTier } from './identity.js';
import { registerPrompts } from './prompts.js';
import {
  costs,
  families,
  friction,
  ledgerCheck,
  ledgerTail,
  registryHistory,
  registryList,
  registryShow,
  runTrace,
  runTraceFile,
  runsList,
  skillShow,
  skillsList,
  skillsReview,
  skillsStats,
  verdictShow,
  verdictsList,
} from './readers.js';
import { registerResources } from './resources.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_GOAL_CHARS,
  MAX_STATUS_WAIT_MS,
  RunRejected,
  cancelRun as cancelOperatorRun,
  runStatusWait as operatorRunStatusWait,
  startRun as startOperatorRun,
} from './run.js';
import { WriteRefused, registryRollback, skillDrop, skillMerge, skillReset, type OperatorActor } from './writes.js';

/**
 * THE CATALOGUE — every `atoma_*` tool, its minimum tier, and what it needs
 * from the host. ONE table, so `tools/list` for a caller, the docs' tool
 * count, and the tier a call re-checks all read the same rows.
 *
 * TIERS (`identity.ts`):
 *   viewer   — read an organisation's projects, runs and traces
 *   member   — start, cancel and publish that organisation's runs
 *   admin    — the organisation's members and model defaults
 *   platform — the instance: operator runs, registry, skills, ledger, the
 *              operator run corpus, friction, the journal, every organisation
 *
 * NEEDS. A tool is registered only when the host can honour it: the tenant
 * tools need the gated projects runtime, the journal tool needs a journal,
 * the operator tools need the store on disk. A caller whose tier admits a
 * tool the host cannot honour simply does not see it — the ungated loopback
 * server has no organisations, so the operator there sees the operator tools
 * and nothing tenant-shaped.
 *
 * WRITES ARE BOUND TO THE CALLER'S ACTIVE ORGANISATION, as the HTTP routes
 * bind them: a platform admin READS every organisation's projects and traces
 * (`ProjectService.listProjects` already does) but starts runs only in their
 * own. A run's trace, output and skill bodies are UNTRUSTED model text and
 * the payloads say so, unchanged from the stdio server.
 */

export interface McpToolDeps {
  /** The gated tenant runtime; null on the ungated loopback path. */
  readonly projects: { readonly service: ProjectService; readonly store: ProjectStore } | null;
  readonly auth: AuthStore | null;
  /** `subscribe` is what lets a session learn a project run finished (resources). */
  readonly journal: (Pick<PlatformEventLog, 'list'> & Partial<Pick<PlatformEventLog, 'subscribe'>>) | null;
  readonly emit?: PlatformEventSink;
  /** Whether this host may spawn operator-corpus runs (the machine's own runner). */
  readonly operatorRuns: boolean;
  /**
   * The preview service, read at CALL time: the preview runtime comes up
   * asynchronously after the server binds, and a deployment without one
   * answers "not available" exactly as the HTTP route does.
   */
  readonly preview?: () => Pick<PreviewHttpService, 'status' | 'open' | 'stop'> | null;
  /** The resident watch's health and the analyst's, read at call time. */
  readonly sentinel?: () => SentinelHealth;
  readonly analyst?: () => ResidentAnalystHealth | null;
  /** The viewer's notification tray — the same builder `/api/notifications` reads. */
  readonly notifications?: (input: {
    principalId: string;
    locale: PushLocale;
    before?: number;
    limit?: number;
  }) => TrayPage;
}

export type McpToolNeed = 'projects' | 'auth' | 'journal' | 'operator-runs' | 'notifications';

export interface McpToolSpec {
  readonly name: string;
  readonly tier: McpTier;
  readonly needs: readonly McpToolNeed[];
  readonly register: (server: McpServer, ctx: McpToolContext) => void;
}

export interface McpToolContext {
  readonly caller: McpCaller;
  readonly tier: McpTier;
  readonly deps: McpToolDeps;
  /** The viewer for tenant tools; throws on the operator path, which has none. */
  readonly viewer: () => Viewer;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Every payload goes out TWICE: as the text block every host renders, and as
 * `structuredContent` for the hosts that read typed results. The text is what
 * a model sees; the structure is what a script keeps. Arrays and scalars have
 * no structured form (the protocol wants an object) and travel as text only.
 */
function jsonResult(payload: unknown): ToolResult {
  const text = JSON.stringify(payload, null, 2);
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { structuredContent: payload as Record<string, unknown> }
      : {};
  return { content: [{ type: 'text', text }], ...structured };
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * `notifications/progress` for a host that sent a progress token — the SDK
 * hands the token in `_meta` and the sender in `extra`; with no token there is
 * nobody listening and nothing is sent. Failures to deliver are swallowed: a
 * progress line is a courtesy, the tool result is the contract.
 */
function progressSender(extra: ToolExtra): ((progress: number, message: string) => void) | null {
  const token = extra._meta?.progressToken;
  if (token === undefined) return null;
  return (progress, message) => {
    void extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress, message },
    }).catch(() => {});
  };
}

/** Bound a caller's `waitMs` to the long-poll cap; absent or nonsense means no wait. */
function boundedWait(waitMs: number | undefined): number {
  return typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0 ? Math.min(Math.trunc(waitMs), MAX_STATUS_WAIT_MS) : 0;
}

/** `waitMs` argument shared by both status tools, described once. */
const WAIT_MS_ARG = z
  .number()
  .int()
  .min(0)
  .max(MAX_STATUS_WAIT_MS)
  .optional()
  .describe(`Long-poll: hold the call until the run changes or this many ms elapse (max ${MAX_STATUS_WAIT_MS}). Send a progress token to receive notifications/progress while waiting.`);

/**
 * Poll a snapshot until it differs from the first one or the wait elapses —
 * the project-run half of `waitMs`, where the truth lives in the tenant store
 * rather than in this process. Coarse by design: a second between reads is
 * nothing beside a run that takes minutes.
 */
async function untilChanged<T>(read: () => T, waitMs: number, onTick?: (value: T) => void): Promise<T> {
  const first = read();
  if (waitMs === 0) return first;
  const before = JSON.stringify(first);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, Math.min(1000, deadline - Date.now())));
    const now = read();
    if (JSON.stringify(now) !== before) {
      onTick?.(now);
      return now;
    }
  }
  return read();
}

/** Who a write is attributed to: the principal behind the token, or the operator by possession. */
function actorOf(ctx: McpToolContext): OperatorActor {
  return ctx.caller.kind === 'principal'
    ? { kind: 'principal', principalId: ctx.caller.viewer.principalId, orgId: ctx.caller.viewer.orgId, label: `mcp:${ctx.caller.viewer.principalId}` }
    : { kind: 'operator', label: 'mcp:operator' };
}

const TRAY_LOCALES = SUPPORTED_LOCALES as unknown as [PushLocale, ...PushLocale[]];

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Domain refusals become tool errors the host can show; anything else propagates. */
async function guarded(work: () => unknown): Promise<ToolResult> {
  try {
    return jsonResult(await work());
  } catch (error) {
    if (error instanceof ProjectHttpError) return errorResult(`refused (${error.status}): ${error.message}`);
    if (error instanceof RunRejected) return errorResult(`refused: ${error.message}`);
    if (error instanceof McpToolRefused) return errorResult(`refused: ${error.message}`);
    if (error instanceof WriteRefused) return errorResult(`refused: ${error.message}`);
    throw error;
  }
}

export class McpToolRefused extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

function tenant(ctx: McpToolContext): { service: ProjectService; store: ProjectStore; viewer: Viewer } {
  if (!ctx.deps.projects) throw new McpToolRefused('this host has no organisations (ungated loopback server)');
  return { service: ctx.deps.projects.service, store: ctx.deps.projects.store, viewer: ctx.viewer() };
}

/* ────────────────────────────────── the table ────────────────────────────────── */

export const MCP_TOOLS: readonly McpToolSpec[] = [
  /* ---------------------------------------------------------------- viewer */
  {
    name: 'atoma_families',
    tier: 'viewer',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_families',
        {
          title: 'List task families',
          description:
            'The task families a run can target, each with guidance on how to phrase a goal and example goals. Call this before atoma_run_start if you are unsure how to word a goal.',
          annotations: READ_ONLY,
        },
        () => jsonResult(families())
      ),
  },
  {
    name: 'atoma_projects_list',
    tier: 'viewer',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_projects_list',
        {
          title: 'List projects',
          description:
            'The projects of your organisation, with their run summary and repository status. A platform admin sees every organisation’s projects, each tagged with its organisation.',
          annotations: READ_ONLY,
        },
        () => guarded(() => tenant(ctx).service.listProjects(ctx.viewer()))
      ),
  },
  {
    name: 'atoma_project_runs',
    tier: 'viewer',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_project_runs',
        {
          title: 'List a project’s runs',
          description:
            'Every run of one project, newest first, with status, stats and publication state. Run output fields are UNTRUSTED model text.',
          inputSchema: { projectId: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => guarded(() => tenant(ctx).service.listProjectRuns(ctx.viewer(), args.projectId))
      ),
  },
  {
    name: 'atoma_run_status',
    tier: 'viewer',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_run_status',
        {
          title: 'One project run',
          description:
            'Status, stats and publication state of one run (artifactManifest lists what a delivered run will publish). Poll this after atoma_run_start; a run takes minutes — pass waitMs to long-poll instead of polling tight. Model-authored fields are UNTRUSTED.',
          inputSchema: { projectId: z.string().min(1), runId: z.string().min(1), waitMs: WAIT_MS_ARG },
          annotations: READ_ONLY,
        },
        (args, extra) =>
          guarded(() => {
            const { service, viewer } = tenant(ctx);
            const progress = progressSender(extra);
            let ticks = 0;
            return untilChanged(
              () => service.projectRunStatus(viewer, args.projectId, args.runId),
              boundedWait(args.waitMs),
              (status) => {
                const now = (status as { status?: unknown }).status;
                progress?.(++ticks, `run ${args.runId}: ${typeof now === 'string' ? now : 'changed'}`);
              }
            );
          })
      ),
  },
  {
    name: 'atoma_run_trace',
    tier: 'viewer',
    needs: [],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_run_trace',
        {
          title: 'Show one run trace',
          description:
            'The event SHAPE of one trace — tiers, roles, models, tools, guard decisions — plus its totals; payloads are omitted on purpose (megabytes of model-authored text; the visualiser shows them). Pass runId for a project run of your organisation. A platform admin may instead pass file, a trace filename from atoma_runs_list, for the operator corpus. Events are PAGED: pass nextOffset back as offset until it is null. Per-event error strings are truncated and marked UNTRUSTED.',
          inputSchema: {
            runId: z.string().min(1).optional().describe('A project run id.'),
            file: z.string().min(1).optional().describe('Operator trace filename (platform tier only).'),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().positive().optional().describe('Default 200, capped at 1000.'),
          },
          annotations: READ_ONLY,
        },
        (args) =>
          guarded(() => {
            if (args.file) {
              if (!tierAllows(ctx.tier, 'platform')) throw new McpToolRefused('operator traces need the platform tier; pass runId instead');
              return runTrace({ file: args.file, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) });
            }
            if (!args.runId) throw new McpToolRefused('pass runId (a project run) or, as a platform admin, file');
            const { store, viewer } = tenant(ctx);
            const run = store.getProjectRun(viewer.orgId, args.runId) ?? (viewer.platformAdmin ? store.getProjectRunAnyOrg(args.runId) : null);
            if (!run) throw new ProjectHttpError(404, 'project run not found');
            const path = resolveProjectRunTraceFile({ projectRunId: run.projectRunId, runsPath: run.hostPaths.runsPath, traceId: run.traceId });
            if (!path) throw new ProjectHttpError(404, 'this run has no trace yet');
            return runTraceFile(path, { ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) });
          })
      ),
  },

  {
    name: 'atoma_run_preview',
    tier: 'viewer',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_run_preview',
        {
          title: 'Preview of a project run',
          description:
            'The live preview of one run’s deliverable: omit action to read its state (allocates nothing). Members may pass action "open" (start or reuse the preview; a ready one returns a URL carrying a ONE-TIME claim — hand it to the person, never store it; a starting one answers with retryAfterSeconds) or "stop". inFlight asks for a snapshot of a run still going; the host decides whether one is what you get.',
          inputSchema: {
            projectId: z.string().min(1),
            runId: z.string().min(1),
            action: z.enum(['open', 'stop']).optional(),
            inFlight: z.boolean().optional(),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        (args) =>
          guarded(async () => {
            const { viewer } = tenant(ctx);
            const preview = ctx.deps.preview?.() ?? null;
            if (!preview) throw new ProjectHttpError(503, 'previews are not available on this deployment');
            if (!args.action) return preview.status(viewer, args.projectId, args.runId);
            if (!tierAllows(ctx.tier, 'member') || !roleAtLeast(viewer.role, 'org:member')) {
              throw new ProjectHttpError(403, 'org:member role or above is required to open or stop previews');
            }
            if (args.action === 'stop') return preview.stop(viewer, args.projectId, args.runId);
            const answered = await preview.open(viewer, args.projectId, args.runId, { inFlight: args.inFlight === true });
            return { httpStatus: answered.status, ...answered.body };
          })
      ),
  },
  {
    name: 'atoma_notifications',
    tier: 'viewer',
    needs: ['projects', 'auth', 'journal', 'notifications'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_notifications',
        {
          title: 'Your notification tray',
          description:
            'The journal rows that were (or would have been) pushed to YOU, resolved against your current roles — finished runs, publications, invitations, announcements. Newest first; page with before. Titles and bodies are rendered copy, never model text.',
          inputSchema: {
            locale: z.enum(TRAY_LOCALES).optional().describe('Copy language; defaults to English.'),
            before: z.number().int().positive().optional(),
            limit: z.number().int().positive().max(50).optional(),
          },
          outputSchema: {
            notifications: z.array(z.record(z.unknown())),
            nextBefore: z.number().nullable(),
          },
          annotations: READ_ONLY,
        },
        (args) =>
          guarded(() =>
            ctx.deps.notifications!({
              principalId: ctx.viewer().principalId,
              locale: args.locale ?? 'en',
              ...(args.before !== undefined ? { before: args.before } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            })
          )
      ),
  },

  /* ---------------------------------------------------------------- member */
  {
    name: 'atoma_project_create',
    tier: 'member',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_project_create',
        {
          title: 'Create a project',
          description:
            'Create a project in your organisation, bound to a GitHub installation linked to it (atoma_projects_list shows the installations through the web console). The payload shape is the console’s: name, slug, family, repositoryTarget { installationId, owner, name, visibility }.',
          inputSchema: { project: z.record(z.unknown()).describe('createProjectInput, as the web console sends it.') },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        (args) => guarded(() => tenant(ctx).service.createProjectFromInput(ctx.viewer(), args.project))
      ),
  },
  {
    name: 'atoma_run_start',
    tier: 'member',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_run_start',
        {
          title: 'Start a project run',
          description:
            'Start a run in one of your organisation’s projects and return immediately; poll atoma_run_status. Runs are SERIALISED on this instance (one at a time, a second is queued or refused) and spend the organisation’s configured provider. The goal is prose describing the artefact; do not name tools in it. requestKey makes the call idempotent.',
          inputSchema: {
            projectId: z.string().min(1),
            goal: z.string().min(1).max(MAX_GOAL_CHARS),
            idempotencyKey: z.string().min(1).max(200).optional().describe('Idempotency key; the same key returns the same run.'),
          },
          annotations: MUTATING,
        },
        (args) =>
          guarded(() =>
            tenant(ctx).service.startProjectRunFromInput(ctx.viewer(), args.projectId, {
              goal: args.goal,
              idempotencyKey: args.idempotencyKey ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            })
          )
      ),
  },
  {
    name: 'atoma_run_cancel',
    tier: 'member',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_run_cancel',
        {
          title: 'Cancel a project run',
          description: 'Request cancellation of one run of your organisation. The run’s process group is signalled; the trace closes.',
          inputSchema: { projectId: z.string().min(1), runId: z.string().min(1) },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (args) => guarded(() => tenant(ctx).service.cancelProjectRun(ctx.viewer(), args.projectId, args.runId))
      ),
  },
  {
    name: 'atoma_publication_retry',
    tier: 'member',
    needs: ['projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_publication_retry',
        {
          title: 'Retry publishing a delivered run',
          description: 'Re-drive the GitHub publication of a delivered run whose publication never reached the repository.',
          inputSchema: { projectId: z.string().min(1), runId: z.string().min(1) },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        (args) => guarded(() => tenant(ctx).service.retryPublication(ctx.viewer(), args.projectId, args.runId))
      ),
  },

  /* ----------------------------------------------------------------- admin */
  {
    name: 'atoma_org_members',
    tier: 'admin',
    needs: ['auth', 'projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_org_members',
        {
          title: 'Organisation members',
          description: 'The members of your organisation and their roles.',
          annotations: READ_ONLY,
        },
        () =>
          guarded(() => {
            const viewer = ctx.viewer();
            const org = ctx.deps.auth!.getOrganisationWithMembers(viewer.orgId);
            return org ? { orgId: org.orgId, name: org.name, members: org.members } : null;
          })
      ),
  },
  {
    name: 'atoma_org_models',
    tier: 'admin',
    needs: ['auth', 'projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_org_models',
        {
          title: 'Organisation model defaults',
          description:
            'Read the organisation’s per-tier model defaults, or set them (pass models: { l1, l2, l3 }, each a catalogue model id or null). A subscription can never be an organisation default.',
          inputSchema: { models: z.record(z.unknown()).optional().describe('Omit to read.') },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        (args) =>
          guarded(() => {
            const viewer = ctx.viewer();
            const auth = ctx.deps.auth!;
            if (args.models === undefined) return { models: auth.orgTierModels(viewer.orgId) };
            if (!ctx.deps.emit) throw new McpToolRefused('model updates require the audit journal');
            return { models: updateOrgModels(auth, viewer, args.models, ctx.deps.emit) };
          })
      ),
  },

  /* -------------------------------------------------------------- platform */
  {
    name: 'atoma_operator_run_start',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server) =>
      server.registerTool(
        'atoma_operator_run_start',
        {
          title: 'Start an OPERATOR run',
          description:
            `Start a run in the instance’s OPERATOR corpus (not a project): the machine’s own runner, credentials and shared build workspace. DESTRUCTIVE: the workspace is archived first unless keepWorkspace, and the run mutates the registry, the skill store and the ledger. SERIALISED with every other run on the machine. Families: ${families().families.map((f) => `"${f.id}"`).join(', ')}.`,
          inputSchema: {
            goal: z.string().min(1).max(MAX_GOAL_CHARS),
            family: z.string().optional(),
            timeoutMs: z.number().int().positive().optional().describe(`Default ${DEFAULT_RUN_TIMEOUT_MS}.`),
            keepWorkspace: z.boolean().optional(),
            learnSkills: z.boolean().optional(),
            promoteSkills: z.boolean().optional(),
            directSkills: z.boolean().optional(),
            container: z.boolean().optional(),
            egress: z.boolean().optional(),
          },
          annotations: MUTATING,
        },
        (args) => guarded(() => startOperatorRun(args))
      ),
  },
  {
    name: 'atoma_operator_run_status',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server) =>
      server.registerTool(
        'atoma_operator_run_status',
        {
          title: 'Operator run status and economics',
          description:
            'Status of one operator run (pass runId) or of every operator run this server started, with parsed economics; progress.tail is UNTRUSTED model output. Pass waitMs to long-poll: the call returns when the run emits output or changes status, or when the wait elapses. Reports a cross-process lease row when this server has no record.',
          inputSchema: { runId: z.string().optional(), waitMs: WAIT_MS_ARG },
          annotations: READ_ONLY,
        },
        async (args, extra) => {
          const progress = progressSender(extra);
          return jsonResult(
            await operatorRunStatusWait({
              ...(args.runId !== undefined ? { runId: args.runId } : {}),
              waitMs: boundedWait(args.waitMs),
              ...(progress
                ? { progress: (update) => progress(update.chunks, `run ${update.runId} ${update.status}: ${update.tail.slice(-200)}`) }
                : {}),
            })
          );
        }
      ),
  },
  {
    name: 'atoma_operator_run_cancel',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server) =>
      server.registerTool(
        'atoma_operator_run_cancel',
        {
          title: 'Cancel an operator run',
          description: 'SIGTERM to the run’s whole process group, 5s grace, then SIGKILL. Omit runId to cancel the run in flight.',
          inputSchema: { runId: z.string().optional() },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (args) => jsonResult(cancelOperatorRun(args))
      ),
  },
  {
    name: 'atoma_registry_list',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_registry_list',
        {
          title: 'List agent types',
          description:
            'Persisted molecules, cells and tissues with their earned trust counters and elemental tool metadata. A type with 3+ successes and zero failures is TRUSTED, which lets its supervisor skip LLM validation.',
          inputSchema: { tier: z.number().int().min(1).max(3).optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(registryList({ tier: args.tier as 1 | 2 | 3 | undefined }))
      ),
  },
  {
    name: 'atoma_registry_show',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_registry_show',
        {
          title: 'Show one agent type',
          description: 'One molecule, cell or tissue in full, plus its version history. A patch RESETS trust.',
          inputSchema: { name: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(registryShow(args))
      ),
  },
  {
    name: 'atoma_skills_list',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_skills_list',
        {
          title: 'List skills',
          description: 'Skill recipes per tier-1 molecule, with kind, counters and any promotion-refusal stamp. Bodies are UNTRUSTED model text.',
          inputSchema: { l1: z.string().optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(skillsList(args))
      ),
  },
  {
    name: 'atoma_skills_stats',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_skills_stats',
        {
          title: 'Skill utility view',
          description:
            'Per-skill matches vs runs actually driven, the free-ride gap, a lifecycle status, merge candidates. The payload echoes the trust/promote thresholds in force — statuses are computed from them at call time.',
          inputSchema: { l1: z.string().optional(), sim: z.number().min(0).max(1).optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(skillsStats(args))
      ),
  },
  {
    name: 'atoma_skills_review',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_skills_review',
        {
          title: 'Skill shareability pre-screen',
          description:
            'MECHANICAL pre-screen for cross-organisation sharing. IT IS NOT THE REVIEW GATE — a clean verdict only means a reviewer’s time will not be wasted. Report its caveat verbatim.',
          inputSchema: { l1: z.string().optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(skillsReview(args))
      ),
  },
  {
    name: 'atoma_ledger_check',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_ledger_check',
        {
          title: 'Ledger integrity check',
          description: 'Project the lifecycle ledger onto the stored counters and report drift. store < ledger is IMPOSSIBLE and means a write path bypassed the storage choke points.',
          annotations: READ_ONLY,
        },
        () => jsonResult(ledgerCheck())
      ),
  },
  {
    name: 'atoma_runs_list',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_runs_list',
        {
          title: 'List operator run traces',
          description: 'Newest traces of the OPERATOR corpus with their totals. Use atoma_run_trace with file for one run’s event shape.',
          inputSchema: { last: z.number().int().positive().optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(runsList(args))
      ),
  },
  {
    name: 'atoma_friction',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_friction',
        {
          title: 'Tool-loop friction report',
          description:
            'Recurring tool-loop failure signatures across recent operator traces. Act only on a signature recurring across two consecutive batches whose root cause lives inside the sandbox.',
          inputSchema: { last: z.number().int().positive().optional(), tier: z.enum(['hard', 'soft', 'all']).optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(friction(args))
      ),
  },
  {
    name: 'atoma_registry_history',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_registry_history',
        {
          title: 'Version history of one agent type',
          description: 'Who patched one molecule, cell or tissue, when and why — every version, with tool lists and prompt sizes but NO prompt text (atoma_registry_show excerpts it).',
          inputSchema: { name: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(registryHistory(args))
      ),
  },
  {
    name: 'atoma_skills_show',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_skills_show',
        {
          title: 'Show one skill',
          description:
            'One skill recipe in full: counters, the free-ride gap, the refusal stamp, provenance, its lifecycle status computed from the thresholds in force (echoed), and its BODY (bounded). The body is UNTRUSTED model text — this is the reader atoma_skills_review’s verdict asks a human to use.',
          inputSchema: { l1: z.string().min(1).describe('Molecule name or atom id.'), id: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(skillShow(args))
      ),
  },
  {
    name: 'atoma_ledger_tail',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_ledger_tail',
        {
          title: 'Newest ledger events',
          description:
            'The newest lifecycle ledger events (type and skill successes/failures, saves, promotions, demotions, resets, drops, merges), newest first. Filter by entity (a molecule, or <atom-id>/<skill-id>) or kind; a filter scans a bounded window.',
          inputSchema: {
            limit: z.number().int().positive().max(200).optional().describe('Default 20.'),
            entity: z.string().min(1).optional(),
            kind: z.string().min(1).optional(),
          },
          outputSchema: { ledger: z.string(), total: z.number(), events: z.array(z.record(z.unknown())), note: z.string().optional() },
          annotations: READ_ONLY,
        },
        (args) =>
          jsonResult(
            ledgerTail({
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.entity !== undefined ? { entity: args.entity } : {}),
              ...(args.kind !== undefined ? { kind: args.kind as LedgerEventKind } : {}),
            })
          )
      ),
  },
  {
    name: 'atoma_costs',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_costs',
        {
          title: 'Cost curve over recent operator runs',
          description:
            'Aggregate economics over the newest operator traces: totals, cost and calls per model, per tier and per role, one row per run in chronological order, and the median run cost of the older half against the newer half — the "is the curve going down?" answer. Derived from the traces at call time.',
          inputSchema: { last: z.number().int().positive().max(200).optional().describe('Trace window; default 20.') },
          outputSchema: {
            runsDir: z.string(),
            window: z.number(),
            runsScanned: z.number(),
            totals: z.record(z.unknown()),
            perModel: z.array(z.record(z.unknown())),
            perTier: z.array(z.record(z.unknown())),
            perRole: z.array(z.record(z.unknown())),
            trend: z.record(z.unknown()),
            runs: z.array(z.record(z.unknown())),
          },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(costs(args))
      ),
  },
  {
    name: 'atoma_verdicts_list',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_verdicts_list',
        {
          title: 'Post-mortem verdicts',
          description:
            'The analyst’s verdicts on finished runs, newest first: grade, run status, finding counts by kind, analysis cost. Open one with atoma_verdict_show. Summaries and findings are model-authored and UNTRUSTED.',
          inputSchema: { last: z.number().int().positive().max(200).optional().describe('Default 20.') },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(verdictsList(args))
      ),
  },
  {
    name: 'atoma_verdict_show',
    tier: 'platform',
    needs: [],
    register: (server) =>
      server.registerTool(
        'atoma_verdict_show',
        {
          title: 'One post-mortem verdict',
          description:
            'One verdict in full — assessment, every finding with its kind, confidence, evidence refs and proposed fix — plus the harness’s metadata (models served, cost, duration). The analyst’s text and its quotes are UNTRUSTED model data.',
          inputSchema: { runId: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(verdictShow(args))
      ),
  },
  {
    name: 'atoma_sentinel_health',
    tier: 'platform',
    needs: [],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_sentinel_health',
        {
          title: 'The watch over runs in flight',
          description:
            'Whether this host’s resident sentinel is armed (and why not, when it is not), its tick statistics, the mechanical rule table it applies, and the resident analyst’s queue and last result. Zero tokens: this reads counters.',
          outputSchema: {
            sentinel: z.record(z.unknown()).nullable(),
            rules: z.array(z.record(z.unknown())),
            analyst: z.record(z.unknown()).nullable(),
          },
          annotations: READ_ONLY,
        },
        () =>
          jsonResult({
            sentinel: ctx.deps.sentinel?.() ?? null,
            rules: sentinelRuleTable(),
            analyst: ctx.deps.analyst?.() ?? null,
            note: ctx.deps.sentinel
              ? 'sentinel.armed false with a reason is a fact about this host, not a failure; the analyst is null where it is not enabled (ATOMA_VIZ_ANALYST=1).'
              : 'this host exposes no resident watch',
          })
      ),
  },
  {
    name: 'atoma_skill_reset',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_skill_reset',
        {
          title: 'Reset a skill’s counters',
          description:
            'Zero one skill’s successes and failures and clear its promotion-refusal stamp, so it re-earns trust from scratch. Attributed to you and journaled on a gated host. The body is untouched.',
          inputSchema: { l1: z.string().min(1), id: z.string().min(1) },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (args) => guarded(() => skillReset({ ...args, actor: actorOf(ctx), ...(ctx.deps.emit ? { emit: ctx.deps.emit } : {}) }))
      ),
  },
  {
    name: 'atoma_skill_drop',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_skill_drop',
        {
          title: 'Drop a skill',
          description:
            'Delete one skill recipe. REFUSED without force when the skill has recorded successes — that is proven knowledge. Attributed to you and journaled on a gated host.',
          inputSchema: { l1: z.string().min(1), id: z.string().min(1), force: z.boolean().optional() },
          annotations: MUTATING,
        },
        (args) => guarded(() => skillDrop({ ...args, actor: actorOf(ctx), ...(ctx.deps.emit ? { emit: ctx.deps.emit } : {}) }))
      ),
  },
  {
    name: 'atoma_skill_merge',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_skill_merge',
        {
          title: 'Merge two skills of one molecule',
          description:
            'The KEEPER absorbs the other skill’s when_to_use (its matching surface) and keeps its own body, kind and counters; the absorbed skill is deleted with its counters. REFUSED without force when the absorbed skill has recorded successes — if that body is the one worth keeping, merge in the other direction. Attributed and journaled.',
          inputSchema: { l1: z.string().min(1), keep: z.string().min(1), absorb: z.string().min(1), force: z.boolean().optional() },
          annotations: MUTATING,
        },
        (args) => guarded(() => skillMerge({ ...args, actor: actorOf(ctx), ...(ctx.deps.emit ? { emit: ctx.deps.emit } : {}) }))
      ),
  },
  {
    name: 'atoma_registry_rollback',
    tier: 'platform',
    needs: ['operator-runs'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_registry_rollback',
        {
          title: 'Roll an agent type back to an older version',
          description:
            'Restore an older version’s prompt, tools and params as a NEW live version (roll-forward-to-old-content; see atoma_registry_history for versions). Trust RESETS: the restored type re-earns it. A bootstrap type’s seeder may patch the rollback away on the next run. Attributed and journaled.',
          inputSchema: { name: z.string().min(1), toVersion: z.number().int().positive() },
          annotations: MUTATING,
        },
        (args) => guarded(() => registryRollback({ ...args, actor: actorOf(ctx), ...(ctx.deps.emit ? { emit: ctx.deps.emit } : {}) }))
      ),
  },
  {
    name: 'atoma_journal_tail',
    tier: 'platform',
    needs: ['journal'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_journal_tail',
        {
          title: 'Platform journal',
          description:
            'Newest rows of the control-plane audit journal: runs, publications, the sentinel’s findings, the supervisor’s verdicts and mends, admin actions. Filter by kind, family, severity, organisation or run; page with before.',
          inputSchema: {
            kind: platformEventKindSchema.optional(),
            family: z.enum(PLATFORM_EVENT_FAMILIES as [string, ...string[]]).optional(),
            severity: z.enum(['info', 'warning', 'error', 'security']).optional(),
            orgId: z.string().optional(),
            runId: z.string().optional(),
            before: z.number().int().positive().optional(),
            limit: z.number().int().positive().max(200).optional(),
          },
          annotations: READ_ONLY,
        },
        (args) =>
          jsonResult(
            ctx.deps.journal!.list({
              kind: args.kind,
              kindFamily: args.family,
              severity: args.severity,
              orgId: args.orgId,
              runId: args.runId,
              before: args.before,
              limit: args.limit,
            })
          )
      ),
  },
  {
    name: 'atoma_organisations',
    tier: 'platform',
    needs: ['auth', 'projects'],
    register: (server, ctx) =>
      server.registerTool(
        'atoma_organisations',
        {
          title: 'Every organisation and its members',
          description: 'The instance’s organisations with their members and roles — the platform admin’s view.',
          annotations: READ_ONLY,
        },
        () => jsonResult(ctx.deps.auth!.listOrganisationsWithMembers())
      ),
  },
];

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

function hostHonours(spec: McpToolSpec, deps: McpToolDeps): boolean {
  return spec.needs.every((need) => {
    if (need === 'projects') return deps.projects !== null;
    if (need === 'auth') return deps.auth !== null;
    if (need === 'journal') return deps.journal !== null;
    if (need === 'notifications') return typeof deps.notifications === 'function';
    return deps.operatorRuns;
  });
}

/** The tools one caller sees on one host — the same predicate `tools/call` re-checks. */
export function visibleTools(caller: McpCaller, deps: McpToolDeps): McpToolSpec[] {
  const tier = callerTier(caller);
  return MCP_TOOLS.filter((spec) => tierAllows(tier, spec.tier) && hostHonours(spec, deps));
}

export interface BuildServerInput {
  readonly caller: McpCaller;
  readonly deps: McpToolDeps;
  readonly version: string;
  readonly instructions: string;
}

/** One server per session, holding exactly the caller's tools. */
export function buildServerForCaller(input: BuildServerInput): McpServer {
  const server = new McpServer({ name: 'atoma', version: input.version }, { instructions: input.instructions });
  const tier = callerTier(input.caller);
  const ctx: McpToolContext = {
    caller: input.caller,
    tier,
    deps: input.deps,
    viewer: () => {
      if (input.caller.kind !== 'principal') throw new McpToolRefused('this tool needs a signed-in principal');
      return input.caller.viewer;
    },
  };
  for (const spec of visibleTools(input.caller, input.deps)) spec.register(server, ctx);
  // Resources follow the tools' tiers (`resources.ts`): every caller gets the
  // families, a principal its organisation's runs, the platform tier the
  // operator corpus — and a subscription tells a session when a run ends.
  registerResources(server, ctx);
  // The prompt surface drives the operator readers (trace files, registry
  // names, molecule names) and completes over the operator store, so it
  // belongs to the platform tier.
  if (tierAllows(tier, 'platform')) registerPrompts(server);
  return server;
}
