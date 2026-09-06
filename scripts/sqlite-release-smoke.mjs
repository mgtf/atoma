// Exercise compiled production SQLite lifetimes outside a test runner's VM.
// GC timing is nondeterministic: this is compatibility coverage, not a claim
// that every affected native binary deterministically reproduces the incident.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--child') {
  const result = spawnSync(process.execPath, ['--expose-gc', script, '--child'], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `SQLite process received ${result.signal}: ${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SQLite compiled lifetime smoke passed/);
  console.log(result.stdout.trim());
} else {
  const { openStoreHandle, closeStoreHandles } = await import('../dist/core/stores.js');
  const { acquireCodexHomeLease, tryAcquireCodexHomeLease } = await import('../dist/core/codexHomeLease.js');
  const { acquireRunLeaseWithoutRecovery, peekRunLease, RunLockBusyError } = await import('../dist/mcp/runLock.js');
  const root = mkdtempSync(join(tmpdir(), 'atoma-sqlite-release-'));
  const profile = join(root, 'codex');
  mkdirSync(profile);
  const store = join(root, 'store.db');
  const lock = join(root, 'run-lease.db');
  const ddl = 'CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)';
  let lease;
  let releaseProfile;
  try {
    for (let batch = 0; batch < 20; batch++) {
      const db = openStoreHandle(store, ddl);
      db.prepare('INSERT INTO evidence VALUES (?, ?)').run(batch, `batch-${batch}`);
      lease = acquireRunLeaseWithoutRecovery(`smoke-${batch}`, lock);
      releaseProfile = await acquireCodexHomeLease(profile);
      assert.equal(tryAcquireCodexHomeLease(profile), null);
      assert.throws(() => acquireRunLeaseWithoutRecovery('contender', lock), RunLockBusyError);
      for (let i = 0; i < 50; i++) {
        assert.equal(db.prepare('SELECT value FROM evidence WHERE id = ?').get(batch).value, `batch-${batch}`);
        assert.equal(peekRunLease(lock)?.runId, `smoke-${batch}`);
      }
      await global.gc({ type: 'major', execution: 'async' });
      releaseProfile();
      releaseProfile = undefined;
      lease.release();
      lease = undefined;
      assert.equal(peekRunLease(lock), null);
      closeStoreHandles();
      await global.gc({ type: 'major', execution: 'async' });
    }
    const db = openStoreHandle(store, ddl);
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence').get().n, 20);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    console.log(`SQLite compiled lifetime smoke passed (${process.version})`);
  } finally {
    releaseProfile?.();
    lease?.release();
    closeStoreHandles();
    rmSync(root, { recursive: true, force: true });
  }
}
