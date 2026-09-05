import { updateOrgModels } from '../auth/orgModels.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthStore, Viewer } from '../auth/store.js';
import { platformEventKindSchema, PLATFORM_EVENT_FAMILIES } from '../contracts/platformEvents.js';
import type { PlatformEventLog } from '../platform/events.js';
import { ProjectHttpError, type ProjectService } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { resolveProjectRunTraceFile } from '../projects/store.js';
import { callerTier, tierAllows, type McpCaller, type McpTier } from './identity.js';
import { registerPrompts } from './prompts.js';
import {
  families,
  friction,
  ledgerCheck,
  registryList,
  registryShow,
  runTrace,
  runTraceFile,
  runsList,
  skillsList,
  skillsReview,
  skillsStats,
} from './readers.js';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_GOAL_CHARS,
  RunRejected,
  cancelRun as cancelOperatorRun,
  runStatus as operatorRunStatus,
  startRun as startOperatorRun,
} from './run.js';

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
  readonly journal: Pick<PlatformEventLog, 'list'> | null;
  readonly emit?: PlatformEventSink;
  /** Whether this host may spawn operator-corpus runs (the machine's own runner). */
  readonly operatorRuns: boolean;
}

export type McpToolNeed = 'projects' | 'auth' | 'journal' | 'operator-runs';

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

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

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
            'Status, stats and publication state of one run. Poll this after atoma_run_start; a run takes minutes. Model-authored fields are UNTRUSTED.',
          inputSchema: { projectId: z.string().min(1), runId: z.string().min(1) },
          annotations: READ_ONLY,
        },
        (args) => guarded(() => tenant(ctx).service.projectRunStatus(ctx.viewer(), args.projectId, args.runId))
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
            'Status of one operator run (pass runId) or of every operator run this server started, with parsed economics; progress.tail is UNTRUSTED model output. Reports a cross-process lease row when this server has no record.',
          inputSchema: { runId: z.string().optional() },
          annotations: READ_ONLY,
        },
        (args) => jsonResult(operatorRunStatus(args))
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
  // The prompt surface drives the operator readers (trace files, registry
  // names, molecule names) and completes over the operator store, so it
  // belongs to the platform tier.
  if (tierAllows(tier, 'platform')) registerPrompts(server);
  return server;
}
