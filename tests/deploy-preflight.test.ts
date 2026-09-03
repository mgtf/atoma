import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploymentBlockers } from '../src/cli/deploy-preflight.js';
import { requestWaitsForDeployment } from '../src/viz/deployment.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-deploy-preflight-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deployment preflight', () => {
  it('is clear without a store or run lease', () => {
    const root = temporaryRoot();
    expect(
      deploymentBlockers({
        dbPath: join(root, 'absent.db'),
        runLockPath: join(root, 'absent-lock.db'),
      })
    ).toEqual([]);
  });

  it('reads runtime state without repairing or rewriting it', () => {
    const root = temporaryRoot();
    const dbPath = join(root, 'atoma.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE project_runs (status TEXT NOT NULL);
      CREATE TABLE project_run_preview_instances (state TEXT NOT NULL);
      INSERT INTO project_runs VALUES ('running'), ('delivered');
      INSERT INTO project_run_preview_instances VALUES ('ready'), ('stopped');
    `);
    db.close();

    expect(
      deploymentBlockers({ dbPath, runLockPath: join(root, 'absent-lock.db') })
    ).toEqual(['1 project run(s) are queued or running', '1 result preview(s) still own runtime']);

    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) AS n FROM project_runs').get() as { n: number }).n).toBe(2);
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM project_run_preview_instances').get() as { n: number }).n
    ).toBe(2);
    after.close();
  });
});

describe('deployment admission marker', () => {
  it('keeps reads up and pauses every mutating request plus stateful OAuth callbacks', () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'deploy.lock');
    writeFileSync(lockPath, 'deploying\n');
    const env = { ATOMA_DEPLOY_LOCK_PATH: lockPath };

    expect(requestWaitsForDeployment('GET', '/', env)).toBe(false);
    expect(requestWaitsForDeployment('GET', '/api/projects', env)).toBe(false);
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(true);
    expect(requestWaitsForDeployment('POST', '/webhooks/github', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/login', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/callback', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/github/connect', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/github/authorize', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/github/setup', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/whoami', env)).toBe(false);
  });

  it('changes nothing when the deployment marker is absent', () => {
    const root = temporaryRoot();
    const env = { ATOMA_DEPLOY_LOCK_PATH: join(root, 'absent.lock') };
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(false);
  });
});
