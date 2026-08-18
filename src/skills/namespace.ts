import { existsSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { RunnerConfigError } from '../core/errors.js';
import { MOLECULES } from '../registry/taxonomies/molecules.js';

declare const brand: unique symbol;

/**
 * The key a skill namespace is filed under on disk.
 *
 * WHAT THIS IS FOR. The atom NAME is a display label (T4). `SkillRegistry`
 * keys directories by `atomId`. Both are `string`, so a production site
 * left passing a name would typecheck, run, and quietly file skills under
 * a namespace nothing else reads. This brand exists so the compiler
 * refuses that.
 *
 * WHERE THE BRAND APPLIES, AND WHERE IT DELIBERATELY DOES NOT. It types the
 * production CARRIERS — `ownerNs`, `activeSkillNs`, `blameNs`, `args.l1Name`
 * and friends — so nothing can put a bare `atom.name` into one. It is NOT on
 * `SkillRegistry`'s public parameters, and that is a deliberate limit rather
 * than an oversight:
 *
 *   - The store is genuinely KEY-AGNOSTIC. `namespaceDir` is
 *     `join(rootDir, sanitise(ns))`; it files skills under whatever key it is
 *     handed and reads them back from the same one. A namespace is not
 *     required to be an atom id for the store to be correct, and asserting
 *     that it is would over-constrain a component whose contract is "give me a
 *     key".
 *   - Consequently ~280 test call sites that pass `'Water'` as an arbitrary
 *     opaque key are CORRECT both before and after the flip. Branding the
 *     public API would have rewritten all of them to buy a guarantee about
 *     production code that the carrier typing already provides.
 *
 * WHAT ACTUALLY GUARDS THE FLIP is therefore not a type at the store boundary
 * but a behavioural test through the production path: create an atom, drive a
 * skill through the real lifecycle, and assert the directory on disk is the
 * atom's id. Unit tests that mint their own namespaces cannot catch a
 * production path still looking up by name — only exercising that path can.
 */
export type SkillNamespace = string & { readonly [brand]: 'SkillNamespace' };

/**
 * The namespace an atom's skills belong to — the ONE derivation.
 *
 * Takes the whole identity rather than one field so which field is load-bearing
 * stops being the caller's business. Callers already hold an atom or a registry
 * type, so this is not extra work for them; it is the choke point that makes
 * the name→id change a one-line edit here instead of a hunt.
 */
export function namespaceOf(atom: {
  readonly atomId: string;
  readonly name: string;
}): SkillNamespace {
  // Directories are keyed by atomId. A leftover name-keyed tree is
  // refused at launch / doctor (`assertCurrentIdentity`); there is no
  // migrate-identity command after the 2026-08-18 reset.
  return atom.atomId as SkillNamespace;
}

export interface SkillOwnerIdentity {
  readonly atomId: string;
  readonly name: string;
}

export interface LeftoverNameKeyedNamespace {
  readonly name: string;
  readonly atomId?: string;
}

/**
 * Read L1 identities from a store without writing (doctor / launch peek).
 *
 * A missing or unreadable file is an empty list — the curated molecule
 * pool still catches a leftover `skills/Water/` after a from-scratch
 * reset. Do not use `openDb` here: it creates and migrates.
 */
export function readSkillOwners(dbPath: string): readonly SkillOwnerIdentity[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT atom_id AS atomId, name FROM atom_types
           WHERE tier = 1 AND atom_id IS NOT NULL`
        )
        .all() as { atomId: string | null; name: string }[];
      const owners: SkillOwnerIdentity[] = [];
      for (const row of rows) {
        if (typeof row.atomId === 'string' && row.atomId.length > 0) {
          owners.push({ atomId: row.atomId, name: row.name });
        }
      }
      return owners;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Directories under the skill root that are still named as a molecule
 * (curated pool or a live L1 label) rather than as an atom id.
 *
 * Those trees are invisible to `loadFor(namespaceOf(atom))`. An unknown
 * orphan directory is left alone — `mergeInto` already leaves those, and
 * tests mint their own keys.
 */
export function leftoverNameKeyedNamespaces(
  skillRoot: string,
  atoms: readonly SkillOwnerIdentity[] = []
): readonly LeftoverNameKeyedNamespace[] {
  if (!existsSync(skillRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const allowed = new Set(atoms.map((atom) => atom.atomId));
  const forbidden = new Set(MOLECULES.map((molecule) => molecule.name));
  const atomIdByName = new Map<string, string>();
  for (const atom of atoms) {
    if (atom.name !== atom.atomId) forbidden.add(atom.name);
    atomIdByName.set(atom.name, atom.atomId);
  }
  for (const id of allowed) forbidden.delete(id);
  return entries
    .filter((name) => forbidden.has(name))
    .map((name) => {
      const atomId = atomIdByName.get(name);
      return atomId ? { name, atomId } : { name };
    });
}

export function formatSkillIdentityWarning(
  leftovers: readonly LeftoverNameKeyedNamespace[]
): string {
  const lines = leftovers.map((leftover) =>
    leftover.atomId
      ? `  skills/${leftover.name}/  (live atom "${leftover.name}" is filed at skills/${leftover.atomId}/)`
      : `  skills/${leftover.name}/  (curated molecule name; the loader looks under the atom id)`
  );
  return (
    'skill store still has name-keyed directories; they are invisible to the id-keyed loader:\n' +
    `${lines.join('\n')}\n` +
    'Archive or delete those directories. Do not rename them onto a new atom id — after the ' +
    "2026-08-18 reset that would attach another identity's recipes. Fresh skills belong under " +
    'skills/<atom-id>/.'
  );
}

/**
 * Refuse a leftover name-keyed skill tree at launch.
 *
 * There is no migrator: after the 2026-08-18 reset a leftover
 * `skills/Water/` belongs to a deleted identity, and moving it onto the
 * current Water uuid would attach another atom's recipes.
 */
export function assertCurrentIdentity(
  skillRoot: string,
  atoms: readonly SkillOwnerIdentity[] = []
): void {
  const leftovers = leftoverNameKeyedNamespaces(skillRoot, atoms);
  if (leftovers.length === 0) return;
  throw new RunnerConfigError(formatSkillIdentityWarning(leftovers));
}

/**
 * Re-admit a namespace that came OUT of the store (`listNamespaces`, the
 * visibility lattice, an operator CLI argument, an MCP request parameter).
 *
 * Values read back from the store are namespaces by construction — they were
 * written as one — so this is a widening, not a conversion. It is the only
 * sanctioned way to make a `SkillNamespace` without an atom, kept separate from
 * `namespaceOf` so that grepping this name lists every place that trusts a
 * string it did not derive itself.
 */
export function asStoredNamespace(raw: string): SkillNamespace {
  return raw as SkillNamespace;
}

/**
 * Admit an operator / MCP / viz argument that may be a display name or an
 * atom id, and return the stored namespace key.
 *
 * `idToName` is the atom-id → molecule-name map the operator surfaces
 * already load for display. If `raw` is an id in that map, or a name that
 * maps to one, we return the id. Otherwise the raw string — orphaned
 * directories and tests that mint their own keys stay addressable.
 */
export function resolveNamespaceKey(
  raw: string,
  idToName: ReadonlyMap<string, string>
): string {
  if (idToName.has(raw)) return raw;
  for (const [id, name] of idToName) {
    if (name === raw) return id;
  }
  return raw;
}
