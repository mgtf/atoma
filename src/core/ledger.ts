import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { z } from 'zod';
import type { platformEventActorTypeSchema } from '../contracts/platformEvents.js';
import { closeStoreHandles, openStoreHandle, storeDbPath } from './stores.js';

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
 *
 * SCOPE (T7, 2026-09-18). Every event can also say WHERE it arose: the
 * organisation, project and run, and WHO caused it, in the actor vocabulary
 * `platform_events` already uses in this same file. The columns are nullable
 * and additive — a row written before them, or by a process with nothing to
 * say, reads with no scope. Two consequences worth stating:
 *
 *  1. THE MIGRATION LANDS ON BOTH OPEN PATHS OR ON NEITHER. `appendLedger`
 *     swallows its own failure, so a column added by `openDb` alone would
 *     turn every append through the cached `openStoreHandle` path into
 *     silent loss, and the reverse. `ensureLedgerSchema` is the one
 *     definition and both paths call it.
 *  2. THE SCOPE IS PROCESS STATE, NOT A PARAMETER. The choke points that
 *     append (`AtomRegistry.note`, `SkillRegistry.recordEvent`) are called
 *     from deep inside the supervise loop, which knows nothing about
 *     organisations — and must not, per the platform-trust decision. A run
 *     child is one run, so the runner sets the scope once after
 *     `assertProjectRunAuthority` proved which run it is; a multi-tenant
 *     process (the viz server's MCP write tools) wraps each SYNCHRONOUS
 *     operator write in `withLedgerScope`. Nothing infers a scope: an event
 *     with none is a platform event, and that is the honest default.
 */

/** The actor vocabulary is the platform journal's; one shape, one home. */
export type LedgerActorType = z.infer<typeof platformEventActorTypeSchema>;

/**
 * Where an event arose and who caused it. Every field optional: a run child
 * knows all of them, an operator CLI knows only that it is the CLI, the
 * bootstrap knows nothing.
 */
export interface LedgerScope {
  readonly orgId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly actorType?: LedgerActorType;
  readonly actorId?: string;
}

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
  | 'type-counter-compensation'
  // A behavior change revokes validation bypass, preserving historical totals.
  | 'type-trust-reset'
  // `skills forgive` — the skill-side twin of type-counter-compensation:
  // negative deltas retract MISATTRIBUTED increments with a mandatory
  // reason, so an environment failure (not evidence against a recipe) no
  // longer costs every earned success the way all-or-nothing reset does.
  | 'skill-counter-compensation'
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
  /** `Water` for an L1 molecule, `Water/web-build-loop` for its skills. */
  readonly entity: string;
  readonly detail?: Record<string, unknown>;
  /** Absent when the event carries no organisation, project, run or actor. */
  readonly scope?: LedgerScope;
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
  detail  TEXT,
  -- Scope (T7). Nullable: a platform-level event has none. On a store older
  -- than these columns they are ADDED by ensureLedgerSchema; keep this list
  -- and LEDGER_SCOPE_COLUMNS in step.
  org_id     TEXT,
  project_id TEXT,
  run_id     TEXT,
  actor_type TEXT,
  actor_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_entity ON lifecycle_events(entity);
`;

/** The scope columns, in the order the DDL declares them. */
export const LEDGER_SCOPE_COLUMNS = ['org_id', 'project_id', 'run_id', 'actor_type', 'actor_id'] as const;

/**
 * Indexes over the scope columns live here rather than in the table DDL: on a
 * store created before the columns existed, `CREATE INDEX` on them would fail
 * before the ALTER that adds them had run.
 */
const LEDGER_SCOPE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_lifecycle_run ON lifecycle_events(run_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_org ON lifecycle_events(org_id);
`;

function ledgerColumns(db: LedgerDb): Set<string> {
  const rows = db.prepare('PRAGMA table_info(lifecycle_events)').all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Add the scope columns to a table created before them. Idempotent, and
 * re-checked inside the write lock because two processes (a run child and the
 * viz server, say) can open one store within the same second.
 */
function migrateLedgerScopeColumns(db: LedgerDb): void {
  const missing = LEDGER_SCOPE_COLUMNS.filter((column) => !ledgerColumns(db).has(column));
  if (missing.length > 0) {
    db.transaction(() => {
      const present = ledgerColumns(db);
      for (const column of LEDGER_SCOPE_COLUMNS) {
        if (!present.has(column)) db.exec(`ALTER TABLE lifecycle_events ADD COLUMN ${column} TEXT`);
      }
    }).immediate();
  }
  db.exec(LEDGER_SCOPE_INDEX_DDL);
}

/**
 * THE ONE ledger schema step, for every writable open of the store.
 *
 * `openDb` (the registry's handle) and `openLedgerHandle` (the cached handle
 * the skill choke points and the viz use) both call this, which is what makes
 * "the migration lands on both paths at once" a structural property rather
 * than a discipline. A caller with its own handle to a store that may predate
 * the scope columns calls it before the first `insertEvent`.
 */
export function ensureLedgerSchema(db: LedgerDb): void {
  db.exec(LEDGER_TABLE_DDL);
  migrateLedgerScopeColumns(db);
}


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
   
  console.warn(`[ledger] write failed (further failures silent): ${(err as Error).message}`);
}

/**
 * The cached, writable ledger handle on `path` — table created and scope
 * columns present. For callers with no store handle of their own
 * (`SkillRegistry`, the viz admin journal, the CLI).
 */
export function openLedgerHandle(path: string): LedgerDb {
  return openStoreHandle(path, LEDGER_TABLE_DDL, migrateLedgerScopeColumns);
}

function handleFor(path: string): LedgerDb {
  return openLedgerHandle(path);
}

/** Drop cached handles. For tests that repoint `ATOMA_LEDGER_DB` mid-suite. */
export const closeLedgerHandles = closeStoreHandles;

let processScope: LedgerScope | null = null;

/**
 * The scope every append in this process carries unless the event names its
 * own. A run child sets it once, after `assertProjectRunAuthority` said which
 * run it is; `null` clears it. Fields are merged over by an event's explicit
 * `scope`, so a run can still name a different actor for one event.
 */
export function setLedgerScope(scope: LedgerScope | null): void {
  processScope = scope;
}

export function ledgerScope(): LedgerScope | null {
  return processScope;
}

/**
 * Run one SYNCHRONOUS operation under a scope, restoring the previous one
 * afterwards — the shape a multi-tenant process needs, where the process
 * scope would attribute one request's write to another's principal.
 *
 * Synchronous is load-bearing, not a convenience: a promise returned from
 * `fn` would resolve AFTER the scope was restored, and every append inside it
 * would carry the wrong actor with no error anywhere. better-sqlite3 is
 * synchronous and so is every registry write, so the guard costs nothing.
 */
export function withLedgerScope<T>(scope: LedgerScope, fn: () => T): T {
  const previous = processScope;
  processScope = { ...previous, ...scope };
  try {
    const result = fn();
    if (isThenable(result)) {
      throw new Error('withLedgerScope needs a synchronous operation: a promise would outlive the scope');
    }
    return result;
  } finally {
    processScope = previous;
  }
}

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function effectiveScope(event: Omit<LedgerEvent, 'at'>): LedgerScope | undefined {
  if (!processScope && !event.scope) return undefined;
  const merged: LedgerScope = { ...processScope, ...event.scope };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
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
    insertEvent(target, stamped(event));
  } catch (err) {
    warnOnce(err);
  }
}

/** Timestamp the event and resolve its scope (own fields over the process scope). */
function stamped(event: Omit<LedgerEvent, 'at'>): LedgerEvent {
  const scope = effectiveScope(event);
  const { scope: _own, ...rest } = event;
  return { at: new Date().toISOString(), ...rest, ...(scope ? { scope } : {}) };
}

/**
 * Append one event or THROW — the fail-closed sibling of `appendLedger`, for
 * OPERATOR audit ops whose safe-loss direction is inverted.
 *
 * The fail-open contract exists so a ledger failure can never take down run
 * execution, and for the counter bumps that ordering is also safe: a lost
 * POSITIVE increment leaves the store ABOVE the ledger, the direction `check`
 * tolerates as expected drift. A NEGATIVE compensation inverts that: mutate
 * the store first and lose the append, and the store sits BELOW the ledger —
 * the direction `check` reports as IMPOSSIBLE — while the CLI has already
 * claimed an audit row that does not exist (found by adversarial review,
 * 2026-08-21). So the compensation path journals FIRST through this strict
 * append and mutates only afterwards: an append failure aborts with the
 * store untouched, and a store-write failure after the append lands in the
 * benign store>ledger direction.
 */
export function appendLedgerStrict(event: Omit<LedgerEvent, 'at'>, db?: LedgerDb): void {
  const target = db ?? handleFor(ledgerDbPath());
  insertEvent(target, stamped(event));
}

/**
 * The raw insert, so a caller inside a transaction can reuse it. THROWS.
 * Writes the event's OWN scope as given: the process scope is applied by
 * `appendLedger`/`appendLedgerStrict`, not here.
 */
export function insertEvent(db: LedgerDb, ev: LedgerEvent): void {
  db.prepare(
    `INSERT INTO lifecycle_events (at, kind, entity, detail, org_id, project_id, run_id, actor_type, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ev.at,
    ev.kind,
    ev.entity,
    ev.detail === undefined ? null : JSON.stringify(ev.detail),
    ev.scope?.orgId ?? null,
    ev.scope?.projectId ?? null,
    ev.scope?.runId ?? null,
    ev.scope?.actorType ?? null,
    ev.scope?.actorId ?? null
  );
}

interface EventRow {
  at: string;
  kind: string;
  entity: string;
  detail: string | null;
  org_id?: string | null;
  project_id?: string | null;
  run_id?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
}

/**
 * The SELECT list a reader can use on this handle. A READ-ONLY handle on a
 * store nobody has opened writably since the scope columns arrived (a backup
 * snapshot, `ledger tail --db`) has no such columns, and selecting them would
 * throw — which the fail-open readers would turn into an empty ledger.
 */
function selectList(db: LedgerDb): string {
  const present = ledgerColumns(db);
  const scoped = LEDGER_SCOPE_COLUMNS.every((column) => present.has(column));
  return scoped ? `at, kind, entity, detail, ${LEDGER_SCOPE_COLUMNS.join(', ')}` : 'at, kind, entity, detail';
}

function rowScope(r: EventRow): LedgerScope | undefined {
  const scope: LedgerScope = {
    ...(r.org_id ? { orgId: r.org_id } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.actor_type ? { actorType: r.actor_type as LedgerActorType } : {}),
    ...(r.actor_id ? { actorId: r.actor_id } : {}),
  };
  return Object.keys(scope).length > 0 ? scope : undefined;
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
  const scope = rowScope(r);
  return {
    at: r.at,
    kind: r.kind as LedgerEventKind,
    entity: r.entity,
    ...(detail ? { detail } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Read every event in append order. Never throws; a missing store reads empty. */
export function readLedger(db?: LedgerDb): LedgerEvent[] {
  try {
    const target = db ?? handleFor(ledgerDbPath());
    const rows = target
      .prepare(`SELECT ${selectList(target)} FROM lifecycle_events ORDER BY seq ASC`)
      .all() as EventRow[];
    return rows.map(rowToEvent);
  } catch (err) {
    warnOnce(err);
    return [];
  }
}

/**
 * The NEWEST `limit` events, newest first, without materialising the table.
 *
 * `readLedger` deliberately returns everything in append order because
 * `projectCounters` is a fold over the whole history and cannot be computed
 * from a tail. A reader that only DISPLAYS recent activity — the CLI's
 * `ledger tail`, the admin journal — must not pay for that: an instance with
 * a long history would load every row on every poll.
 */
export function readLedgerTail(limit: number, db?: LedgerDb): LedgerEvent[] {
  const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit)));
  try {
    const target = db ?? handleFor(ledgerDbPath());
    const rows = target
      .prepare(`SELECT ${selectList(target)} FROM lifecycle_events ORDER BY seq DESC LIMIT ?`)
      .all(bounded) as EventRow[];
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
      case 'type-counter-compensation':
      case 'skill-counter-compensation': {
        // Clamped at zero: both stores floor their counters, so a projection
        // driven negative (possible when the compensated increments predate
        // the ledger and were never journaled) is a state no honest history
        // produces — and a negative residue would silently absorb that many
        // later phantom events on the same axis. On any fully-journaled
        // history projection <= store per axis, so the clamp can never
        // manufacture a false IMPOSSIBLE (adversarial review, 2026-08-21).
        c.successes = Math.max(
          0,
          c.successes + (typeof ev.detail?.['successes'] === 'number' ? ev.detail['successes'] : 0)
        );
        c.failures = Math.max(
          0,
          c.failures + (typeof ev.detail?.['failures'] === 'number' ? ev.detail['failures'] : 0)
        );
        break;
      }
      default:
        break;
    }
  }
  return map;
}
