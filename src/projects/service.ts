import type { IncomingMessage } from 'node:http';
import type { Viewer } from '../auth/store.js';
import { ORG_ROLES, type OrgRole } from '../auth/store.js';
import {
  createProjectInputSchema,
  createProjectRunInputSchema,
  projectRunPublicSchema,
  type Project,
  type ProjectRun,
} from '../contracts/projects.js';
import { eventLabel, type PlatformEventSink } from '../contracts/platformEvents.js';
import { GitHubStore } from '../github/store.js';
import { PublicationSupersededError } from './publisher.js';
import { ProjectStateConflict, resolveProjectRunTraceFile } from './store.js';
import {
  ProjectRunBusy,
  ProjectRunConfigurationError,
  ProjectRunCoordinator,
} from './coordinator.js';

/**
 * PROJECTS HTTP SERVICE — one boundary between the viz server and the
 * project control plane.
 *
 * Rules enforced HERE, once:
 * - Every read and write is scoped by the VIEWER's active organisation; an
 *   id supplied by the browser never selects the org.
 * - Write actions (create project, start run) require at least org:member;
 *   org:viewer can read but never execute (T9).
 * - Public projections omit host paths; the full ProjectRun stays internal.
 */

const MAX_JSON_BODY_BYTES = 64 * 1024;

export class ProjectHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ProjectHttpError';
  }
}

export function roleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(minimum);
}

export interface ProjectServiceDeps {
  readonly store: import('./store.js').ProjectStore;
  readonly coordinator: ProjectRunCoordinator;
  readonly github: GitHubStore | null;
  /**
   * Optional audit sink, injected rather than imported: the project control
   * plane must not learn about the viz server's event log to be testable.
   * Absent means "no journal", never "broken".
   */
  readonly events?: PlatformEventSink;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_JSON_BODY_BYTES) throw new ProjectHttpError(413, 'request body too large');
    chunks.push(bytes);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ProjectHttpError(400, 'request body is not valid JSON');
  }
}

function publicRun(run: ProjectRun, publication: import('../contracts/projects.js').Publication | null) {
  const base = projectRunPublicSchema.parse(run);
  const traceFile = resolveProjectRunTraceFile({
    projectRunId: run.projectRunId,
    runsPath: run.hostPaths.runsPath,
    traceId: run.traceId,
  });
  return {
    ...base,
    traceId: run.traceId ?? (traceFile ? run.projectRunId : null),
    costUsd: run.stats?.costUsd ?? null,
    durationS: null,
    publication: publication
      ? {
          status: publication.status,
          repositoryUrl: publication.repositoryUrl,
          commitSha: publication.commitSha,
        }
      : null,
  };
}

function publicProject(
  project: Project,
  runSummary: { runCount: number; lastRunAt: string | null } = {
    runCount: 0,
    lastRunAt: null,
  }
) {
  return {
    projectId: project.projectId,
    name: project.name,
    slug: project.slug,
    status: project.status,
    family: project.family,
    repositoryTarget: project.repositoryTarget,
    repositoryStatus: project.repositoryStatus,
    repositoryFullName: project.repositoryFullName,
    repositoryUrl: project.repositoryUrl,
    repositoryError: project.repositoryError,
    ...runSummary,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export class ProjectService {
  private readonly store: import('./store.js').ProjectStore;
  private readonly coordinator: ProjectRunCoordinator;
  private readonly github: GitHubStore | null;
  private readonly events: PlatformEventSink;

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.coordinator = deps.coordinator;
    this.github = deps.github;
    // A no-op default keeps every emission site free of `?.` noise.
    this.events = deps.events ?? (() => undefined);
  }

  /** GET /api/github/installations — org-scoped. */
  listInstallations(viewer: Viewer): unknown {
    if (!this.github) return [];
    return this.github.listInstallations(viewer.orgId).map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      targetType: installation.targetType,
      status: installation.status,
      repositorySelection: installation.repositorySelection,
    }));
  }

  /** GET /api/projects — a platform admin reads ALL organisations' projects. */
  listProjects(viewer: Viewer): unknown {
    if (viewer.platformAdmin) {
      return this.store.listAllProjects().map((project) => ({
        ...publicProject(
          project,
          this.store.projectRunSummary(project.orgId, project.projectId)
        ),
        orgId: project.orgId,
        orgName: project.orgName,
      }));
    }
    return this.store.listProjects(viewer.orgId).map((project) =>
      publicProject(
        project,
        this.store.projectRunSummary(viewer.orgId, project.projectId)
      )
    );
  }

  /**
   * The organisation whose rows this viewer may read for `projectId`: their
   * own — or, for a platform admin, whichever organisation owns the project.
   * Reads only; writes stay bound to the viewer's active organisation.
   */
  private readOrgFor(viewer: Viewer, projectId: string): string {
    if (!viewer.platformAdmin) return viewer.orgId;
    return this.store.getProjectAnyOrg(projectId)?.orgId ?? viewer.orgId;
  }

  /** POST /api/projects — org:member or above. */
  async createProject(req: IncomingMessage, viewer: Viewer): Promise<unknown> {
    return this.createProjectFromInput(viewer, await readJsonBody(req));
  }

  /**
   * The same creation from an already-parsed payload: the MCP's door. The
   * HTTP route is a body reader in front of this; the checks live once.
   */
  createProjectFromInput(viewer: Viewer, body: unknown): unknown {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to create projects');
    }
    const input = createProjectInputSchema.safeParse(body);
    if (!input.success) throw new ProjectHttpError(400, 'invalid project payload');
    if (this.github) {
      const installation = this.github.getInstallation(input.data.repositoryTarget.installationId);
      if (!installation || installation.orgId !== viewer.orgId || installation.status !== 'active') {
        throw new ProjectHttpError(
          400,
          'repository target must reference an active GitHub installation linked to this organisation'
        );
      }
    } else {
      throw new ProjectHttpError(503, 'GitHub App is not configured on this deployment');
    }
    try {
      const project = this.store.createProject({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        project: input.data,
      });
      this.events({
        kind: 'project.created',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        projectId: project.projectId,
        summary: `Project "${eventLabel(project.name)}" created`,
        detail: { slug: project.slug, family: project.family },
      });
      return publicProject(project);
    } catch (error) {
      // The store says WHICH identity collided — a slug or a repository — and
      // both are 409. This used to depend on matching a driver's own prose for
      // one constraint, which said nothing about the other and would have gone
      // on saying "slug" for a repository collision.
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      if (error instanceof Error && /UNIQUE constraint failed: projects\./.test(error.message)) {
        // Backstop only: reachable if something bypasses the checks above.
        throw new ProjectHttpError(409, 'a project identity in this organisation is already taken');
      }
      throw error;
    }
  }

  /** GET /api/projects/:id/runs */
  listProjectRuns(viewer: Viewer, projectId: string): unknown {
    const orgId = this.readOrgFor(viewer, projectId);
    const runs = this.store.listProjectRuns(orgId, projectId);
    if (!runs) throw new ProjectHttpError(404, 'project not found');
    return runs.map((run) => {
      const publication = this.store.getPublicationForRun(orgId, run.projectRunId);
      return publicRun(run, publication);
    });
  }

  /** POST /api/projects/:id/runs — org:member or above; idempotent by key. */
  async startProjectRun(req: IncomingMessage, viewer: Viewer, projectId: string): Promise<unknown> {
    return this.startProjectRunFromInput(viewer, projectId, await readJsonBody(req));
  }

  /** One project run, for a poller: the MCP's `atoma_run_status`. */
  projectRunStatus(viewer: Viewer, projectId: string, projectRunId: string): unknown {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    return publicRun(run, this.store.getPublicationForRun(orgId, run.projectRunId));
  }

  /** The same start from an already-parsed payload: the MCP's door. */
  async startProjectRunFromInput(viewer: Viewer, projectId: string, body: unknown): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to start runs');
    }
    const input = createProjectRunInputSchema.safeParse(body);
    if (!input.success) throw new ProjectHttpError(400, 'invalid run payload');
    try {
      const run = await this.coordinator.start({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        projectId,
        request: input.data,
      });
      // The GOAL is model-facing prose of arbitrary length and content; only
      // its bounded label reaches the journal, and never the whole prompt.
      this.events({
        kind: 'run.started',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        projectId,
        runId: run.projectRunId,
        summary: `Run started: ${eventLabel(run.goal, 120)}`,
      });
      const publication = this.store.getPublicationForRun(viewer.orgId, run.projectRunId);
      return publicRun(run, publication);
    } catch (error) {
      if (error instanceof ProjectRunBusy) throw new ProjectHttpError(409, error.message);
      if (error instanceof ProjectRunConfigurationError) throw new ProjectHttpError(400, error.message);
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      if (error instanceof Error && error.message === 'project not found') {
        throw new ProjectHttpError(404, 'project not found');
      }
      throw error;
    }
  }

  /** POST /api/projects/:id/runs/:runId/cancel */
  async cancelProjectRun(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to cancel runs');
    }
    // Bind the run to the project NAMED IN THE PATH, like the publish-retry
    // route: a run under another project of the same org must be a 404, or
    // the REST hierarchy lies.
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) {
      throw new ProjectHttpError(404, 'project run not found');
    }
    const cancelled = this.coordinator.cancel(viewer.orgId, projectRunId);
    if (!cancelled) throw new ProjectHttpError(404, 'project run not found');
    // WHO asked is the point of this one: `coordinator.cancel` takes only an
    // org and a run id, so the requesting principal is knowable here and
    // nowhere downstream.
    this.events({
      kind: 'run.cancelled',
      actorType: 'principal',
      actorId: viewer.principalId,
      orgId: viewer.orgId,
      projectId,
      runId: projectRunId,
      summary: `Run cancellation requested: ${eventLabel(cancelled.goal, 120)}`,
    });
    const publication = this.store.getPublicationForRun(viewer.orgId, cancelled.projectRunId);
    return publicRun(cancelled, publication);
  }

  /** POST /api/projects/:id/runs/:runId/publish — org:member or above. */
  async retryPublication(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to retry publication');
    }
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    try {
      const retried = await this.coordinator.retryPublication(viewer.orgId, projectRunId);
      if (!retried) throw new ProjectHttpError(404, 'project run not found');
      const publication = this.store.getPublicationForRun(viewer.orgId, projectRunId);
      return publicRun(retried, publication);
    } catch (error) {
      if (error instanceof ProjectHttpError) throw error;
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      // A POLICY refusal, not a transport failure: this run is older than the
      // one already published, and no retry converges.
      if (error instanceof PublicationSupersededError) {
        throw new ProjectHttpError(409, error.message);
      }
      if (error instanceof ProjectRunConfigurationError) {
        throw new ProjectHttpError(503, error.message);
      }
      // The publisher already recorded the failure on the publication row;
      // surface a bounded message so the operator can see why it failed.
      throw new ProjectHttpError(
        502,
        `publication retry failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`
      );
    }
  }
}
