import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { storeDbPath } from './stores.js';

/**
 * APPEND-ONLY LIFECYCLE LEDGER (P2 — event-sourced provenance, stage 1).
 * ======================================================================
 * Every trust/lifecycle mutation in the system appends one event here, from
 * the storage choke points themselves (AtomRegistry counter methods,
 * SkillRegistry lifecycle methods) — so the ledger sees exactly what the
 * mutable stores see, with zero extra call sites to maintain.
 *
 * Stage 1 is DUAL-WRITE: the SQLite counters and `_meta.json` sidecars remain
 * authoritative for runtime decisions, and the ledger is the durable record
 * that lets `npm run ledger -- check` recompute what the counters SHOULD be
 * and flag drift.
 *
 * IT LIVES IN THE STORE ITSELF (table `lifecycle_events`), and used to be a
 * sibling `atoma-ledger.jsonl`. Two things the move fixes, both measured
 * rather than aesthetic:
 *
 *  1. THE PAIRING IS NOW PHYSICAL FOR ATOM TYPES. The ledger's documented
 *     hard rule was that ONE ledger maps to ONE authoritative store — events
 *     carry no store identity, so `check` compares a projection against
 *     whichever store you point it at. It was enforced by convention and the
 *     convention broke: two throwaway `tsx` scripts opened `:memory:`
 *     registries, bumped `Helium`, and appended four phantom successes to the
 *     real file, leaving `ledger check` reporting
 *     `IMPOSSIBLE  Helium: store 2 < ledger 6` permanently — a false alarm on
 *     the one tool whose entire value is being believed. `AtomRegistry` now
 *     writes events through its OWN handle, so an in-memory registry gets an
 *     in-memory ledger by construction and cannot reach the real store at
 *     all. That is elimination, not mitigation.
 *  2. THE COUNTER AND ITS EVENT ARE ONE TRANSACTION. `recordSuccess` appended
 *     BEFORE the `UPDATE`, so a crash between the two lines left the store
 *     one behind the ledger — which is exactly the IMPOSSIBLE direction the
 *     check treats as proof that a write path bypassed the choke points. The
 *     integrity checker could be made to lie by an ill-timed SIGKILL, and
 *     runs get SIGKILLed (burn-in group-kills at the wall-clock budget).
 *
 * The skill half of the pairing stays conventional while skill bodies live on
 * disk: `check` still takes a `--skills-dir`. That is the honest remaining
 * gap, and the main structural argument for eventually moving skills in too.
 *
 * Fail-open by design: a ledger write must NEVER take down a run — telemetry
 * that crashes production is worse than no telemetry. Errors are swallowed
 * after a single console.warn.
 */

export type LedgerEventKind =
  | 'type-success'
  | 'type-failure'
  | 'skill-success'
  | 'skill-failure'
  | 'skill-save'
  | 'promote'
  | 'demote'
  | 'promotion-refused'
  | 'direct-failure'
  | 'direct-failures-cleared'
  | 'counters-reset'
  // Catalog-hygiene verbs (CLI `skills drop` / `skills merge`). The entity
  // disappears from the store afterwards; `ledger check` iterates the STORE,
  // so a dropped entity's stale projection is never compared — no special
  // handling needed in projectCounters.
  | 'skill-drop'
  | 'skill-merge'
  // `registry dedupe`. UNLIKE `skill-merge`, this one MOVES COUNTERS: the
  // winner absorbs the losers' totals (`AtomRegistry.mergeInto`), so the
  // projection has to follow or the winner reads as unexplained drift
  // forever. `detail.successes` / `detail.failures` carry the delta.
  | 'type-merge';

export interface LedgerEvent {
  readonly at: string;
  readonly kind: LedgerEventKind;
  /** `Hydrogen` for atom types, `Hydrogen/web-build-loop` for skills. */
  readonly entity: string;
  readonly detail?: Record<string, unknown>;
}

/** Minimal surface we need from a better-sqlite3 handle. Keeps `db.ts` free. */
export type LedgerDb = Database.Database;

export const LEDGER_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS lifecycle_events (
  -- MONOTONIC, and load-bearing. \`at\` is an ISO timestamp with millisecond
  -- resolution and the ledger records bursts (a supervise loop bumps several
  -- counters inside one millisecond routinely), so ordering by \`at\` is
  -- ambiguous exactly when it matters: \`projectCounters\` is order-sensitive
  -- because \`counters-reset\` and \`promote\` ZERO the running totals, and a
  -- reset replayed one position early or late changes the projection. File
  -- order gave this for free in the JSONL era; a rowid gives it back.
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  entity  TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_entity ON lifecycle_events(entity);
`;

/** Pre-consolidation ledger file. Read once by the importer, never written. */
export const LEGACY_LEDGER_FILENAME = 'atoma-ledger.jsonl';

/**
 * Which store's ledger, when the caller has no handle of its own.
 *
 * `ATOMA_LEDGER_DB` exists for the same reason `ATOMA_LEDGER_PATH` did: the
 * test suite and `viz:demo` must not write into the developer's real store.
 * It is deliberately a DB path, not a file path — the ledger is a table now.
 */
export function ledgerDbPath(): string {
  return resolve(process.env['ATOMA_LEDGER_DB'] ?? storeDbPath());
}

/**
 * `ledgerWritesAllowed` USED TO LIVE HERE and is deliberately gone.
 *
 * It refused an append when the calling registry was `:memory:` and no ledger
 * had been named — a guard against the incident in the header. `AtomRegistry`
 * now passes its own handle, so an in-memory registry writes to an in-memory
 * ledger and the events have nowhere else to go: the predicate had no
 * remaining caller, and a guard whose condition can no longer arise is a test
 * that proves nothing. The property is pinned instead by "an in-memory
 * registry cannot reach the configured store" in `tests/ledger.test.ts`,
 * which drives the real classes.
 */

let warnedOnce = false;

function warnOnce(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[ledger] write failed (further failures silent): ${(err as Error).message}`);
}

/**
 * Lazily-opened handles for callers with no store of their own, one per path.
 *
 * Caching matters: `SkillRegistry` appends on every counter bump, and opening
 * a SQLite connection per event would turn a burst of skill successes into a
 * burst of file opens. WAL makes the second handle on one file safe.
 */
const handles = new Map<string, LedgerDb>();

function handleFor(path: string): LedgerDb {
  let db = handles.get(path);
  if (!db) {
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(LEDGER_TABLE_DDL);
    handles.set(path, db);
  }
  return db;
}

/** Drop cached handles. For tests that repoint `ATOMA_LEDGER_DB` mid-suite. */
export function closeLedgerHandles(): void {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  handles.clear();
}

/**
 * Append one event. Fail-open: never throws.
 *
 * Pass `db` when you already hold the store — `AtomRegistry` does, which is
 * what makes its events structurally inseparable from its counters.
 */
export function appendLedger(event: Omit<LedgerEvent, 'at'>, db?: LedgerDb): void {
  try {
    const target = db ?? handleFor(ledgerDbPath());
    insertEvent(target, { at: new Date().toISOString(), ...event });
  } catch (err) {
    warnOnce(err);
  }
}

/** The raw insert, so a caller inside a transaction can reuse it. THROWS. */
export function insertEvent(db: LedgerDb, ev: LedgerEvent): void {
  db.prepare('INSERT INTO lifecycle_events (at, kind, entity, detail) VALUES (?, ?, ?, ?)').run(
    ev.at,
    ev.kind,
    ev.entity,
    ev.detail === undefined ? null : JSON.stringify(ev.detail)
  );
}

interface EventRow {
  at: string;
  kind: string;
  entity: string;
  detail: string | null;
}

function rowToEvent(r: EventRow): LedgerEvent {
  let detail: Record<string, unknown> | undefined;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      // A detail blob that will not parse must not blind the reader to the
      // event itself — same rule the JSONL reader applied to torn lines.
      detail = undefined;
    }
  }
  return {
    at: r.at,
    kind: r.kind as LedgerEventKind,
    entity: r.entity,
    ...(detail ? { detail } : {}),
  };
}

/** Read every event in append order. Never throws; a missing store reads empty. */
export function readLedger(db?: LedgerDb): LedgerEvent[] {
  try {
    const target = db ?? handleFor(ledgerDbPath());
    const rows = target
      .prepare('SELECT at, kind, entity, detail FROM lifecycle_events ORDER BY seq ASC')
      .all() as EventRow[];
    return rows.map(rowToEvent);
  } catch (err) {
    warnOnce(err);
    return [];
  }
}

/** How many events the store holds, without materialising them. */
export function ledgerCount(db?: LedgerDb): number {
  try {
    const target = db ?? handleFor(ledgerDbPath());
    const row = target.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/** Parse a pre-consolidation JSONL ledger. Skips torn lines rather than throwing. */
export function readLegacyJsonl(path: string): LedgerEvent[] {
  if (!existsSync(path)) return [];
  const out: LedgerEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as LedgerEvent;
      if (typeof obj.kind === 'string' && typeof obj.entity === 'string') out.push(obj);
    } catch {
      // torn/corrupt line — skip, never crash the import
    }
  }
  return out;
}

/**
 * Import a sibling `atoma-ledger.jsonl` into an empty `lifecycle_events`.
 *
 * Called from `openDb`, so an existing installation carries its history
 * across the move with no operator step. Three conditions, each closing a way
 * this could do harm:
 *   - the DB is a real FILE (`:memory:` fixtures must not inhale the
 *     developer's 949-event history — the same accident, mirrored);
 *   - the table is EMPTY (idempotent: a second open imports nothing, so the
 *     file can be deleted or kept without changing the outcome);
 *   - the JSONL sits NEXT TO the DB it is being merged into, which is the
 *     only evidence available that the two were ever paired.
 * The file is left in place: an import that also deletes its source cannot be
 * inspected afterwards, and the whole point of the exercise is a ledger you
 * can believe.
 */
export function importLegacyLedger(db: LedgerDb, dbPath: string): number {
  if (dbPath === ':memory:' || dbPath.startsWith('file::memory:') || dbPath === '') return 0;
  try {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get() as { n: number };
    if (existing.n > 0) return 0;
    const explicit = process.env['ATOMA_LEDGER_PATH'];
    const candidate = explicit
      ? resolve(explicit)
      : join(dirname(resolve(dbPath)), LEGACY_LEDGER_FILENAME);
    const events = readLegacyJsonl(candidate);
    if (events.length === 0) return 0;
    const insertAll = db.transaction((rows: LedgerEvent[]) => {
      for (const ev of rows) insertEvent(db, ev);
    });
    insertAll(events);
    return events.length;
  } catch (err) {
    warnOnce(err);
    return 0;
  }
}

export interface ProjectedCounters {
  successes: number;
  failures: number;
}

/**
 * Project per-entity success/failure counters from the ledger, honouring
 * the events that RESET them (counters-reset, promote — promotion zeroes
 * the counters by contract, the script form re-earns trust; skill-save
 * does NOT reset, matching SkillRegistry.save's counter-preserving
 * contract).
 */
export function projectCounters(events: LedgerEvent[]): Map<string, ProjectedCounters> {
  const map = new Map<string, ProjectedCounters>();
  const get = (e: string): ProjectedCounters => {
    let c = map.get(e);
    if (!c) {
      c = { successes: 0, failures: 0 };
      map.set(e, c);
    }
    return c;
  };
  for (const ev of events) {
    const c = get(ev.entity);
    switch (ev.kind) {
      case 'type-success':
      case 'skill-success':
        c.successes++;
        break;
      case 'type-failure':
      case 'skill-failure':
        c.failures++;
        break;
      case 'counters-reset':
      case 'promote':
        c.successes = 0;
        c.failures = 0;
        break;
      case 'type-merge': {
        // The absorbed totals really were added to this entity's counters, so
        // adding them here keeps the projection exact rather than merely
        // quiet. The losers keep their own projections, which nothing
        // compares: `check` iterates the STORE and their rows are gone.
        const d = ev.detail ?? {};
        if (typeof d['successes'] === 'number') c.successes += d['successes'];
        if (typeof d['failures'] === 'number') c.failures += d['failures'];
        break;
      }
      default:
        break;
    }
  }
  return map;
}
