import Database from 'better-sqlite3';
import { importLegacyLedger, LEDGER_TABLE_DDL } from '../core/ledger.js';
import { newAtomId } from './atomId.js';
import {
  initializeTaxonomyVersion,
  STORE_METADATA_DDL,
} from './taxonomyMigration.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atom_types (
  tier          INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  ordinal       INTEGER NOT NULL,
  -- Surrogate identity (T4). Declared nullable so that a fresh table and a
  -- back-filled legacy one carry the SAME column definition; presence is
  -- guaranteed by every writer supplying one and by backfillAtomIds closing
  -- any gap on open, and uniqueness by idx_atom_types_atom_id below.
  atom_id       TEXT,
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
 * Give every pre-existing row a surrogate id (T4).
 *
 * The column is added NULLABLE because SQLite cannot add a NOT NULL column to
 * a populated table without a default, and a shared constant default would
 * defeat uniqueness. So the shape is: add nullable, fill each row with its own
 * id, then let a UNIQUE index carry the constraint. Runs inside one
 * transaction, and costs one indexed lookup returning nothing once the store
 * has been through it.
 */
function backfillAtomIds(db: DB): void {
  const pending = db
    .prepare('SELECT tier, ordinal FROM atom_types WHERE atom_id IS NULL')
    .all() as { tier: number; ordinal: number }[];
  if (pending.length === 0) return;
  const update = db.prepare('UPDATE atom_types SET atom_id = ? WHERE tier = ? AND ordinal = ?');
  db.transaction(() => {
    for (const row of pending) update.run(newAtomId(), row.tier, row.ordinal);
  })();
}

function addColumnIfMissing(db: DB, table: string, column: string, ddl: string): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
  db.exec(STORE_METADATA_DDL);
  // Forward migration for DBs that predate the counter columns. Safe to run
  // every open: no-op when the columns are already present.
  addColumnIfMissing(db, 'atom_types', 'successes', 'successes INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'atom_types', 'failures', 'failures INTEGER NOT NULL DEFAULT 0');
  // Surrogate identity (T4). Nullable column + backfill + UNIQUE index; see
  // backfillAtomIds for why it cannot be declared NOT NULL in one step.
  addColumnIfMissing(db, 'atom_types', 'atom_id', 'atom_id TEXT');
  backfillAtomIds(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_atom_types_atom_id ON atom_types(atom_id)');
  // Carry a pre-consolidation atoma-ledger.jsonl across, once, if one sits
  // next to this file and the table is still empty. No-op for `:memory:`.
  importLegacyLedger(db, path);
  initializeTaxonomyVersion(db);
  return db;
}
