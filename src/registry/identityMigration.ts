import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from './db.js';
import { STORE_METADATA_DDL } from './taxonomyMigration.js';

/**
 * Migrate skill namespaces from the atom NAME to the atom's surrogate id
 * (invariant T4) — the filesystem half of demoting a taxonomy name to a
 * display label.
 *
 * WHY THIS IS NOT PART OF `taxonomyMigration.ts`, WHICH DOES THE SAME CLASS
 * OF WORK. Three reasons, all measured on the live store rather than assumed:
 *
 *   1. It is version-gated on `TAXONOMY_VERSION`, and the live store already
 *      sits at that version — `planTaxonomyMigration` short-circuits to
 *      `alreadyCurrent` and would silently move nothing. Bumping that constant
 *      is not available either: `assertCurrentTaxonomy` then throws at every
 *      run start and points the operator at a command gated by the same
 *      counter. The two migrations are orthogonal and one integer cannot
 *      express both, so identity gets its OWN key.
 *   2. That harness rewrites system prompts, resets trust counters and bumps
 *      type versions. None of that may happen here: an atom's identity
 *      changing spelling is not a change to what the atom IS, so its prompts,
 *      its earned counters and its version must all be untouched.
 *   3. Its staging is not crash-safe (renames before the try opens; the DB
 *      transaction commits before the temp→final rename loop that sits outside
 *      it). This one is built the other way round — see below.
 *
 * THE SAFETY PROPERTY IS CONVERGENCE, NOT ROLLBACK. Both halves are
 * independently idempotent and the DB stamp is written LAST, so the operation
 * is re-runnable from any interruption rather than needing to be undone:
 *
 *   - Directories are renamed name→id. A re-run rebuilds the plan from the
 *     names still present on disk, so a directory already moved is simply not
 *     a source any more and is skipped.
 *   - Ledger entities are rewritten by prefix, `Water/x` → `<id>/x`. After one
 *     pass no entity carries the old prefix, so a second pass matches nothing.
 *   - The version stamp shares a transaction with the ledger rewrite and is
 *     the commit marker. A crash before it leaves a store that re-runs
 *     cleanly; a crash after it leaves a store that reports `alreadyCurrent`.
 *
 * No temp staging is needed because a swap is impossible: every source is a
 * taxonomy name and every target is a UUID, so no target can collide with a
 * source that has not moved yet.
 */

export const IDENTITY_METADATA_KEY = 'identity_version';

/** Bumped only when the identity SCHEME changes, never for a taxonomy rename. */
export const IDENTITY_VERSION = 1;

export interface NamespaceMove {
  readonly atomId: string;
  /** Display name the namespace is currently filed under. */
  readonly name: string;
  readonly fromPath: string;
  readonly toPath: string;
}

export interface LedgerRename {
  readonly name: string;
  readonly atomId: string;
}

export interface IdentityMigrationPlan {
  readonly alreadyCurrent: boolean;
  readonly namespaceMoves: readonly NamespaceMove[];
  /**
   * Prefix rewrites for the ledger, derived from the atom table and NOT from
   * `namespaceMoves`.
   *
   * That independence is load-bearing and was found by a test rather than by
   * reasoning. Deriving it from the filesystem meant that a crash between the
   * directory rename and the version stamp produced a re-plan with zero moves
   * — and therefore zero ledger rewrites — which then stamped the store as
   * migrated with its history still keyed by name. Every skill would have read
   * as counter drift forever. Keyed off the atom table, the rewrite converges
   * no matter what the filesystem already did.
   */
  readonly ledgerRenames: readonly LedgerRename[];
  /** Ledger rows whose `entity` carries an `<atom-name>/` prefix. */
  readonly ledgerRows: number;
  /**
   * Directories present in the skill store that match no live atom name and
   * no atom id. Reported, never touched: a namespace whose atom was removed
   * is still the operator's data.
   */
  readonly unmatchedNamespaces: readonly string[];
}

export interface IdentityMigrationResult {
  readonly movedNamespaces: number;
  readonly rewrittenLedgerRows: number;
}

interface AtomRow {
  atom_id: string | null;
  name: string;
}

export function identityVersion(db: DB): number | null {
  db.exec(STORE_METADATA_DDL);
  const row = db
    .prepare('SELECT value FROM store_metadata WHERE key = ?')
    .get(IDENTITY_METADATA_KEY) as { value: string } | undefined;
  if (!row) return null;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * A brand-new store is born on the current identity scheme; a populated
 * unversioned one is left for the explicit migration, exactly as the taxonomy
 * version does. Called from `openDb`, so it must stay cheap and total.
 */
export function initializeIdentityVersion(db: DB): void {
  db.exec(STORE_METADATA_DDL);
  if (identityVersion(db) !== null) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM atom_types').get() as { n: number };
  if (count.n === 0) {
    db.prepare('INSERT INTO store_metadata (key, value) VALUES (?, ?)').run(
      IDENTITY_METADATA_KEY,
      String(IDENTITY_VERSION)
    );
  }
}

function liveAtoms(db: DB): AtomRow[] {
  return db.prepare('SELECT atom_id, name FROM atom_types').all() as AtomRow[];
}

function directoriesIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => {
    try {
      return statSync(join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

export function planIdentityMigration(db: DB, skillsDir: string): IdentityMigrationPlan {
  const current = identityVersion(db);
  if (current !== null && current >= IDENTITY_VERSION) {
    return {
      alreadyCurrent: true,
      namespaceMoves: [],
      ledgerRenames: [],
      ledgerRows: 0,
      unmatchedNamespaces: [],
    };
  }

  const atoms = liveAtoms(db).filter((a): a is { atom_id: string; name: string } =>
    Boolean(a.atom_id)
  );
  const idByName = new Map(atoms.map((a) => [a.name, a.atom_id]));
  const knownIds = new Set(atoms.map((a) => a.atom_id));

  const root = resolve(skillsDir);
  const moves: NamespaceMove[] = [];
  const unmatched: string[] = [];
  for (const entry of directoriesIn(root)) {
    // Already an id: a previous interrupted run got this far. Not a source.
    if (knownIds.has(entry)) continue;
    const atomId = idByName.get(entry);
    if (!atomId) {
      unmatched.push(entry);
      continue;
    }
    moves.push({
      atomId,
      name: entry,
      fromPath: join(root, entry),
      toPath: join(root, atomId),
    });
  }

  // Derived from the ATOM TABLE, deliberately not from `moves` — see the
  // `ledgerRenames` docstring. Every live atom whose name still prefixes a
  // ledger entity needs rewriting, whether or not it owns a directory.
  const ledgerRenames: LedgerRename[] = atoms.map((a) => ({
    name: a.name,
    atomId: a.atom_id,
  }));

  // Count, don't fetch: a mature store carries thousands of rows and the plan
  // is printed by a dry run.
  const ledgerRows =
    ledgerRenames.length === 0
      ? 0
      : (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM lifecycle_events
               WHERE ${ledgerRenames.map(() => 'entity LIKE ?').join(' OR ')}`
            )
            .get(...ledgerRenames.map((r) => `${r.name}/%`)) as { n: number }
        ).n;

  return {
    alreadyCurrent: false,
    namespaceMoves: moves,
    ledgerRenames,
    ledgerRows,
    unmatchedNamespaces: unmatched,
  };
}

/**
 * Apply the plan. Filesystem first, then one transaction that rewrites the
 * ledger and stamps the version — see the module docstring for why that order
 * makes an interruption re-runnable instead of corrupting.
 */
export function applyIdentityMigration(
  db: DB,
  skillsDir: string,
  plan: IdentityMigrationPlan
): IdentityMigrationResult {
  if (plan.alreadyCurrent) return { movedNamespaces: 0, rewrittenLedgerRows: 0 };

  const root = resolve(skillsDir);
  mkdirSync(root, { recursive: true });

  let moved = 0;
  for (const move of plan.namespaceMoves) {
    // Re-checked at apply time rather than trusted from the plan: a target
    // that already exists means a concurrent or half-finished run, and
    // merging two namespaces silently is the one outcome worth refusing.
    if (existsSync(move.toPath)) {
      throw new Error(
        `identity migration: ${move.toPath} already exists — refusing to merge it with ${move.fromPath}`
      );
    }
    if (!existsSync(move.fromPath)) continue;
    renameSync(move.fromPath, move.toPath);
    moved++;
  }

  const rewritten = db.transaction(() => {
    let rows = 0;
    const update = db.prepare(
      `UPDATE lifecycle_events
          SET entity = ? || substr(entity, ?)
        WHERE entity LIKE ?`
    );
    for (const rename of plan.ledgerRenames) {
      const prefix = `${rename.name}/`;
      rows += update.run(`${rename.atomId}/`, prefix.length + 1, `${prefix}%`).changes;
    }
    db.prepare(
      `INSERT INTO store_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(IDENTITY_METADATA_KEY, String(IDENTITY_VERSION));
    return rows;
  })();

  return { movedNamespaces: moved, rewrittenLedgerRows: rewritten };
}
