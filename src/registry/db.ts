import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { LEDGER_TABLE_DDL } from '../core/ledger.js';

export type DB = Database.Database;

/**
 * ONE registry for the whole platform. A run is a run: the operator's, an
 * organisation's, anyone's — they all read the same rows and earn trust on
 * the same counters (decision 2026-09-15, `docs/platform-trust-2026-09-15.md`).
 * The per-owner partition of 2026-09-09 is folded back by
 * `migrateRegistryToPlatform` below.
 */
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

-- Identities the platform fold ABSORBED into a same-name row. Skill
-- namespaces are keyed by atom id, so this is what lets the skills catalog
-- move the absorbed identity's recipes under the kept one (see
-- src/skills/migratePlatform.ts). Append-only evidence, never consulted by
-- the registry itself.
CREATE TABLE IF NOT EXISTS atom_id_merges (
  absorbed_atom_id TEXT PRIMARY KEY,
  kept_atom_id     TEXT NOT NULL,
  absorbed_name    TEXT NOT NULL,
  absorbed_owner   TEXT NOT NULL,
  merged_at        TEXT NOT NULL
);
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
    migrateRegistryToPlatform(db);
    db.exec(SCHEMA);
    // The lifecycle ledger is a table in this same file, so that an event and
    // the counter it records can share a transaction and so that an in-memory
    // registry cannot append to the real store. See src/core/ledger.ts.
    db.exec(LEDGER_TABLE_DDL);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_atom_types_atom_id ON atom_types(atom_id)');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Whether a store still carries the 2026-09-09 per-owner partition. */
export function registryIsPartitioned(db: DB): boolean {
  const columns = db.prepare('PRAGMA table_info(atom_types)').all() as { name: string }[];
  return columns.some((column) => column.name === 'owner_key');
}

interface OwnedTypeRow {
  owner_key: string; tier: number; ordinal: number; atom_id: string; name: string;
  description: string; system_prompt: string; tools_json: string; params_json: string;
  created_by: string; created_at: string; version: number; successes: number; failures: number;
}

/**
 * Fold the per-owner partition back into one platform registry.
 *
 * Operator rows are copied as they are. Every project row then joins the
 * commons, in creation order:
 *   - a row whose (tier, name) already exists is ABSORBED: its successes and
 *     failures are added to the kept row (a run is a run — the trust it earned
 *     counts), its history is left to the backup, and the identity mapping is
 *     recorded in `atom_id_merges` so the skills catalog can follow;
 *   - any other row is kept whole, identity, prompt, history and counters,
 *     taking a fresh ordinal when its own collides and a `-<n>` suffix when
 *     its name is held by another tier.
 * The whole file is backed up first (`VACUUM INTO`, committed WAL pages
 * included) and the fold is one immediate transaction: a failure leaves the
 * partitioned store untouched beside its backup.
 */
function migrateRegistryToPlatform(db: DB): void {
  if (!registryIsPartitioned(db)) return;
  if (db.name !== ':memory:' && db.name !== '') {
    const backup = `${db.name}.before-platform-registry-${randomUUID()}.db`;
    writeFileSync(backup, '', { flag: 'wx', mode: 0o600 });
    db.prepare('VACUUM INTO ?').run(backup);
  }
  db.transaction(() => {
    // Another host handle may have completed the fold while we backed up.
    if (!registryIsPartitioned(db)) return;
    db.exec(`ALTER TABLE atom_types RENAME TO atom_types_partitioned;
      ALTER TABLE atom_type_versions RENAME TO atom_versions_partitioned;
      DROP INDEX IF EXISTS idx_atom_types_name;
      DROP INDEX IF EXISTS idx_atom_types_tier;
      DROP INDEX IF EXISTS idx_atom_types_atom_id;`);
    db.exec(SCHEMA);
    const insertType = db.prepare(`INSERT INTO atom_types
      (tier, ordinal, atom_id, name, description, system_prompt, tools_json, params_json, created_by, created_at, version, successes, failures)
      VALUES (@tier, @ordinal, @atom_id, @name, @description, @system_prompt, @tools_json, @params_json, @created_by, @created_at, @version, @successes, @failures)`);
    const copyVersions = db.prepare(`INSERT INTO atom_type_versions
      (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
      SELECT ?, ?, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason
      FROM atom_versions_partitioned WHERE owner_key = ? AND tier = ? AND ordinal = ?`);
    const rows = db.prepare(`SELECT * FROM atom_types_partitioned
      ORDER BY CASE WHEN owner_key = 'operator' THEN 0 ELSE 1 END, created_at ASC, atom_id ASC`).all() as OwnedTypeRow[];
    const byTierName = new Map<string, OwnedTypeRow>();
    const takenNames = new Set<string>();
    const usedOrdinals = new Map<number, Set<number>>();
    for (const tier of [1, 2, 3]) {
      const used = (db.prepare(`SELECT DISTINCT ordinal FROM atom_versions_partitioned WHERE owner_key = 'operator' AND tier = ?`).all(tier) as { ordinal: number }[])
        .map((row) => row.ordinal);
      usedOrdinals.set(tier, new Set(used));
    }
    const mergedAt = new Date().toISOString();
    const recordMerge = db.prepare(`INSERT INTO atom_id_merges (absorbed_atom_id, kept_atom_id, absorbed_name, absorbed_owner, merged_at)
      VALUES (?, ?, ?, ?, ?)`);
    const absorb = db.prepare('UPDATE atom_types SET successes = successes + ?, failures = failures + ? WHERE atom_id = ?');
    for (const row of rows) {
      const kept = byTierName.get(`${row.tier}:${row.name}`);
      if (kept) {
        absorb.run(row.successes, row.failures, kept.atom_id);
        kept.successes += row.successes; kept.failures += row.failures;
        recordMerge.run(row.atom_id, kept.atom_id, row.name, row.owner_key, mergedAt);
        continue;
      }
      const ordinals = usedOrdinals.get(row.tier)!;
      let ordinal = row.ordinal;
      if (row.owner_key !== 'operator' && ordinals.has(ordinal)) ordinal = Math.max(0, ...ordinals) + 1;
      let name = row.name;
      for (let n = 2; takenNames.has(name); n++) name = `${row.name}-${n}`;
      const platformRow = { ...row, ordinal, name };
      insertType.run({ tier: row.tier, ordinal, atom_id: row.atom_id, name, description: row.description,
        system_prompt: row.system_prompt, tools_json: row.tools_json, params_json: row.params_json,
        created_by: row.created_by, created_at: row.created_at, version: row.version,
        successes: row.successes, failures: row.failures });
      copyVersions.run(row.tier, ordinal, row.owner_key, row.tier, row.ordinal);
      ordinals.add(ordinal); takenNames.add(name);
      byTierName.set(`${row.tier}:${row.name}`, platformRow);
    }
    db.exec('DROP TABLE atom_types_partitioned; DROP TABLE atom_versions_partitioned');
    db.exec('CREATE UNIQUE INDEX idx_atom_types_atom_id ON atom_types(atom_id)');
  }).immediate();
}
