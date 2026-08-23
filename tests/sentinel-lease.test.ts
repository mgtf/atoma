import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  claimSentinelWatch,
  peekSentinelWatch,
  SENTINEL_WATCH_TABLE_DDL,
} from '../src/sentinel/lease.js';

/**
 * THE WATCH LEASE. What these hold:
 *   - at most one appending resident watch per product store;
 *   - the one asymmetry runs toward the deliberate act: a CLI displaces a viz
 *     server, and yields to another live CLI;
 *   - staleness is measured against the OWNER'S cadence, never the claimant's,
 *     or a fast poller would evict a healthy slow one;
 *   - the heartbeat IS the ownership check: it fails once the row is not ours,
 *     which is how a displaced watch learns to stop appending.
 */

const roots: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-sentinel-lease-'));
  roots.push(root);
  return join(root, 'atoma.db');
}

/** A row owned by a pid that is certainly not alive, written by hand. */
function writeRow(
  dbPath: string,
  row: {
    source: string;
    ownerPid: number;
    intervalMs: number;
    startedAt: string;
    heartbeatAt: string;
    fingerprint?: string | null;
  }
): void {
  const db = new Database(dbPath);
  db.exec(SENTINEL_WATCH_TABLE_DDL);
  db.prepare(
    `INSERT INTO sentinel_watch
       (singleton, token, source, owner_pid, owner_fingerprint, label, interval_ms, started_at, heartbeat_at)
     VALUES (1, 'foreign-token', ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       source = excluded.source, owner_pid = excluded.owner_pid,
       owner_fingerprint = excluded.owner_fingerprint,
       interval_ms = excluded.interval_ms, started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at`
  ).run(
    row.source,
    row.ownerPid,
    row.fingerprint ?? null,
    row.intervalMs,
    row.startedAt,
    row.heartbeatAt
  );
  db.close();
}

describe('one appending watch per store', () => {
  it('gives the watch to the first claimant and refuses the second', () => {
    const dbPath = storePath();
    const first = claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 20_000 });
    expect(first.held).toBe(true);

    const second = claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 20_000 });
    expect(second.held).toBe(false);
    if (second.held) throw new Error('unreachable');
    expect(second.incumbent.source).toBe('viz-server');
    expect(second.incumbent.ownerPid).toBe(process.pid);
  });

  it('lets an explicitly started CLI take the watch from a viz server', () => {
    // Typing `npm run sentinel` is the deliberate act; a browser tab somebody
    // left open must not refuse it.
    const dbPath = storePath();
    const server = claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 20_000 });
    expect(server.held).toBe(true);
    if (!server.held) throw new Error('unreachable');

    const cli = claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 });
    expect(cli.held).toBe(true);
    if (!cli.held) throw new Error('unreachable');
    expect(cli.displaced?.source).toBe('viz-server');

    // And the displaced server learns it: the heartbeat IS the ownership check.
    expect(server.lease.heartbeat()).toBe(false);
    expect(cli.lease.heartbeat()).toBe(true);
  });

  it('refuses a second CLI, where the tie is genuinely ambiguous', () => {
    const dbPath = storePath();
    expect(claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 }).held).toBe(true);
    const second = claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 });
    expect(second.held).toBe(false);
  });

  it('reclaims a row whose owner is gone', () => {
    const dbPath = storePath();
    // pid 2^22 is above every default pid_max: nothing to signal.
    writeRow(dbPath, {
      source: 'cli',
      ownerPid: 4_194_303,
      intervalMs: 20_000,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    const claim = claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 20_000 });
    expect(claim.held).toBe(true);
    // A reclaim is not a takeover: nothing live was displaced.
    if (!claim.held) throw new Error('unreachable');
    expect(claim.displaced).toBeUndefined();
  });

  it('measures staleness against the OWNER cadence, not the claimant', () => {
    // A `--interval 2000` CLI must not evict a healthy 20-second server six
    // seconds after its last beat. The floor is a minute either way.
    const dbPath = storePath();
    const beat = new Date(Date.now() - 25_000).toISOString();
    writeRow(dbPath, {
      source: 'viz-server',
      ownerPid: process.pid,
      intervalMs: 20_000,
      startedAt: beat,
      heartbeatAt: beat,
    });
    // Same-process pid is alive, beat is 25s old, floor is 60s: not stale, and
    // a server claimant has no takeover right either.
    expect(claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 2_000 }).held).toBe(
      false
    );

    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    writeRow(dbPath, {
      source: 'viz-server',
      ownerPid: process.pid,
      intervalMs: 20_000,
      startedAt: old,
      heartbeatAt: old,
    });
    expect(claimSentinelWatch(dbPath, { source: 'viz-server', intervalMs: 2_000 }).held).toBe(
      true
    );
  });

  it('frees the watch on release, and reading it is never a reason to fail', () => {
    const dbPath = storePath();
    const claim = claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 });
    if (!claim.held) throw new Error('unreachable');
    expect(peekSentinelWatch(dbPath)?.source).toBe('cli');
    claim.lease.release();
    expect(peekSentinelWatch(dbPath)).toBeNull();
    // Releasing twice is harmless, and a store that does not exist reads null
    // rather than throwing into a boot path.
    claim.lease.release();
    expect(peekSentinelWatch(join(tmpdir(), 'atoma-no-such-store.db'))).toBeNull();
  });
});
