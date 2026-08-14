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
