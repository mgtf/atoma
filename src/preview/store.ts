import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import {
  previewDescriptorSchema,
  previewEgressHostSchema,
  previewInstanceSchema,
  type PreviewDescriptor,
  type PreviewErrorCode,
  type PreviewInstance,
  type PreviewRuntime,
  type PreviewStopReason,
} from '../contracts/preview.js';
import { organisationIdSchema, principalIdSchema, projectIdSchema, projectRunIdSchema } from '../contracts/projects.js';

/**
 * PREVIEW STATE, IN THE ONE PRODUCT STORE.
 *
 * Three tables, no second database (`src/core/stores.ts` states why there is
 * one). They join the consolidated file the same way `auth_*`, `project*`,
 * `github_*` and `platform_events` do: one exported DDL constant handed to
 * `openStoreHandle`, whose `applied` set is keyed by the DDL STRING, so a
 * handle another subsystem already opened still gets these tables.
 *
 * The org scoping is a COMPOSITE foreign key, not a column convention:
 * `project_runs` carries `UNIQUE (project_run_id, org_id)` precisely so a
 * child row cannot name a run from another organisation. Every read takes an
 * org id first and every statement filters on it, so an IDOR is a missing row
 * rather than a leaked one.
 */
export const PREVIEW_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS project_run_preview_descriptors (
  project_run_id                TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  availability                  TEXT NOT NULL CHECK (availability IN ('available','unavailable')),
  kind                          TEXT CHECK (kind IS NULL OR kind IN ('static','node')),
  entry                         TEXT,
  unavailable_reason            TEXT,
  requested_hosts_json          TEXT NOT NULL CHECK (json_valid(requested_hosts_json)),
  created_at                    TEXT NOT NULL,
  UNIQUE (project_run_id, org_id),
  FOREIGN KEY (project_run_id, org_id) REFERENCES project_runs(project_run_id, org_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(project_id, org_id),
  -- The same rule the zod schema states, restated where the bytes live: a
  -- store is read by more than the process that wrote it.
  CHECK (
    (availability = 'available' AND kind IS NOT NULL AND unavailable_reason IS NULL) OR
    (availability = 'unavailable' AND kind IS NULL AND entry IS NULL AND unavailable_reason IS NOT NULL)
  ),
  CHECK (kind IS NOT 'node' OR entry IS NOT NULL),
  CHECK (kind IS NOT 'static' OR entry IS NULL)
);

CREATE TABLE IF NOT EXISTS project_run_preview_instances (
  project_run_id                TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  state                         TEXT NOT NULL CHECK (state IN ('stopped','starting','ready','stopping','failed')),
  generation                    INTEGER NOT NULL CHECK (generation > 0),
  -- WHAT ACTUALLY SERVED THIS GENERATION. Null for a static preview, which
  -- runs no container; otherwise the pinned digest and the isolation runtime,
  -- so a rollback can be explained and not merely performed.
  image_digest                  TEXT,
  runtime                       TEXT CHECK (runtime IS NULL OR runtime IN ('runsc','runc')),
  started_at                    TEXT,
  ready_at                      TEXT,
  last_activity_at              TEXT,
  expires_at                    TEXT,
  error_code                    TEXT,
  last_stop_reason              TEXT,
  updated_at                    TEXT NOT NULL,
  UNIQUE (project_run_id, org_id),
  FOREIGN KEY (project_run_id, org_id) REFERENCES project_runs(project_run_id, org_id),
  CHECK (
    (state <> 'failed' AND error_code IS NULL) OR
    (state =  'failed' AND error_code IS NOT NULL)
  ),
  CHECK (state <> 'ready' OR ready_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS project_preview_egress (
  project_id                    TEXT NOT NULL,
  org_id                        TEXT NOT NULL REFERENCES auth_organisations(org_id),
  host                          TEXT NOT NULL,
  approved_by_principal_id      TEXT NOT NULL REFERENCES auth_principals(principal_id),
  approved_at                   TEXT NOT NULL,
  PRIMARY KEY (project_id, host),
  FOREIGN KEY (project_id, org_id) REFERENCES projects(project_id, org_id),
  FOREIGN KEY (org_id, approved_by_principal_id)
    REFERENCES auth_memberships(org_id, principal_id)
);

CREATE INDEX IF NOT EXISTS project_preview_instances_org_state_idx
  ON project_run_preview_instances(org_id, state);
CREATE INDEX IF NOT EXISTS project_preview_egress_org_project_idx
  ON project_preview_egress(org_id, project_id);

-- A descriptor is what delivery OBSERVED. Revising it would describe a
-- workspace that has not changed, so the store refuses rather than trusting
-- every future writer to remember.
CREATE TRIGGER IF NOT EXISTS project_run_preview_descriptors_immutable
BEFORE UPDATE ON project_run_preview_descriptors
BEGIN
  SELECT RAISE(ABORT, 'preview descriptors are immutable');
END;

-- Generation is monotonic per run: a restart mints a new browser origin, and
-- an origin that could go backwards would let a stale service worker from a
-- previous generation control the next one.
CREATE TRIGGER IF NOT EXISTS project_run_preview_instances_generation_monotonic
BEFORE UPDATE OF generation ON project_run_preview_instances
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'preview generation must not go backwards');
END;
`;

export class PreviewStateConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewStateConflict';
  }
}

interface DescriptorRow {
  project_run_id: string;
  project_id: string;
  org_id: string;
  availability: string;
  kind: string | null;
  entry: string | null;
  unavailable_reason: string | null;
  requested_hosts_json: string;
  created_at: string;
}

interface InstanceRow {
  project_run_id: string;
  org_id: string;
  state: string;
  generation: number;
  image_digest: string | null;
  runtime: string | null;
  started_at: string | null;
  ready_at: string | null;
  last_activity_at: string | null;
  expires_at: string | null;
  error_code: string | null;
  last_stop_reason: string | null;
  updated_at: string;
}

function descriptorFromRow(row: DescriptorRow): PreviewDescriptor {
  return previewDescriptorSchema.parse({
    projectRunId: row.project_run_id,
    projectId: row.project_id,
    orgId: row.org_id,
    availability: row.availability,
    kind: row.kind,
    entry: row.entry,
    unavailableReason: row.unavailable_reason,
    requestedHosts: JSON.parse(row.requested_hosts_json) as unknown,
    createdAt: row.created_at,
  });
}

function instanceFromRow(row: InstanceRow): PreviewInstance {
  return previewInstanceSchema.parse({
    projectRunId: row.project_run_id,
    orgId: row.org_id,
    state: row.state,
    generation: row.generation,
    imageDigest: row.image_digest,
    runtime: row.runtime,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    errorCode: row.error_code,
    lastStopReason: row.last_stop_reason,
    updatedAt: row.updated_at,
  });
}

export interface PreviewStoreOptions {
  readonly initialize?: boolean;
}

export class PreviewStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database, options: PreviewStoreOptions = {}) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (options.initialize !== false) this.db.exec(PREVIEW_TABLES_DDL);
  }

  /**
   * Open against the explicitly selected product store. No default path, for
   * the same reason `ProjectStore.open` has none: these rows are tenant state,
   * and a store chosen by ambient environment is a store nobody chose.
   */
  static open(dbPath: string): PreviewStore {
    if (!dbPath) throw new Error('PreviewStore.open requires the selected product DB path');
    return new PreviewStore(openStoreHandle(dbPath, PREVIEW_TABLES_DDL));
  }

  /* ───────────────────────────── descriptors ───────────────────────────── */

  /**
   * Write the delivery-time descriptor, once.
   *
   * A second call for the same run is a NO-OP that returns the stored row
   * rather than an error: delivery is terminal, so the only way here twice is
   * a retry, and a retry must not fail a run that is already delivered.
   */
  putDescriptor(descriptor: PreviewDescriptor): PreviewDescriptor {
    const parsed = previewDescriptorSchema.parse(descriptor);
    this.db
      .prepare(
        `INSERT INTO project_run_preview_descriptors
           (project_run_id, project_id, org_id, availability, kind, entry,
            unavailable_reason, requested_hosts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_run_id) DO NOTHING`
      )
      .run(
        parsed.projectRunId,
        parsed.projectId,
        parsed.orgId,
        parsed.availability,
        parsed.kind,
        parsed.entry,
        parsed.unavailableReason,
        JSON.stringify(parsed.requestedHosts),
        parsed.createdAt
      );
    const stored = this.getDescriptor(parsed.orgId, parsed.projectRunId);
    if (!stored) throw new Error('preview descriptor disappeared immediately after insertion');
    return stored;
  }

  getDescriptor(orgIdInput: string, projectRunIdInput: string): PreviewDescriptor | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare(
        `SELECT * FROM project_run_preview_descriptors
         WHERE project_run_id = ? AND org_id = ?`
      )
      .get(projectRunId, orgId) as DescriptorRow | undefined;
    return row ? descriptorFromRow(row) : null;
  }

  /* ────────────────────────────── instances ────────────────────────────── */

  getInstance(orgIdInput: string, projectRunIdInput: string): PreviewInstance | null {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectRunId = projectRunIdSchema.parse(projectRunIdInput);
    const row = this.db
      .prepare(
        `SELECT * FROM project_run_preview_instances
         WHERE project_run_id = ? AND org_id = ?`
      )
      .get(projectRunId, orgId) as InstanceRow | undefined;
    return row ? instanceFromRow(row) : null;
  }

  /**
   * Idempotent start. Returns the live generation and whether THIS call is the
   * one that must go and build it.
   *
   * `starting` and `ready` are reused as-is, so two members clicking Preview
   * at the same moment get one isolate rather than two — the concurrency the
   * design requires of `open` (§10). `stopped` and `failed` mint the NEXT
   * generation, which is what makes a restart a new browser origin.
   *
   * One `BEGIN IMMEDIATE` transaction: the read decides what the write does,
   * and this store file has more than one writer.
   */
  openInstance(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly now?: Date;
  }): { readonly instance: PreviewInstance; readonly started: boolean } {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const now = (input.now ?? new Date()).toISOString();
    const transact = this.db.transaction(() => {
      const current = this.getInstance(orgId, projectRunId);
      if (current && (current.state === 'starting' || current.state === 'ready')) {
        return { instance: current, started: false };
      }
      if (current && current.state === 'stopping') {
        throw new PreviewStateConflict('preview is stopping; reopen once it has stopped');
      }
      const generation = (current?.generation ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO project_run_preview_instances
             (project_run_id, org_id, state, generation, image_digest, runtime,
              started_at, ready_at, last_activity_at, expires_at,
              error_code, last_stop_reason, updated_at)
           VALUES (?, ?, 'starting', ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?, ?)
           ON CONFLICT(project_run_id) DO UPDATE SET
             state = 'starting',
             generation = excluded.generation,
             image_digest = NULL,
             runtime = NULL,
             started_at = excluded.started_at,
             ready_at = NULL,
             last_activity_at = excluded.last_activity_at,
             expires_at = NULL,
             error_code = NULL,
             updated_at = excluded.updated_at
           WHERE project_run_preview_instances.generation = ?`
        )
        .run(
          projectRunId,
          orgId,
          generation,
          now,
          now,
          current?.lastStopReason ?? null,
          now,
          current?.generation ?? 0
        );
      const opened = this.getInstance(orgId, projectRunId);
      if (!opened || opened.generation !== generation) {
        // A throw, never a return: better-sqlite3 COMMITS a transaction whose
        // callback returns, so a lost race reported this way would commit
        // whatever the winner wrote while telling this caller it had started.
        throw new PreviewStateConflict('preview open lost to a concurrent start');
      }
      return { instance: opened, started: true };
    });
    return transact.immediate();
  }

  /** `starting` → `ready`, recording what served this generation. */
  markReady(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly imageDigest?: string | null;
    readonly runtime?: PreviewRuntime | null;
    readonly expiresAt: string;
    readonly now?: Date;
  }): PreviewInstance {
    const now = (input.now ?? new Date()).toISOString();
    return this.cas({
      orgId: input.orgId,
      projectRunId: input.projectRunId,
      generation: input.generation,
      sql: `UPDATE project_run_preview_instances
            SET state = 'ready', ready_at = ?, last_activity_at = ?, expires_at = ?,
                image_digest = ?, runtime = ?, error_code = NULL, updated_at = ?
            WHERE project_run_id = ? AND org_id = ? AND generation = ? AND state = 'starting'`,
      params: [
        now,
        now,
        input.expiresAt,
        input.imageDigest ?? null,
        input.runtime ?? null,
        now,
      ],
      conflict: 'preview ready CAS lost to a concurrent transition',
    });
  }

  /** Any live state → `failed`, with a bounded code the browser may read. */
  markFailed(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly errorCode: PreviewErrorCode;
    readonly now?: Date;
  }): PreviewInstance {
    const now = (input.now ?? new Date()).toISOString();
    return this.cas({
      orgId: input.orgId,
      projectRunId: input.projectRunId,
      generation: input.generation,
      sql: `UPDATE project_run_preview_instances
            SET state = 'failed', error_code = ?, ready_at = NULL, expires_at = NULL,
                updated_at = ?
            WHERE project_run_id = ? AND org_id = ? AND generation = ?
              AND state IN ('starting','ready','stopping')`,
      params: [input.errorCode, now],
      conflict: 'preview failure CAS lost to a concurrent transition',
    });
  }

  /** `starting`/`ready` → `stopping`. Teardown removes routes before runtime. */
  beginStop(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly reason: PreviewStopReason;
    readonly now?: Date;
  }): PreviewInstance {
    const now = (input.now ?? new Date()).toISOString();
    return this.cas({
      orgId: input.orgId,
      projectRunId: input.projectRunId,
      generation: input.generation,
      sql: `UPDATE project_run_preview_instances
            SET state = 'stopping', last_stop_reason = ?, ready_at = NULL, expires_at = NULL,
                error_code = NULL, updated_at = ?
            WHERE project_run_id = ? AND org_id = ? AND generation = ?
              AND state IN ('starting','ready')`,
      params: [input.reason, now],
      conflict: 'preview stop CAS lost to a concurrent transition',
    });
  }

  /**
   * `stopping` → `stopped`, and ONLY from `stopping`.
   *
   * A FAILED PREVIEW STAYS FAILED until the next explicit open, which is what
   * the state machine says and what a member needs: `failed` is the state that
   * carries the bounded error code, so a teardown that moved the row to
   * `stopped` would clear the one field explaining why the button did not
   * work. Releasing the runtime objects of a failed start is the service's
   * job; the row is state, not a teardown queue.
   */
  finishStop(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly reason: PreviewStopReason;
    readonly now?: Date;
  }): PreviewInstance {
    const now = (input.now ?? new Date()).toISOString();
    return this.cas({
      orgId: input.orgId,
      projectRunId: input.projectRunId,
      generation: input.generation,
      sql: `UPDATE project_run_preview_instances
            SET state = 'stopped', last_stop_reason = ?, ready_at = NULL, expires_at = NULL,
                image_digest = NULL, runtime = NULL, error_code = NULL, updated_at = ?
            WHERE project_run_id = ? AND org_id = ? AND generation = ?
              AND state = 'stopping'`,
      params: [input.reason, now],
      conflict: 'preview stop CAS lost to a concurrent transition',
    });
  }

  /**
   * The trusted UI heartbeat, and ONLY in `ready`.
   *
   * Application traffic never reaches here by construction: this is called by
   * the authenticated parent surface, not by the preview's own requests, so
   * abandoned generated code cannot keep itself alive (design D6).
   */
  touchActivity(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly now?: Date;
  }): PreviewInstance | null {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const now = (input.now ?? new Date()).toISOString();
    const changed = this.db
      .prepare(
        `UPDATE project_run_preview_instances
         SET last_activity_at = ?, updated_at = ?
         WHERE project_run_id = ? AND org_id = ? AND generation = ? AND state = 'ready'`
      )
      .run(now, now, projectRunId, orgId, input.generation).changes;
    // A heartbeat for a generation that has moved on is not an error: the
    // browser is a beat behind, and telling it so is the caller's job.
    return changed === 1 ? this.getInstance(orgId, projectRunId) : null;
  }

  /**
   * Every transition is one guarded statement: the state it may leave and the
   * generation it belongs to are both in the WHERE, so a stale caller loses
   * rather than overwriting a generation that has moved on.
   */
  private cas(input: {
    readonly orgId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly sql: string;
    readonly params: readonly unknown[];
    readonly conflict: string;
  }): PreviewInstance {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectRunId = projectRunIdSchema.parse(input.projectRunId);
    const changed = this.db
      .prepare(input.sql)
      .run(...input.params, projectRunId, orgId, input.generation).changes;
    if (changed !== 1) throw new PreviewStateConflict(input.conflict);
    const updated = this.getInstance(orgId, projectRunId);
    if (!updated) throw new PreviewStateConflict(input.conflict);
    return updated;
  }

  /**
   * Every preview currently holding runtime, with the project it belongs to.
   *
   * Joined against `project_runs` because the instance row is keyed by run and
   * a sweeper needs the project to read the summary back. Live states only: a
   * `stopped` or `failed` row owns nothing to reclaim.
   */
  listLiveInstances(): Array<{
    readonly orgId: string;
    readonly projectId: string;
    readonly projectRunId: string;
    readonly generation: number;
    readonly expiresAt: string | null;
    readonly lastActivityAt: string | null;
  }> {
    return (
      this.db
        .prepare(
          `SELECT i.org_id, i.project_run_id, i.generation, i.expires_at, i.last_activity_at,
                  r.project_id
           FROM project_run_preview_instances i
           JOIN project_runs r
             ON r.project_run_id = i.project_run_id AND r.org_id = i.org_id
           WHERE i.state IN ('starting','ready','stopping')
           ORDER BY i.project_run_id`
        )
        .all() as Array<{
        org_id: string;
        project_id: string;
        project_run_id: string;
        generation: number;
        expires_at: string | null;
        last_activity_at: string | null;
      }>
    ).map((row) => ({
      orgId: row.org_id,
      projectId: row.project_id,
      projectRunId: row.project_run_id,
      generation: row.generation,
      expiresAt: row.expires_at,
      lastActivityAt: row.last_activity_at,
    }));
  }

  /**
   * How many previews are holding runtime, globally and for one organisation.
   *
   * COUNTED FROM THE STORE, never from memory: more than one process writes
   * this file, and an in-memory count would let each of them believe it was
   * the only one — which is how a "maximum of four" becomes eight.
   */
  countLiveInstances(orgIdInput: string): { readonly global: number; readonly org: number } {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN org_id = ? THEN 1 ELSE 0 END) AS mine
         FROM project_run_preview_instances
         WHERE state IN ('starting','ready','stopping')`
      )
      .get(orgId) as { total: number; mine: number | null };
    return { global: row.total, org: row.mine ?? 0 };
  }

  /**
   * Boot-time crash recovery: no preview survives the process that started it.
   *
   * The runtime objects are gone with the launcher's own reconciliation, so a
   * row left in a live state is describing containers that do not exist. It is
   * forced to `stopped` with reason `crash` rather than left for a member to
   * discover as a Preview button that never becomes ready.
   *
   * The mirror of `ProjectStore.reconcileInterrupted`, and deliberately NOT
   * something an observer does: a row that outlived its process is repaired at
   * the next boot by the component that owns it, never by whoever noticed.
   */
  reconcileInterrupted(now?: Date): number {
    const at = (now ?? new Date()).toISOString();
    return this.db
      .prepare(
        `UPDATE project_run_preview_instances
         SET state = 'stopped', last_stop_reason = 'crash', ready_at = NULL,
             expires_at = NULL, image_digest = NULL, runtime = NULL,
             error_code = NULL, updated_at = ?
         WHERE state IN ('starting','ready','stopping')`
      )
      .run(at).changes;
  }

  /* ─────────────────────────── egress approvals ────────────────────────── */

  listApprovedHosts(orgIdInput: string, projectIdInput: string): string[] {
    const orgId = organisationIdSchema.parse(orgIdInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    return (
      this.db
        .prepare(
          `SELECT host FROM project_preview_egress
           WHERE project_id = ? AND org_id = ? ORDER BY host`
        )
        .all(projectId, orgId) as Array<{ host: string }>
    ).map((row) => previewEgressHostSchema.parse(row.host));
  }

  /**
   * Replace a project's approved set in one transaction.
   *
   * REPLACE, not merge: the admin screen shows the whole set and PUTs the
   * whole set, so a merge would make an unchecked box mean nothing. Every host
   * is re-parsed here even though the route parsed it — this store is also
   * reachable from the CLI, and a schema enforced at one of two doors is a
   * schema enforced at neither.
   */
  replaceApprovedHosts(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly hosts: readonly string[];
    readonly approvedByPrincipalId: string;
    readonly now?: Date;
  }): string[] {
    const orgId = organisationIdSchema.parse(input.orgId);
    const projectId = projectIdSchema.parse(input.projectId);
    const principalId = principalIdSchema.parse(input.approvedByPrincipalId);
    const hosts = [...new Set(input.hosts.map((host) => previewEgressHostSchema.parse(host)))].sort();
    const now = (input.now ?? new Date()).toISOString();
    const transact = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM project_preview_egress WHERE project_id = ? AND org_id = ?')
        .run(projectId, orgId);
      const insert = this.db.prepare(
        `INSERT INTO project_preview_egress
           (project_id, org_id, host, approved_by_principal_id, approved_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const host of hosts) insert.run(projectId, orgId, host, principalId, now);
      return hosts;
    });
    return transact.immediate();
  }
}

/**
 * The effective policy for one preview: what the run asked for, intersected
 * with what this project's admins approved.
 *
 * INTERSECTION, in one place, because the two halves are written by different
 * people at different times — a run declares its needs, an admin approves a
 * project's — and computing it twice is how a CSP and a sidecar come to
 * disagree about the same preview.
 */
export function effectiveEgressHosts(
  requested: readonly string[],
  approved: readonly string[]
): { readonly allowed: string[]; readonly blocked: string[] } {
  const approvedSet = new Set(approved);
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const host of requested) {
    if (approvedSet.has(host)) allowed.push(host);
    else blocked.push(host);
  }
  return { allowed, blocked };
}
