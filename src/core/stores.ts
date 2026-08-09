import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

/**
 * WHERE THIS ATOMA INSTANCE KEEPS ITS STATE.
 * ==========================================
 *
 * ONE rule, in ONE place, because there used to be four copies of it and they
 * had already drifted. `run:build` wrote to `ATOMA_BUILD_DB_PATH` /
 * `./atoma-build.db` while every CLI defaulted to `ATOMA_DB_PATH` /
 * `./atoma.db`, so four call sites had each grown their own
 * `existsSync('./atoma-build.db') ? … : …` probe to paper over the mismatch —
 * `src/cli/registry.ts`, `src/cli/skills.ts`, `src/cli/ledger.ts` and
 * `src/viz/server.ts`, no two written the same way, one of them (the viz)
 * serving BOTH files as separate stores in the UI. Same lesson as
 * `usedOrdinals`, where `create` and `branch` each held a copy of the
 * name-allocation rule and the copies disagreeing WAS the bug.
 *
 * WHY ONE DATABASE AND NOT ONE PER FAMILY. The split existed to keep two task
 * families apart — build-app and research-brief. `research-brief.ts` was
 * deleted when the runner became generic (`src/run/`), and its store has sat
 * at 0 rows ever since, so the split has been paying its costs while
 * separating nothing. It was also the wrong axis: atom types and skills are
 * deliberately CROSS-FAMILY assets (`resolveCreationDescription` strips task
 * themes from descriptions precisely so a type earns reuse outside the task
 * that spawned it), so partitioning the registry by family fights the one
 * property the catalog exists to have. A second store becomes justified when
 * two instances must not see each other's trust counters — which is tenancy,
 * and tenancy is a deployment concern (see docs/saas-architecture.md), not a
 * task family.
 */

/** The store. Trust counters, version history and the lifecycle ledger. */
export const DEFAULT_DB_PATH = './atoma.db';

/** Learned recipe bodies. Still filesystem-backed — see CLAUDE.md for why. */
export const DEFAULT_SKILLS_DIR = './skills';

/**
 * Pre-consolidation store name. Read ONLY as a migration ramp (below), never
 * as a second store.
 */
const LEGACY_DB_PATH = './atoma-build.db';

/** Pre-consolidation env var, honoured so an exported shell keeps working. */
const LEGACY_DB_ENV = 'ATOMA_BUILD_DB_PATH';

/**
 * Does this path hold a store with atom types in it?
 *
 * Answered by opening it, because the alternative is guessing. The migration
 * ramp has to distinguish "the new store does not exist yet" from "the new
 * store exists and is empty", and only the file itself knows which.
 * Deliberately total: an unreadable file, a non-SQLite file, or one without
 * the table is "not populated", never an exception — a path resolver that
 * throws would take down every CLI on a corrupt sibling.
 */
function hasAtomTypes(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    // `readonly` matters: resolving a path must not create files, flip
    // journal_mode, or drop -wal/-shm next to a store nobody asked to open.
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM atom_types').get() as { n: number };
      return row.n > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Resolve the store path: explicit flag → `ATOMA_DB_PATH` → legacy → default.
 *
 * THE LEGACY BRANCH IS A RAMP, NOT A FALLBACK. The failure it prevents is the
 * expensive one: the store is gitignored runtime state holding counters
 * earned over months (`Methane` at 133✓, `Water` at 36✓), so quietly opening
 * a fresh `./atoma.db` beside a populated `./atoma-build.db` would destroy
 * the trained state while presenting as a working system — no error, no
 * missing file, just an agent that has forgotten everything and starts
 * re-learning.
 *
 * IT FIRES ON EMPTY, NOT MERELY ON ABSENT, and the first version got that
 * wrong. `./atoma.db` already existed on the developer's machine holding zero
 * rows — created by any bare `npm run registry -- list`, whose default was
 * already `./atoma.db` while every run wrote `./atoma-build.db` — so an
 * absence test never fired and the resolver picked the empty store. Found by
 * `tests/run-profile-build.test.ts` failing with "no Neuron in the build
 * store", which is the silent-loss scenario arriving on the one path that
 * still checks. Note the shape: the accident that creates the empty file is
 * the SAME mismatch this module exists to remove, so it is the normal state,
 * not an edge case.
 *
 * Renaming the file retires the branch; `legacyStoreNotice` says so out loud
 * so it does not silently become permanent.
 */
export function storeDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env['ATOMA_DB_PATH'] ?? process.env[LEGACY_DB_ENV];
  if (env) return env;
  if (!hasAtomTypes(DEFAULT_DB_PATH) && hasAtomTypes(LEGACY_DB_PATH)) return LEGACY_DB_PATH;
  return DEFAULT_DB_PATH;
}

/** Resolve the skills root: explicit flag → `ATOMA_SKILLS_DIR` → default. */
export function skillsDirPath(explicit?: string): string {
  return explicit ?? process.env['ATOMA_SKILLS_DIR'] ?? DEFAULT_SKILLS_DIR;
}

/**
 * Lazily-opened store handles for callers that hold no registry of their own
 * — the skill choke points' ledger appends and the prefilter decision cache.
 *
 * Caching matters: both append on hot paths (every counter bump, every
 * prefilter call), and a connection per operation would turn a burst into a
 * burst of file opens. WAL makes several handles on one file safe, including
 * alongside the handle `openDb` gave the registry.
 *
 * DDL IS PER (HANDLE, TABLE), not per open. Two subsystems now share one
 * file, so a handle created by the first must not leave the second's table
 * missing — and re-running `CREATE TABLE IF NOT EXISTS` on every cache read
 * would be a needless statement on the hottest path.
 */
const handles = new Map<string, { db: Database.Database; applied: Set<string> }>();

export function openStoreHandle(path: string, ddl: string): Database.Database {
  let h = handles.get(path);
  if (!h) {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    h = { db, applied: new Set() };
    handles.set(path, h);
  }
  if (!h.applied.has(ddl)) {
    h.db.exec(ddl);
    h.applied.add(ddl);
  }
  return h.db;
}

/** Drop cached handles. For tests that repoint a store path mid-suite. */
export function closeStoreHandles(): void {
  for (const h of handles.values()) {
    try {
      h.db.close();
    } catch {
      /* already closed */
    }
  }
  handles.clear();
}

/**
 * One line naming the rename, or null when there is nothing to say.
 *
 * Printed rather than performed: renaming a live SQLite file means moving its
 * `-wal` and `-shm` siblings too, and a viz server may hold it open readonly
 * at that moment. The operator does it once, deliberately, with nothing
 * running — the same reason `registry rollback` restores content rather than
 * rewriting history.
 */
export function legacyStoreNotice(resolved: string): string | null {
  if (resolved !== LEGACY_DB_PATH) return null;
  return (
    `[store] using the pre-consolidation ${LEGACY_DB_PATH}; there is one store now. ` +
    `Stop every atoma process and run:  mv atoma-build.db atoma.db  ` +
    `(also move atoma-build.db-wal / -shm if present).`
  );
}
