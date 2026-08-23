import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { openStoreHandle } from '../core/stores.js';
import { processExists, processFingerprint } from '../mcp/runLock.js';

/**
 * THE WATCH LEASE — at most one APPENDING resident watch per product store.
 *
 * WHY IT EXISTS, precisely. De-duplication against the journal is a
 * CROSS-TICK guarantee, not a within-tick one: `emittedKeys()` SELECTs and
 * `screen()` INSERTs as two statements, and `platform_events` carries no
 * uniqueness over (kind, run_id, dedupeKey) — its only indexes are on org and
 * kind. Two watchers ticking in the same window therefore each write the same
 * finding once. That stayed theoretical while the only watch was a CLI an
 * operator started deliberately; arming the viz server by default makes the
 * pair routine, so the claim needed either a constraint or a lease. A unique
 * index is not available cheaply — `dedupeKey` lives inside the `detail` JSON,
 * not in a column — so it is a lease, and the constraint stays an open
 * question for its own migration.
 *
 * It lives in the PRODUCT STORE, beside `push_vapid_keys`: exclusivity is
 * per-journal, the journal is in that store, so the store IS the key and the
 * row is a singleton. No second store, and nothing operational to clean up.
 *
 * WHO WINS. Reclaim is automatic when the owner is gone, is a different
 * process wearing its pid, or has been silent past its own cadence. Beyond
 * that there is ONE asymmetry, and it runs toward the deliberate act: a
 * resident `npm run sentinel` TAKES OVER from a viz server, because
 * `src/sentinel/AGENTS.md` says a run beside a burn-in batch is watched by the
 * bare CLI and never by leaving a browser open — an operator typing that
 * command with a `--cost-alert` must not be refused by a tab they forgot. In
 * every other pairing the claimant yields: a server yields to any live watch,
 * and a CLI yields to another live CLI, where the tie is genuinely ambiguous.
 * The displaced server notices on its next ownership check and re-arms by
 * itself once the CLI is gone, so neither direction needs a restart.
 *
 * It is keyed by the store, which is why it lives IN the store — unlike
 * `mcpRunLockPath()`, whose lease is keyed by the machine and therefore sits
 * in its own operational database. A restored backup travels with its watch
 * row, and the reclaim checks are what make that safe.
 */

export const SENTINEL_WATCH_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS sentinel_watch (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  token            TEXT NOT NULL,
  source           TEXT NOT NULL,
  owner_pid        INTEGER NOT NULL,
  owner_fingerprint TEXT,
  label            TEXT,
  interval_ms      INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL
);
`;

/** Which process hosts a watch. Two hosts, and the vocabulary is closed. */
export type SentinelWatchSource = 'viz-server' | 'cli';

export interface SentinelWatchIncumbent {
  readonly source: string;
  readonly ownerPid: number;
  readonly label: string | null;
  readonly intervalMs: number;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

export interface SentinelWatchLease {
  /**
   * Refresh the row. FALSE means the lease is no longer ours — the row was
   * reclaimed or deleted — and the caller must stop appending. A watch that
   * kept ticking after losing its lease is the double-writer this prevents.
   */
  heartbeat(at?: Date): boolean;
  release(): void;
}

export type SentinelWatchClaim =
  | {
      readonly held: true;
      readonly lease: SentinelWatchLease;
      /** A LIVE watch this claim took over from, so the caller can say so. */
      readonly displaced?: SentinelWatchIncumbent;
    }
  | { readonly held: false; readonly incumbent: SentinelWatchIncumbent };

interface WatchRow {
  token: string;
  source: string;
  owner_pid: number;
  owner_fingerprint: string | null;
  label: string | null;
  interval_ms: number;
  started_at: string;
  heartbeat_at: string;
}

/**
 * A heartbeat older than three of the INCUMBENT'S OWN intervals, floored at a
 * minute. Reading the incumbent's interval rather than the claimant's is
 * load-bearing: a `--interval 2000` CLI would otherwise judge a healthy
 * 20-second server stale six seconds after its last tick and steal the watch.
 */
const STALE_FLOOR_MS = 60_000;

function staleAfterMs(row: WatchRow): number {
  const interval = Number.isFinite(row.interval_ms) ? row.interval_ms : 0;
  return Math.max(STALE_FLOOR_MS, interval * 3);
}

function toIncumbent(row: WatchRow): SentinelWatchIncumbent {
  return {
    source: row.source,
    ownerPid: row.owner_pid,
    label: row.label,
    intervalMs: row.interval_ms,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  };
}

/**
 * Reclaimable when the owner is provably gone, provably a DIFFERENT process
 * that inherited the pid, or silent past its own staleness window. An owner
 * that exists and cannot be fingerprinted is left alone: unverifiable is not
 * permission.
 */
function reclaimable(row: WatchRow, nowMs: number): boolean {
  if (!processExists(row.owner_pid)) return true;
  const fingerprint = processFingerprint(row.owner_pid);
  if (row.owner_fingerprint && fingerprint && fingerprint !== row.owner_fingerprint) return true;
  const beat = Date.parse(row.heartbeat_at);
  if (!Number.isFinite(beat)) return true;
  return nowMs - beat > staleAfterMs(row);
}

/** The one asymmetry: an explicitly started CLI displaces a viz server. */
function mayTakeOver(row: WatchRow, claimant: SentinelWatchSource): boolean {
  return claimant === 'cli' && row.source === 'viz-server';
}

function readRow(db: Database.Database): WatchRow | undefined {
  return db.prepare('SELECT * FROM sentinel_watch WHERE singleton = 1').get() as
    | WatchRow
    | undefined;
}

/** Who holds the watch on this store, without trying to take it. */
export function peekSentinelWatch(dbPath: string): SentinelWatchIncumbent | null {
  try {
    const row = readRow(openStoreHandle(dbPath, SENTINEL_WATCH_TABLE_DDL));
    return row ? toIncumbent(row) : null;
  } catch {
    // A reader must not be the reason a caller cannot boot.
    return null;
  }
}

export function claimSentinelWatch(
  dbPath: string,
  options: {
    readonly source: SentinelWatchSource;
    readonly intervalMs: number;
    readonly label?: string;
    readonly now?: () => Date;
  }
): SentinelWatchClaim {
  const db = openStoreHandle(dbPath, SENTINEL_WATCH_TABLE_DDL);
  const now = options.now ?? (() => new Date());
  const token = randomUUID();
  const pid = process.pid;

  // BEGIN IMMEDIATE (below) for the same reason the MCP run lease uses it:
  // read and replace must be ONE transaction, or two claimants both see the
  // same stale row and both take the watch.
  const claim = db.transaction((): SentinelWatchClaim => {
    const existing = readRow(db);
    const stamp = now().toISOString();
    if (
      existing &&
      !reclaimable(existing, Date.parse(stamp)) &&
      !mayTakeOver(existing, options.source)
    ) {
      return { held: false, incumbent: toIncumbent(existing) };
    }
    const displaced = existing && !reclaimable(existing, Date.parse(stamp)) ? toIncumbent(existing) : null;
    db.prepare(
      `INSERT INTO sentinel_watch
         (singleton, token, source, owner_pid, owner_fingerprint, label, interval_ms,
          started_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         token = excluded.token,
         source = excluded.source,
         owner_pid = excluded.owner_pid,
         owner_fingerprint = excluded.owner_fingerprint,
         label = excluded.label,
         interval_ms = excluded.interval_ms,
         started_at = excluded.started_at,
         heartbeat_at = excluded.heartbeat_at`
    ).run(
      token,
      options.source,
      pid,
      processFingerprint(pid),
      options.label ?? null,
      Math.max(1, Math.trunc(options.intervalMs)),
      stamp,
      stamp
    );
    return {
      held: true,
      ...(displaced ? { displaced } : {}),
      lease: {
        heartbeat(at?: Date): boolean {
          try {
            const result = db
              .prepare(
                'UPDATE sentinel_watch SET heartbeat_at = ? WHERE singleton = 1 AND token = ?'
              )
              .run((at ?? now()).toISOString(), token);
            return result.changes > 0;
          } catch {
            // A locked store is not proof the lease was lost; keep watching
            // and let the next beat settle it.
            return true;
          }
        },
        release(): void {
          try {
            db.prepare('DELETE FROM sentinel_watch WHERE singleton = 1 AND token = ?').run(token);
          } catch {
            // A row left behind is reclaimed by the next claimant on
            // staleness; releasing twice is harmless.
          }
        },
      },
    };
  });

  return claim.immediate();
}
