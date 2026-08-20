import Database from 'better-sqlite3';

/**
 * WHERE THIS ATOMA INSTANCE KEEPS ITS STATE.
 * ==========================================
 *
 * ONE rule, in ONE place, because there used to be four copies of it and they
 * had already drifted — four call sites each with their own probe for a
 * second store file, no two written the same way, one of them (the viz)
 * serving both as separate stores in the UI. Same lesson as `usedOrdinals`,
 * where `create` and `branch` each held a copy of the name-allocation rule
 * and the copies disagreeing WAS the bug.
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

/** Learned recipe bodies. Still filesystem-backed — see AGENTS.md for why. */
export const DEFAULT_SKILLS_DIR = './skills';

/**
 * Resolve the product store path: explicit flag → `ATOMA_DB_PATH` → default.
 * Callers that already own an environment snapshot can supply it explicitly;
 * the default preserves the process-global operator path for existing CLIs.
 */
export function storeDbPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicit) return explicit;
  const configured = env['ATOMA_DB_PATH'];
  if (configured) return configured;
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
