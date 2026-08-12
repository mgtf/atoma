/**
 * Cross-process lease for the MCP run slot.
 *
 * SQLite supplies the compare-and-delete primitive a lockfile cannot: stale
 * recovery and successor acquisition happen under BEGIN IMMEDIATE, and every
 * update/delete is conditioned on a random token. Two recoverers can never
 * delete each other's freshly-acquired lease (the lockfile ABA race).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
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

export interface RunLease {
  readonly path: string;
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
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL
  )
`;

function openLockDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function processExists(pid: number): boolean {
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

function toOwner(row: LeaseRow): RunLockOwner {
  return {
    token: row.token,
    runId: row.run_id,
    ownerPid: row.owner_pid,
    acquiredAt: row.acquired_at,
    ...(row.child_pgid !== null ? { childPgid: row.child_pgid } : {}),
  };
}

function makeLease(db: Database.Database, path: string, owner: RunLockOwner): RunLease {
  let released = false;
  return {
    path,
    attachChild(pgid) {
      if (released) throw new Error(`cannot attach child ${pgid}: run lease is already released`);
      const changed = db
        .prepare(
          'UPDATE mcp_run_lease SET child_pgid = ? WHERE singleton = 1 AND token = ?'
        )
        .run(pgid, owner.token).changes;
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
  const read = db.prepare('SELECT * FROM mcp_run_lease WHERE singleton = 1');
  const insert = db.prepare(
    `INSERT INTO mcp_run_lease
      (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
     VALUES (1, ?, ?, ?, NULL, ?)`
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
          insert.run(owner.token, owner.runId, owner.ownerPid, owner.acquiredAt);
          return true;
        }).immediate();
        if (claimed) return makeLease(db, path, owner);
        continue;
      }

      const stale = toOwner(existing);
      if (processExists(stale.ownerPid)) {
        throw new RunLockBusyError(
          `another MCP server owns the run slot (${stale.runId}, pid ${stale.ownerPid}, since ${stale.acquiredAt})`,
          stale
        );
      }

      if (stale.childPgid !== undefined && runProcessGroupExists(stale.childPgid)) {
        const gone = await terminateRunProcessGroup(stale.childPgid);
        if (!gone) {
          throw new RunLockBusyError(
            `the previous MCP server died while run ${stale.runId} survived (process group ${stale.childPgid}); cleanup did not reach ESRCH after ${RUN_KILL_GRACE_MS + RUN_KILL_CONFIRM_MS}ms`,
            stale
          );
        }
      }

      // Compare-and-swap under BEGIN IMMEDIATE. If another recoverer already
      // replaced the stale token, this transaction changes nothing and loops.
      const claimed = db.transaction(() => {
        if (deleteByToken.run(stale.token).changes !== 1) return false;
        insert.run(owner.token, owner.runId, owner.ownerPid, owner.acquiredAt);
        return true;
      }).immediate();
      if (claimed) return makeLease(db, path, owner);
    }
    throw new RunLockBusyError(`could not acquire MCP run lease ${path} after recovery races`);
  } catch (err) {
    db.close();
    throw err;
  }
}
