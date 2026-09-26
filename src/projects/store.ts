import { randomUUID } from 'node:crypto';
import { orgRunLimitSchema, type OrgRunCapacity } from '../contracts/projects.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStoreHandle, STORE_BUSY_TIMEOUT_MS } from '../core/stores.js';
import { runStatsSchema, type RunStats } from '../contracts/runStats.js';
import { ledgerRows, runPayerLedgerSchema, type RunPayerLedger } from '../contracts/runPayers.js';
import {
  artifactManifestSchema,
  commitShaSchema,
  createProjectInputSchema,
  createProjectRunInputSchema,
  rerunProjectRunInputSchema,
  runSeedSchema,
  startProjectRunInputSchema,
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
  repositoryRunBaseSchema,
  type RepositoryRunBase,
  repositoryStatusSchema,
  type ArtifactManifest,
  type CreateProjectInput,
  type RunSeed,
  type StartProjectRunInput,
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
import { captureAcceptanceSpec, parseAcceptanceSpec } from '../run/acceptanceSpec.js';
import type { AcceptanceSpec, ChecklistSource } from '../contracts/acceptanceChecklist.js';

/** An acceptance list a run carries, and who wrote it. */
export interface RunAcceptance {
  readonly spec: AcceptanceSpec;
  readonly source: ChecklistSource;
}

/**
 * The `project_runs` table, parameterised by its NAME — the one table whose
 * definition is needed twice.
 *
 * It is a function rather than a literal because the status CHECK gained
 * `'partial'` on 2026-09-22 and SQLite cannot add or widen a CHECK by
 * `ALTER TABLE`. A store created before that date would refuse every landed
 * run, so `migrateProjectRunsForPartial` rebuilds it under a temporary name —
 * the documented SQLite table-rebuild procedure — and that rebuild must use
 * THIS definition, not a second copy of it that could drift from it.
 */
function projectRunsTable(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  project_run_id                TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  requested_by_principal_id     TEXT NOT NULL REFERENCES auth_principals(principal_id),
  request_key                   TEXT NOT NULL,
  goal                          TEXT NOT NULL,
  status                        TEXT NOT NULL CHECK (status IN ('queued','running','delivered','partial','failed','cancelled')),
  workspace_path                TEXT NOT NULL,
  runs_path                     TEXT NOT NULL,
  log_path                      TEXT NOT NULL,
  skills_path                   TEXT,
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
`;
}

/**
 * The `project_run_payers` table, parameterised by its NAME for the same
 * reason as `projectRunsTable`: its `source` CHECK gained `'run'` on
 * 2026-09-25 (a comparison rerun's model override), and a CHECK is widened
 * only by a rebuild (`migrateRunPayersForRunSource`).
 */
function projectRunPayersTable(name: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  project_run_id TEXT NOT NULL REFERENCES project_runs(project_run_id),
  tier           TEXT NOT NULL CHECK (tier IN ('l1','l2','l3')),
  org_id         TEXT NOT NULL REFERENCES auth_organisations(org_id),
  selection      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  payer          TEXT NOT NULL CHECK (payer IN ('host-subscription','principal-subscription','org-key','host-key','host-selfhosted')),
  source         TEXT NOT NULL CHECK (source IN ('run','account','org','host')),
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (project_run_id, tier)
);
`;
}

/**
 * Projects share the primary product SQLite store with identity, registry and
 * ledger state. The browser never chooses a workspace, runs directory or log
 * path: those host-owned values enter only through `createProjectRun` after a
 * control-plane UUID has been allocated.
 */
export const PROJECT_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS org_run_limits (
  org_id TEXT PRIMARY KEY REFERENCES auth_organisations(org_id),
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent IN (0, 1))
);
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

${projectRunsTable('project_runs')}
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
  -- The branch head OBSERVED before this publication. NOT in the CHECK below:
  -- a first publication legitimately has no base, and SQLite cannot add a
  -- CHECK by ALTER TABLE, so constraining it would leave fresh and migrated
  -- stores with different constraints.
  base_sha                      TEXT,
  seed_commit_sha               TEXT,
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

/*
 * WHO PAID FOR THIS RUN, DURABLY, FOR EVERY RUN.
 *
 * The three-row RunPayerLedger is built for every run, but it only ever
 * survived the process when a run touched a CLI subscription: the
 * onSubscriptionTransport hook journals it, and nothing else did. A run
 * funded entirely by an organisation or host API key left no payer record at
 * all, so the one question a hosted platform must answer about a finished run
 * — who paid for it — had no answer for exactly the runs a bill depends on.
 *
 * Three rows per run, written in the SAME transaction as the queued->running
 * transition (startProjectRun), so a tenant run cannot be observed as running
 * while nobody knows who pays for it. NOT a universal invariant of the table:
 * the synthetic retrieval-benchmark harness in cli/retrievalProjectAttempt.ts
 * transitions its own rows directly, and its bookkeeping source run has no
 * payer because it spends nothing. Every run the coordinator starts has one.
 * The rows are immutable: the ledger describes a decision already taken, and
 * a payer that could be edited afterwards would be worth nothing as evidence.
 *
 * NO SECRETS. A row names a selector, a transport, a payer KIND and which
 * level chose it — never a credential, and never tenant-supplied text.
 */
${projectRunPayersTable('project_run_payers')}
CREATE INDEX IF NOT EXISTS project_run_payers_org_idx ON project_run_payers(org_id, payer);

CREATE TRIGGER IF NOT EXISTS project_run_payers_immutable
BEFORE UPDATE ON project_run_payers
BEGIN
  SELECT RAISE(ABORT, 'a recorded payer is immutable');
END;

/*
 * THE ACCEPTANCE CRITERIA A USER APPROVED for one run, captured by the host
 * before the run existed (docs/acceptance-contract-2026-09-14.md). One row
 * per run that carried a list, written in the SAME transaction as the run
 * reservation, so a queued run is never observable without the list it was
 * launched with. Immutable: it is what the run was asked to show, and a list
 * that could be edited afterwards would make every later reading of the
 * run's acceptance meaningless. Additive under decision gate 0 (hardened
 * SQLite, closed 2026-09-18); scoped to the run's organisation (R6). The
 * text is the user's, stored as data and never used as a key or path (R2).
 */
CREATE TABLE IF NOT EXISTS project_run_acceptance (
  project_run_id TEXT PRIMARY KEY REFERENCES project_runs(project_run_id),
  org_id         TEXT NOT NULL REFERENCES auth_organisations(org_id),
  spec_json      TEXT NOT NULL CHECK (json_valid(spec_json)),
  digest         TEXT NOT NULL,
  recorded_at    TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS project_run_acceptance_immutable
BEFORE UPDATE ON project_run_acceptance
BEGIN
  SELECT RAISE(ABORT, 'an approved acceptance list is immutable');
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

/**
 * Widen the `project_runs.status` CHECK to admit `'partial'`, by rebuilding the
 * table.
 *
 * WHY A REBUILD AND NOT AN `ALTER TABLE`. SQLite has no way to add or relax a
 * CHECK in place — the note on `project_publications.base_sha` in the DDL above
 * says so about the same limitation, and the case-folded projects index says it
 * again. There the answer was to express the constraint as an INDEX instead,
 * which a store can gain later. A column CHECK has no such equivalent, so a
 * store created before 2026-09-22 would reject every landed run with
 * `CHECK constraint failed` and the whole partial-delivery path would be dead
 * on exactly the deployment it was written for.
 *
 * The steps are SQLite's own documented table-rebuild procedure
 * (https://sqlite.org/lang_altertable.html): foreign keys off, one
 * transaction, copy into a new table, drop, rename, rebuild the indexes and
 * trigger the drop took with it. Two details are not boilerplate:
 *
 *   - the copy is driven by the OLD table's actual column list, and any column
 *     it holds that the fresh definition lacks is re-added before the insert.
 *     Every additive migration below (`repository_base_json`, `bytes_expired_at`
 *     and friends) lives in the live table and not in the DDL constant, so a
 *     copy driven by the constant would silently drop columns of real data.
 *   - it is a no-op the moment the stored schema already names `'partial'`, so
 *     it runs once per store and never on a fresh one.
 */
function migrateProjectRunsForPartial(db: Database.Database): void {
  rebuildTableUnlessSchemaNames(db, 'project_runs', `'partial'`, projectRunsTable);
}

/**
 * Widen `project_run_payers.source` to admit `'run'`, by the same rebuild. The
 * payer rows are immutable evidence, so the rebuild copies them verbatim and
 * the DDL re-run restores their immutability trigger with the index.
 */
function migrateRunPayersForRunSource(db: Database.Database): void {
  rebuildTableUnlessSchemaNames(db, 'project_run_payers', `'run'`, projectRunPayersTable);
}

/** The one rebuild procedure, documented on `migrateProjectRunsForPartial`. */
function rebuildTableUnlessSchemaNames(
  db: Database.Database,
  table: string,
  marker: string,
  definition: (name: string) => string
): void {
  const stored = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  if (!stored?.sql || stored.sql.includes(marker)) return;
  const temporary = `${table}_rebuild`;
  const columnsOf = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name
    );
  const oldColumns = columnsOf(table);
  const foreignKeysWereOn =
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined)
      ?.foreign_keys === 1;
  // Outside the transaction: SQLite ignores this pragma inside one.
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS ${temporary}`);
      db.exec(definition(temporary));
      const fresh = columnsOf(temporary);
      for (const column of oldColumns) {
        if (!fresh.includes(column)) db.exec(`ALTER TABLE ${temporary} ADD COLUMN ${column} TEXT`);
      }
      const list = oldColumns.join(', ');
      db.exec(`INSERT INTO ${temporary} (${list}) SELECT ${list} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
      // The drop took the table's indexes and its identity trigger with it.
      // Re-running the whole DDL is the honest way to restore them: every
      // statement in it is `IF NOT EXISTS`, so it recreates exactly what is
      // missing and cannot drift from a second hand-written copy.
      db.exec(PROJECT_TABLES_DDL);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (foreignKeysWereOn) db.exec('PRAGMA foreign_keys=ON');
  }
}

const RUN_TRANSITIONS: Readonly<Record<ProjectRunStatus, readonly ProjectRunStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  // 'partial' is terminal like its siblings, and reachable only from
  // 'running': a landed run is one that was in flight and stopped on its own
  // budget. It is NOT a step on the way to 'delivered' — the next attempt is
  // its own run, seeded from this one's workspace.
  running: ['delivered', 'partial', 'failed', 'cancelled'],
  delivered: [],
  partial: [],
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
  repository_source_json: string | null;
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
  repository_base_json: string | null;
  workspace_path: string;
  runs_path: string;
  log_path: string;
  skills_path?: string | null;
  bytes_expired_at?: string | null;
  rerun_of_run_id?: string | null;
  model_overrides_json?: string | null;
  seed_json?: string | null;
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
  base_sha: string | null;
  pull_request_url: string | null;
  git_json: string | null;
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
      ...(row.repository_source_json ? { source: parseJson(row.repository_source_json, 'repository source') } : {}),
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
    bytesExpiredAt: row.bytes_expired_at ?? null,
    status: row.status,
    hostPaths: {
      workspacePath: row.workspace_path,
      runsPath: row.runs_path,
      logPath: row.log_path,
      ...(row.skills_path ? { skillsPath: row.skills_path } : {}),
    },
    ...(row.repository_base_json ? { repositoryBase: parseJson(row.repository_base_json, 'repository base') } : {}),
    ...(row.rerun_of_run_id ? { rerunOf: row.rerun_of_run_id } : {}),
    ...(row.model_overrides_json ? { modelOverrides: parseJson(row.model_overrides_json, 'model overrides') } : {}),
    ...(row.seed_json ? { seed: parseJson(row.seed_json, 'run seed') } : {}),
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
    // `?? null` deliberately: a store opened with `initialize: false` ran no
    // migration, so the column may be absent and better-sqlite3 yields
    // undefined. Degrade to null instead of failing the parse on every row.
    baseSha: row.base_sha ?? null,
    git: row.git_json ? parseJson(row.git_json, 'publication git receipt') : null,
    ...(row.pull_request_url ? { pullRequestUrl: row.pull_request_url } : {}),
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

/**
 * Does this store already hold the project control plane?
 *
 * For READERS that must not bring it into being. `ProjectStore.open` applies
 * the DDL, which is right for the server that owns these tables and wrong for
 * an observer: a watcher pointed at a store that has never had a tenant would
 * otherwise CREATE the tenant tables as a side effect of looking. Read-only
 * connection, closed immediately.
 */
export function hasProjectTables(dbPath: string): boolean {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_runs'")
        .get() !== undefined
    );
  } finally {
    db.close();
  }
}

/**
 * `CREATE INDEX` that REPORTS its refusal instead of throwing.
 *
 * Every index applied at open time is a constraint imposed on rows that
 * already exist, so "this store cannot satisfy it" is an expected answer, not
 * an exception: a deployment whose store predates the constraint must still
 * OPEN. The reason comes back so the caller can choose what to fall back to,
 * and tell the operator what it fell back from.
 */
function createIndexOrReason(db: Database.Database, sql: string): string | null {
  try {
    db.exec(sql);
    return null;
  } catch (error) {
    return String(error);
  }
}

export class ProjectStore {
  private readonly db: Database.Database;
  private readonly closeOnClose: boolean;

  constructor(db: Database.Database, options: ProjectStoreOptions = {}) {
    this.db = db;
    this.closeOnClose = options.closeOnClose ?? false;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    if (options.initialize !== false) {
      this.db.exec(PROJECT_TABLES_DDL);
      // BEFORE the additive migration below, and before anything writes: a
      // store created prior to 2026-09-22 carries a status CHECK that refuses
      // `'partial'`, and the rebuild copies the table as it finds it.
      migrateProjectRunsForPartial(this.db);
      migrateRunPayersForRunSource(this.db);
      // ADDITIVE MIGRATION. `CREATE TABLE IF NOT EXISTS` does nothing to a
      // table that already exists, so a column added to the DDL above never
      // reaches a store created before it. Same guarded shape the auth store
      // uses. INSIDE this branch on purpose: `hasProjectTables` exists so a
      // reader may open a store with no control plane, and PRAGMA/ALTER there
      // would throw.
      //
      // No backfill and no guess: every publication that has ever succeeded in
      // this product was a first publish, so NULL — "this publication created
      // the branch" — is factually true for every pre-existing row.
      const publicationColumns = (
        this.db.prepare('PRAGMA table_info(project_publications)').all() as { name: string }[]
      ).map((column) => column.name);
      if (!publicationColumns.includes('base_sha')) {
        this.db.exec('ALTER TABLE project_publications ADD COLUMN base_sha TEXT');
      }
      for (const [table, column] of [
        ['projects', 'repository_source_json'],
        ['project_runs', 'repository_base_json'],
        ['project_runs', 'skills_path'],
        ['project_runs', 'bytes_expired_at'],
        ['project_runs', 'bytes_deleted_at'],
        ['project_runs', 'rerun_of_run_id'],
        ['project_runs', 'model_overrides_json'],
        ['project_runs', 'seed_json'],
        ['project_run_acceptance', 'source'],
        ['project_publications', 'pull_request_url'],
        ['project_publications', 'seed_commit_sha'],
        ['project_publications', 'git_json'],
      ]) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
      // AFTER the ALTER loop and outside the DDL constant, because the columns
      // exist only once that loop ran; `IF NOT EXISTS` recreates them after a
      // rebuild, which restores only what the DDL declares. What a rerun
      // re-ran and on which models is fixed at reservation, and a seed once
      // recorded is a fact about the past.
      this.db.exec(`
CREATE TRIGGER IF NOT EXISTS project_runs_rerun_immutable
BEFORE UPDATE OF rerun_of_run_id, model_overrides_json ON project_runs
WHEN NEW.rerun_of_run_id IS NOT OLD.rerun_of_run_id
  OR NEW.model_overrides_json IS NOT OLD.model_overrides_json
BEGIN
  SELECT RAISE(ABORT, 'what a comparison rerun re-ran is immutable');
END;
CREATE TRIGGER IF NOT EXISTS project_runs_seed_immutable
BEFORE UPDATE OF seed_json ON project_runs
WHEN OLD.seed_json IS NOT NULL AND NEW.seed_json IS NOT OLD.seed_json
BEGIN
  SELECT RAISE(ABORT, 'a recorded run seed is immutable');
END;
`);
      // ONE PROJECT PER REPOSITORY, per organisation, COMPARED THE WAY GITHUB
      // COMPARES IT. Nothing forbade two
      // projects naming the same repository, and since publication became
      // incremental the second one only finds out AFTER it has run and spent:
      // its first publish reads a branch this project does not own and is
      // refused, permanently. A unique INDEX rather than a table constraint
      // because SQLite cannot add a CHECK or a UNIQUE by ALTER TABLE, and a
      // rebuild would leave fresh and migrated stores with different schemas.
      //
      // Guarded: a store that already holds a duplicate pair cannot create it,
      // and failing to OPEN would be far worse than failing to enforce. The
      // operator is told, loudly, which pair to resolve.
      //
      // FOLDED, and under a NEW NAME. The first version of this index compared
      // BINARY, so `acme/Site` and `acme/site` were two rows here and one
      // repository at GitHub: the collision walked straight back onto the
      // publish path this index exists to clear (2026-08-27, 2.5). The client
      // has always known better — `parseRepository` folds case before comparing
      // an identity — and the alphabet GitHub allows in an owner or a
      // repository name is ASCII, exactly what SQLite's `lower()` folds.
      //
      // The new name is load-bearing: `CREATE UNIQUE INDEX IF NOT EXISTS`
      // matches by NAME, so reusing the old one would leave every migrated
      // store on the binary index while claiming to have migrated. The binary
      // index is dropped only AFTER the folded one exists, so no step leaves a
      // store less protected than it opened, and a store already holding a
      // case-variant pair — the one that needs this most — keeps the binary
      // index and is told which pair to resolve.
      const folded = createIndexOrReason(
        this.db,
        `CREATE UNIQUE INDEX IF NOT EXISTS projects_org_repository_target_ci_idx
           ON projects(org_id, lower(repository_target_owner), lower(repository_target_name))`
      );
      if (folded === null) {
        this.db.exec('DROP INDEX IF EXISTS projects_org_repository_target_idx');
      } else {
        const binary = createIndexOrReason(
          this.db,
          `CREATE UNIQUE INDEX IF NOT EXISTS projects_org_repository_target_idx
             ON projects(org_id, repository_target_owner, repository_target_name)`
        );
        process.stderr.write(
          `[atoma projects] cannot enforce one project per repository case-insensitively: ${folded}\n` +
            '[atoma projects] two projects in one organisation name the same repository up to case; ' +
            'resolve the duplicate and reopen the store to enforce it\n' +
            (binary === null
              ? '[atoma projects] exact duplicates are still refused meanwhile\n'
              : `[atoma projects] exact duplicates are NOT refused either: ${binary}\n`)
        );
      }
    }
  }

  /** Open the explicitly selected primary product store. There is no default. */
  static open(dbPath: string): ProjectStore {
    if (!dbPath) throw new Error('ProjectStore.open requires the selected product DB path');
    return new ProjectStore(openStoreHandle(dbPath, PROJECT_TABLES_DDL));
  }

  saveRepositoryRunBase(orgId: string, runId: string, input: RepositoryRunBase): void {
    const base = repositoryRunBaseSchema.parse(input);
    const changed = this.db.prepare(`UPDATE project_runs SET repository_base_json = ?
      WHERE org_id = ? AND project_run_id = ? AND status = 'running' AND repository_base_json IS NULL`)
      .run(JSON.stringify(base), orgId, runId).changes;
    if (changed !== 1) throw new ProjectStateConflict('repository base already captured or run is not running');
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
    // ONE WRITE TRANSACTION, NOT THREE STATEMENTS (2026-08-27, 3.5). Both
    // checks below read rows the INSERT then depends on, and this store file
    // has more than one writer: `POST /api/projects` and `projects create` are
    // separate processes over one path. Outside a transaction the loser of that
    // race passed both checks and met the unique index only at INSERT time, so
    // the 409 that names the holder reached the caller as a driver's UNIQUE
    // prose instead — and on the folded EXPRESSION index that prose names the
    // INDEX, not the columns, which no backstop in this repo recognises.
    // `BEGIN IMMEDIATE` (better-sqlite3's `.immediate`) takes the write lock
    // BEFORE the first read, so the checks and the INSERT are one decision
    // against every other writer on the machine; `busy_timeout = 5000` above
    // makes the loser wait rather than fail.
    const transact = this.db.transaction((): Project => {
      // THE SLUG SPEAKS FIRST: it is the project's own identity, and a caller who
      // reused it wants to hear that, not a fact about a repository. Explicit
      // rather than caught from a UNIQUE violation's message, because parsing a
      // driver's prose to learn which constraint fired is the brittleness this
      // codebase keeps removing elsewhere.
      const slugTaken = this.db
        .prepare('SELECT project_id FROM projects WHERE org_id = ? AND slug = ? LIMIT 1')
        .get(orgId, project.slug) as { project_id: string } | undefined;
      if (slugTaken) {
        throw new ProjectStateConflict(
          `a project with the slug ${project.slug} already exists in this organisation`
        );
      }
      // Then the repository. The unique index below is the guarantee, but a raw
      // constraint violation says nothing an operator can act on, and the whole
      // point is to move this refusal off the publish path — where it costs a
      // run — and onto creation, where it costs a retyped flag.
      //
      // FOLDED, like the index and like GitHub: `acme/Site` and `acme/site` are
      // one repository, and comparing them binary here is what let the second
      // project be created and then fail permanently at its first publish.
      const taken = this.db
        .prepare(
          `SELECT slug, repository_target_owner AS owner, repository_target_name AS name
             FROM projects
            WHERE org_id = ?
              AND lower(repository_target_owner) = lower(?)
              AND lower(repository_target_name) = lower(?)
            LIMIT 1`
        )
        .get(orgId, project.repositoryTarget.owner, project.repositoryTarget.name) as
        | { slug: string; owner: string; name: string }
        | undefined;
      if (taken) {
        // The HOLDER's spelling, not the caller's. They differ now that the
        // comparison folds, and echoing the caller's back would name a
        // repository the holding project does not actually publish to.
        throw new ProjectStateConflict(
          `project ${taken.slug} already publishes to ${taken.owner}/${taken.name}; one repository belongs to one project`
        );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO projects (
             project_id, org_id, created_by_principal_id, name, slug, initial_prompt, family,
             status, github_installation_id, repository_target_owner, repository_target_name,
             repository_visibility, repository_source_json, repository_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 'pending', ?, ?)`
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
          project.repositoryTarget.source ? JSON.stringify(project.repositoryTarget.source) : null,
          now,
          now
        );
        return this.getProject(orgId, projectId)!;
    });
    // `.immediate` and not the default deferred transaction: a deferred one
    // takes the write lock at the INSERT, which is after both reads and
    // therefore exactly the window this closes.
    return transact.immediate();
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

  /**
   * PLATFORM-ADMIN READS. Every method below deliberately drops the org
   * filter; callers must gate them on `viewer.platformAdmin`. They exist so
   * the admin surface reuses the exact same row shapes as the org-scoped
   * reads instead of growing a parallel projection.
   */
  listAllProjects(): Array<Project & { orgName: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT p.*, o.name AS org_name
           FROM projects p
           LEFT JOIN auth_organisations o ON o.org_id = p.org_id
           ORDER BY p.updated_at DESC, p.project_id ASC`
        )
        .all() as Array<ProjectRow & { org_name: string | null }>
    ).map((row) => ({ ...projectFromRow(row), orgName: row.org_name }));
  }

  /** Resolve a project by id across ALL organisations (admin reads only). */
  getProjectAnyOrg(projectIdInput: string): Project | null {
    const projectId = projectIdSchema.parse(projectIdInput);
    const row = this.db
      .prepare('SELECT * FROM projects WHERE project_id = ?')
      .get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  listAllRunTraces(): Array<{
    id: string;
    orgId: string;
    file: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    rerunOf?: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.org_id, r.project_run_id, r.trace_id, r.runs_path, r.project_id, p.name AS project_name, p.slug AS project_slug, r.rerun_of_run_id
         FROM project_runs r
         JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
         ORDER BY r.created_at DESC, r.project_run_id ASC`
      )
      .all() as Array<{
      org_id: string;
      project_run_id: string;
      trace_id: string | null;
      runs_path: string;
      project_id: string;
      project_name: string;
      project_slug: string;
      rerun_of_run_id?: string | null;
    }>;
    const out: Array<{
      id: string;
      orgId: string;
      file: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
      rerunOf?: string;
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
        orgId: row.org_id,
        file,
        projectId: row.project_id,
        projectName: row.project_name,
        projectSlug: row.project_slug,
        ...(row.rerun_of_run_id ? { rerunOf: row.rerun_of_run_id } : {}),
      });
    }
    return out;
  }

  /**
   * Runs the control plane says are executing RIGHT NOW, with the trace file
   * to read and the scope a finding about them belongs to.
   *
   * `status = 'running'` is a TRANSACTIONAL fact, which is why a live watch
   * over this corpus needs no heuristic — unlike the operator corpus, where
   * `isIndexEntryLive` has to INFER liveness from event timestamps because
   * nothing records it. Two caveats belong to the caller, not here: a run is
   * `running` before its recorder has persisted anything, so `file` is null
   * for the first seconds; and a row can outlive its process (SIGKILL between
   * two transitions) until boot's `reconcileInterrupted` fails it.
   *
   * Cross-org by construction — the same scope `listAllRunTraces` already
   * serves, and for the same reason: the caller is the platform-wide sentinel,
   * reachable only by a platform admin.
   */
  listLiveRunTraces(): Array<{
    projectRunId: string;
    orgId: string;
    projectId: string;
    projectSlug: string;
    file: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.project_run_id, r.trace_id, r.runs_path, r.org_id, r.project_id,
                p.slug AS project_slug
         FROM project_runs r
         JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
         WHERE r.status = 'running'
         ORDER BY r.started_at ASC, r.project_run_id ASC`
      )
      .all() as Array<{
      project_run_id: string;
      trace_id: string | null;
      runs_path: string;
      org_id: string;
      project_id: string;
      project_slug: string;
    }>;
    return rows.map((row) => ({
      projectRunId: row.project_run_id,
      orgId: row.org_id,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      file: resolveProjectRunTraceFile({
        projectRunId: row.project_run_id,
        runsPath: row.runs_path,
        traceId: row.trace_id,
      }),
    }));
  }

  /**
   * Runs the control plane says have ENDED, with the trace to analyse and the
   * scope a verdict about them belongs to — the analyst's corpus, symmetric to
   * `listLiveRunTraces` for the sentinel. `ended_at` is the transactional
   * terminal fact, so no quiet-period inference is needed here; the caller
   * still waits for the machine to be idle before spending on one.
   *
   * Cross-org by construction, for the same reason as the two listings above:
   * the caller is the platform-wide supervisor, never a tenant surface.
   */
  listFinishedRunTraces(): Array<{
    projectRunId: string;
    orgId: string;
    projectId: string;
    projectSlug: string;
    status: 'delivered' | 'partial' | 'failed' | 'cancelled';
    endedAt: string;
    file: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.project_run_id, r.trace_id, r.runs_path, r.org_id, r.project_id, r.status, r.ended_at,
                p.slug AS project_slug
         FROM project_runs r
         JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
         WHERE r.status IN ('delivered', 'partial', 'failed', 'cancelled') AND r.ended_at IS NOT NULL
         ORDER BY r.ended_at ASC, r.project_run_id ASC`
      )
      .all() as Array<{
      project_run_id: string;
      trace_id: string | null;
      runs_path: string;
      org_id: string;
      project_id: string;
      status: 'delivered' | 'partial' | 'failed' | 'cancelled';
      ended_at: string;
      project_slug: string;
    }>;
    return rows.map((row) => ({
      projectRunId: row.project_run_id,
      orgId: row.org_id,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      status: row.status,
      endedAt: row.ended_at,
      file: resolveProjectRunTraceFile({
        projectRunId: row.project_run_id,
        runsPath: row.runs_path,
        traceId: row.trace_id,
      }),
    }));
  }

  findAnyRunTraceFile(idInput: string, onRead?: (orgId: string) => void): string | null {
    if (!isRunLookupId(idInput)) return null;
    const asUuid = projectRunIdSchema.safeParse(idInput);
    const row = (
      asUuid.success
        ? this.db
            .prepare(
              `SELECT org_id, project_run_id, trace_id, runs_path FROM project_runs
               WHERE project_run_id = ? OR trace_id = ?`
            )
            .get(asUuid.data, asUuid.data)
        : this.db
            .prepare(
              `SELECT org_id, project_run_id, trace_id, runs_path FROM project_runs WHERE trace_id = ?`
            )
            .get(idInput)
    ) as { org_id: string; project_run_id: string; trace_id: string | null; runs_path: string } | undefined;
    if (!row) return null;
    onRead?.(row.org_id);
    return resolveProjectRunTraceFile({
      projectRunId: row.project_run_id,
      runsPath: row.runs_path,
      traceId: row.trace_id,
    });
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

  /**
   * Move a project from an installation GitHub no longer knows to its
   * organisation's replacement installation of the SAME account. Compare-and-
   * set on the old id, so two publishers racing to rebind converge on one row.
   * The caller decides eligibility (see `GitHubPublisher`); this only writes.
   */
  rebindInstallation(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly from: string;
    readonly to: string;
  }): Project | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectId = projectIdSchema.parse(input.projectId);
    const current = this.getProject(orgId, projectId);
    if (!current) return null;
    if (current.repositoryTarget.installationId === input.to) return current;
    const changed = this.db
      .prepare(
        `UPDATE projects SET github_installation_id = ?, updated_at = ?
         WHERE project_id = ? AND org_id = ? AND github_installation_id = ?`
      )
      .run(input.to, new Date().toISOString(), projectId, orgId, input.from).changes;
    if (changed !== 1) throw new ProjectStateConflict('installation rebind lost to a concurrent change');
    return this.getProject(orgId, projectId)!;
  }

  /** Read an exact retry without reserving another run or taking its lease. */
  findProjectRunForRequest(
    orgIdInput: string,
    projectIdInput: string,
    principalIdInput: string,
    requestInput: StartProjectRunInput
  ): ProjectRun | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsed = startProjectRunInputSchema.parse(requestInput);
    const project = this.getProject(orgId, projectId);
    if (!project) return null;
    if (project.status !== 'active') throw new ProjectStateConflict('cannot run an archived project');
    const existing = this.db
      .prepare('SELECT * FROM project_runs WHERE project_id = ? AND request_key = ? AND org_id = ?')
      .get(projectId, parsed.idempotencyKey, orgId) as ProjectRunRow | undefined;
    if (!existing) return null;
    if ('rerunOf' in parsed) {
      // A rerun's identity is WHAT it re-ran and ON WHICH MODELS; its goal and
      // list are copies of the origin's, which is immutable, so comparing them
      // again would compare a row with itself.
      if (existing.requested_by_principal_id !== principalId ||
          existing.rerun_of_run_id !== parsed.rerunOf ||
          existing.model_overrides_json !== JSON.stringify(parsed.models)) {
        throw new ProjectStateConflict('run idempotency key was already used for different input');
      }
      return runFromRow(existing);
    }
    const request = createProjectRunInputSchema.parse(requestInput);
    if (existing.rerun_of_run_id) {
      throw new ProjectStateConflict('run idempotency key was already used for different input');
    }
    // The approved list is part of the request: the same key and goal with a
    // different list is a different request, never a retry of the old run.
    const wantedDigest = request.acceptanceChecklist ? captureAcceptanceSpec(request.acceptanceChecklist).digest : null;
    const storedDigest = this.getRunAcceptanceSpec(orgId, existing.project_run_id)?.digest ?? null;
    if (existing.requested_by_principal_id !== principalId || existing.goal !== request.goal ||
        wantedDigest !== storedDigest) {
      throw new ProjectStateConflict('run idempotency key was already used for different input');
    }
    return runFromRow(existing);
  }

  runCapacity(orgIdInput: string): OrgRunCapacity {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const limit = this.db.prepare('SELECT max_concurrent AS value FROM org_run_limits WHERE org_id = ?')
      .get(orgId) as { value: number } | undefined;
    const count = this.db.prepare("SELECT COUNT(*) AS value FROM project_runs WHERE org_id = ? AND status IN ('queued','running')")
      .get(orgId) as { value: number };
    return { maxConcurrent: orgRunLimitSchema.parse(limit?.value ?? 1), active: count.value, globalMaxConcurrent: 1 };
  }

  setRunLimit(orgIdInput: string, value: number): void {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const limit = orgRunLimitSchema.parse(value);
    this.db.prepare(`INSERT INTO org_run_limits (org_id, max_concurrent) VALUES (?, ?)
      ON CONFLICT(org_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`).run(orgId, limit);
  }

  assertRunCapacity(orgId: string): void {
    const capacity = this.runCapacity(orgId);
    if (capacity.active >= capacity.maxConcurrent) {
      throw new ProjectStateConflict(capacity.maxConcurrent === 0
        ? 'New runs are suspended for this organisation'
        : 'Organisation concurrent run limit reached');
    }
  }

  createProjectRun(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly principalId: string;
    readonly request: StartProjectRunInput;
    /**
     * Required with a rerun request, refused without one: what the host
     * copied from the origin run. The goal is the origin's; the acceptance
     * list is the one the origin ran against, with who wrote it.
     */
    readonly origin?: {
      readonly goal: string;
      readonly acceptance: RunAcceptance | null;
    };
    readonly hostPaths: ProjectRunHostPaths;
    readonly projectRunId?: string;
    readonly enforceCapacity?: boolean;
  }): { readonly run: ProjectRun; readonly created: boolean } | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectId = projectIdSchema.parse(input.projectId);
    const principalId = principalIdSchema.parse(input.principalId);
    const parsed = startProjectRunInputSchema.parse(input.request);
    const rerun = 'rerunOf' in parsed ? rerunProjectRunInputSchema.parse(parsed) : null;
    if (Boolean(rerun) !== Boolean(input.origin)) {
      throw new Error('a rerun request and its origin are supplied together or not at all');
    }
    const request = rerun
      ? createProjectRunInputSchema.parse({ goal: input.origin!.goal, idempotencyKey: rerun.idempotencyKey })
      : createProjectRunInputSchema.parse(parsed);
    const paths = hostPaths(input.hostPaths);
    const requestedRunId = projectRunIdSchema.parse(input.projectRunId ?? randomUUID());
    let acceptance: RunAcceptance | null = null;
    if (rerun && input.origin!.acceptance) {
      acceptance = { spec: parseAcceptanceSpec(input.origin!.acceptance.spec), source: input.origin!.acceptance.source };
    } else if (!rerun && request.acceptanceChecklist) {
      acceptance = { spec: captureAcceptanceSpec(request.acceptanceChecklist), source: 'user' };
    }
    const transact = this.db.transaction(() => {
      const project = this.getProject(orgId, projectId);
      if (!project) return null;
      if (project.status !== 'active') throw new ProjectStateConflict('cannot run an archived project');
      const goal = request.goal;
      const existing = this.findProjectRunForRequest(orgId, projectId, principalId, parsed);
      if (existing) {
        return { run: existing, created: false } as const;
      }
      if (input.enforceCapacity) this.assertRunCapacity(orgId);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO project_runs (
             project_run_id, project_id, org_id, requested_by_principal_id, request_key,
             goal, status, workspace_path, runs_path, log_path, skills_path,
             rerun_of_run_id, model_overrides_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`
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
          paths.skillsPath ?? null,
          rerun?.rerunOf ?? null,
          rerun ? JSON.stringify(rerun.models) : null,
          now,
          now
        );
      if (acceptance) {
        // `source` NULL is a user list, which is every row written before
        // 2026-09-25; only a rerun of a run that drafted its own list writes
        // 'drafted' here.
        this.db
          .prepare(
            `INSERT INTO project_run_acceptance (project_run_id, org_id, spec_json, digest, recorded_at, source)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(requestedRunId, orgId, JSON.stringify(acceptance.spec), acceptance.spec.digest, now,
            acceptance.source === 'user' ? null : acceptance.source);
      }
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

  /**
   * The acceptance list the user approved for a run, re-parsed and
   * re-digested on read; null when the run was launched without one. A row
   * that no longer matches its digest THROWS: a corrupted list is not "none".
   */
  getRunAcceptanceSpec(orgIdInput: string, projectRunIdInput: string): AcceptanceSpec | null {
    return this.getRunAcceptance(orgIdInput, projectRunIdInput)?.spec ?? null;
  }

  /**
   * The same row with WHO WROTE IT: `user` for a list a person approved,
   * `drafted` for the list a comparison rerun inherited from an origin that
   * drafted its own. The child is told which, because the two are judged
   * differently (`withAcceptanceChecklist`).
   */
  getRunAcceptance(orgIdInput: string, projectRunIdInput: string): RunAcceptance | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    // A store opened with `initialize: false` ran no DDL and may predate the
    // table; no table means no run of that store was launched with a list.
    const table = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_run_acceptance'")
      .get();
    if (!table) return null;
    const row = this.db
      .prepare('SELECT * FROM project_run_acceptance WHERE project_run_id = ? AND org_id = ?')
      .get(projectRunId, orgId) as { spec_json: string; digest: string; source?: string | null } | undefined;
    if (!row) return null;
    const spec = parseAcceptanceSpec(parseJson(row.spec_json, 'acceptance specification'));
    if (spec.digest !== row.digest) throw new Error('acceptance specification row digest does not match its content');
    if (row.source !== undefined && row.source !== null && row.source !== 'drafted') {
      throw new Error('acceptance specification row names an unknown source');
    }
    return { spec, source: row.source === 'drafted' ? 'drafted' : 'user' };
  }

  /**
   * Record where a running run's workspace came from, once. A compare-and-set
   * like `saveRepositoryRunBase`: only a `running` row with no seed yet, so a
   * second resolution cannot rewrite what the first one copied.
   */
  recordRunSeed(orgIdInput: string, projectRunIdInput: string, seedInput: RunSeed): void {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const seed = runSeedSchema.parse(seedInput);
    const changed = this.db
      .prepare(`UPDATE project_runs SET seed_json = ?
        WHERE org_id = ? AND project_run_id = ? AND status = 'running' AND seed_json IS NULL`)
      .run(JSON.stringify(seed), orgId, projectRunId).changes;
    if (changed !== 1) throw new ProjectStateConflict('run seed already recorded or run is not running');
  }

  /** A platform admin's READ across organisations; never a write path. */
  getProjectRunAnyOrg(projectRunIdInput: string): ProjectRun | null {
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare('SELECT * FROM project_runs WHERE project_run_id = ?')
      .get(projectRunId) as ProjectRunRow | undefined;
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

  projectRunSummary(
    orgIdInput: string,
    projectIdInput: string
  ): { runCount: number; lastRunAt: string | null } {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS run_count, MAX(created_at) AS last_run_at
         FROM project_runs WHERE project_id = ? AND org_id = ?`
      )
      .get(projectId, orgId) as { run_count: number; last_run_at: string | null };
    return { runCount: row.run_count, lastRunAt: row.last_run_at };
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
    rerunOf?: string;
  }> {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const rows = this.db
      .prepare(
        `SELECT r.project_run_id, r.trace_id, r.runs_path, r.project_id, p.name AS project_name, p.slug AS project_slug, r.rerun_of_run_id
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
      rerun_of_run_id?: string | null;
    }>;
    const out: Array<{
      id: string;
      file: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
      rerunOf?: string;
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
        ...(row.rerun_of_run_id ? { rerunOf: row.rerun_of_run_id } : {}),
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
    // Same evidence bar as 'delivered', and deliberately so: a landed run is a
    // real deliverable, just an incomplete one, so it owes the same trace and
    // the same self-consistent stats. It differs on one point — it may carry an
    // error string, because the phases it never ran are worth naming and there
    // is no other field that says so.
    if (to === 'partial') {
      if (!nextTraceId || !stats || stats.outcome !== 'partial') {
        throw new Error('partial requires traceId and partial run stats');
      }
    }
    if (to === 'failed') {
      if (!error) throw new Error('failed requires an error');
      if (stats?.outcome === 'delivered' || stats?.outcome === 'partial' || stats?.outcome === 'cancelled') {
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
    const terminal = to === 'delivered' || to === 'partial' || to === 'failed' || to === 'cancelled';
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

  /**
   * A run starts and its payer ledger become visible together — the mirror of
   * `completeProjectRun`. Anything that reads `running` can therefore read
   * who pays for it, and a crash between the two is not a reachable state.
   */
  startProjectRun(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly payers: RunPayerLedger;
  }): ProjectRun | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const payers = runPayerLedgerSchema.parse(input.payers);
    return this.db.transaction(() => {
      const started = this.transitionProjectRun({
        orgId,
        projectRunId,
        from: 'queued',
        to: 'running',
      });
      if (!started) return null;
      // `transitionProjectRun` treats a same-status transition as an
      // idempotent replay, so a second start must be one here too — but only
      // a replay that says the same thing. A start that renamed the payer
      // would rewrite evidence through the back door the immutability trigger
      // exists to close.
      const existing = this.getRunPayers(orgId, projectRunId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(payers)) {
          throw new ProjectStateConflict('run start replay carries different payers');
        }
        return started;
      }
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO project_run_payers
           (project_run_id, tier, org_id, selection, provider, payer, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [tier, row] of ledgerRows(payers)) {
        insert.run(projectRunId, tier, orgId, row.selection, row.provider, row.payer, row.source, now);
      }
      return started;
    }).immediate();
  }

  /**
   * The payer rows of one run, in tier order. A per-run read, deliberately
   * NOT an org-wide cost surface: what a tenant may be shown about spend is
   * an open product decision, and this is the evidence underneath it.
   */
  getRunPayers(orgIdInput: string, projectRunIdInput: string): RunPayerLedger | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const rows = this.db
      .prepare(
        `SELECT tier, selection, provider, payer, source
         FROM project_run_payers WHERE project_run_id = ? AND org_id = ?`
      )
      .all(projectRunId, orgId) as Array<{
      tier: string;
      selection: string;
      provider: string;
      payer: string;
      source: string;
    }>;
    if (rows.length === 0) return null;
    const byTier = Object.fromEntries(
      rows.map((row) => [row.tier, { selection: row.selection, provider: row.provider, payer: row.payer, source: row.source }])
    );
    const parsed = runPayerLedgerSchema.safeParse(byTier);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Delivery and its immutable file inventory become visible together.
   *
   * `to` carries the two outcomes that HAVE an inventory. A landed run takes
   * the same path as a delivered one — same transaction, same manifest, same
   * atomicity — because its files are equally real; the difference is the
   * status it lands in and the fact that publication will not touch it.
   */
  completeProjectRun(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly traceId: string;
    readonly stats: RunStats;
    readonly manifest: ArtifactManifest;
    readonly to?: 'delivered' | 'partial';
    readonly error?: string;
  }): ProjectRun | null {
    return this.db.transaction(() => {
      const completed = this.transitionProjectRun({
        orgId: input.orgId, projectRunId: input.projectRunId,
        from: 'running', to: input.to ?? 'delivered', traceId: input.traceId, stats: input.stats,
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
      if (!completed) return null;
      const saved = this.saveArtifactManifest(input.orgId, input.projectRunId, input.manifest);
      if (!saved) throw new ProjectStateConflict('project run disappeared before artifact persistence');
      return saved;
    }).immediate();
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
    if (current.status !== 'delivered' && current.status !== 'partial') {
      throw new ProjectStateConflict('artifacts can be attached only to a delivered or partial run');
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
         WHERE project_run_id = ? AND org_id = ? AND status IN ('delivered', 'partial')
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
      // 'delivered' ONLY, and 'partial' is excluded on purpose rather than by
      // omission: the customer's repository is the one surface where an
      // incomplete artefact set would be indistinguishable from a finished
      // one once it landed, so a landed run is offered for download and seeds
      // the next run (of a project created in atoma), but never publishes and,
      // since 159ab36, is not previewed either.
      if (run.status !== 'delivered' || !run.artifactManifestHash) {
        throw new ProjectStateConflict('publication requires a delivered run with artifacts');
      }
      // THE CHOKE POINT for every publication path: a comparison rerun is a
      // measurement beside the project's line, and the project's repository
      // is that line.
      if (run.rerunOf) {
        throw new ProjectStateConflict('a comparison rerun is never published');
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

  /** Durable ownership receipt for an interrupted first publication. */
  recordPublicationSeed(orgIdInput: string, publicationIdInput: string, shaInput: string): void {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const publicationId = publicationIdSchema.parse(publicationIdInput);
    const seed = commitShaSchema.parse(shaInput);
    const result = this.db.prepare(`UPDATE project_publications SET seed_commit_sha = ?
      WHERE org_id = ? AND publication_id = ? AND status = 'publishing'
      AND (seed_commit_sha IS NULL OR seed_commit_sha = ?)`).run(seed, orgId, publicationId, seed);
    if (result.changes !== 1) throw new Error('Publication seed receipt could not be recorded');
  }

  publicationSeed(orgIdInput: string, publicationIdInput: string): string | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const publicationId = publicationIdSchema.parse(publicationIdInput);
    const row = this.db.prepare(`SELECT seed_commit_sha FROM project_publications
      WHERE org_id = ? AND publication_id = ?`).get(orgId, publicationId) as
      { seed_commit_sha: string | null } | undefined;
    return row?.seed_commit_sha ? commitShaSchema.parse(row.seed_commit_sha) : null;
  }

  getPublicationForRun(orgIdInput: string, projectRunIdInput: string): Publication | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare('SELECT * FROM project_publications WHERE project_run_id = ? AND org_id = ?')
      .get(projectRunId, orgId) as PublicationRow | undefined;
    return row ? publicationFromRow(row) : null;
  }

  /**
   * What this PROJECT last published, and which run's artifacts those are.
   *
   * Publication is per-run and there is no per-project pointer — deliberately:
   * "is the branch still where we left it" is answerable only by GitHub, and a
   * stored head would be a cache of state GitHub owns, which is exactly how a
   * wrong divergence verdict gets manufactured. This answers the two questions
   * that ARE local: which commit is this project's own (the authority to
   * publish onto an existing branch), and how far behind the repository is.
   *
   * Ordered by the RUN's creation, not by `published_at`, because publication
   * order can differ from run order after a retry; ties break on the run id
   * rather than the publication UUID, since a UUID tiebreak can select the
   * older row and then report a head this project does not own.
   */
  lastPublishedCommitForProject(
    orgIdInput: string,
    projectIdInput: string
  ): { publicationId: string; projectRunId: string; runCreatedAt: string; commitSha: string } | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    const row = this.db
      .prepare(
        `SELECT pub.publication_id, pub.project_run_id, pub.commit_sha, r.created_at
           FROM project_publications pub
           JOIN project_runs r
             ON r.project_run_id = pub.project_run_id AND r.org_id = pub.org_id
          WHERE pub.org_id = ? AND r.project_id = ? AND pub.status = 'published'
          ORDER BY r.created_at DESC, pub.project_run_id DESC
          LIMIT 1`
      )
      .get(orgId, projectId) as
      | { publication_id: string; project_run_id: string; commit_sha: string | null; created_at: string }
      | undefined;
    if (!row || !row.commit_sha) return null;
    return {
      publicationId: row.publication_id,
      projectRunId: row.project_run_id,
      runCreatedAt: row.created_at,
      commitSha: row.commit_sha,
    };
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
          current.commitSha !== receipt.commitSha ||
          current.baseSha !== receipt.baseSha ||
          JSON.stringify(current.git ?? null) !== JSON.stringify(receipt.git ?? null) ||
          (current.pullRequestUrl ?? null) !== (receipt.pullRequestUrl ?? null))
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
             commit_sha = ?, base_sha = ?, pull_request_url = ?, git_json = ?, error = ?, published_at = ?, updated_at = ?
         WHERE publication_id = ? AND org_id = ? AND status = ?`
      )
      .run(
        to,
        receipt?.repositoryId ?? null,
        receipt?.fullName ?? null,
        receipt?.url ?? null,
        receipt?.commitSha ?? null,
        receipt?.baseSha ?? null,
        receipt?.pullRequestUrl ?? null,
        receipt?.git ? JSON.stringify(receipt.git) : null,
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

  /**
   * Boot-time crash recovery. The only writers that move a run out of
   * `queued`/`running` or a publication out of `publishing` are in-memory
   * drivers inside the viz server process (`ProjectRunCoordinator.finish`,
   * `GitHubPublisher.publish`). After a crash no such driver exists, so those
   * rows can never move again on their own — and the publisher short-circuits
   * on `publishing`, which would block even a future retry forever. Fails
   * each orphan through the normal CAS transitions so triggers, timestamps
   * and validation all apply; a row that races a concurrent transition is
   * skipped, not fatal.
   */
  reconcileInterrupted(errorInput: string): { runs: number; publications: number } {
    const error = boundedError(errorInput) ?? 'interrupted';
    let runs = 0;
    const orphanRuns = this.db
      .prepare(
        `SELECT org_id, project_run_id, status FROM project_runs
         WHERE status IN ('queued','running')`
      )
      .all() as { org_id: string; project_run_id: string; status: string }[];
    for (const row of orphanRuns) {
      try {
        this.transitionProjectRun({
          orgId: row.org_id,
          projectRunId: row.project_run_id,
          from: projectRunStatusSchema.parse(row.status),
          to: 'failed',
          error,
        });
        runs += 1;
      } catch (transitionError) {
        if (!(transitionError instanceof ProjectStateConflict)) throw transitionError;
      }
    }
    let publications = 0;
    const orphanPublications = this.db
      .prepare(
        `SELECT org_id, publication_id FROM project_publications WHERE status = 'publishing'`
      )
      .all() as { org_id: string; publication_id: string }[];
    for (const row of orphanPublications) {
      try {
        this.transitionPublication({
          orgId: row.org_id,
          publicationId: row.publication_id,
          from: 'publishing',
          to: 'failed',
          error,
        });
        publications += 1;
      } catch (transitionError) {
        if (!(transitionError instanceof ProjectStateConflict)) throw transitionError;
      }
    }
    return { runs, publications };
  }

  close(): void {
    if (this.closeOnClose) this.db.close();
  }
}
