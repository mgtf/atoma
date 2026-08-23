import type Database from 'better-sqlite3';
import { ZodError } from 'zod';
import {
  isPlatformEventFamily,
  platformEventInputSchema,
  severityForKind,
  type PlatformEvent,
  type PlatformEventInput,
  type PlatformEventKind,
  type PlatformEventSeverity,
} from '../contracts/platformEvents.js';
import { openStoreHandle, storeDbPath } from '../core/stores.js';

/**
 * THE PLATFORM EVENT LOG — append-only control-plane audit, plus the
 * in-process bus the notification router listens on.
 *
 * One more table group on the ONE product store, joined through
 * `openStoreHandle` exactly like the auth, projects, github and push groups.
 *
 * FAIL-OPEN, on the ledger's precedent: telemetry that crashes production is
 * worse than no telemetry, and every emitter here sits on a request path or
 * inside a run's completion. `append` never throws — not on a closed handle,
 * not on a schema violation, not on a listener that explodes. It is LOUDER
 * than the ledger's `warnOnce`, though: the ledger warns once and is silent
 * forever, which for an audit trail would hide a systematic emitter bug
 * behind one line of scrollback. Here each distinct reason warns once, with
 * the set of seen reasons bounded so a flood cannot grow memory.
 *
 * ONE WRITE PATH, ONE NOTIFICATION. Subscribers are notified from inside
 * `append`, so there is no way to journal an event without offering it to the
 * router — the "impossible to forget" shape the run/notification split had to
 * be refactored into. Cross-process writers (the operator CLI) reach the same
 * table through their own handle and therefore notify nobody: audited, never
 * pushed. That is intentional and stated in the design doc.
 */

export const PLATFORM_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS platform_events (
  -- MONOTONIC and load-bearing, the same reasoning as lifecycle_events.seq:
  -- \`at\` has millisecond resolution and one login burst writes several rows
  -- inside one millisecond, so \`at\` alone cannot order them. Readers page
  -- newest-first on \`seq\`, and a cursor over an ambiguous ordering would
  -- skip or repeat rows at page boundaries.
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  org_id     TEXT,
  project_id TEXT,
  run_id     TEXT,
  summary    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_events_org ON platform_events(org_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_kind ON platform_events(kind);
`;

/** Hard ceiling on rows kept, independent of age. */
export const PLATFORM_EVENTS_MAX_ROWS = 50_000;
export const PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3_650;

export const PLATFORM_EVENTS_DEFAULT_PAGE_SIZE = 50;
export const PLATFORM_EVENTS_MAX_PAGE_SIZE = 200;

/** Bounded so a persistently failing emitter cannot grow this set. */
const MAX_WARNED_REASONS = 20;
const warnedReasons = new Set<string>();

/**
 * One LINE per failure. A ZodError's `message` is a multi-line JSON dump of
 * every issue, which is unreadable in a log and buries the one field that is
 * actually wrong; compact it to `path: message` pairs.
 */
function describe(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
      .slice(0, 300);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function warnOnce(reason: string, error: unknown): void {
  const key = `${reason}: ${describe(error)}`;
  if (warnedReasons.has(key)) return;
  if (warnedReasons.size < MAX_WARNED_REASONS) warnedReasons.add(key);
  process.stderr.write(`[atoma events] ${key}\n`);
}

/** Test seam: the warned-reason set is module state. */
export function resetPlatformEventWarnings(): void {
  warnedReasons.clear();
}

/**
 * Retention window in days: `ATOMA_EVENTS_RETENTION_DAYS` → default. An
 * invalid or non-positive value falls back to the default rather than
 * disabling retention or deleting everything — the same
 * read-it-through-a-validator rule as `trustThreshold()`.
 */
export function eventsRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ATOMA_EVENTS_RETENTION_DAYS'];
  if (raw === undefined) return PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_RETENTION_DAYS) {
    return PLATFORM_EVENTS_DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

export interface PlatformEventQuery {
  /** Exclusive `seq` cursor for newest-first paging: rows with `seq < before`. */
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
  readonly kind?: string | undefined;
  /**
   * One FAMILY of kinds — the segment before the dot (`run`, `security`, …).
   * The admin journal filters by family because 28 kinds is not a chip row,
   * and the family list is derived from the kind vocabulary rather than
   * written twice. Validated against that closed set by the caller; an
   * unknown family is ignored, never interpolated.
   */
  readonly kindFamily?: string | undefined;
  readonly severity?: string | undefined;
  readonly orgId?: string | undefined;
  /**
   * One run's rows. Added for the sentinel, which de-duplicates against the
   * JOURNAL rather than against its own memory: the journal is the source of
   * truth for "have I already said this", so a restarted watcher does not
   * repeat a run's findings.
   */
  readonly runId?: string | undefined;
}

export interface PlatformEventPage {
  readonly events: PlatformEvent[];
  /** Cursor for the next page, or null when this page is the last one. */
  readonly nextBefore: number | null;
}

export type PlatformEventListener = (event: PlatformEvent) => void | Promise<void>;

interface EventRow {
  seq: number;
  at: string;
  kind: string;
  severity: string;
  actor_type: string;
  actor_id: string | null;
  org_id: string | null;
  project_id: string | null;
  run_id: string | null;
  summary: string;
  detail: string | null;
}

/**
 * Rows are read TOLERANTLY, on the ledger's `rowToEvent` precedent: an
 * unparseable `detail` degrades to absent, and a `kind` or `severity` this
 * build does not know is passed through as-is rather than dropped. Blinding
 * the audit surface is a worse failure than rendering an unfamiliar label,
 * and a strict parse here would let one foreign row hide every row around it.
 */
function rowToEvent(row: EventRow): PlatformEvent {
  let detail: Record<string, unknown> | undefined;
  if (row.detail) {
    try {
      const parsed = JSON.parse(row.detail) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = undefined;
    }
  }
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind as PlatformEventKind,
    severity: row.severity as PlatformEventSeverity,
    actorType: row.actor_type as PlatformEvent['actorType'],
    actorId: row.actor_id,
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    summary: row.summary,
    ...(detail ? { detail } : {}),
  };
}

export class PlatformEventLog {
  private readonly db: Database.Database;
  private readonly listeners = new Set<PlatformEventListener>();
  private readonly now: () => Date;

  private constructor(db: Database.Database, now?: () => Date) {
    this.db = db;
    this.now = now ?? (() => new Date());
  }

  static open(path?: string, now?: () => Date): PlatformEventLog {
    return new PlatformEventLog(
      openStoreHandle(path ?? storeDbPath(), PLATFORM_EVENTS_TABLE_DDL),
      now
    );
  }

  /**
   * Subscribe to events appended BY THIS PROCESS. Returns the unsubscribe.
   * A listener that throws or rejects is contained and warned about; it can
   * never fail the append or the request that caused it.
   */
  subscribe(listener: PlatformEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Journal one event and offer it to the subscribers. Never throws; returns
   * the stored row, or null when the event was dropped (invalid input or a
   * store failure) so a caller that cares can tell.
   */
  append(input: PlatformEventInput): PlatformEvent | null {
    let stored: PlatformEvent;
    try {
      const parsed = platformEventInputSchema.parse(input);
      const at = this.now().toISOString();
      const severity = severityForKind(parsed.kind);
      const result = this.db
        .prepare(
          `INSERT INTO platform_events
             (at, kind, severity, actor_type, actor_id, org_id, project_id, run_id, summary, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          at,
          parsed.kind,
          severity,
          parsed.actorType,
          parsed.actorId,
          parsed.orgId,
          parsed.projectId,
          parsed.runId,
          parsed.summary,
          parsed.detail === undefined ? null : JSON.stringify(parsed.detail)
        );
      stored = {
        seq: Number(result.lastInsertRowid),
        at,
        severity,
        kind: parsed.kind,
        actorType: parsed.actorType,
        actorId: parsed.actorId,
        orgId: parsed.orgId,
        projectId: parsed.projectId,
        runId: parsed.runId,
        summary: parsed.summary,
        ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
      };
    } catch (error) {
      warnOnce(`append(${String(input.kind)}) failed`, error);
      return null;
    }
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(stored)).catch((error: unknown) => {
          warnOnce(`listener for ${stored.kind} rejected`, error);
        });
      } catch (error) {
        warnOnce(`listener for ${stored.kind} threw`, error);
      }
    }
    return stored;
  }

  /** A `PlatformEventSink` bound to this log, for injection into domain code. */
  get sink(): (input: PlatformEventInput) => void {
    return (input) => {
      this.append(input);
    };
  }

  /**
   * Newest-first page. Out-of-range `limit` values CLAMP rather than error
   * (the MCP reader precedent): an operator typing `limit=5000` gets the
   * maximum page, not a 400.
   */
  list(query: PlatformEventQuery = {}): PlatformEventPage {
    const limit = Math.max(
      1,
      Math.min(
        PLATFORM_EVENTS_MAX_PAGE_SIZE,
        Number.isFinite(query.limit) && query.limit !== undefined
          ? Math.trunc(query.limit)
          : PLATFORM_EVENTS_DEFAULT_PAGE_SIZE
      )
    );
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.before !== undefined && Number.isFinite(query.before)) {
      clauses.push('seq < ?');
      params.push(Math.trunc(query.before));
    }
    if (query.kind) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    if (query.kindFamily && isPlatformEventFamily(query.kindFamily)) {
      // Parameterised prefix match, and the family is checked against the
      // closed vocabulary first: a filter must not become a pattern channel.
      clauses.push('kind LIKE ?');
      params.push(`${query.kindFamily}.%`);
    }
    if (query.severity) {
      clauses.push('severity = ?');
      params.push(query.severity);
    }
    if (query.orgId) {
      clauses.push('org_id = ?');
      params.push(query.orgId);
    }
    if (query.runId) {
      clauses.push('run_id = ?');
      params.push(query.runId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    try {
      // limit + 1 so "is there another page" is an observation, not a guess.
      const rows = this.db
        .prepare(
          `SELECT seq, at, kind, severity, actor_type, actor_id, org_id, project_id, run_id, summary, detail
             FROM platform_events${where}
            ORDER BY seq DESC
            LIMIT ?`
        )
        .all(...params, limit + 1) as EventRow[];
      const page = rows.slice(0, limit).map(rowToEvent);
      const last = page[page.length - 1];
      return {
        events: page,
        nextBefore: rows.length > limit && last ? last.seq : null,
      };
    } catch (error) {
      warnOnce('list failed', error);
      return { events: [], nextBefore: null };
    }
  }

  count(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM platform_events').get() as {
        n: number;
      };
      return row.n;
    } catch {
      return 0;
    }
  }

  /**
   * Retention: by age AND by row cap. Both halves matter — the age cut alone
   * lets a burst blow the table up inside the window, and the cap alone keeps
   * an idle deployment's rows forever. Never throws; a failed sweep is warned
   * about and retried on the next tick.
   *
   * A row whose `at` is not a sortable ISO instant (only reachable from a
   * foreign writer) survives the age half — 'garbage' sorts above any digit —
   * and is collected by the row cap instead.
   */
  sweep(env: NodeJS.ProcessEnv = process.env): { deleted: number } {
    try {
      const cutoff = new Date(
        this.now().getTime() - eventsRetentionDays(env) * 24 * 60 * 60 * 1_000
      ).toISOString();
      const swept = this.db.transaction(() => {
        const aged = this.db
          .prepare('DELETE FROM platform_events WHERE at < ?')
          .run(cutoff).changes;
        const capped = this.db
          .prepare(
            `DELETE FROM platform_events
              WHERE seq NOT IN (
                SELECT seq FROM platform_events ORDER BY seq DESC LIMIT ?
              )`
          )
          .run(PLATFORM_EVENTS_MAX_ROWS).changes;
        return aged + capped;
      });
      return { deleted: swept.immediate() };
    } catch (error) {
      warnOnce('sweep failed', error);
      return { deleted: 0 };
    }
  }
}
