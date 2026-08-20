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
import { GitHubStore } from '../github/store.js';
import { ProjectStateConflict, resolveProjectRunTraceFile } from './store.js';
import { ProjectRunBusy, ProjectRunConfigurationError, ProjectRunCoordinator } from './coordinator.js';

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

function publicProject(project: Project) {
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
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export class ProjectService {
  private readonly store: import('./store.js').ProjectStore;
  private readonly coordinator: ProjectRunCoordinator;
  private readonly github: GitHubStore | null;

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.coordinator = deps.coordinator;
    this.github = deps.github;
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

  /** GET /api/projects */
  listProjects(viewer: Viewer): unknown {
    return this.store.listProjects(viewer.orgId).map(publicProject);
  }

  /** POST /api/projects — org:member or above. */
  async createProject(req: IncomingMessage, viewer: Viewer): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to create projects');
    }
    const body = await readJsonBody(req);
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
      return publicProject(project);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: projects\.org_id, projects\.slug/.test(error.message)) {
        throw new ProjectHttpError(409, 'a project with this slug already exists in the organisation');
      }
      throw error;
    }
  }

  /** GET /api/projects/:id/runs */
  listProjectRuns(viewer: Viewer, projectId: string): unknown {
    const runs = this.store.listProjectRuns(viewer.orgId, projectId);
    if (!runs) throw new ProjectHttpError(404, 'project not found');
    return runs.map((run) => {
      const publication = this.store.getPublicationForRun(viewer.orgId, run.projectRunId);
      return publicRun(run, publication);
    });
  }

  /** POST /api/projects/:id/runs — org:member or above; idempotent by key. */
  async startProjectRun(req: IncomingMessage, viewer: Viewer, projectId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to start runs');
    }
    const body = await readJsonBody(req);
    const input = createProjectRunInputSchema.safeParse(body);
    if (!input.success) throw new ProjectHttpError(400, 'invalid run payload');
    try {
      const run = await this.coordinator.start({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        projectId,
        request: input.data,
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
    const runs = this.store.listProjectRuns(viewer.orgId, projectId);
    if (!runs) throw new ProjectHttpError(404, 'project not found');
    const cancelled = this.coordinator.cancel(viewer.orgId, projectRunId);
    if (!cancelled) throw new ProjectHttpError(404, 'project run not found');
    const publication = this.store.getPublicationForRun(viewer.orgId, cancelled.projectRunId);
    return publicRun(cancelled, publication);
  }
}
