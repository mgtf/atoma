import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { LEDGER_TABLE_DDL } from '../core/ledger.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atom_types (
  owner_key     TEXT NOT NULL DEFAULT 'operator',
  tier          INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  ordinal       INTEGER NOT NULL,
  -- Surrogate identity (T4) — see src/core/atomId.ts. Uniqueness is carried by
  -- idx_atom_types_atom_id below, which a UNIQUE column constraint could not
  -- express alongside the composite primary key.
  atom_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  successes     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_key, tier, ordinal),
  UNIQUE (owner_key, name)
);

CREATE TABLE IF NOT EXISTS atom_type_versions (
  owner_key     TEXT NOT NULL DEFAULT 'operator',
  tier          INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  modified_by   TEXT NOT NULL,
  modified_at   TEXT NOT NULL,
  reason        TEXT,
  PRIMARY KEY (owner_key, tier, ordinal, version)
);

CREATE INDEX IF NOT EXISTS idx_atom_types_name ON atom_types(owner_key, name);
CREATE INDEX IF NOT EXISTS idx_atom_types_tier ON atom_types(owner_key, tier);
`;

/**
 * Readonly look at whether a store file can accept the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a pre-T4 `atom_types` (no
 * `atom_id` column); the next statement (`CREATE UNIQUE INDEX ... atom_id`)
 * then throws. Doctor reports that before `startTask` hits it. A missing
 * file is compatible — `openDb` will create the current schema.
 */
export type AtomStoreSchema = 'missing' | 'compatible' | 'pre-t4' | 'unreadable';

export function inspectAtomStoreSchema(path: string): AtomStoreSchema {
  if (!existsSync(path)) return 'missing';
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const cols = db.prepare('PRAGMA table_info(atom_types)').all() as { name: string }[];
      if (cols.length === 0) return 'compatible';
      return cols.some((col) => col.name === 'atom_id') ? 'compatible' : 'pre-t4';
    } finally {
      db.close();
    }
  } catch {
    return 'unreadable';
  }
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    migrateRegistryOwnership(db);
    db.exec(SCHEMA);
    // The lifecycle ledger is a table in this same file, so that an event and
    // the counter it records can share a transaction and so that an in-memory
    // registry cannot append to the real store. See src/core/ledger.ts.
    db.exec(LEDGER_TABLE_DDL);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_atom_types_atom_id ON atom_types(atom_id)');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Read-only operator readers also support a pre-ownership archive; never widen a project read. */
export function operatorRegistryPredicate(db: DB): string {
  const columns = db.prepare('PRAGMA table_info(atom_types)').all() as { name: string }[];
  return columns.some(column => column.name === 'owner_key') ? "owner_key = 'operator'" : '1';
}

/** Keep every old identity private to the operator; no inference from model-authored provenance. */
function migrateRegistryOwnership(db: DB): void {
  const columns = db.prepare('PRAGMA table_info(atom_types)').all() as { name: string }[];
  if (!columns.length || columns.some(column => column.name === 'owner_key')) return;
  if (!columns.some(column => column.name === 'atom_id')) throw new Error('registry requires the atom_id migration first');
  // VACUUM INTO includes committed WAL pages and every product table. It must
  // succeed before the transaction touches the schema. Identities, skills,
  // ledger rows, traces and disposable caches are not renamed or rewritten.
  if (db.name !== ':memory:' && db.name !== '') {
    const backup = `${db.name}.before-registry-ownership-${randomUUID()}.db`;
    writeFileSync(backup, '', { flag: 'wx', mode: 0o600 });
    db.prepare('VACUUM INTO ?').run(backup);
  }
  db.transaction(() => {
    // Another host handle may have completed the migration while we backed up.
    if (operatorRegistryPredicate(db) !== '1') return;
    db.exec(`ALTER TABLE atom_types RENAME TO atom_types_before_ownership;
      ALTER TABLE atom_type_versions RENAME TO atom_versions_before_ownership;
      DROP INDEX IF EXISTS idx_atom_types_name;
      DROP INDEX IF EXISTS idx_atom_types_tier;
      DROP INDEX IF EXISTS idx_atom_types_atom_id;`);
    db.exec(SCHEMA);
    const copy = (table: string, source: string): void => {
      const names = (db.prepare(`PRAGMA table_info(${source})`).all() as { name: string }[])
        .map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ');
      db.exec(`INSERT INTO ${table} (${names}) SELECT ${names} FROM ${source}`);
    };
    copy('atom_types', 'atom_types_before_ownership');
    copy('atom_type_versions', 'atom_versions_before_ownership');
    db.exec('DROP TABLE atom_types_before_ownership; DROP TABLE atom_versions_before_ownership');
    db.exec('CREATE UNIQUE INDEX idx_atom_types_atom_id ON atom_types(atom_id)');
  }).immediate();
}
