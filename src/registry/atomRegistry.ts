import type { DB } from './db.js';
import type {
  AtomModifications,
  GenerationParams,
  Tier,
  Tool,
} from '../core/types.js';
import { RegistryNotFoundError } from '../core/errors.js';
import { nextAvailableElement } from './taxonomies/elements.js';
import { nextAvailableMolecule } from './taxonomies/molecules.js';
import { nextAvailableCell } from './taxonomies/cells.js';

export interface AtomType {
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
      return nextAvailableElement(used);
    case 2:
      return nextAvailableMolecule(used);
    case 3:
      return nextAvailableCell(used);
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

export class AtomRegistry {
  constructor(private readonly db: DB) {}

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

  create(tier: Tier, seed: CreateSeed): AtomType {
    return this.db.transaction((): AtomType => {
      const usedRows = this.db
        .prepare('SELECT ordinal FROM atom_types WHERE tier = ?')
        .all(tier) as { ordinal: number }[];
      const used = new Set(usedRows.map((r) => r.ordinal));
      const { ordinal, name } = nextAvailable(tier, used);
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO atom_types
           (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          tier,
          ordinal,
          name,
          seed.description,
          seed.systemPrompt,
          JSON.stringify(seed.tools),
          JSON.stringify(seed.params),
          seed.createdBy,
          now
        );

      return {
        tier,
        ordinal,
        name,
        description: seed.description,
        systemPrompt: seed.systemPrompt,
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

      return { ...merged, version: nextVersion, successes: 0, failures: 0 };
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

      const usedRows = this.db
        .prepare('SELECT ordinal FROM atom_types WHERE tier = ?')
        .all(source.tier) as { ordinal: number }[];
      const used = new Set(usedRows.map((r) => r.ordinal));

      let ordinal: number;
      let name: string;
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
      this.db
        .prepare(
          `INSERT INTO atom_types
           (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          source.tier,
          ordinal,
          name,
          finalDescription,
          merged.systemPrompt,
          JSON.stringify(merged.tools),
          JSON.stringify(merged.params),
          createdBy,
          now
        );

      return {
        tier: source.tier,
        ordinal,
        name,
        description: finalDescription,
        systemPrompt: merged.systemPrompt,
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
   * Bump the success counter for a type. Called by the supervise loop after an
   * approved final result. Trusted types accumulate successes to eventually
   * short-circuit the validator LLM call.
   */
  recordSuccess(name: string): void {
    this.db
      .prepare('UPDATE atom_types SET successes = successes + 1 WHERE name = ?')
      .run(name);
  }

  /**
   * Bump the failure counter. Called by the supervise loop when an escalation
   * is about to branch the type. Any failure resets trust until enough new
   * successes accumulate.
   */
  recordFailure(name: string): void {
    this.db
      .prepare('UPDATE atom_types SET failures = failures + 1 WHERE name = ?')
      .run(name);
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
      const refreshed = this.getByName(winnerName);
      if (!refreshed) throw new Error('mergeInto: winner vanished after merge');
      return refreshed;
    })();
  }

  versionsOf(name: string): { version: number; modifiedAt: string; reason: string | null }[] {
    const t = this.getByName(name);
    if (!t) return [];
    return this.db
      .prepare(
        `SELECT version, modified_at, reason
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
