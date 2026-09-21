import type Database from 'better-sqlite3';
import type { SkillMeta, SkillProvenance } from './types.js';

/**
 * WHERE SKILL TRUST LIVES (W4, 2026-09-18): one row per recipe in the
 * product store, in the SAME file as `lifecycle_events`.
 *
 * Until now every counter, stamp and match tally sat in a `_meta.json`
 * sidecar beside the body, mutated by whole-file read/modify/write. Two
 * writers on one sidecar — a run child and the viz server's MCP write tools,
 * or two run children — were a lost update with no error anywhere, and the
 * run lease never covered the platform-tier skill tools (T6 deviation (a),
 * docs/saas-architecture.md). A row in the store closes that the way the
 * atom counters were closed: the mutation is ONE statement inside ONE
 * `.immediate()` transaction, and the lifecycle event that records it is
 * inserted in the same transaction, so `ledger check` compares a store and a
 * ledger that cannot disagree by a crash between two writes.
 *
 * The BODY stays on disk (`SKILL.md`, `_fallback.md`, `_demoted-script.md`,
 * `_namespace.json`): it is human-authored, diffable text and the reasons for
 * keeping it that way are unchanged. What moved is exactly the runtime state
 * that was never meant to be hand-edited.
 *
 * Keyed by `(namespace, skill_id)` and nothing else: one store pairs with one
 * catalog root, the pairing `ledger check --skills-dir` has always carried.
 * A restored store therefore brings its counters wherever the bodies are
 * unpacked, which the sidecars could not promise.
 *
 * The legacy sidecar is IMPORTED once, on the first mutation of its recipe or
 * by `reconcilePlatformSkills`, then renamed to `_meta.imported.json` so it
 * stays readable as evidence and can never be imported twice. A reader that
 * finds no row and an unimported sidecar reads the sidecar — that is a store
 * nobody has written since the move, and the sidecar is still the truth.
 */

export const SKILL_META_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS skill_meta (
  namespace                    TEXT    NOT NULL,
  skill_id                     TEXT    NOT NULL,
  successes                    INTEGER NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures                     INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  updated_at                   TEXT    NOT NULL,
  promotion_refused_at         TEXT,
  promotion_refused_reason     TEXT,
  promotion_refused_generation TEXT,
  compiled_generation          TEXT,
  -- JSON: SkillProvenance
  provenance                   TEXT,
  direct_failures              INTEGER NOT NULL DEFAULT 0 CHECK (direct_failures >= 0),
  matches                      INTEGER NOT NULL DEFAULT 0 CHECK (matches >= 0),
  last_matched_at              TEXT,
  -- JSON: string[]
  declared_writes              TEXT,
  PRIMARY KEY (namespace, skill_id)
);
`;

/** Sidecar name after import: still evidence, never a source again. */
export const IMPORTED_META_FILENAME = '_meta.imported.json';

export function ensureSkillMetaSchema(db: Database.Database): void {
  db.exec(SKILL_META_TABLE_DDL);
}

export function skillMetaTableExists(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_meta'`).get() !== undefined;
}

interface Row {
  namespace: string;
  skill_id: string;
  successes: number;
  failures: number;
  updated_at: string;
  promotion_refused_at: string | null;
  promotion_refused_reason: string | null;
  promotion_refused_generation: string | null;
  compiled_generation: string | null;
  provenance: string | null;
  direct_failures: number;
  matches: number;
  last_matched_at: string | null;
  declared_writes: string | null;
}

const COLUMNS =
  'namespace, skill_id, successes, failures, updated_at, promotion_refused_at, promotion_refused_reason, ' +
  'promotion_refused_generation, compiled_generation, provenance, direct_failures, matches, last_matched_at, declared_writes';

function parseProvenance(text: string | null): SkillProvenance | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      ['distilled', 'revised', 'compiled', 'hand-authored'].includes(String((parsed as Record<string, unknown>)['mechanism']))
    ) {
      return parsed as SkillProvenance;
    }
  } catch {
    /* a provenance blob that will not parse must not hide the counters */
  }
  return undefined;
}

function parseDeclaredWrites(text: string | null): readonly string[] | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((w): w is string => typeof w === 'string' && w.length > 0)) {
      return parsed;
    }
  } catch {
    /* same rule as provenance */
  }
  return undefined;
}

/** The row as the `SkillMeta` the rest of the subsystem has always consumed. */
export function rowToMeta(row: Row): SkillMeta {
  const provenance = parseProvenance(row.provenance);
  const declaredWrites = parseDeclaredWrites(row.declared_writes);
  // The reason and generation are meaningless without their stamp — the same
  // rule the sidecar reader applied to a hand-edited file.
  const stamped = row.promotion_refused_at ? row.promotion_refused_at : undefined;
  return {
    successes: row.successes,
    failures: row.failures,
    updatedAt: row.updated_at,
    ...(stamped ? { promotionRefusedAt: stamped } : {}),
    ...(stamped && row.promotion_refused_reason ? { promotionRefusedReason: row.promotion_refused_reason } : {}),
    ...(stamped && row.promotion_refused_generation ? { promotionRefusedGeneration: row.promotion_refused_generation } : {}),
    ...(row.compiled_generation ? { compiledGeneration: row.compiled_generation } : {}),
    ...(provenance ? { provenance } : {}),
    ...(row.direct_failures > 0 ? { directFailures: row.direct_failures } : {}),
    ...(row.matches > 0 ? { matches: row.matches } : {}),
    ...(row.last_matched_at ? { lastMatchedAt: row.last_matched_at } : {}),
    ...(declaredWrites ? { declaredWrites } : {}),
  };
}

export function readMetaRow(db: Database.Database, namespace: string, skillId: string): SkillMeta | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM skill_meta WHERE namespace = ? AND skill_id = ?`)
    .get(namespace, skillId) as Row | undefined;
  return row ? rowToMeta(row) : null;
}

/** Every recipe of one namespace, in one read. */
export function readMetaRows(db: Database.Database, namespace: string): Map<string, SkillMeta> {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM skill_meta WHERE namespace = ?`).all(namespace) as Row[];
  return new Map(rows.map((row) => [row.skill_id, rowToMeta(row)]));
}

/**
 * Replace the whole row. ONE statement; callers run it inside the
 * `.immediate()` transaction that also inserts the lifecycle event, so the
 * read that computed `meta` and this write cannot interleave with another
 * writer's.
 */
export function writeMetaRow(db: Database.Database, namespace: string, skillId: string, meta: SkillMeta): void {
  db.prepare(
    `INSERT INTO skill_meta (${COLUMNS})
     VALUES (@namespace, @skill_id, @successes, @failures, @updated_at, @promotion_refused_at, @promotion_refused_reason,
             @promotion_refused_generation, @compiled_generation, @provenance, @direct_failures, @matches, @last_matched_at, @declared_writes)
     ON CONFLICT (namespace, skill_id) DO UPDATE SET
       successes = excluded.successes, failures = excluded.failures, updated_at = excluded.updated_at,
       promotion_refused_at = excluded.promotion_refused_at, promotion_refused_reason = excluded.promotion_refused_reason,
       promotion_refused_generation = excluded.promotion_refused_generation, compiled_generation = excluded.compiled_generation,
       provenance = excluded.provenance, direct_failures = excluded.direct_failures, matches = excluded.matches,
       last_matched_at = excluded.last_matched_at, declared_writes = excluded.declared_writes`
  ).run({
    namespace,
    skill_id: skillId,
    successes: meta.successes,
    failures: meta.failures,
    updated_at: meta.updatedAt,
    promotion_refused_at: meta.promotionRefusedAt ?? null,
    promotion_refused_reason: meta.promotionRefusedAt ? meta.promotionRefusedReason ?? null : null,
    promotion_refused_generation: meta.promotionRefusedAt ? meta.promotionRefusedGeneration ?? null : null,
    compiled_generation: meta.compiledGeneration ?? null,
    provenance: meta.provenance ? JSON.stringify(meta.provenance) : null,
    direct_failures: meta.directFailures ?? 0,
    matches: meta.matches ?? 0,
    last_matched_at: meta.lastMatchedAt ?? null,
    declared_writes: meta.declaredWrites && meta.declaredWrites.length > 0 ? JSON.stringify(meta.declaredWrites) : null,
  });
}

/**
 * The counter bump as ONE statement with the increment computed by SQLite:
 * `successes = successes + 1`, never `successes = <value read a moment ago>`.
 * Returns false when there is no row to bump — the caller seeds first.
 */
export function bumpMetaRow(
  db: Database.Database,
  namespace: string,
  skillId: string,
  kind: 'success' | 'failure',
  at: string
): boolean {
  const info = db
    .prepare(
      `UPDATE skill_meta SET successes = successes + ?, failures = failures + ?, updated_at = ?
       WHERE namespace = ? AND skill_id = ?`
    )
    .run(kind === 'success' ? 1 : 0, kind === 'failure' ? 1 : 0, at, namespace, skillId);
  return info.changes === 1;
}

export function deleteMetaRow(db: Database.Database, namespace: string, skillId: string): boolean {
  return db.prepare(`DELETE FROM skill_meta WHERE namespace = ? AND skill_id = ?`).run(namespace, skillId).changes === 1;
}

export function deleteNamespaceRows(db: Database.Database, namespace: string): number {
  return db.prepare(`DELETE FROM skill_meta WHERE namespace = ?`).run(namespace).changes;
}
