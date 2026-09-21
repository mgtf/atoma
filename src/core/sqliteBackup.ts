import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Copy a live SQLite database through SQLite's online-backup API.
 *
 * Copying only the main `*.db` file is not a snapshot when the source uses
 * WAL: committed pages may still live solely in `*.db-wal`. Opening the
 * source read-only and asking SQLite to back it up sees one consistent
 * transaction boundary, includes those WAL pages, and never checkpoints or
 * writes the production store.
 *
 * ONE definition, shared by the compare harness (per-round treatment
 * snapshots) and the state-backup CLI — the WAL subtlety above is exactly
 * the kind of rule that drifts when copied.
 */
export async function snapshotSqliteStore(
  sourceDb: string,
  destinationDb: string
): Promise<void> {
  const source = resolve(sourceDb);
  const destination = resolve(destinationDb);
  if (source === destination) {
    throw new Error('sqlite snapshot destination must differ from the source store');
  }
  if (!existsSync(source)) {
    throw new Error(`sqlite snapshot source store does not exist: ${source}`);
  }
  if (existsSync(destination)) {
    throw new Error(`sqlite snapshot destination already exists: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });

  let sourceHandle: Database.Database | null = null;
  try {
    sourceHandle = new Database(source, { readonly: true, fileMustExist: true });
    await sourceHandle.backup(destination);
    settleJournal(destination);
  } catch (err) {
    // A failed online backup may leave a partial destination; remove it so
    // the helper is safe to retry and never leaves a plausible-looking
    // half-copy behind.
    rmSync(destination, { force: true });
    rmSync(destination + '-wal', { force: true });
    rmSync(destination + '-shm', { force: true });
    throw new Error(`could not snapshot sqlite store ${source}`, { cause: err });
  } finally {
    sourceHandle?.close();
  }
}

/**
 * Leave the snapshot in ROLLBACK mode, as ONE self-contained file.
 *
 * The online backup inherits the SOURCE's journal mode, and the product store
 * runs in WAL. SQLite then refuses `mode=ro` on the copy unless it can create
 * `-shm` beside it, which the offline reader cannot do on read-only media, and
 * which newer SQLite builds refuse outright on a read-only connection
 * (measured 2026-09-22: python 3.51.0 answers "unable to open database file"
 * for a WAL-flagged snapshot carried alone). Recovery carries store.db ALONE —
 * `scripts/restore-drill.py` copies that one file and opens it read-only — so a
 * WAL-flagged snapshot is a backup nobody can read. Switching the COPY to
 * DELETE checkpoints it and drops the sidecars; the source is untouched, and
 * the product re-enables WAL when it next opens the restored store.
 */
function settleJournal(destination: string): void {
  const snapshot = new Database(destination, { fileMustExist: true });
  try {
    snapshot.pragma('journal_mode = DELETE');
  } finally {
    snapshot.close();
  }
  rmSync(destination + '-wal', { force: true });
  rmSync(destination + '-shm', { force: true });
}
