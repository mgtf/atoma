import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import { runStatsSchema, type RunStats } from '../contracts/runStats.js';
import {
  artifactManifestSchema,
  createProjectInputSchema,
  createProjectRunInputSchema,
  idempotencyKeySchema,
  organisationIdSchema,
  principalIdSchema,
  projectIdSchema,
  projectRunHostPathsSchema,
  projectRunIdSchema,
  projectRunSchema,
  projectRunStatusSchema,
  projectSchema,
  publicationIdSchema,
  publicationReceiptSchema,
  publicationSchema,
  publicationStatusSchema,
  repositoryReceiptSchema,
  repositoryStatusSchema,
  type ArtifactManifest,
  type CreateProjectInput,
  type CreateProjectRunInput,
  type Project,
  type ProjectRun,
  type ProjectRunHostPaths,
  type ProjectRunStatus,
  type Publication,
  type PublicationReceipt,
  type PublicationStatus,
  type RepositoryReceipt,
  type RepositoryStatus,
} from '../contracts/projects.js';
import { artifactManifestHash } from './artifacts.js';

/**
 * Projects share the primary product SQLite store with identity, registry and
 * ledger state. The browser never chooses a workspace, runs directory or log
 * path: those host-owned values enter only through `createProjectRun` after a
 * control-plane UUID has been allocated.
 */
export const PROJECT_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id                    TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  created_by_principal_id       TEXT NOT NULL REFERENCES auth_principals(principal_id),
  name                          TEXT NOT NULL,
  slug                          TEXT NOT NULL,
  initial_prompt                TEXT NOT NULL,
  family                        TEXT NOT NULL,
  status                        TEXT NOT NULL CHECK (status IN ('active','archived')),
  github_installation_id        TEXT NOT NULL,
  repository_target_owner       TEXT NOT NULL,
  repository_target_name        TEXT NOT NULL,
  repository_visibility         TEXT NOT NULL CHECK (repository_visibility IN ('private','public')),
  repository_status             TEXT NOT NULL CHECK (repository_status IN ('pending','creating','ready','failed')),
  repository_id                 TEXT,
  repository_full_name          TEXT,
  repository_url                TEXT,
  repository_default_branch     TEXT,
  repository_error              TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL,
  UNIQUE (project_id, org_id),
  UNIQUE (org_id, slug),
  FOREIGN KEY (org_id, created_by_principal_id)
    REFERENCES auth_memberships(org_id, principal_id),
  CHECK (
    repository_status <> 'ready' OR
    (repository_id IS NOT NULL AND repository_full_name IS NOT NULL AND
     repository_url IS NOT NULL AND repository_default_branch IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS project_runs (
  project_run_id                TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  requested_by_principal_id     TEXT NOT NULL REFERENCES auth_principals(principal_id),
  request_key                   TEXT NOT NULL,
  goal                          TEXT NOT NULL,
  status                        TEXT NOT NULL CHECK (status IN ('queued','running','delivered','failed','cancelled')),
  workspace_path                TEXT NOT NULL,
  runs_path                     TEXT NOT NULL,
  log_path                      TEXT NOT NULL,
  trace_id                      TEXT,
  stats_json                    TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),
  artifact_manifest_json        TEXT CHECK (artifact_manifest_json IS NULL OR json_valid(artifact_manifest_json)),
  artifact_manifest_hash        TEXT,
  error                         TEXT,
  created_at                    TEXT NOT NULL,
  started_at                    TEXT,
  ended_at                      TEXT,
  updated_at                    TEXT NOT NULL,
  UNIQUE (project_run_id, org_id),
  UNIQUE (project_id, request_key),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(project_id, org_id),
  FOREIGN KEY (org_id, requested_by_principal_id)
    REFERENCES auth_memberships(org_id, principal_id),
  CHECK (
    (artifact_manifest_json IS NULL AND artifact_manifest_hash IS NULL) OR
    (artifact_manifest_json IS NOT NULL AND artifact_manifest_hash IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS project_publications (
  publication_id                TEXT PRIMARY KEY,
  project_run_id                TEXT NOT NULL UNIQUE,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  idempotency_key               TEXT NOT NULL,
  manifest_hash                 TEXT NOT NULL,
  status                        TEXT NOT NULL CHECK (status IN ('pending','publishing','published','failed')),
  repository_id                 TEXT,
  repository_full_name          TEXT,
  repository_url                TEXT,
  commit_sha                    TEXT,
  error                         TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL,
  published_at                  TEXT,
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (project_run_id, org_id)
    REFERENCES project_runs(project_run_id, org_id),
  CHECK (
    status <> 'published' OR
    (repository_id IS NOT NULL AND repository_full_name IS NOT NULL AND
     repository_url IS NOT NULL AND commit_sha IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS projects_org_updated_idx
  ON projects(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS project_runs_project_created_idx
  ON project_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_runs_org_status_idx
  ON project_runs(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS project_publications_org_status_idx
  ON project_publications(org_id, status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS projects_org_immutable
BEFORE UPDATE OF org_id ON projects
WHEN NEW.org_id <> OLD.org_id
BEGIN
  SELECT RAISE(ABORT, 'projects.org_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS project_runs_identity_immutable
BEFORE UPDATE OF project_id, org_id, requested_by_principal_id, workspace_path, runs_path, log_path
ON project_runs
WHEN NEW.project_id <> OLD.project_id
  OR NEW.org_id <> OLD.org_id
  OR NEW.requested_by_principal_id <> OLD.requested_by_principal_id
  OR NEW.workspace_path <> OLD.workspace_path
  OR NEW.runs_path <> OLD.runs_path
  OR NEW.log_path <> OLD.log_path
BEGIN
  SELECT RAISE(ABORT, 'project run identity and host paths are immutable');
END;

CREATE TRIGGER IF NOT EXISTS project_publications_identity_immutable
BEFORE UPDATE OF project_run_id, org_id, idempotency_key, manifest_hash
ON project_publications
WHEN NEW.project_run_id <> OLD.project_run_id
  OR NEW.org_id <> OLD.org_id
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.manifest_hash <> OLD.manifest_hash
BEGIN
  SELECT RAISE(ABORT, 'publication identity is immutable');
END;
`;

const RUN_TRANSITIONS: Readonly<Record<ProjectRunStatus, readonly ProjectRunStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['delivered', 'failed', 'cancelled'],
  delivered: [],
  failed: [],
  cancelled: [],
};

const REPOSITORY_TRANSITIONS: Readonly<Record<RepositoryStatus, readonly RepositoryStatus[]>> = {
  pending: ['creating', 'failed'],
  creating: ['ready', 'failed'],
  ready: [],
  failed: ['creating'],
};

const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
  pending: ['publishing', 'failed'],
  publishing: ['published', 'failed'],
  published: [],
  failed: ['publishing'],
};

export class ProjectStateConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStateConflict';
  }
}

interface ProjectRow {
  project_id: string;
  org_id: string;
  created_by_principal_id: string;
  name: string;
  slug: string;
  initial_prompt: string;
  family: string;
  status: string;
  github_installation_id: string;
  repository_target_owner: string;
  repository_target_name: string;
  repository_visibility: string;
  repository_status: string;
  repository_id: string | null;
  repository_full_name: string | null;
  repository_url: string | null;
  repository_default_branch: string | null;
  repository_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRunRow {
  project_run_id: string;
  project_id: string;
  org_id: string;
  requested_by_principal_id: string;
  request_key: string;
  goal: string;
  status: string;
  workspace_path: string;
  runs_path: string;
  log_path: string;
  trace_id: string | null;
  stats_json: string | null;
  artifact_manifest_json: string | null;
  artifact_manifest_hash: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

interface PublicationRow {
  publication_id: string;
  project_run_id: string;
  org_id: string;
  idempotency_key: string;
  manifest_hash: string;
  status: string;
  repository_id: string | null;
  repository_full_name: string | null;
  repository_url: string | null;
  commit_sha: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is corrupt JSON: ${(error as Error).message}`);
  }
}

function projectFromRow(row: ProjectRow): Project {
  return projectSchema.parse({
    projectId: row.project_id,
    orgId: row.org_id,
    createdByPrincipalId: row.created_by_principal_id,
    name: row.name,
    slug: row.slug,
    initialPrompt: row.initial_prompt,
    family: row.family,
    status: row.status,
    repositoryTarget: {
      installationId: row.github_installation_id,
      owner: row.repository_target_owner,
      name: row.repository_target_name,
      visibility: row.repository_visibility,
    },
    repositoryStatus: row.repository_status,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    repositoryUrl: row.repository_url,
    defaultBranch: row.repository_default_branch,
    repositoryError: row.repository_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Locate the JSON trace for a project run. The coordinator names the file
 * `{projectRunId}.json` under `runsPath`; a stored `traceId` may differ for
 * legacy rows. Missing files stay missing — queued runs have none.
 */
export function resolveProjectRunTraceFile(input: {
  readonly projectRunId: string;
  readonly runsPath: string;
  readonly traceId?: string | null;
}): string | null {
  const names = new Set([`${input.projectRunId}.json`]);
  if (input.traceId) names.add(`${input.traceId}.json`);
  for (const name of names) {
    const file = path.join(input.runsPath, name);
    if (existsSync(file)) return file;
  }
  return null;
}

function isRunLookupId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value);
}

function runFromRow(row: ProjectRunRow): ProjectRun {
  return projectRunSchema.parse({
    projectRunId: row.project_run_id,
    projectId: row.project_id,
    orgId: row.org_id,
    requestedByPrincipalId: row.requested_by_principal_id,
    requestKey: row.request_key,
    goal: row.goal,
    status: row.status,
    hostPaths: {
      workspacePath: row.workspace_path,
      runsPath: row.runs_path,
      logPath: row.log_path,
    },
    traceId: row.trace_id,
    stats: row.stats_json === null ? null : runStatsSchema.parse(parseJson(row.stats_json, 'run stats')),
    artifactManifest:
      row.artifact_manifest_json === null
        ? null
        : artifactManifestSchema.parse(parseJson(row.artifact_manifest_json, 'artifact manifest')),
    artifactManifestHash: row.artifact_manifest_hash,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  });
}

function publicationFromRow(row: PublicationRow): Publication {
  return publicationSchema.parse({
    publicationId: row.publication_id,
    projectRunId: row.project_run_id,
    orgId: row.org_id,
    idempotencyKey: row.idempotency_key,
    manifestHash: row.manifest_hash,
    status: row.status,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    repositoryUrl: row.repository_url,
    commitSha: row.commit_sha,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  });
}

function hostPaths(input: ProjectRunHostPaths): ProjectRunHostPaths {
  const parsed = projectRunHostPathsSchema.parse(input);
  for (const [name, value] of Object.entries(parsed)) {
    if (value.includes('\0') || !path.isAbsolute(value) || path.resolve(value) !== value) {
      throw new Error(`${name} must be a canonical absolute host path`);
    }
  }
  return parsed;
}

function boundedError(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length === 0 || value.length > 2_000) {
    throw new Error('error must contain 1..2000 characters');
  }
  return value;
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function traceId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value.includes('\\') ||
    hasAsciiControl(value)
  ) {
    throw new Error('traceId must be a bounded path-safe identifier');
  }
  return value;
}

export interface ProjectStoreOptions {
  readonly initialize?: boolean;
  readonly closeOnClose?: boolean;
}

export class ProjectStore {
  private readonly db: Database.Database;
  private readonly closeOnClose: boolean;

  constructor(db: Database.Database, options: ProjectStoreOptions = {}) {
    this.db = db;
    this.closeOnClose = options.closeOnClose ?? false;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (options.initialize !== false) this.db.exec(PROJECT_TABLES_DDL);
  }

  /** Open the explicitly selected primary product store. There is no default. */
  static open(dbPath: string): ProjectStore {
    if (!dbPath) throw new Error('ProjectStore.open requires the selected product DB path');
    return new ProjectStore(openStoreHandle(dbPath, PROJECT_TABLES_DDL));
  }

  createProject(input: {
    readonly orgId: string;
    readonly principalId: string;
    readonly project: CreateProjectInput;
    readonly projectId?: string;
  }): Project {
    const orgId = organisationIdSchema.parse(input.orgId);
    const principalId = principalIdSchema.parse(input.principalId);
    const projectId = projectIdSchema.parse(input.projectId ?? randomUUID());
    const project = createProjectInputSchema.parse(input.project);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (
           project_id, org_id, created_by_principal_id, name, slug, initial_prompt, family,
           status, github_installation_id, repository_target_owner, repository_target_name,
           repository_visibility, repository_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        projectId,
        orgId,
        principalId,
        project.name,
        project.slug,
        project.initialPrompt,
        project.family,
        project.repositoryTarget.installationId,
        project.repositoryTarget.owner,
        project.repositoryTarget.name,
        project.repositoryTarget.visibility,
        now,
        now
      );
    return this.getProject(orgId, projectId)!;
  }

  getProject(orgIdInput: string, projectIdInput: string): Project | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    const row = this.db
      .prepare('SELECT * FROM projects WHERE project_id = ? AND org_id = ?')
      .get(projectId, orgId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listProjects(orgIdInput: string): Project[] {
    const orgId = organisationIdSchema.parse(orgIdInput);
    return (
      this.db
        .prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC, project_id ASC')
        .all(orgId) as ProjectRow[]
    ).map(projectFromRow);
  }

  transitionRepository(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly from: RepositoryStatus;
    readonly to: RepositoryStatus;
    readonly receipt?: RepositoryReceipt;
    readonly error?: string;
  }): Project | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectId = projectIdSchema.parse(input.projectId);
    const from = repositoryStatusSchema.parse(input.from);
    const to = repositoryStatusSchema.parse(input.to);
    const receipt = input.receipt ? repositoryReceiptSchema.parse(input.receipt) : null;
    const error = boundedError(input.error);
    if (to === 'ready' && !receipt) throw new Error('repository ready requires a receipt');
    if (to === 'failed' && !error) throw new Error('repository failure requires an error');
    if (to !== 'ready' && receipt) throw new Error('repository receipt is valid only for ready');
    if (to !== 'failed' && error) throw new Error('repository error is valid only for failed');

    const current = this.getProject(orgId, projectId);
    if (!current) return null;
    if (current.repositoryStatus === to) {
      if (
        receipt &&
        (current.repositoryId !== receipt.repositoryId ||
          current.repositoryFullName !== receipt.fullName ||
          current.repositoryUrl !== receipt.url ||
          current.defaultBranch !== receipt.defaultBranch)
      ) {
        throw new ProjectStateConflict('repository transition replay carries a different receipt');
      }
      if (error && current.repositoryError !== error) {
        throw new ProjectStateConflict('repository transition replay carries a different error');
      }
      return current;
    }
    if (current.repositoryStatus !== from) {
      throw new ProjectStateConflict(
        `repository is ${current.repositoryStatus}, expected ${from} before ${to}`
      );
    }
    if (!REPOSITORY_TRANSITIONS[from].includes(to)) {
      throw new ProjectStateConflict(`repository transition ${from} -> ${to} is not allowed`);
    }
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE projects
         SET repository_status = ?, repository_id = ?, repository_full_name = ?,
             repository_url = ?, repository_default_branch = ?, repository_error = ?, updated_at = ?
         WHERE project_id = ? AND org_id = ? AND repository_status = ?`
      )
      .run(
        to,
        receipt?.repositoryId ?? null,
        receipt?.fullName ?? null,
        receipt?.url ?? null,
        receipt?.defaultBranch ?? null,
        error,
        now,
        projectId,
        orgId,
        from
      ).changes;
    if (changed !== 1) throw new ProjectStateConflict('repository CAS lost to a concurrent transition');
    return this.getProject(orgId, projectId)!;
  }

  createProjectRun(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly principalId: string;
    readonly request: CreateProjectRunInput;
    readonly hostPaths: ProjectRunHostPaths;
    readonly projectRunId?: string;
  }): { readonly run: ProjectRun; readonly created: boolean } | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectId = projectIdSchema.parse(input.projectId);
    const principalId = principalIdSchema.parse(input.principalId);
    const request = createProjectRunInputSchema.parse(input.request);
    const paths = hostPaths(input.hostPaths);
    const requestedRunId = projectRunIdSchema.parse(input.projectRunId ?? randomUUID());
    const transact = this.db.transaction(() => {
      const project = this.getProject(orgId, projectId);
      if (!project) return null;
      if (project.status !== 'active') throw new ProjectStateConflict('cannot run an archived project');
      const goal = request.goal;
      const existing = this.db
        .prepare('SELECT * FROM project_runs WHERE project_id = ? AND request_key = ?')
        .get(projectId, request.idempotencyKey) as ProjectRunRow | undefined;
      if (existing) {
        if (existing.org_id !== orgId) return null;
        if (existing.requested_by_principal_id !== principalId || existing.goal !== goal) {
          throw new ProjectStateConflict('run idempotency key was already used for different input');
        }
        return { run: runFromRow(existing), created: false } as const;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_runs (
             project_run_id, project_id, org_id, requested_by_principal_id, request_key,
             goal, status, workspace_path, runs_path, log_path, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
        )
        .run(
          requestedRunId,
          projectId,
          orgId,
          principalId,
          request.idempotencyKey,
          goal,
          paths.workspacePath,
          paths.runsPath,
          paths.logPath,
          now,
          now
        );
      return { run: this.getProjectRun(orgId, requestedRunId)!, created: true } as const;
    });
    return transact.immediate();
  }

  getProjectRun(orgIdInput: string, projectRunIdInput: string): ProjectRun | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare('SELECT * FROM project_runs WHERE project_run_id = ? AND org_id = ?')
      .get(projectRunId, orgId) as ProjectRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listProjectRuns(orgIdInput: string, projectIdInput: string): ProjectRun[] | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    if (!this.getProject(orgId, projectId)) return null;
    return (
      this.db
        .prepare(
          'SELECT * FROM project_runs WHERE project_id = ? AND org_id = ? ORDER BY created_at DESC, project_run_id ASC'
        )
        .all(projectId, orgId) as ProjectRunRow[]
    ).map(runFromRow);
  }

  /**
   * Trace files for one organisation. A run belongs to exactly one project;
   * `/api/runs` lists this set and never a shared instance directory.
   */
  listOrgRunTraces(orgIdInput: string): Array<{
    id: string;
    file: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
  }> {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const rows = this.db
      .prepare(
        `SELECT r.project_run_id, r.trace_id, r.runs_path, r.project_id, p.name AS project_name, p.slug AS project_slug
         FROM project_runs r
         JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
         WHERE r.org_id = ?
         ORDER BY r.created_at DESC, r.project_run_id ASC`
      )
      .all(orgId) as Array<{
      project_run_id: string;
      trace_id: string | null;
      runs_path: string;
      project_id: string;
      project_name: string;
      project_slug: string;
    }>;
    const out: Array<{
      id: string;
      file: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
    }> = [];
    for (const row of rows) {
      const file = resolveProjectRunTraceFile({
        projectRunId: row.project_run_id,
        runsPath: row.runs_path,
        traceId: row.trace_id,
      });
      if (!file) continue;
      out.push({
        id: row.project_run_id,
        file,
        projectId: row.project_id,
        projectName: row.project_name,
        projectSlug: row.project_slug,
      });
    }
    return out;
  }

  findOrgRunTraceFile(orgIdInput: string, idInput: string): string | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    if (!isRunLookupId(idInput)) return null;
    const asUuid = projectRunIdSchema.safeParse(idInput);
    const row = (
      asUuid.success
        ? this.db
            .prepare(
              `SELECT project_run_id, trace_id, runs_path FROM project_runs
               WHERE org_id = ? AND (project_run_id = ? OR trace_id = ?)`
            )
            .get(orgId, asUuid.data, asUuid.data)
        : this.db
            .prepare(
              `SELECT project_run_id, trace_id, runs_path FROM project_runs
               WHERE org_id = ? AND trace_id = ?`
            )
            .get(orgId, idInput)
    ) as { project_run_id: string; trace_id: string | null; runs_path: string } | undefined;
    if (!row) return null;
    return resolveProjectRunTraceFile({
      projectRunId: row.project_run_id,
      runsPath: row.runs_path,
      traceId: row.trace_id,
    });
  }

  transitionProjectRun(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly from: ProjectRunStatus;
    readonly to: ProjectRunStatus;
    readonly traceId?: string;
    readonly stats?: RunStats;
    readonly error?: string;
  }): ProjectRun | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const from = projectRunStatusSchema.parse(input.from);
    const to = projectRunStatusSchema.parse(input.to);
    const nextTraceId = traceId(input.traceId);
    const stats = input.stats ? runStatsSchema.parse(input.stats) : null;
    const error = boundedError(input.error);
    if ((to === 'queued' || to === 'running') && (nextTraceId || stats || error)) {
      throw new Error(`transition to ${to} cannot carry completion fields`);
    }
    if (to === 'delivered') {
      if (!nextTraceId || !stats || stats.outcome !== 'delivered') {
        throw new Error('delivered requires traceId and delivered run stats');
      }
      if (error) throw new Error('delivered cannot carry an error');
    }
    if (to === 'failed') {
      if (!error) throw new Error('failed requires an error');
      if (stats?.outcome === 'delivered' || stats?.outcome === 'cancelled') {
        throw new Error('failed status contradicts the supplied run stats');
      }
    }
    if (to === 'cancelled' && stats && stats.outcome !== 'cancelled' && stats.outcome !== 'error') {
      throw new Error('cancelled status contradicts the supplied run stats');
    }

    const current = this.getProjectRun(orgId, projectRunId);
    if (!current) return null;
    if (current.status === to) {
      const sameStats = stats === null || JSON.stringify(current.stats) === JSON.stringify(stats);
      if (
        (nextTraceId !== null && current.traceId !== nextTraceId) ||
        !sameStats ||
        (error !== null && current.error !== error)
      ) {
        throw new ProjectStateConflict('run transition replay carries different completion data');
      }
      return current;
    }
    if (current.status !== from) {
      throw new ProjectStateConflict(`run is ${current.status}, expected ${from} before ${to}`);
    }
    if (!RUN_TRANSITIONS[from].includes(to)) {
      throw new ProjectStateConflict(`run transition ${from} -> ${to} is not allowed`);
    }
    const now = new Date().toISOString();
    const terminal = to === 'delivered' || to === 'failed' || to === 'cancelled';
    const changed = this.db
      .prepare(
        `UPDATE project_runs
         SET status = ?, trace_id = ?, stats_json = ?, error = ?,
             started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
             ended_at = CASE WHEN ? = 1 THEN ? ELSE ended_at END,
             updated_at = ?
         WHERE project_run_id = ? AND org_id = ? AND status = ?`
      )
      .run(
        to,
        nextTraceId,
        stats ? JSON.stringify(stats) : null,
        error,
        to,
        now,
        terminal ? 1 : 0,
        now,
        now,
        projectRunId,
        orgId,
        from
      ).changes;
    if (changed !== 1) throw new ProjectStateConflict('run CAS lost to a concurrent transition');
    return this.getProjectRun(orgId, projectRunId)!;
  }

  saveArtifactManifest(
    orgIdInput: string,
    projectRunIdInput: string,
    manifestInput: ArtifactManifest
  ): ProjectRun | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const manifest = artifactManifestSchema.parse(manifestInput);
    const hash = artifactManifestHash(manifest);
    const current = this.getProjectRun(orgId, projectRunId);
    if (!current) return null;
    if (current.status !== 'delivered') {
      throw new ProjectStateConflict('artifacts can be attached only to a delivered run');
    }
    if (current.artifactManifestHash !== null) {
      if (
        current.artifactManifestHash !== hash ||
        JSON.stringify(current.artifactManifest) !== JSON.stringify(manifest)
      ) {
        throw new ProjectStateConflict('run already carries a different artifact manifest');
      }
      return current;
    }
    const changed = this.db
      .prepare(
        `UPDATE project_runs
         SET artifact_manifest_json = ?, artifact_manifest_hash = ?, updated_at = ?
         WHERE project_run_id = ? AND org_id = ? AND status = 'delivered'
           AND artifact_manifest_json IS NULL AND artifact_manifest_hash IS NULL`
      )
      .run(JSON.stringify(manifest), hash, new Date().toISOString(), projectRunId, orgId).changes;
    if (changed !== 1) throw new ProjectStateConflict('artifact manifest CAS lost to a concurrent writer');
    return this.getProjectRun(orgId, projectRunId)!;
  }

  reservePublication(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly idempotencyKey: string;
    readonly publicationId?: string;
  }): { readonly publication: Publication; readonly created: boolean } | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
    const publicationId = publicationIdSchema.parse(input.publicationId ?? randomUUID());
    const transact = this.db.transaction(() => {
      const run = this.getProjectRun(orgId, projectRunId);
      if (!run) return null;
      if (run.status !== 'delivered' || !run.artifactManifestHash) {
        throw new ProjectStateConflict('publication requires a delivered run with artifacts');
      }
      const byKey = this.db
        .prepare('SELECT * FROM project_publications WHERE org_id = ? AND idempotency_key = ?')
        .get(orgId, idempotencyKey) as PublicationRow | undefined;
      if (byKey) {
        if (byKey.project_run_id !== projectRunId) {
          throw new ProjectStateConflict('publication idempotency key belongs to another run');
        }
        return { publication: publicationFromRow(byKey), created: false } as const;
      }
      const byRun = this.db
        .prepare('SELECT * FROM project_publications WHERE project_run_id = ? AND org_id = ?')
        .get(projectRunId, orgId) as PublicationRow | undefined;
      if (byRun) return { publication: publicationFromRow(byRun), created: false } as const;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_publications (
             publication_id, project_run_id, org_id, idempotency_key, manifest_hash,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          publicationId,
          projectRunId,
          orgId,
          idempotencyKey,
          run.artifactManifestHash,
          now,
          now
        );
      return { publication: this.getPublication(orgId, publicationId)!, created: true } as const;
    });
    return transact.immediate();
  }

  getPublication(orgIdInput: string, publicationIdInput: string): Publication | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const publicationId = publicationIdSchema.parse(publicationIdInput);
    const row = this.db
      .prepare('SELECT * FROM project_publications WHERE publication_id = ? AND org_id = ?')
      .get(publicationId, orgId) as PublicationRow | undefined;
    return row ? publicationFromRow(row) : null;
  }

  getPublicationForRun(orgIdInput: string, projectRunIdInput: string): Publication | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare('SELECT * FROM project_publications WHERE project_run_id = ? AND org_id = ?')
      .get(projectRunId, orgId) as PublicationRow | undefined;
    return row ? publicationFromRow(row) : null;
  }

  transitionPublication(input: {
    readonly orgId: string;
    readonly publicationId: string;
    readonly from: PublicationStatus;
    readonly to: PublicationStatus;
    readonly receipt?: PublicationReceipt;
    readonly error?: string;
  }): Publication | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const publicationId = publicationIdSchema.parse(input.publicationId);
    const from = publicationStatusSchema.parse(input.from);
    const to = publicationStatusSchema.parse(input.to);
    const receipt = input.receipt ? publicationReceiptSchema.parse(input.receipt) : null;
    const error = boundedError(input.error);
    if (to === 'published' && !receipt) throw new Error('published requires a receipt');
    if (to === 'failed' && !error) throw new Error('publication failure requires an error');
    if (to !== 'published' && receipt) throw new Error('publication receipt is valid only for published');
    if (to !== 'failed' && error) throw new Error('publication error is valid only for failed');
    const current = this.getPublication(orgId, publicationId);
    if (!current) return null;
    if (current.status === to) {
      if (
        receipt &&
        (current.repositoryId !== receipt.repositoryId ||
          current.repositoryFullName !== receipt.fullName ||
          current.repositoryUrl !== receipt.url ||
          current.commitSha !== receipt.commitSha)
      ) {
        throw new ProjectStateConflict('publication replay carries a different receipt');
      }
      if (error && current.error !== error) {
        throw new ProjectStateConflict('publication replay carries a different error');
      }
      return current;
    }
    if (current.status !== from) {
      throw new ProjectStateConflict(`publication is ${current.status}, expected ${from} before ${to}`);
    }
    if (!PUBLICATION_TRANSITIONS[from].includes(to)) {
      throw new ProjectStateConflict(`publication transition ${from} -> ${to} is not allowed`);
    }
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE project_publications
         SET status = ?, repository_id = ?, repository_full_name = ?, repository_url = ?,
             commit_sha = ?, error = ?, published_at = ?, updated_at = ?
         WHERE publication_id = ? AND org_id = ? AND status = ?`
      )
      .run(
        to,
        receipt?.repositoryId ?? null,
        receipt?.fullName ?? null,
        receipt?.url ?? null,
        receipt?.commitSha ?? null,
        error,
        to === 'published' ? now : null,
        now,
        publicationId,
        orgId,
        from
      ).changes;
    if (changed !== 1) throw new ProjectStateConflict('publication CAS lost to a concurrent transition');
    return this.getPublication(orgId, publicationId)!;
  }

  close(): void {
    if (this.closeOnClose) this.db.close();
  }
}
