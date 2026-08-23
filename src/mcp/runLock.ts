/**
 * Cross-process lease for the MCP run slot.
 *
 * SQLite supplies the compare-and-delete primitive a lockfile cannot: stale
 * recovery and successor acquisition happen under BEGIN IMMEDIATE, and every
 * update/delete is conditioned on a random token. Two recoverers can never
 * delete each other's freshly-acquired lease (the lockfile ABA race).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  RUN_KILL_CONFIRM_MS,
  RUN_KILL_GRACE_MS,
  runProcessGroupExists,
  terminateRunProcessGroup,
} from '../cli/burnin.js';

export interface RunLockOwner {
  readonly token: string;
  readonly runId: string;
  readonly ownerPid: number;
  readonly acquiredAt: string;
  readonly childPgid?: number;
}

/** A run the recovery path destroyed to free the slot — see `acquireRunLease`. */
export interface ReapedRun {
  readonly runId: string;
  readonly childPgid: number;
}

export interface RunLease {
  readonly path: string;
  /**
   * Present when acquiring meant REAPING a previous server's surviving run:
   * the dead owner's live process group was terminated as a side effect of
   * this acquisition. The 2026-08-14 review flagged that the reap was SILENT —
   * the caller got a lease as if nothing had happened, so a host that had just
   * destroyed a run could not explain the missing deliverable. startRun
   * publishes this on its payload.
   */
  readonly recovered?: ReapedRun;
  /** Persist the detached process-group id. Throws if ownership was lost. */
  attachChild(pgid: number): void;
  /** Conditional by token and safe to call twice. */
  release(): void;
}

export type RunLeaseAcquirer = (runId: string) => Promise<RunLease>;

export class RunLockBusyError extends Error {
  constructor(
    message: string,
    readonly owner?: RunLockOwner
  ) {
    super(message);
    this.name = 'RunLockBusyError';
  }
}

export function mcpRunLockPath(): string {
  return resolve(
    process.env['ATOMA_MCP_RUN_LOCK'] ?? join(homedir(), '.atoma', 'mcp-run-lock.db')
  );
}

interface LeaseRow {
  token: string;
  run_id: string;
  owner_pid: number;
  child_pgid: number | null;
  acquired_at: string;
  owner_fingerprint: string | null;
  child_fingerprint: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL,
    owner_fingerprint TEXT,
    child_fingerprint TEXT
  )
`;

const FINGERPRINT_COLUMNS = [
  ['owner_fingerprint', 'TEXT'],
  ['child_fingerprint', 'TEXT'],
] as const;

function openLockDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const columns = new Set(
    (db.pragma('table_info(mcp_run_lease)') as Array<{ name: string }>).map((column) =>
      column.name
    )
  );
  for (const [name, type] of FINGERPRINT_COLUMNS) {
    if (columns.has(name)) continue;
    try {
      db.exec(`ALTER TABLE mcp_run_lease ADD COLUMN ${name} ${type}`);
    } catch (err) {
      // Two MCP processes can open an old store together. One may complete
      // the additive migration after the other's PRAGMA snapshot.
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }
  return db;
}

/**
 * Is this pid a live process? Exported because the sentinel's watch lease asks
 * the same question of the same kind of row, and two definitions of "is the
 * owner still there" is how one of them ends up trusting a recycled pid.
 */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'EPERM'
    );
  }
}

/**
 * Stable process birth identity, not merely a recyclable PID.
 *
 * Linux exposes boot id + start ticks directly. BSD/macOS `ps lstart` is the
 * portable fallback. A missing fingerprint is treated as unverifiable, never
 * as permission to signal a process group.
 */
export function processFingerprint(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = afterName[19]; // field 22; array starts at field 3
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (startTicks && bootId) return `linux:${bootId}:${startTicks}`;
  } catch {
    // Non-Linux platform or the process disappeared between probes.
  }
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

function leasePredatesCurrentBoot(acquiredAt: string): boolean {
  const acquiredMs = Date.parse(acquiredAt);
  if (!Number.isFinite(acquiredMs)) return false;
  // Leave two seconds for wall-clock/uptime sampling skew at boot.
  return acquiredMs < Date.now() - uptime() * 1000 - 2000;
}

type RecordedIdentity = 'match' | 'mismatch' | 'unverifiable' | 'gone';

function recordedIdentity(
  pid: number,
  expectedFingerprint: string | null,
  acquiredAt: string
): RecordedIdentity {
  if (!processExists(pid)) return 'gone';
  if (!expectedFingerprint) {
    return leasePredatesCurrentBoot(acquiredAt) ? 'mismatch' : 'unverifiable';
  }
  const actual = processFingerprint(pid);
  if (!actual) return 'unverifiable';
  return actual === expectedFingerprint ? 'match' : 'mismatch';
}

function toOwner(row: LeaseRow): RunLockOwner {
  return {
    token: row.token,
    runId: row.run_id,
    ownerPid: row.owner_pid,
    acquiredAt: row.acquired_at,
    ...(row.child_pgid !== null ? { childPgid: row.child_pgid } : {}),
  };
}

function makeLease(
  db: Database.Database,
  path: string,
  owner: RunLockOwner,
  recovered?: ReapedRun
): RunLease {
  let released = false;
  return {
    path,
    ...(recovered ? { recovered } : {}),
    attachChild(pgid) {
      if (released) throw new Error(`cannot attach child ${pgid}: run lease is already released`);
      const childFingerprint = processFingerprint(pgid);
      const changed = db
        .prepare(
          `UPDATE mcp_run_lease
           SET child_pgid = ?, child_fingerprint = ?
           WHERE singleton = 1 AND token = ?`
        )
        .run(pgid, childFingerprint, owner.token).changes;
      if (changed !== 1) {
        throw new Error(`lost MCP run lease before child ${pgid} could be attached`);
      }
    },
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare('DELETE FROM mcp_run_lease WHERE singleton = 1 AND token = ?').run(
          owner.token
        );
      } finally {
        db.close();
      }
    },
  };
}

export async function acquireRunLease(
  runId: string,
  path = mcpRunLockPath()
): Promise<RunLease> {
  const db = openLockDb(path);
  const owner: RunLockOwner = {
    token: randomUUID(),
    runId,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const ownerFingerprint = processFingerprint(owner.ownerPid);
  const read = db.prepare('SELECT * FROM mcp_run_lease WHERE singleton = 1');
  const insert = db.prepare(
    `INSERT INTO mcp_run_lease
      (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
       owner_fingerprint, child_fingerprint)
     VALUES (1, ?, ?, ?, NULL, ?, ?, NULL)`
  );
  const deleteByToken = db.prepare(
    'DELETE FROM mcp_run_lease WHERE singleton = 1 AND token = ?'
  );

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = read.get() as LeaseRow | undefined;
      if (!existing) {
        const claimed = db.transaction(() => {
          if (read.get() !== undefined) return false;
          insert.run(
            owner.token,
            owner.runId,
            owner.ownerPid,
            owner.acquiredAt,
            ownerFingerprint
          );
          return true;
        }).immediate();
        if (claimed) return makeLease(db, path, owner);
        continue;
      }

      const stale = toOwner(existing);
      const ownerIdentity = recordedIdentity(
        stale.ownerPid,
        existing.owner_fingerprint,
        stale.acquiredAt
      );
      if (ownerIdentity === 'match' || ownerIdentity === 'unverifiable') {
        throw new RunLockBusyError(
          `another MCP server owns the run slot (${stale.runId}, pid ${stale.ownerPid}, since ${stale.acquiredAt}${ownerIdentity === 'unverifiable' ? ', process birth unverifiable' : ''})`,
          stale
        );
      }

      let reaped: ReapedRun | undefined;
      if (stale.childPgid !== undefined && runProcessGroupExists(stale.childPgid)) {
        const childIdentity = recordedIdentity(
          stale.childPgid,
          existing.child_fingerprint,
          stale.acquiredAt
        );
        if (childIdentity === 'unverifiable' || childIdentity === 'gone') {
          throw new RunLockBusyError(
            `the previous MCP server died while run ${stale.runId} left process group ${stale.childPgid}, but its birth identity cannot be verified; refusing to signal a possibly recycled group`,
            stale
          );
        }
        if (childIdentity === 'match') {
          const gone = await terminateRunProcessGroup(stale.childPgid);
          if (!gone) {
            throw new RunLockBusyError(
              `the previous MCP server died while run ${stale.runId} survived (process group ${stale.childPgid}); cleanup did not reach ESRCH after ${RUN_KILL_GRACE_MS + RUN_KILL_CONFIRM_MS}ms`,
              stale
            );
          }
          // A surviving run was just DESTROYED to free the slot. Carry the
          // identity of what was killed onto the lease so the caller can say
          // so — a silent reap leaves the host unable to explain why the
          // previous run's deliverable vanished (2026-08-14 review, MCP §).
          reaped = { runId: stale.runId, childPgid: stale.childPgid };
        } else {
          // Same numeric PGID, different process birth: it belongs to someone
          // else now. Reclaim only the stale row and never send a signal.
        }
      }

      // Compare-and-swap under BEGIN IMMEDIATE. If another recoverer already
      // replaced the stale token, this transaction changes nothing and loops.
      const claimed = db.transaction(() => {
        if (deleteByToken.run(stale.token).changes !== 1) return false;
        insert.run(
          owner.token,
          owner.runId,
          owner.ownerPid,
          owner.acquiredAt,
          ownerFingerprint
        );
        return true;
      }).immediate();
      if (claimed) return makeLease(db, path, owner, reaped);
    }
    throw new RunLockBusyError(`could not acquire MCP run lease ${path} after recovery races`);
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * READ-ONLY view of the lease row, for status reporting.
 *
 * WHY IT EXISTS: run records are in-memory only, so after a server restart
 * `atoma_run_status` used to answer "no run with id" while the lease row still
 * named a possibly-LIVE run from the previous server — the surviving run was
 * invisible until the next `atoma_run_start` destructively recovered it
 * (2026-08-14 review, MCP §). This peek lets the status path report that
 * cross-process owner without becoming a second recovery path.
 *
 * THE CONTRACT IS "LOOK, NEVER TOUCH": the handle is readonly + fileMustExist
 * (the same shape the MCP readers use — `openLockDb` would mkdir, exec the
 * schema and flip journal_mode, i.e. WRITE), the query is one SELECT, and no
 * process is probed or signalled — reporting must never kill or mutate what it
 * reports on. Recovery stays exclusively in `acquireRunLease`, where it runs
 * under BEGIN IMMEDIATE with fingerprint checks. An absent/torn store is
 * "nothing to report", never a throw in a status poll.
 */
export function peekRunLease(path = mcpRunLockPath()): RunLockOwner | null {
  if (!existsSync(path)) return null;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare('SELECT * FROM mcp_run_lease WHERE singleton = 1')
      .get() as LeaseRow | undefined;
    return row ? toOwner(row) : null;
  } catch {
    // Missing table (a foreign file at this path) or a torn store: a status
    // reader has nothing to say about it.
    return null;
  } finally {
    db.close();
  }
}
