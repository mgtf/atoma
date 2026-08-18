import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { LEDGER_TABLE_DDL } from '../core/ledger.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atom_types (
  tier          INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  ordinal       INTEGER NOT NULL,
  -- Surrogate identity (T4) — see src/core/atomId.ts. Uniqueness is carried by
  -- idx_atom_types_atom_id below, which a UNIQUE column constraint could not
  -- express alongside the composite primary key.
  atom_id       TEXT NOT NULL,
  name          TEXT UNIQUE NOT NULL,
  description   TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  successes     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tier, ordinal)
);

CREATE TABLE IF NOT EXISTS atom_type_versions (
  tier          INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  modified_by   TEXT NOT NULL,
  modified_at   TEXT NOT NULL,
  reason        TEXT,
  PRIMARY KEY (tier, ordinal, version)
);

CREATE INDEX IF NOT EXISTS idx_atom_types_name ON atom_types(name);
CREATE INDEX IF NOT EXISTS idx_atom_types_tier ON atom_types(tier);
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
  db.exec(SCHEMA);
  // The lifecycle ledger is a table in this same file, so that an event and
  // the counter it records can share a transaction and so that an in-memory
  // registry cannot append to the real store. See src/core/ledger.ts.
  db.exec(LEDGER_TABLE_DDL);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_atom_types_atom_id ON atom_types(atom_id)');
  return db;
}
