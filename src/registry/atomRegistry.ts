import type { DB } from './db.js';
import type {
  AtomModifications,
  GenerationParams,
  Tier,
  Tool,
} from '../core/types.js';
import {
  RegistryNotFoundError,
  ValidationError,
} from '../core/errors.js';
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
          JSON.stringify(current.tools),
          JSON.stringify(current.params),
          modifiedBy,
          now,
          reason ?? null
        );

      const merged = applyMods(current, mods);

      this.db
        .prepare(
          `UPDATE atom_types
             SET system_prompt = ?, tools_json = ?, params_json = ?, version = ?
           WHERE tier = ? AND ordinal = ?`
        )
        .run(
          merged.systemPrompt,
          JSON.stringify(merged.tools),
          JSON.stringify(merged.params),
          nextVersion,
          current.tier,
          current.ordinal
        );

      return { ...merged, version: nextVersion };
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
        if (this.getByName(overrideName)) {
          throw new ValidationError(`name already in use: ${overrideName}`);
        }
        const next = nextAvailable(source.tier, used);
        ordinal = next.ordinal;
        name = overrideName;
      } else {
        const next = nextAvailable(source.tier, used);
        ordinal = next.ordinal;
        name = next.name;
      }

      const now = new Date().toISOString();
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
          `${merged.description} (branched from ${fromName})`,
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
        description: `${merged.description} (branched from ${fromName})`,
        systemPrompt: merged.systemPrompt,
        tools: merged.tools,
        params: merged.params,
        createdBy,
        createdAt: now,
        version: 1,
      };
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

  return {
    ...source,
    systemPrompt,
    tools,
    params,
  };
}
