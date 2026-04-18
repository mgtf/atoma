import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atom_types (
  tier          INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  ordinal       INTEGER NOT NULL,
  name          TEXT UNIQUE NOT NULL,
  description   TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json    TEXT NOT NULL DEFAULT '[]',
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
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

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
