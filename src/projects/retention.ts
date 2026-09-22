import { previousSeedRun } from './coordinator.js';
import { ProjectStore } from './store.js';
import { organisationIdSchema, projectIdSchema, projectRunIdSchema } from '../contracts/projects.js';
import type Database from 'better-sqlite3';
import { lstatSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectWorkspaceRelative } from '../contracts/launcherVolumes.js';
import type { PlatformEventInput, PlatformEvent } from '../contracts/platformEvents.js';

export const RUN_RETENTION_DAYS = 90;
export interface RetentionCandidate {
  runId: string;
  orgId: string;
  projectId: string;
  paths: string[];
  held: string | null;
}

/** Refuse redirected ancestors, including junctions, before recursive removal. */
export function assertRetentionPath(rootInput: string, targetInput: string): void {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('retention path escapes root');
  let current = target;
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('retention refuses symlinks and junctions');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function retentionPlan(db: Database.Database, projectsRoot: string, workspaceRoot?: string, now = new Date()): RetentionCandidate[] {
  const cutoff = new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString();
  const columns = db.prepare('PRAGMA table_info(project_runs)').all() as { name: string }[];
  const deletedFilter = columns.some(column => column.name === 'bytes_deleted_at') ? 'AND r.bytes_deleted_at IS NULL' : '';
  const rows = db.prepare(`SELECT r.*, p.status AS project_status FROM project_runs r
    JOIN projects p ON p.project_id = r.project_id AND p.org_id = r.org_id
    WHERE r.status IN ('delivered','partial','failed','cancelled') AND r.ended_at <= ?
    ${deletedFilter} ORDER BY r.ended_at, r.project_run_id`).all(cutoff) as Array<{
      project_run_id: string; org_id: string; project_id: string; workspace_path: string;
      runs_path: string; log_path: string; status: string; project_status: string;
    }>;
  return rows.map(row => {
    organisationIdSchema.parse(row.org_id); projectIdSchema.parse(row.project_id); projectRunIdSchema.parse(row.project_run_id);
    const runRoot = join(resolve(projectsRoot), 'orgs', row.org_id, 'projects', row.project_id, 'runs', row.project_run_id);
    assertRetentionPath(projectsRoot, runRoot);
    const legacyWorkspace = join(runRoot, 'workspace');
    const projected = workspaceRoot ? join(resolve(workspaceRoot), projectWorkspaceRelative({
      orgId: row.org_id, projectId: row.project_id, runId: row.project_run_id,
    })) : null;
    if (resolve(row.runs_path) !== join(runRoot, 'traces') || resolve(row.log_path) !== join(runRoot, 'run.log') ||
        (resolve(row.workspace_path) !== legacyWorkspace && resolve(row.workspace_path) !== projected)) {
      throw new Error('retention refuses an unrecognised run layout: ' + row.project_run_id);
    }
    const paths = [runRoot];
    if (projected && resolve(row.workspace_path) === projected) {
      // The run-owned parent also holds retrieval-source and disposable indexes.
      assertRetentionPath(workspaceRoot!, dirname(projected));
      paths.push(dirname(projected));
    }
    let held: string | null = null;
    if (row.project_status === 'active') {
      const seed = previousSeedRun(new ProjectStore(db, { initialize: false }), row.org_id, row.project_id);
      if (seed?.projectRunId === row.project_run_id) held = 'current project seed';
    }
    const publication = db.prepare("SELECT 1 FROM project_publications WHERE project_run_id = ? AND status <> 'published'").get(row.project_run_id);
    if (publication) held = 'unfinished publication';
    return { runId: row.project_run_id, orgId: row.org_id, projectId: row.project_id, paths, held };
  });
}

/** Offline maintenance only. The CLI additionally owns the machine run lease. */
export function applyRetention(db: Database.Database, projectsRoot: string, workspaceRoot: string | undefined, audit: (input: PlatformEventInput) => PlatformEvent | null, now = new Date()): number {
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const blockers = [
    ["project_runs", "status IN ('queued','running')"],
    ["project_publications", "status = 'publishing'"],
    ["project_run_preview_instances", "state IN ('starting','ready','stopping')"],
  ];
  for (const [table, predicate] of blockers) {
    if (hasTable(table!) && db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get()) throw new Error('retention requires idle services: ' + table);
  }
  const emit = (candidate: RetentionCandidate, phase: string) => {
    const event: PlatformEventInput = { kind: 'run.retention', actorType: 'cli', actorId: null,
      orgId: candidate.orgId, projectId: candidate.projectId, runId: candidate.runId,
      summary: 'Run byte retention: ' + phase, detail: { phase, retentionDays: RUN_RETENTION_DAYS } };
    // A failed audit must stop destructive work, even though ordinary telemetry is fail-open.
    if (!audit(event)) throw new Error('retention audit unavailable');
  };
  const candidates = retentionPlan(db, projectsRoot, workspaceRoot, now);
  let deleted = 0;
  for (const candidate of candidates) {
    if (candidate.held) continue;
    emit(candidate, 'started');
    db.prepare('UPDATE project_runs SET bytes_expired_at = COALESCE(bytes_expired_at, ?) WHERE project_run_id = ?')
      .run(now.toISOString(), candidate.runId);
    try {
      for (const target of candidate.paths) {
        assertRetentionPath(dirname(target), target);
        rmSync(target, { recursive: true, force: true });
      }
      emit(candidate, 'deleted');
      db.prepare('UPDATE project_runs SET bytes_deleted_at = ? WHERE project_run_id = ?').run(now.toISOString(), candidate.runId);
      deleted += 1;
    } catch (error) {
      emit(candidate, 'failed');
      throw error;
    }
  }
  return deleted;
}
