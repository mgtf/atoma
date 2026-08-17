import type { DB } from './db.js';
import { appendLedger } from '../core/ledger.js';
import type {
  AtomModifications,
  GenerationParams,
  Tier,
  Tool,
} from '../core/types.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { newAtomId } from '../core/atomId.js';
import { nextAvailableMolecule } from './taxonomies/molecules.js';
import { nextAvailableCell } from './taxonomies/cells.js';
import { nextAvailableTissue } from './taxonomies/tissues.js';

/**
 * Is this string safe to use as an atom NAME?
 *
 * Atom names are path components (the skill store namespaces by them), so
 * the answer is not "is it pretty" but "can it escape a directory". Rejects
 * anything outside [A-Za-z0-9._-], plus the all-dots strings (`.`, `..`)
 * that pass a charset test and still traverse. Exported so the same rule can
 * be asserted from tests.
 */
export function isSafeAtomName(s: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) && !/^\.+$/.test(s);
}

export interface AtomType {
  /**
   * Surrogate identity (T4). Stable for the life of the type: patch,
   * rollback and counter bumps never change it, and it is never reissued.
   * `name` beside it is a DISPLAY LABEL — see src/core/atomId.ts for why the
   * two are being separated and what the name's triple duty already cost.
   */
  readonly atomId: string;
  readonly tier: Tier;
  readonly ordinal: number;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly params: GenerationParams;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly version: number;
  /** Cumulative count of approved final results produced by this type. */
  readonly successes: number;
  /** Cumulative count of escalations that ended this type's supervision loop. */
  readonly failures: number;
}

/**
 * One archived row of `atom_type_versions` — the content a version had
 * when a later patch superseded it. Consumed by the registry CLI's
 * `history` / `rollback` commands. NOTE: `description` is not versioned.
 */
export interface AtomVersionRow {
  readonly version: number;
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly params: GenerationParams;
  readonly modifiedBy: string;
  readonly modifiedAt: string;
  readonly reason?: string;
}

export interface CreateSeed {
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly params: GenerationParams;
  readonly createdBy: string;
}

interface Row {
  tier: number;
  ordinal: number;
  atom_id: string | null;
  name: string;
  description: string;
  system_prompt: string;
  tools_json: string;
  params_json: string;
  created_by: string;
  created_at: string;
  version: number;
  successes: number;
  failures: number;
}

function rowToType(row: Row): AtomType {
  return {
    // Non-null in practice: every writer supplies one and `openDb` back-fills
    // any legacy gap before a read can reach here. The fallback keeps a
    // hand-edited or mid-migration store readable instead of throwing.
    atomId: row.atom_id ?? '',
    tier: row.tier as Tier,
    ordinal: row.ordinal,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    tools: JSON.parse(row.tools_json) as Tool[],
    params: JSON.parse(row.params_json) as GenerationParams,
    createdBy: row.created_by,
    createdAt: row.created_at,
    version: row.version,
    successes: row.successes ?? 0,
    failures: row.failures ?? 0,
  };
}

function nextAvailable(tier: Tier, used: Set<number>): { ordinal: number; name: string } {
  switch (tier) {
    case 1:
      return nextAvailableMolecule(used);
    case 2:
      return nextAvailableCell(used);
    case 3:
      return nextAvailableTissue(used);
  }
}

/**
 * Normalize an atom type name for semantic collision detection.
 * Lowercases, strips all non-alphanumeric characters (spaces, hyphens,
 * underscores, dots) so that `Minesweeper-WebGL`, `WebGLMinesweeper`,
 * `minesweeper_webgl` and `Minesweeper WebGL` all collapse to the same
 * key. Names that map to the same key would confuse the prefilter and
 * inflate the catalogue — we use this to reject or suffix such duplicates
 * at `branch` time.
 *
 * Note: order-sensitive by design. `MinesweeperWebGL` and `WebGLMinesweeper`
 * differ in word order and will NOT collide — matching that would require
 * a full bag-of-tokens pass which is too aggressive for a collision check.
 * This is a pragmatic middle ground: catch the trivially-equivalent casings
 * + punctuation variants that accumulate in practice, let genuinely
 * different names through.
 */
export function normalizeNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Fuzzy name key for the `dedupe --fuzzy` CLI flow. Strategy: reduce the
 * name to its sorted-alphanumeric character histogram + length. This
 * collapses case, punctuation, AND word order AND inconsistent camelCase
 * splits into a single canonical form — so `WebGLMinesweeper`,
 * `MinesweeperWebGL`, `minesweeper-webgl`, `MINESWEEPER WEBGL` all map to
 * the same key. Length is kept as a prefix so that genuine suffix variants
 * (e.g. `Minesweeper` vs `Minesweeper-2`) remain distinct groups — the
 * `-2` is there for a reason (auto-suffixed on collision) and collapsing
 * it back would over-merge.
 *
 * Trade-off: unrelated anagrams (`silent` ↔ `listen`) collide. In practice
 * atom names are domain-specific compound words, so the collision rate is
 * low; the CLI always shows the human operator the full names in a group
 * before any merge fires. If you need stricter matching, the caller can
 * still fall back to `normalizeNameKey` (order-sensitive, no anagram
 * tolerance) — that's what the default dedupe mode does.
 *
 * HEURISTIC — not a semantic equivalence check. Use before calling
 * `mergeInto`, NEVER automatically at branch time.
 */
export function tokenBagKey(name: string): string {
  const letters = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .split('')
    .sort()
    .join('');
  return `${letters.length}:${letters}`;
}

/**
 * Strip one or more trailing `(branched from X)` suffixes from a description.
 * Historical registries accumulated long chains like
 *   "core text (branched from A) (branched from B) (branched from C)"
 * because `branch` used to concatenate without deduplication. This helper
 * peels all such suffixes so downstream consumers (prefilter, UI, CLI) see
 * the original core description. `branch` itself also calls this when
 * constructing the new type's description so no new chain can form.
 */
export function stripBranchProvenance(description: string): string {
  // Match "(branched from anything)" greedily stripping each trailing one.
  // Anything = non-paren-closing run to be resilient to nested punctuation.
  let out = description;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\s*\(branched from [^)]+\)\s*$/i, '');
  } while (out !== prev);
  return out.trim();
}

/**
 * Rewrite a leading "You are <PersonaName>" line so the persona matches the
 * atom's actual name. Addresses a recurring contamination where Sonnet, when
 * authoring a seed system prompt, hardcoded a pre-v2 name like "You are
 * Carbon, an L1 element..." that then persisted through branches — every descendant of
 * the seeded atom ends up thinking it's Carbon even when its registry name
 * is Phosphorus, Silicon, Aluminum, etc.
 *
 * Only rewrites when:
 *   - the prompt starts with `/^You are <Capitalized>\b/` (excludes English
 *     articles like "You are a focused worker" — lowercase → untouched)
 *   - the captured name differs from `newName` (idempotent otherwise)
 *
 * Keeps everything else (punctuation, rest of the prompt) intact.
 * Only the first identity assertion at the very start is rewritten;
 * subsequent "You are ..." occurrences later in the body (if any) are
 * left alone because they may be about the USER, not the atom.
 */
export function rebrandPersona(systemPrompt: string, newName: string): string {
  const match = systemPrompt.match(/^(You are )([A-Z][A-Za-z0-9_-]*)/);
  if (!match) return systemPrompt;
  if (match[2] === newName) return systemPrompt;
  return (
    match[1]! + newName + systemPrompt.slice(match[1]!.length + match[2]!.length)
  );
}

export class AtomRegistry {
  constructor(private readonly db: DB) {}

  /**
   * Append a lifecycle event TO THIS REGISTRY'S OWN STORE.
   *
   * Passing `this.db` is what makes the ledger inseparable from the counters
   * it describes, and it replaces a guard with a structure:
   *   - an in-memory fixture now gets an in-memory ledger, so the accident
   *     that motivated `ledgerWritesAllowed` — two throwaway `tsx` scripts
   *     bumping `Helium` on a `:memory:` registry and appending four phantom
   *     successes to the real file, leaving `ledger check` permanently red —
   *     is no longer reachable at all rather than merely refused;
   *   - `patch` and `rollback` already run inside `db.transaction`, so their
   *     events now roll back WITH the write. Appending to a separate file
   *     meant a failed patch left a phantom `counters-reset` behind, which
   *     `check` reads as ledger > store: the IMPOSSIBLE direction.
   */
  private note(event: Parameters<typeof appendLedger>[0]): void {
    appendLedger(event, this.db);
  }

  listByTier(tier: Tier): AtomType[] {
    const rows = this.db
      .prepare('SELECT * FROM atom_types WHERE tier = ? ORDER BY ordinal ASC')
      .all(tier) as Row[];
    return rows.map(rowToType);
  }

  getByName(name: string): AtomType | null {
    const row = this.db
      .prepare('SELECT * FROM atom_types WHERE name = ?')
      .get(name) as Row | undefined;
    return row ? rowToType(row) : null;
  }

  getByTierOrdinal(tier: Tier, ordinal: number): AtomType | null {
    const row = this.db
      .prepare('SELECT * FROM atom_types WHERE tier = ? AND ordinal = ?')
      .get(tier, ordinal) as Row | undefined;
    return row ? rowToType(row) : null;
  }

  /**
   * Ordinals that may NOT be handed out at this tier: live rows UNION the
   * version history.
   *
   * The history term is what honours a `remove` tombstone. `create` had it
   * and `branch` did not, so the two allocators disagreed and a branch after
   * a removal re-issued the dead atom's ordinal — and therefore its taxonomy
   * NAME. REPRODUCED: create/create/remove(Helium)/branch handed the branch
   * "Helium" back, while `create` correctly skipped to Lithium. The new atom
   * then inherits the dead one's identity in archived run traces AND its
   * skill namespace (`skills/Helium/` still holds the removed atom's learned
   * recipes and their earned counters), which is exactly what the tombstone
   * exists to prevent.
   *
   * Shared rather than duplicated so the two call sites cannot drift apart
   * again — the drift is the whole bug.
   */
  private usedOrdinals(tier: Tier): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT ordinal FROM atom_types WHERE tier = ?
         UNION
         SELECT DISTINCT ordinal FROM atom_type_versions WHERE tier = ?`
      )
      .all(tier, tier) as { ordinal: number }[];
    return new Set(rows.map((r) => r.ordinal));
  }

  create(tier: Tier, seed: CreateSeed): AtomType {
    return this.db.transaction((): AtomType => {
      // Allocation considers live rows ∪ version-history rows: an atom
      // deleted via `remove` leaves a `[removed]` tombstone in
      // atom_type_versions precisely so its ordinal (and therefore its
      // taxonomy NAME) is never re-issued — a reused name would let a
      // future atom silently inherit the dead atom's identity in old
      // run traces and skill namespaces.
      const used = this.usedOrdinals(tier);
      const { ordinal, name } = nextAvailable(tier, used);
      const now = new Date().toISOString();
      // Align the persona baked into the seed prompt with the taxonomy name
      // we just assigned. Without this, Sonnet-authored seeds with a
      // hardcoded "You are Carbon" line silently pollute every future branch.
      const systemPrompt = rebrandPersona(seed.systemPrompt, name);
      const atomId = newAtomId();

      this.db
        .prepare(
          `INSERT INTO atom_types
           (tier, ordinal, atom_id, name, description, system_prompt, tools_json, params_json, created_by, created_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          tier,
          ordinal,
          atomId,
          name,
          seed.description,
          systemPrompt,
          JSON.stringify(seed.tools),
          JSON.stringify(seed.params),
          seed.createdBy,
          now
        );

      return {
        atomId,
        tier,
        ordinal,
        name,
        description: seed.description,
        systemPrompt,
        tools: seed.tools,
        params: seed.params,
        createdBy: seed.createdBy,
        createdAt: now,
        version: 1,
        successes: 0,
        failures: 0,
      };
    })();
  }

  patch(
    name: string,
    mods: AtomModifications,
    modifiedBy: string,
    reason?: string
  ): AtomType {
    return this.db.transaction((): AtomType => {
      const current = this.getByName(name);
      if (!current) throw new RegistryNotFoundError(name);

      const merged = applyMods(current, mods);

      // No-op guard: validators occasionally return `scope: 'patch'` with a
      // diagnostic `reasoning` but no concrete `modifications` (or only
      // nullish/empty fields). `applyMods` then produces an atom byte-identical
      // to the current one; persisting it would create a misleading duplicate
      // version AND silently reset the success/failure counters. Short-circuit
      // so the canonical type is left untouched. Description-only patches
      // are allowed through the guard — they're cheap and meaningful.
      const currentToolsJson = JSON.stringify(current.tools);
      const currentParamsJson = JSON.stringify(current.params);
      if (
        merged.systemPrompt === current.systemPrompt &&
        JSON.stringify(merged.tools) === currentToolsJson &&
        JSON.stringify(merged.params) === currentParamsJson &&
        merged.description === current.description
      ) {
        return current;
      }

      const nextVersion = current.version + 1;
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO atom_type_versions
           (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          current.tier,
          current.ordinal,
          current.version,
          current.systemPrompt,
          currentToolsJson,
          currentParamsJson,
          modifiedBy,
          now,
          reason ?? null
        );

      // Patch resets counters: the type's behaviour has changed, so past
      // successes no longer guarantee anything about the new version. Trust
      // must be earned again.
      this.db
        .prepare(
          `UPDATE atom_types
             SET description = ?, system_prompt = ?, tools_json = ?, params_json = ?, version = ?,
                 successes = 0, failures = 0
           WHERE tier = ? AND ordinal = ?`
        )
        .run(
          merged.description,
          merged.systemPrompt,
          JSON.stringify(merged.tools),
          JSON.stringify(merged.params),
          nextVersion,
          current.tier,
          current.ordinal
        );
    this.note({ kind: 'counters-reset', entity: name, detail: { reason: 'patch' } });

      return { ...merged, version: nextVersion, successes: 0, failures: 0 };
    })();
  }

  /**
   * Archived versions of a type, oldest first. Each row is the content a
   * version HAD when a patch superseded it — the LIVE version is not in
   * this list (it lives in `atom_types`). Rows for a `[removed]` tombstone
   * are included: history outlives the live row by design.
   */
  listVersions(name: string): AtomVersionRow[] {
    const current = this.getByName(name);
    if (!current) throw new RegistryNotFoundError(name);
    const rows = this.db
      .prepare(
        `SELECT version, system_prompt, tools_json, params_json,
                modified_by, modified_at, reason
         FROM atom_type_versions
         WHERE tier = ? AND ordinal = ?
         ORDER BY version ASC`
      )
      .all(current.tier, current.ordinal) as {
        version: number;
        system_prompt: string;
        tools_json: string;
        params_json: string;
        modified_by: string;
        modified_at: string;
        reason: string | null;
      }[];
    return rows.map((r) => ({
      version: r.version,
      systemPrompt: r.system_prompt,
      tools: JSON.parse(r.tools_json) as Tool[],
      params: JSON.parse(r.params_json) as GenerationParams,
      modifiedBy: r.modified_by,
      modifiedAt: r.modified_at,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }

  /**
   * Restore an ARCHIVED version's content as a NEW live version —
   * roll-forward-to-the-past, never history rewriting: the current
   * content is archived like any patch would, the version counter keeps
   * increasing, and the restored type re-earns trust from 0/0 (its
   * behaviour just changed; "patch resets trust" applies to a rollback
   * exactly as much as to a forward patch).
   *
   * Restores systemPrompt + tools + params EXACTLY (this is deliberately
   * NOT routed through `applyMods`, whose params merge cannot delete a
   * key added by a later version). The description is NOT versioned in
   * `atom_type_versions` and therefore keeps its current value.
   *
   * Two caveats the CLI surfaces to the operator:
   *   - canonical/bootstrap types are re-aligned by their idempotent
   *     seeder on the next run, which will simply patch the rollback
   *     away if the seed prompt differs — rollback is for DYNAMIC types,
   *     or for pinning a canonical during a single diagnostic run;
   *   - rolling back to content identical to the live row is a no-op
   *     (mirrors the patch no-op guard).
   */
  rollback(name: string, toVersion: number, modifiedBy = 'registry-cli:rollback'): AtomType {
    return this.db.transaction((): AtomType => {
      const current = this.getByName(name);
      if (!current) throw new RegistryNotFoundError(name);
      if (toVersion === current.version) {
        throw new Error(`rollback: v${toVersion} is already the live version of ${name}`);
      }
      const row = this.db
        .prepare(
          `SELECT system_prompt, tools_json, params_json
           FROM atom_type_versions
           WHERE tier = ? AND ordinal = ? AND version = ?`
        )
        .get(current.tier, current.ordinal, toVersion) as
        | { system_prompt: string; tools_json: string; params_json: string }
        | undefined;
      if (!row) {
        const available = this.listVersions(name).map((v) => v.version);
        throw new Error(
          `rollback: ${name} has no archived v${toVersion} (archived: ${available.join(', ') || 'none'}; live: v${current.version})`
        );
      }

      // No-op guard, same rationale as patch's: a content-identical
      // "restore" would only reset counters and pollute history.
      if (
        row.system_prompt === current.systemPrompt &&
        row.tools_json === JSON.stringify(current.tools) &&
        row.params_json === JSON.stringify(current.params)
      ) {
        return current;
      }

      const now = new Date().toISOString();
      const nextVersion = current.version + 1;
      this.db
        .prepare(
          `INSERT INTO atom_type_versions
           (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          current.tier,
          current.ordinal,
          current.version,
          current.systemPrompt,
          JSON.stringify(current.tools),
          JSON.stringify(current.params),
          modifiedBy,
          now,
          `superseded by rollback to v${toVersion}`
        );
      this.db
        .prepare(
          `UPDATE atom_types
             SET system_prompt = ?, tools_json = ?, params_json = ?, version = ?,
                 successes = 0, failures = 0
           WHERE tier = ? AND ordinal = ?`
        )
        .run(
          row.system_prompt,
          row.tools_json,
          row.params_json,
          nextVersion,
          current.tier,
          current.ordinal
        );
    this.note({ kind: 'counters-reset', entity: name, detail: { reason: 'rollback' } });
      const restored = this.getByName(name);
      if (!restored) throw new RegistryNotFoundError(name);
      return restored;
    })();
  }

  branch(
    fromName: string,
    mods: AtomModifications,
    createdBy: string,
    overrideName?: string
  ): AtomType {
    return this.db.transaction((): AtomType => {
      const source = this.getByName(fromName);
      if (!source) throw new RegistryNotFoundError(fromName);
      const merged = applyMods(source, mods);

      const used = this.usedOrdinals(source.tier);

      let ordinal: number;
      let name: string;
      // An atom NAME is also a path component: the skill store namespaces by
      // it (`skills/<atom-name>/<skill-id>/`). `overrideName` is
      // LLM-authored — it arrives as `verdict.branchName` from an L2/L3
      // validator — so accepting it verbatim let a verdict of `".."` name an
      // atom `..` and write a skill outside the skills root (reproduced).
      // `sanitise` in the skill registry is the inner guard; this is the
      // outer one, at the boundary where model output first becomes an
      // identity. Falling back to the taxonomy rather than throwing keeps
      // `branch` total, as the auto-suffix logic below already assumes.
      if (overrideName !== undefined && !isSafeAtomName(overrideName)) {
        overrideName = undefined;
      }
      if (overrideName) {
        // LLM-suggested branch names can collide across supervise-loop
        // iterations (validator can happily emit the same `branchName` a
        // second time after that type has already been created) AND they
        // can be trivial casing/punctuation variants of an existing name
        // (`Minesweeper-WebGL` vs `minesweeper_webgl`). Both kinds of
        // duplicate fragment the catalogue and confuse the prefilter.
        // Rather than throwing — which kills the whole run — we auto-suffix
        // `-2`, `-3`… so the caller's contract ("branch always succeeds")
        // holds and the semantic intent of the LLM is preserved.
        const existingKeys = this.existingNormalizedNames(source.tier);
        name = overrideName;
        const collides = (candidate: string): boolean =>
          this.getByName(candidate) !== null ||
          existingKeys.has(normalizeNameKey(candidate));
        if (collides(name)) {
          let suffix = 2;
          while (collides(`${overrideName}-${suffix}`)) suffix++;
          name = `${overrideName}-${suffix}`;
        }
        const next = nextAvailable(source.tier, used);
        ordinal = next.ordinal;
      } else {
        const next = nextAvailable(source.tier, used);
        ordinal = next.ordinal;
        name = next.name;
      }

      const now = new Date().toISOString();
      // Provenance is a single tail suffix, not a chain: when a branch is
      // itself branched, the grandparent's "(branched from X)" tail is
      // stripped before the new one is appended. Without this cap, repeated
      // branching produced descriptions like
      //   "...platformer... (branched from A) (branched from B) (branched from C)..."
      // which (a) drowned the real description in the prefilter catalog and
      // (b) inflated every prefilter LLM prompt by hundreds of tokens.
      const coreDescription = stripBranchProvenance(merged.description);
      const finalDescription = `${coreDescription} (branched from ${fromName})`;
      // Rebrand the persona to match the branch's new name. Without this,
      // the chain "Fluorine (seeded 'You are Carbon…')" → "Silicon (branched
      // from Aluminum)" keeps introducing itself as Carbon. The validator
      // prompt already flags this via BRANCHING ACROSS DOMAINS, but the
      // runtime rewrite closes the loop for the `branchOnEscalation` hook
      // which cannot supply a systemPromptReplace itself.
      const systemPrompt = rebrandPersona(merged.systemPrompt, name);
      // A branch is a NEW type, so it gets its OWN identity — it does not
      // inherit the source's. That is what keeps trust, skills and ledger
      // attribution from silently transferring to a derived atom.
      const atomId = newAtomId();
      this.db
        .prepare(
          `INSERT INTO atom_types
           (tier, ordinal, atom_id, name, description, system_prompt, tools_json, params_json, created_by, created_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          source.tier,
          ordinal,
          atomId,
          name,
          finalDescription,
          systemPrompt,
          JSON.stringify(merged.tools),
          JSON.stringify(merged.params),
          createdBy,
          now
        );

      return {
        atomId,
        tier: source.tier,
        ordinal,
        name,
        description: finalDescription,
        systemPrompt,
        tools: merged.tools,
        params: merged.params,
        createdBy,
        createdAt: now,
        version: 1,
        successes: 0,
        failures: 0,
      };
    })();
  }

  /**
   * Remove a type from the live catalog. OPERATOR tool (CLI `remove`) —
   * nothing in the runtime supervise loop ever deletes a type; the
   * loop's lifecycle verbs are patch/branch and counter bumps. Exists
   * to clean up dynamic-creation debris (the misdescribed clone series
   * a lying capability label used to spawn: one near-identical L2 per
   * run, none ever reused). Returns the removed type, or null when no
   * such name exists.
   *
   * The version HISTORY is kept, and the final live state is archived
   * into it as a `[removed]` tombstone row. Two reasons: (a) the
   * deferred rollback CLI relies on `atom_type_versions` surviving,
   * and (b) the tombstone keeps the taxonomy ordinal marked as used —
   * `create` allocates from live rows ∪ version-history rows, so a
   * freed ordinal is never handed to a future atom that would silently
   * inherit the dead atom's name in old run traces.
   */
  remove(name: string): AtomType | null {
    return this.db.transaction((): AtomType | null => {
      const current = this.getByName(name);
      if (!current) return null;
      this.db
        .prepare(
          `INSERT INTO atom_type_versions
           (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          current.tier,
          current.ordinal,
          current.version,
          current.systemPrompt,
          JSON.stringify(current.tools),
          JSON.stringify(current.params),
          'operator-remove',
          new Date().toISOString(),
          `[removed] final state of ${current.name} (${current.successes}✓/${current.failures}✗, createdBy: ${current.createdBy})`
        );
      this.db
        .prepare('DELETE FROM atom_types WHERE tier = ? AND ordinal = ?')
        .run(current.tier, current.ordinal);
      return current;
    })();
  }

  /**
   * Bump the success counter for a type. Called by the supervise loop after an
   * approved final result. Trusted types accumulate successes to eventually
   * short-circuit the validator LLM call.
   */
  recordSuccess(name: string, by?: string): void {
    // ONE TRANSACTION, and that is the point of the ledger living here. The
    // append used to precede the UPDATE as two writes to two files, so a
    // crash between them left the store one BELOW the ledger — precisely the
    // direction `ledger check` reports as proof that a write path bypassed
    // the choke points. Runs do get killed mid-flight (burn-in group-kills at
    // the wall-clock budget), so the integrity checker could be made to lie
    // by timing alone.
    this.db.transaction(() => {
      this.note({
        kind: 'type-success',
        entity: name,
        ...(by ? { detail: { by } } : {}),
      });
      this.db.prepare('UPDATE atom_types SET successes = successes + 1 WHERE name = ?').run(name);
    })();
  }

  /**
   * Bump the failure counter. Called by the supervise loop when an escalation
   * is about to branch the type. Any failure resets trust until enough new
   * successes accumulate.
   */
  recordFailure(name: string, by?: string): void {
    this.db.transaction(() => {
      this.note({
        kind: 'type-failure',
        entity: name,
        ...(by ? { detail: { by } } : {}),
      });
      this.db.prepare('UPDATE atom_types SET failures = failures + 1 WHERE name = ?').run(name);
    })();
  }

  /**
   * Operator-only correction for counters credited to an invalid observation.
   *
   * Negative deltas only: this escape hatch can remove false trust, never mint
   * it. The correction and its ledger event share the registry transaction so
   * `ledger check` remains exact. Used after a provider experiment approved
   * narrative with zero tool actions and credited Lithium + Ammonia once each.
   */
  compensateCounters(
    name: string,
    args: { successes?: number; failures?: number; reason: string }
  ): AtomType {
    const successes = args.successes ?? 0;
    const failures = args.failures ?? 0;
    if (
      !Number.isInteger(successes) ||
      !Number.isInteger(failures) ||
      successes > 0 ||
      failures > 0 ||
      (successes === 0 && failures === 0)
    ) {
      throw new Error('counter compensation requires at least one negative integer delta');
    }
    if (args.reason.trim().length === 0) {
      throw new Error('counter compensation requires a reason');
    }
    return this.db.transaction(() => {
      const current = this.getByName(name);
      if (!current) throw new RegistryNotFoundError(name);
      if (current.successes + successes < 0 || current.failures + failures < 0) {
        throw new Error(`counter compensation would make ${name} negative`);
      }
      this.note({
        kind: 'type-counter-compensation',
        entity: name,
        detail: { successes, failures, reason: args.reason.trim() },
      });
      this.db
        .prepare(
          'UPDATE atom_types SET successes = successes + ?, failures = failures + ? WHERE name = ?'
        )
        .run(successes, failures, name);
      return this.getByName(name)!;
    })();
  }

  /**
   * Return the set of normalized name keys already present at a given tier.
   * Used by `branch` to detect semantic duplicates (case/punctuation variants)
   * without forcing callers to materialise the full row list.
   */
  private existingNormalizedNames(tier: Tier): Set<string> {
    const rows = this.db
      .prepare('SELECT name FROM atom_types WHERE tier = ?')
      .all(tier) as { name: string }[];
    return new Set(rows.map((r) => normalizeNameKey(r.name)));
  }

  /**
   * Scan the registry for semantic-duplicate groups: two or more types on
   * the same tier whose names normalize to the same key. Useful for
   * dedupe/vacuum scripts to surface candidates for merge. Returns one
   * entry per group with at least two members, ordered by tier then key.
   *
   * `opts.fuzzy` switches the grouping key from the order-sensitive
   * `normalizeNameKey` (case + punctuation only) to the order-insensitive
   * `tokenBagKey` so `WebGLMinesweeper` and `MinesweeperWebGL` collide. The
   * strict default stays the conservative baseline; the fuzzy mode is for
   * the CLI dedupe review flow, where the operator always has the last word
   * before `mergeInto` runs.
   */
  findDuplicateGroups(
    opts?: { fuzzy?: boolean }
  ): { tier: Tier; key: string; types: AtomType[] }[] {
    const keyFn = opts?.fuzzy ? tokenBagKey : normalizeNameKey;
    // Two-step grouping: map<tier, map<key, types[]>>. Keeping the tier as
    // its own axis avoids a composite "tier:key" string key that would
    // split incorrectly when the key itself contains `:` (e.g. the fuzzy
    // char-histogram key has shape `"<length>:<sorted-chars>"`).
    const groups = new Map<Tier, Map<string, AtomType[]>>();
    for (const tier of [1, 2, 3] as const) {
      const perTier = new Map<string, AtomType[]>();
      for (const t of this.listByTier(tier)) {
        const k = keyFn(t.name);
        const bucket = perTier.get(k) ?? [];
        bucket.push(t);
        perTier.set(k, bucket);
      }
      groups.set(tier, perTier);
    }
    const out: { tier: Tier; key: string; types: AtomType[] }[] = [];
    for (const [tier, perTier] of groups) {
      for (const [key, types] of perTier) {
        if (types.length < 2) continue;
        out.push({ tier, key, types });
      }
    }
    return out.sort((a, b) => a.tier - b.tier || a.key.localeCompare(b.key));
  }

  /**
   * Update only the human-readable description of a type. Wraps `patch` with
   * the new `descriptionReplace` modification. Exists as a distinct entry
   * point so description-only touch-ups (CLI hygiene passes, manual drift
   * fixes) read cleanly and the patch's reason field ends up meaningful.
   */
  describe(name: string, newDescription: string, modifiedBy = 'hygiene'): AtomType {
    return this.patch(
      name,
      { descriptionReplace: newDescription },
      modifiedBy,
      'descriptionReplace via registry.describe'
    );
  }

  /**
   * Force-align an existing atom's systemPrompt persona with its taxonomy
   * name, using `rebrandPersona`. Returns the updated type if a rewrite
   * happened, or the untouched type otherwise. Used by the
   * `registry rebrand` CLI to retrofit legacy atoms that were created
   * before the auto-rebrand landed. Internally a `patch` with a fresh
   * systemPromptReplace so the version history is preserved.
   */
  rebrand(name: string, modifiedBy = 'rebrand'): { type: AtomType; changed: boolean } {
    const current = this.getByName(name);
    if (!current) throw new RegistryNotFoundError(name);
    const rebranded = rebrandPersona(current.systemPrompt, current.name);
    if (rebranded === current.systemPrompt) {
      return { type: current, changed: false };
    }
    const patched = this.patch(
      name,
      { systemPromptReplace: rebranded },
      modifiedBy,
      `persona rebrand: aligned "You are …" line with atom name "${name}"`
    );
    return { type: patched, changed: true };
  }

  /**
   * Merge one or more "loser" types into a "winner" on the same tier:
   *   - success/failure counters of the losers are added to the winner
   *   - every archived version of the losers is transplanted under the
   *     winner's (tier, ordinal) with a new synthetic version number so
   *     history is preserved rather than discarded
   *   - each loser row is deleted
   *
   * This is a destructive maintenance op used by the `registry dedupe` CLI
   * to collapse accidental near-duplicates (casing / punctuation variants
   * created by LLM-suggested `branchName`s). Callers MUST verify that the
   * types really are semantically equivalent before calling this.
   * Returns the winner's refreshed `AtomType`.
   */
  mergeInto(winnerName: string, loserNames: readonly string[]): AtomType {
    return this.db.transaction((): AtomType => {
      const winner = this.getByName(winnerName);
      if (!winner) throw new RegistryNotFoundError(winnerName);
      if (loserNames.length === 0) return winner;
      let nextVersion = winner.version;
      const maxVersionRow = this.db
        .prepare(
          'SELECT MAX(version) as mv FROM atom_type_versions WHERE tier = ? AND ordinal = ?'
        )
        .get(winner.tier, winner.ordinal) as { mv: number | null } | undefined;
      if (maxVersionRow && typeof maxVersionRow.mv === 'number') {
        nextVersion = Math.max(nextVersion, maxVersionRow.mv);
      }
      let sumSucc = 0;
      let sumFail = 0;
      for (const loserName of loserNames) {
        const loser = this.getByName(loserName);
        if (!loser) continue;
        if (loser.tier !== winner.tier) {
          throw new Error(
            `mergeInto: cannot merge ${loserName} (tier ${loser.tier}) into ${winnerName} (tier ${winner.tier})`
          );
        }
        if (loser.ordinal === winner.ordinal) continue;
        sumSucc += loser.successes;
        sumFail += loser.failures;
        const hist = this.db
          .prepare(
            `SELECT version, system_prompt, tools_json, params_json,
                    modified_by, modified_at, reason
             FROM atom_type_versions
             WHERE tier = ? AND ordinal = ?
             ORDER BY version ASC`
          )
          .all(loser.tier, loser.ordinal) as {
            version: number;
            system_prompt: string;
            tools_json: string;
            params_json: string;
            modified_by: string;
            modified_at: string;
            reason: string | null;
          }[];
        for (const h of hist) {
          nextVersion++;
          this.db
            .prepare(
              `INSERT INTO atom_type_versions
               (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              winner.tier,
              winner.ordinal,
              nextVersion,
              h.system_prompt,
              h.tools_json,
              h.params_json,
              h.modified_by,
              h.modified_at,
              `[merged from ${loser.name} v${h.version}] ${h.reason ?? ''}`.trim()
            );
        }
        // Also archive the loser's CURRENT state as a version snapshot
        // under the winner, so the record is complete.
        nextVersion++;
        this.db
          .prepare(
            `INSERT INTO atom_type_versions
             (tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            winner.tier,
            winner.ordinal,
            nextVersion,
            loser.systemPrompt,
            JSON.stringify(loser.tools),
            JSON.stringify(loser.params),
            loser.createdBy,
            loser.createdAt,
            `[merged from ${loser.name} current state]`
          );
        this.db
          .prepare('DELETE FROM atom_type_versions WHERE tier = ? AND ordinal = ?')
          .run(loser.tier, loser.ordinal);
        this.db
          .prepare('DELETE FROM atom_types WHERE tier = ? AND ordinal = ?')
          .run(loser.tier, loser.ordinal);
      }
      this.db
        .prepare(
          `UPDATE atom_types
             SET successes = successes + ?, failures = failures + ?
           WHERE tier = ? AND ordinal = ?`
        )
        .run(sumSucc, sumFail, winner.tier, winner.ordinal);
      // A COUNTER MUTATION THE LEDGER USED TO MISS ENTIRELY. `mergeInto` moves
      // the losers' trust onto the winner and deletes their rows, so before
      // this the winner simply grew by an unexplained amount — which `check`
      // classifies as `store > ledger`, the direction it treats as benign
      // pre-ledger history. A bypass of the choke point that the checker is
      // structurally blind to is the one failure the ledger cannot afford;
      // the delta is recorded so the projection stays exact instead of
      // merely not-alarming.
      this.note({
        kind: 'type-merge',
        entity: winnerName,
        detail: { absorbed: loserNames, successes: sumSucc, failures: sumFail },
      });
      const refreshed = this.getByName(winnerName);
      if (!refreshed) throw new Error('mergeInto: winner vanished after merge');
      return refreshed;
    })();
  }

  /** Light variant of `listVersions`: metadata only, `[]` for a missing name. */
  versionsOf(name: string): { version: number; modifiedAt: string; reason: string | null }[] {
    const t = this.getByName(name);
    if (!t) return [];
    // Alias snake_case → camelCase at the SQL level. Without the `AS`, the
    // returned rows have shape `{version, modified_at, reason}` and the
    // TypeScript cast to `{modifiedAt}` silently produces `undefined` at
    // every call site — the CLI `show` printed `v1 @ undefined` for months
    // as a result.
    return this.db
      .prepare(
        `SELECT version, modified_at AS modifiedAt, reason
         FROM atom_type_versions
         WHERE tier = ? AND ordinal = ?
         ORDER BY version ASC`
      )
      .all(t.tier, t.ordinal) as { version: number; modifiedAt: string; reason: string | null }[];
  }
}

function applyMods(source: AtomType, mods: AtomModifications): AtomType {
  let systemPrompt = source.systemPrompt;
  if (mods.systemPromptReplace !== undefined) {
    systemPrompt = mods.systemPromptReplace;
  } else if (mods.systemPromptAppend !== undefined) {
    systemPrompt = `${systemPrompt}\n\n${mods.systemPromptAppend}`;
  }

  let tools = [...source.tools];
  if (mods.removeTools && mods.removeTools.length > 0) {
    const rm = new Set(mods.removeTools);
    tools = tools.filter((t) => !rm.has(t.name));
  }
  if (mods.addTools && mods.addTools.length > 0) {
    const known = new Set(tools.map((t) => t.name));
    for (const t of mods.addTools) {
      if (!known.has(t.name)) tools.push(t);
    }
  }

  const params: GenerationParams = { ...source.params, ...(mods.params ?? {}) };

  if (mods.additionalContext) {
    systemPrompt = `${systemPrompt}\n\n<!-- additional context -->\n${mods.additionalContext}`;
  }

  // Validators can request a description overhaul when the atom's true
  // purpose has drifted from its historical template (e.g. a branched
  // "Mario platformer" type that's actually been retargeted to Minesweeper).
  // Keep the branch-provenance suffix if there is one — it carries real
  // ancestry info — but swap out the core text.
  let description = source.description;
  if (mods.descriptionReplace !== undefined) {
    const match = source.description.match(/\s*\(branched from [^)]+\)\s*$/i);
    const provenanceTail = match ? ' ' + match[0].trim() : '';
    description = mods.descriptionReplace.trim() + provenanceTail;
  }

  return {
    ...source,
    description,
    systemPrompt,
    tools,
    params,
  };
}
