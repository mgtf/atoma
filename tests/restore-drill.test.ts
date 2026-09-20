import { applyRetention } from '../src/projects/retention.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { runBackup } from '../src/cli/backup.js';
import { parseRunLog } from '../src/cli/burnin.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
const script = resolve('scripts/restore-drill.py');

describe.skipIf(!hasPython)('offline recovery through real backup archives and a separate process', () => {
  let root: string;
  let db: Database.Database;
  let store: ProjectStore;
  let projectId: string;
  const runId = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-restore-test-'));
    db = new Database(join(root, 'source.db'));
    db.pragma('foreign_keys = ON');
    db.exec(AUTH_TABLES_DDL);
    db.exec("INSERT INTO auth_organisations (org_id,name,created_at) VALUES ('11111111-1111-4111-8111-111111111111','Recovery','2026-09-14');" +
      "INSERT INTO auth_principals (principal_id,kind,display_name,created_at) VALUES ('22222222-2222-4222-8222-222222222222','human','Recovery','2026-09-14');" +
      "INSERT INTO auth_memberships (org_id,principal_id,role,created_at) VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','org:owner','2026-09-14');");
    store = new ProjectStore(db);
    projectId = store.createProject({ orgId: '11111111-1111-4111-8111-111111111111', principalId: '22222222-2222-4222-8222-222222222222', project: {
      name: 'Recovery', slug: 'recovery', repositoryTarget: { installationId: '123', owner: 'test', name: 'recovery', visibility: 'private' },
    } }).projectId;
    const layout = projectRunHostLayout(join(root, 'projects'), '11111111-1111-4111-8111-111111111111', projectId, runId);
    mkdirSync(layout.workspacePath, { recursive: true });
    mkdirSync(layout.runsPath, { recursive: true });
    writeFileSync(join(layout.workspacePath, 'index.html'), '<p>restored</p>');
    writeFileSync(join(layout.runsPath, '44444444-4444-4444-8444-444444444444.json'), '{"id":"44444444-4444-4444-8444-444444444444"}');
    writeFileSync(layout.logPath, 'fixture log');
    store.createProjectRun({ orgId: '11111111-1111-4111-8111-111111111111', projectId, principalId: '22222222-2222-4222-8222-222222222222', projectRunId: runId,
      request: { idempotencyKey: 'recovery', goal: 'Recovery fixture' }, hostPaths: {
        workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath,
      } });
    store.transitionProjectRun({ orgId: '11111111-1111-4111-8111-111111111111', projectRunId: runId, from: 'queued', to: 'running' });
    store.transitionProjectRun({ orgId: '11111111-1111-4111-8111-111111111111', projectRunId: runId, from: 'running', to: 'delivered', traceId: '44444444-4444-4444-8444-444444444444', stats: parseRunLog('✓ build finished') });
    for (const tier of ['skills', 'runs', 'archive', 'supervisor']) mkdirSync(join(root, tier));
  });
  afterEach(() => { closeStoreHandles(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const backupOpts = () => ({ dest: join(root, 'snapshots'), keep: 2, storeDb: join(root, 'source.db'),
    skillsDir: join(root, 'skills'), runsDir: join(root, 'runs'), archiveDir: join(root, 'archive'),
    projectsRoot: join(root, 'projects'), supervisorDir: join(root, 'supervisor'), repoRoot: join(root, 'checkout'), log: () => {} });
  const backup = () => runBackup(backupOpts());
  const restore = (snapshot: string, dest = join(root, 'recovered')) => spawnSync(python, [script, snapshot, '--dest', dest], { encoding: 'utf8', timeout: 30000 });

  it('restores six tiers and reconciles real ProjectStore rows without rewriting source paths or starting a service', async () => {
    const snapshot = await backup();
    // The original absolute host paths must no longer work: recovery must
    // answer from the extracted corpus, not accidentally read the live one.
    renameSync(join(root, 'projects'), join(root, 'original-projects-offline'));
    const result = restore(snapshot.snapshotDir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'verified', servicesStarted: false,
      store: { integrity: 'ok', issues: [], projectRuns: [{ runId, status: 'delivered', workspace: true, log: true, trace: true }] } });
    expect(readFileSync(join(root, 'recovered', 'projects', 'orgs', '11111111-1111-4111-8111-111111111111', 'projects', projectId, 'runs', runId, 'workspace', 'index.html'), 'utf8')).toBe('<p>restored</p>');
    expect(store.getProjectRun('11111111-1111-4111-8111-111111111111', runId)?.status).toBe('delivered');
  });

  it('restores intentionally expired bytes as metadata, and flags interrupted retention', async () => {
    db.prepare("UPDATE projects SET status = 'archived' WHERE project_id = ?").run(projectId);
    db.prepare("UPDATE project_runs SET ended_at = '2025-01-01T00:00:00.000Z' WHERE project_run_id = ?").run(runId);
    const events = PlatformEventLog.open(join(root, 'source.db'));
    expect(applyRetention(db, join(root, 'projects'), undefined, event => events.append(event))).toBe(1);
    const snapshot = await backup();
    const result = restore(snapshot.snapshotDir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).store).toMatchObject({
      issues: [], projectRuns: [{ runId, status: 'delivered', retention: 'expired', workspace: false }],
    });
    db.prepare('UPDATE project_runs SET bytes_deleted_at = NULL WHERE project_run_id = ?').run(runId);
    const interrupted = await backup();
    const retry = restore(interrupted.snapshotDir, join(root, 'interrupted'));
    expect(retry.status).toBe(2);
    expect(JSON.parse(retry.stdout).store.issues).toContainEqual({ runId, reason: 'interrupted-retention' });
    closeStoreHandles();
  });

  it('verifies a deployment that declares the tier it does not have', async () => {
    // THE DEPLOYED SHAPE. A server keeps no ~/.atoma/archive: that tier holds
    // pre/post-benchmark store archives and it runs no benchmarks. The drill
    // required all six tiers, so every snapshot of this shape reported
    // incomplete and exited 2 — the only disaster-recovery check the product
    // owns, calibrated to a developer machine.
    //
    // This fixture proves the FIX. A snapshot taken from the real host would
    // prove the host, and the two are not the same claim.
    rmSync(join(root, 'archive'), { recursive: true, force: true });
    const snapshot = await runBackup({ ...backupOpts(), optionalTiers: ['archive'] });
    const result = restore(snapshot.snapshotDir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'verified',
      expectedTiers: ['projects', 'runs', 'skills', 'store', 'supervisor'],
      notApplicableTiers: ['archive'], missingExpectedTiers: [] });
  });

  it('still fails when the same tier vanishes undeclared', async () => {
    // The other half of the fix: forgiving every skip would have made the
    // drill reassuring about exactly the case it exists to catch.
    rmSync(join(root, 'archive'), { recursive: true, force: true });
    const snapshot = await backup();
    const result = restore(snapshot.snapshotDir);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'incomplete',
      missingExpectedTiers: ['archive'] });
  });

  it('refuses a manifest that declares the store optional', async () => {
    const snapshot = await backup();
    const manifestPath = join(snapshot.snapshotDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['optionalTiers'] = ['store'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = restore(snapshot.snapshotDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('store tier cannot be declared optional');
  });

  it('refuses corruption before allocating the recovery destination', async () => {
    const snapshot = await backup();
    writeFileSync(join(snapshot.snapshotDir, 'projects.tar.gz'), 'corrupt');
    const result = restore(snapshot.snapshotDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(existsSync(join(root, 'recovered'))).toBe(false);
  });

  it('refuses an existing destination without changing its contents', async () => {
    const snapshot = await backup();
    mkdirSync(join(root, 'recovered'));
    writeFileSync(join(root, 'recovered', 'keep'), 'original');
    expect(restore(snapshot.snapshotDir).status).toBe(1);
    expect(readFileSync(join(root, 'recovered', 'keep'), 'utf8')).toBe('original');
  });

  it('reports a missing delivered trace instead of claiming recovery completeness', async () => {
    const layout = projectRunHostLayout(join(root, 'projects'), '11111111-1111-4111-8111-111111111111', projectId, runId);
    rmSync(join(layout.runsPath, '44444444-4444-4444-8444-444444444444.json'));
    const snapshot = await backup();
    const result = restore(snapshot.snapshotDir);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'incomplete', store: { issues: [{ runId, reason: 'missing-trace' }] } });
  });

  it('refuses an archive symlink even when the snapshot checksum matches', async () => {
    const snapshot = await backup();
    const patch = spawnSync(python, ['-c',
      "import tarfile,json,hashlib,pathlib,sys;p=pathlib.Path(sys.argv[1]);a=p/'projects.tar.gz';t=tarfile.open(a,'w:gz');i=tarfile.TarInfo('orgs/escape');i.type=tarfile.SYMTYPE;i.linkname='/tmp';t.addfile(i);t.close();m=json.loads((p/'manifest.json').read_text());m['projects']['bytes']=a.stat().st_size;m['projects']['sha256']=hashlib.sha256(a.read_bytes()).hexdigest();(p/'manifest.json').write_text(json.dumps(m))", snapshot.snapshotDir], { encoding: 'utf8' });
    expect(patch.status, patch.stderr).toBe(0);
    expect(restore(snapshot.snapshotDir).status).toBe(1);
    expect(existsSync(join(root, 'recovered'))).toBe(false);
  });

  it.each(['orgs/D:escape', 'orgs/file:stream', 'orgs/.. /escape'])('refuses Windows path aliases before extraction: %s', async (member) => {
    const snapshot = await backup();
    const patch = spawnSync(python, ['-c',
      "import tarfile,json,hashlib,pathlib,sys,io;p=pathlib.Path(sys.argv[1]);a=p/'projects.tar.gz';t=tarfile.open(a,'w:gz');i=tarfile.TarInfo(sys.argv[2]);i.size=1;t.addfile(i,io.BytesIO(b'x'));t.close();m=json.loads((p/'manifest.json').read_text());m['projects']['bytes']=a.stat().st_size;m['projects']['sha256']=hashlib.sha256(a.read_bytes()).hexdigest();(p/'manifest.json').write_text(json.dumps(m))", snapshot.snapshotDir, member], { encoding: 'utf8' });
    expect(patch.status, patch.stderr).toBe(0);
    expect(restore(snapshot.snapshotDir).status).toBe(1);
    expect(existsSync(join(root, 'recovered'))).toBe(false);
  });

  it('keeps a missing supervisor tier visible as incomplete recovery', async () => {
    rmSync(join(root, 'supervisor'), { recursive: true });
    const snapshot = await backup();
    const result = restore(snapshot.snapshotDir);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'incomplete', completeInventory: false,
      skipped: [expect.stringMatching(/^supervisor /)], store: { integrity: 'ok', issues: [] } });
  });
});
