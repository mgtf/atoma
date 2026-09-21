import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { applyRetention, assertRetentionPath, retentionPlan } from '../src/projects/retention.js';
import { ProjectRunCoordinator, projectRunHostLayout } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { rmSync } from 'node:fs';

const roots: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  // realpath: retention refuses a symlinked ancestor, and macOS resolves
  // tmpdir() through /var -> private/var. A deployment root is a real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-maintenance-')));
  roots.push(root);
  return projectRetrievalFixture(root);
}

describe('organisation run admission', () => {
  it('defaults to one, persists suspension, and refuses before acquiring a lease', async () => {
    const f = fixture();
    expect(f.projects.runCapacity(f.viewer.orgId)).toEqual({ active: 0, maxConcurrent: 1, globalMaxConcurrent: 1 });
    f.projects.setRunLimit(f.viewer.orgId, 0);
    expect(ProjectStore.open(f.dbPath).runCapacity(f.viewer.orgId).maxConcurrent).toBe(0);
    expect(() => f.projects.setRunLimit(f.viewer.orgId, 2)).toThrow();
    const acquireLease = vi.fn(() => { throw new Error('must not acquire'); });
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath,
      projectsRoot: f.root, skillsDir: join(f.root, 'skills'), hostEnv: {}, acquireLease });
    await expect(coordinator.start({ orgId: f.viewer.orgId, projectId: f.project.projectId,
      principalId: f.viewer.principalId, request: { idempotencyKey: randomUUID(), goal: 'Build' } })).rejects.toThrow('suspended');
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it('reserves under the store transaction, preserving retries and other organisations', () => {
    const f = fixture();
    const first = f.makeRun();
    const g = projectRetrievalFixture(f.root, { subject: 'other', slug: 'other' });
    expect(g.projects.runCapacity(g.viewer.orgId).active).toBe(0);
    const request = { idempotencyKey: first.run.requestKey, goal: first.run.goal };
    f.projects.setRunLimit(f.viewer.orgId, 0);
    const input = { orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
      request, hostPaths: first.run.hostPaths, enforceCapacity: true };
    expect(f.projects.createProjectRun(input)?.created).toBe(false);
    expect(() => f.projects.createProjectRun({ ...input, request: { ...request, idempotencyKey: randomUUID() } })).toThrow('suspended');
    f.projects.setRunLimit(f.viewer.orgId, 1);
    expect(() => f.projects.createProjectRun({ ...input, request: { ...request, idempotencyKey: randomUUID() } })).toThrow('limit reached');
  });
});

describe('offline run retention', () => {
  it('plans without deleting, protects the seed, deletes bytes with receipts and preserves run metadata', () => {
    const f = fixture();
    const old = f.makeRun({ 'old.txt': 'old' });
    const head = f.makeRun({ 'head.txt': 'head' });
    const db = new Database(f.dbPath);
    try {
      db.prepare('UPDATE project_runs SET created_at = ?, ended_at = ? WHERE project_run_id = ?')
        .run('2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', old.run.projectRunId);
      db.prepare('UPDATE project_runs SET created_at = ?, ended_at = ? WHERE project_run_id = ?')
        .run('2025-02-01T00:00:00.000Z', '2025-02-02T00:00:00.000Z', head.run.projectRunId);
      const now = new Date('2026-09-20T00:00:00Z');
      const plan = retentionPlan(db, f.root, undefined, now);
      expect(plan.find(row => row.runId === head.run.projectRunId)?.held).toBe('current project seed');
      expect(existsSync(old.layout.workspacePath)).toBe(true);
      expect(() => applyRetention(db, f.root, undefined, () => null, now)).toThrow('audit unavailable');
      expect(existsSync(old.layout.workspacePath)).toBe(true);
      const log = PlatformEventLog.open(f.dbPath);
      expect(applyRetention(db, f.root, undefined, event => log.append(event), now)).toBe(1);
      expect(existsSync(old.layout.runRoot)).toBe(false);
      expect(existsSync(head.layout.workspacePath)).toBe(true);
      const receipt = f.projects.getProjectRun(f.viewer.orgId, old.run.projectRunId)!;
      expect(receipt.status).toBe('delivered');
      expect(receipt.artifactManifestHash).toBe(old.run.artifactManifestHash);
      expect(receipt.bytesExpiredAt).toBe(now.toISOString());
      expect(log.list().events.filter(event => event.kind === 'run.retention')).toHaveLength(2);
      expect(applyRetention(db, f.root, undefined, event => log.append(event), now)).toBe(0);
    } finally { db.close(); }
  });

  it('expires the separate launcher projection at the cutoff and keeps the shared catalogue', () => {
    const f = fixture();
    const runId = randomUUID();
    const workspaceRoot = join(f.root, 'launcher-workspaces');
    const layout = projectRunHostLayout(f.root, f.viewer.orgId, f.project.projectId, runId, workspaceRoot);
    f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId,
      principalId: f.viewer.principalId, projectRunId: runId,
      request: { idempotencyKey: runId, goal: 'Retention fixture' },
      hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath,
        logPath: layout.logPath, skillsPath: join(f.root, 'shared-skills') } });
    mkdirSync(layout.workspacePath, { recursive: true });
    writeFileSync(join(layout.workspacePath, 'result.txt'), 'result');
    mkdirSync(join(f.root, 'shared-skills'), { recursive: true });
    writeFileSync(join(f.root, 'shared-skills', 'keep.txt'), 'knowledge');
    const now = new Date('2026-09-20T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const db = new Database(f.dbPath);
    try {
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = ? WHERE project_run_id = ?")
        .run(cutoff, runId);
      expect(retentionPlan(db, f.root, workspaceRoot, new Date(now.getTime() - 1))).toHaveLength(0);
      expect(retentionPlan(db, f.root, workspaceRoot, now)).toHaveLength(1);
      const log = PlatformEventLog.open(f.dbPath);
      expect(applyRetention(db, f.root, workspaceRoot, event => log.append(event), now)).toBe(1);
      expect(existsSync(layout.workspacePath)).toBe(false);
      expect(existsSync(join(f.root, 'shared-skills', 'keep.txt'))).toBe(true);
    } finally { db.close(); }
  });

  it('refuses live work and forged paths before deleting anything', () => {
    const f = fixture();
    const run = f.makeRun();
    const db = new Database(f.dbPath);
    try {
      expect(() => applyRetention(db, f.root, undefined, () => null)).toThrow('idle services');
      expect(() => assertRetentionPath(f.root, join(f.root, '..', 'outside'))).toThrow('escapes root');
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = '2025-01-01T00:00:00.000Z' WHERE project_run_id = ?")
        .run(run.run.projectRunId);
      const forgedId = randomUUID();
      f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId,
        principalId: f.viewer.principalId, projectRunId: forgedId,
        request: { idempotencyKey: forgedId, goal: 'Unrecognised legacy layout' },
        hostPaths: { ...run.run.hostPaths, workspacePath: join(f.root, 'other') } });
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = '2025-01-01T00:00:00.000Z' WHERE project_run_id = ?")
        .run(forgedId);
      expect(() => retentionPlan(db, f.root)).toThrow('unrecognised run layout');
    } finally { db.close(); }
  });

  it.skipIf(process.platform === 'win32')('refuses symlink ancestors', () => {
    const f = fixture();
    symlinkSync(tmpdir(), join(f.root, 'redirect'));
    expect(() => assertRetentionPath(f.root, join(f.root, 'redirect', 'child'))).toThrow('symlinks');
  });
});
