import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';
import type { Tier, Tool } from '../core/types.js';
import { insertEvent } from '../core/ledger.js';
import { rebrandPersona } from './atomRegistry.js';
import { elementForTool } from '../contracts/toolTaxonomy.js';
import {
  currentTaxonomyName,
  legacyTaxonomyName,
} from './taxonomyNames.js';

export const TAXONOMY_VERSION = 2;
export const TAXONOMY_METADATA_KEY = 'taxonomy_version';

export const STORE_METADATA_DDL = `
CREATE TABLE IF NOT EXISTS store_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface StoredAtom {
  tier: number;
  ordinal: number;
  name: string;
  description: string;
  system_prompt: string;
  tools_json: string;
  params_json: string;
  created_by: string;
  version: number;
  successes: number;
  failures: number;
}

export interface TaxonomyRename {
  readonly tier: Tier;
  readonly ordinal: number;
  readonly from: string;
  readonly to: string;
}

export interface SkillNamespaceRename {
  readonly from: string;
  readonly to: string;
  readonly fromPath: string;
  readonly toPath: string;
}

export interface TaxonomyMigrationPlan {
  readonly alreadyCurrent: boolean;
  readonly renames: readonly TaxonomyRename[];
  readonly skillNamespaces: readonly SkillNamespaceRename[];
  readonly affectedTypes: number;
}

export interface TaxonomyMigrationResult {
  readonly renamedTypes: number;
  readonly renamedSkillNamespaces: number;
  readonly resetTypes: number;
  readonly clearedPrefilterEntries: number;
}

export function taxonomyVersion(db: DB): number | null {
  db.exec(STORE_METADATA_DDL);
  const row = db
    .prepare('SELECT value FROM store_metadata WHERE key = ?')
    .get(TAXONOMY_METADATA_KEY) as { value: string } | undefined;
  if (!row) return null;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * A brand-new store starts directly on the current taxonomy. A populated
 * unversioned store is deliberately left untouched for the explicit
 * registry migration, which also moves filesystem-backed skill namespaces.
 */
export function initializeTaxonomyVersion(db: DB): void {
  db.exec(STORE_METADATA_DDL);
  if (taxonomyVersion(db) !== null) return;
  const count = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM atom_types) +
         (SELECT COUNT(*) FROM atom_type_versions) AS n`
    )
    .get() as { n: number };
  if (count.n === 0) {
    db.prepare('INSERT INTO store_metadata (key, value) VALUES (?, ?)').run(
      TAXONOMY_METADATA_KEY,
      String(TAXONOMY_VERSION)
    );
  }
}

export function assertCurrentTaxonomy(db: DB): void {
  const version = taxonomyVersion(db);
  if (version === TAXONOMY_VERSION) return;
  throw new Error(
    `registry taxonomy is ${version === null ? 'legacy/unversioned' : `v${version}`}; ` +
      `run \`npm run registry -- migrate-taxonomy --apply\` before starting a run`
  );
}

function replacementMapForStore(db: DB): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT tier, ordinal FROM atom_types
       UNION
       SELECT tier, ordinal FROM atom_type_versions`
    )
    .all() as { tier: number; ordinal: number }[];
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.tier !== 1 && row.tier !== 2 && row.tier !== 3) continue;
    const tier = row.tier;
    out.set(legacyTaxonomyName(tier, row.ordinal), currentTaxonomyName(tier, row.ordinal));
  }
  return out;
}

function replaceRoleTerms(text: string): string {
  return text
    .replace(/\bL1 elements\b/g, 'L1 molecules')
    .replace(/\bL1 element\b/g, 'L1 molecule')
    .replace(/\btier-1 elements\b/g, 'tier-1 molecules')
    .replace(/\btier-1 element\b/g, 'tier-1 molecule')
    .replace(/\bL2 molecules\b/g, 'L2 cells')
    .replace(/\bL2 molecule\b/g, 'L2 cell')
    .replace(/\btier-2 molecules\b/g, 'tier-2 cells')
    .replace(/\btier-2 molecule\b/g, 'tier-2 cell')
    .replace(/\bL3 cells\b/g, 'L3 tissues')
    .replace(/\bL3 cell\b/g, 'L3 tissue')
    .replace(/\btier-3 cells\b/g, 'tier-3 tissues')
    .replace(/\btier-3 cell\b/g, 'tier-3 tissue')
    .replace(/\btop-level cells\b/g, 'top-level tissues')
    .replace(/\btop-level cell\b/g, 'top-level tissue')
    .replace(/\bL2 orchestrator for\b/g, 'L2 cell for')
    .replace(/\bone L1 leaf\b/g, 'one L1 molecule')
    .replace(/\borthogonal L1 leaves\b/g, 'orthogonal L1 molecules')
    .replace(/\btier-1 atom\b/g, 'tier-1 molecule')
    .replace(/\btoolset genuinely diverges\b/g, 'element set genuinely diverges')
    .replace(/\byou NEVER call tools yourself\b/g, 'you NEVER invoke elements yourself')
    .replace(
      /\bL1 is the ONLY tier that writes files, runs shell commands, starts servers and validates artefacts\b/g,
      'L1 is the ONLY agent tier that invokes elements to write files, run shell commands, start servers and validate artefacts'
    )
    .replace(
      /\bconcrete side-effects happen only at L1\b/g,
      'concrete side-effects happen only in L1 molecules'
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite only structural provenance phrases. A blanket name replacement
 * would corrupt legitimate task prose (`Water`, `Carbon`, etc.).
 */
function replaceIdentityReferences(text: string, names: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of names) {
    const escaped = escapeRegExp(from);
    out = out
      .replace(new RegExp(`(\\bcreated by\\s+)${escaped}\\b`, 'g'), `$1${to}`)
      .replace(new RegExp(`(\\bbranched from\\s+)${escaped}\\b`, 'g'), `$1${to}`);
  }
  return out;
}

function enrichToolsJson(raw: string): string {
  let tools: unknown;
  try {
    tools = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(tools)) return raw;
  const enriched = tools.map((value): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const tool = value as Tool;
    if (typeof tool.name !== 'string') return value;
    const element = elementForTool(tool.name);
    if (!element) return value;
    return {
      ...value,
      element: {
        number: element.number,
        name: element.name,
        symbol: element.symbol,
      },
    };
  });
  return JSON.stringify(enriched);
}

function renameStructuredValue(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return names.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => renameStructuredValue(entry, names));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, renameStructuredValue(entry, names)])
  );
}

function renameEntity(entity: string, names: ReadonlyMap<string, string>): string {
  const slash = entity.indexOf('/');
  if (slash < 0) return names.get(entity) ?? entity;
  const owner = entity.slice(0, slash);
  const renamed = names.get(owner);
  return renamed ? `${renamed}${entity.slice(slash)}` : entity;
}

function skillNamespacePlan(
  skillsDir: string,
  names: ReadonlyMap<string, string>
): SkillNamespaceRename[] {
  const root = resolve(skillsDir);
  if (!existsSync(root)) return [];
  const moves: SkillNamespaceRename[] = [];
  for (const entry of readdirSync(root)) {
    const fromPath = join(root, entry);
    if (!statSync(fromPath).isDirectory()) continue;
    const to = names.get(entry);
    if (!to || to === entry) continue;
    moves.push({ from: entry, to, fromPath, toPath: join(root, to) });
  }
  return moves;
}

export function planTaxonomyMigration(db: DB, skillsDir: string): TaxonomyMigrationPlan {
  db.exec(STORE_METADATA_DDL);
  const version = taxonomyVersion(db);
  if (version === TAXONOMY_VERSION) {
    return { alreadyCurrent: true, renames: [], skillNamespaces: [], affectedTypes: 0 };
  }
  if (version !== null) {
    throw new Error(`unsupported registry taxonomy version ${version}`);
  }

  const atoms = db.prepare('SELECT * FROM atom_types ORDER BY tier, ordinal').all() as StoredAtom[];
  const renames: TaxonomyRename[] = [];
  for (const atom of atoms) {
    if (atom.tier !== 1 && atom.tier !== 2 && atom.tier !== 3) {
      throw new Error(`unsupported atom tier ${atom.tier}`);
    }
    const tier = atom.tier;
    const legacy = legacyTaxonomyName(tier, atom.ordinal);
    const current = currentTaxonomyName(tier, atom.ordinal);
    if (atom.name === legacy && legacy !== current) {
      renames.push({ tier, ordinal: atom.ordinal, from: legacy, to: current });
    } else if (atom.name !== current) {
      // Explicit branch override: keep its semantic identity, but migrate its
      // role wording and tool metadata with every other live type.
      continue;
    }
  }

  const movingNames = new Set(renames.map((rename) => rename.from));
  const occupied = new Set(atoms.map((atom) => atom.name));
  const targets = new Set<string>();
  for (const rename of renames) {
    if (targets.has(rename.to)) {
      throw new Error(`taxonomy migration maps more than one type to "${rename.to}"`);
    }
    targets.add(rename.to);
    if (occupied.has(rename.to) && !movingNames.has(rename.to)) {
      throw new Error(`taxonomy target "${rename.to}" is occupied by a non-migrating type`);
    }
  }

  const names = replacementMapForStore(db);
  for (const [from, to] of names) {
    if (from !== to && occupied.has(to) && !movingNames.has(to)) {
      throw new Error(
        `taxonomy target "${to}" is occupied by a non-migrating type (historical identity "${from}")`
      );
    }
  }
  const skillNamespaces = skillNamespacePlan(skillsDir, names);
  const movingSkillPaths = new Set(skillNamespaces.map((move) => move.fromPath));
  for (const move of skillNamespaces) {
    if (existsSync(move.toPath) && !movingSkillPaths.has(move.toPath)) {
      throw new Error(
        `cannot migrate skill namespace ${move.from}: destination ${move.toPath} already exists`
      );
    }
  }

  return {
    alreadyCurrent: false,
    renames,
    skillNamespaces,
    affectedTypes: atoms.length,
  };
}

export function applyTaxonomyMigration(
  db: DB,
  skillsDir: string,
  plan = planTaxonomyMigration(db, skillsDir)
): TaxonomyMigrationResult {
  if (plan.alreadyCurrent) {
    return {
      renamedTypes: 0,
      renamedSkillNamespaces: 0,
      resetTypes: 0,
      clearedPrefilterEntries: 0,
    };
  }

  const root = resolve(skillsDir);
  mkdirSync(root, { recursive: true });
  const staged = plan.skillNamespaces.map((move, index) => ({
    ...move,
    tempPath: join(root, `.taxonomy-v${TAXONOMY_VERSION}-${index}-${basename(move.fromPath)}`),
  }));
  for (const move of staged) {
    if (existsSync(move.tempPath)) {
      throw new Error(`stale taxonomy migration path exists: ${move.tempPath}`);
    }
    renameSync(move.fromPath, move.tempPath);
  }

  let result:
    | {
        resetTypes: number;
        clearedPrefilterEntries: number;
      }
    | undefined;
  try {
    result = db.transaction(() => {
      const atoms = db.prepare('SELECT * FROM atom_types ORDER BY tier, ordinal').all() as StoredAtom[];
      const names = replacementMapForStore(db);
      const renameByKey = new Map<string, TaxonomyRename>(
        plan.renames.map((rename) => [`${rename.tier}:${rename.ordinal}`, rename] as const)
      );
      const now = new Date().toISOString();

      for (const rename of plan.renames) {
        db.prepare('UPDATE atom_types SET name = ? WHERE tier = ? AND ordinal = ?').run(
          `__taxonomy_v${TAXONOMY_VERSION}_${rename.tier}_${rename.ordinal}`,
          rename.tier,
          rename.ordinal
        );
      }

      for (const atom of atoms) {
        const tier = atom.tier as Tier;
        const rename = renameByKey.get(`${tier}:${atom.ordinal}`);
        const finalName = rename?.to ?? atom.name;
        const promptWithRoles = replaceIdentityReferences(
          replaceRoleTerms(atom.system_prompt),
          names
        );
        const systemPrompt = rename
          ? rebrandPersona(promptWithRoles, finalName)
          : promptWithRoles;
        const description = replaceIdentityReferences(
          replaceRoleTerms(atom.description),
          names
        );
        const toolsJson = enrichToolsJson(atom.tools_json);
        const createdBy = names.get(atom.created_by) ?? atom.created_by;

        db.prepare(
          `INSERT INTO atom_type_versions
           (tier, ordinal, version, system_prompt, tools_json, params_json,
            modified_by, modified_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          tier,
          atom.ordinal,
          atom.version,
          atom.system_prompt,
          atom.tools_json,
          atom.params_json,
          'taxonomy-migration-v2',
          now,
          `renamed ${atom.name} → ${finalName}; Element(tool) → Molecule(L1) → Cell(L2) → Tissue(L3)`
        );

        db.prepare(
          `UPDATE atom_types
              SET name = ?, description = ?, system_prompt = ?, tools_json = ?,
                  created_by = ?, version = ?, successes = 0, failures = 0
            WHERE tier = ? AND ordinal = ?`
        ).run(
          finalName,
          description,
          systemPrompt,
          toolsJson,
          createdBy,
          atom.version + 1,
          tier,
          atom.ordinal
        );
      }

      const versions = db
        .prepare('SELECT rowid AS id, modified_by FROM atom_type_versions')
        .all() as { id: number; modified_by: string }[];
      const updateVersionActor = db.prepare(
        'UPDATE atom_type_versions SET modified_by = ? WHERE rowid = ?'
      );
      for (const version of versions) {
        const renamed = names.get(version.modified_by);
        if (renamed) updateVersionActor.run(renamed, version.id);
      }

      const events = db
        .prepare('SELECT seq, entity, detail FROM lifecycle_events ORDER BY seq')
        .all() as { seq: number; entity: string; detail: string | null }[];
      const updateEvent = db.prepare(
        'UPDATE lifecycle_events SET entity = ?, detail = ? WHERE seq = ?'
      );
      for (const event of events) {
        let detail = event.detail;
        if (detail) {
          try {
            detail = JSON.stringify(renameStructuredValue(JSON.parse(detail), names));
          } catch {
            // Preserve malformed historical detail byte-for-byte.
          }
        }
        updateEvent.run(renameEntity(event.entity, names), detail, event.seq);
      }

      for (const atom of atoms) {
        const rename = renameByKey.get(`${atom.tier}:${atom.ordinal}`);
        insertEvent(db, {
          at: now,
          kind: 'counters-reset',
          entity: rename?.to ?? atom.name,
          detail: {
            reason: 'taxonomy-migration-v2',
            ...(rename ? { from: rename.from, to: rename.to } : {}),
          },
        });
      }

      let clearedPrefilterEntries = 0;
      const cacheTable = db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
           WHERE type = 'table' AND name = 'prefilter_cache'`
        )
        .get() as { present: number } | undefined;
      if (cacheTable) {
        clearedPrefilterEntries = db.prepare('DELETE FROM prefilter_cache').run().changes;
      }

      db.prepare(
        `INSERT INTO store_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(TAXONOMY_METADATA_KEY, String(TAXONOMY_VERSION));

      return { resetTypes: atoms.length, clearedPrefilterEntries };
    })();
  } catch (error) {
    for (const move of [...staged].reverse()) {
      if (existsSync(move.tempPath) && !existsSync(move.fromPath)) {
        renameSync(move.tempPath, move.fromPath);
      }
    }
    throw error;
  }

  for (const move of staged) renameSync(move.tempPath, move.toPath);

  return {
    renamedTypes: plan.renames.length,
    renamedSkillNamespaces: staged.length,
    resetTypes: result.resetTypes,
    clearedPrefilterEntries: result.clearedPrefilterEntries,
  };
}
