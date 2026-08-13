import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/registry/db.js';
import {
  applyTaxonomyMigration,
  assertCurrentTaxonomy,
  planTaxonomyMigration,
  taxonomyVersion,
} from '../src/registry/taxonomyMigration.js';
import {
  currentTaxonomyName,
  legacyTaxonomyName,
} from '../src/registry/taxonomyNames.js';
import { readLedger } from '../src/core/ledger.js';

function insertLegacyType(
  db: ReturnType<typeof openDb>,
  tier: 1 | 2 | 3,
  ordinal: number,
  name: string,
  prompt: string,
  createdBy: string,
  tools: unknown[] = []
): void {
  db.prepare(
    `INSERT INTO atom_types
      (tier, ordinal, name, description, system_prompt, tools_json, params_json,
       created_by, created_at, version, successes, failures)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 1, 3, 0)`
  ).run(
    tier,
    ordinal,
    name,
    `legacy tier ${tier}`,
    prompt,
    JSON.stringify(tools),
    createdBy,
    '2026-01-01T00:00:00.000Z'
  );
}

describe('taxonomy v2 migration', () => {
  it('keeps the pre-v2 curated-list boundaries when migrating high ordinals', () => {
    expect(legacyTaxonomyName(2, 41)).toBe('Molecule41');
    expect(legacyTaxonomyName(3, 21)).toBe('Cell21');
    expect(currentTaxonomyName(1, 41)).toBe('Cellulose');
    expect(currentTaxonomyName(2, 21)).toBe('Chromatophore');
    expect(currentTaxonomyName(2, 41)).toBe('Cell41');
    expect(currentTaxonomyName(3, 21)).toBe('Tissue21');
  });

  it('renames all ranks and skill namespaces while preserving history', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-taxonomy-'));
    const skills = join(root, 'skills');
    const db = openDb(':memory:');
    try {
      insertLegacyType(
        db,
        1,
        1,
        'Hydrogen',
        'You are Hydrogen, an L1 element.',
        'bootstrap-canonical',
        [{ name: 'read_file', description: 'read', inputSchema: {} }]
      );
      insertLegacyType(
        db,
        2,
        1,
        'Water',
        'You are Water, an L2 molecule created by Neuron.',
        'Neuron'
      );
      insertLegacyType(
        db,
        3,
        1,
        'Neuron',
        'You are Neuron, a top-level cell.',
        'user'
      );
      db.prepare('UPDATE atom_types SET description = ? WHERE tier = 3').run(
        'A top-level cell for application builds.'
      );
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('taxonomy_version');
      db.prepare(
        `INSERT INTO lifecycle_events (at, kind, entity, detail)
         VALUES ('2026-01-01T00:00:00.000Z', 'type-success', 'Hydrogen', NULL),
                ('2026-01-01T00:00:00.001Z', 'skill-success', 'Hydrogen/demo-skill', NULL)`
      ).run();

      mkdirSync(join(skills, 'Hydrogen', 'demo-skill'), { recursive: true });
      writeFileSync(join(skills, 'Hydrogen', 'demo-skill', 'SKILL.md'), 'body', 'utf8');

      const plan = planTaxonomyMigration(db, skills);
      expect(() => assertCurrentTaxonomy(db)).toThrow(/migrate-taxonomy --apply/);
      expect(plan.renames).toEqual([
        { tier: 1, ordinal: 1, from: 'Hydrogen', to: 'Water' },
        { tier: 2, ordinal: 1, from: 'Water', to: 'Tracheid' },
        { tier: 3, ordinal: 1, from: 'Neuron', to: 'Meristem' },
      ]);
      expect(plan.skillNamespaces.map((move) => [move.from, move.to])).toEqual([
        ['Hydrogen', 'Water'],
      ]);

      const result = applyTaxonomyMigration(db, skills, plan);
      expect(result).toMatchObject({
        renamedTypes: 3,
        renamedSkillNamespaces: 1,
        resetTypes: 3,
      });
      expect(taxonomyVersion(db)).toBe(2);
      expect(() => assertCurrentTaxonomy(db)).not.toThrow();

      const rows = db
        .prepare(
          `SELECT tier, name, description, system_prompt, tools_json, created_by, version,
                  successes, failures
             FROM atom_types ORDER BY tier`
        )
        .all() as {
          tier: number;
          name: string;
          description: string;
          system_prompt: string;
          tools_json: string;
          created_by: string;
          version: number;
          successes: number;
          failures: number;
        }[];
      expect(rows.map((row) => row.name)).toEqual(['Water', 'Tracheid', 'Meristem']);
      expect(rows.map((row) => row.system_prompt)).toEqual([
        'You are Water, an L1 molecule.',
        'You are Tracheid, an L2 cell created by Meristem.',
        'You are Meristem, a top-level tissue.',
      ]);
      expect(rows[2]?.description).toBe('A top-level tissue for application builds.');
      expect(rows[1]?.created_by).toBe('Meristem');
      expect(rows.every((row) => row.version === 2)).toBe(true);
      expect(rows.every((row) => row.successes === 0 && row.failures === 0)).toBe(true);
      expect(JSON.parse(rows[0]!.tools_json)[0].element).toEqual({
        number: 3,
        name: 'Lithium',
        symbol: 'Li',
      });

      expect(existsSync(join(skills, 'Hydrogen'))).toBe(false);
      expect(existsSync(join(skills, 'Water', 'demo-skill', 'SKILL.md'))).toBe(true);

      const entities = readLedger(db).map((event) => event.entity);
      expect(entities).toContain('Water/demo-skill');
      expect(entities).not.toContain('Hydrogen/demo-skill');
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM atom_type_versions').get()
      ).toEqual({ n: 3 });

      expect(applyTaxonomyMigration(db, skills)).toEqual({
        renamedTypes: 0,
        renamedSkillNamespaces: 0,
        resetTypes: 0,
        clearedPrefilterEntries: 0,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a target name belongs to a non-migrating override', () => {
    const db = openDb(':memory:');
    try {
      insertLegacyType(
        db,
        1,
        1,
        'Hydrogen',
        'You are Hydrogen, an L1 element.',
        'legacy'
      );
      insertLegacyType(
        db,
        3,
        2,
        'Water',
        'You are Water, a custom supervisor.',
        'user'
      );
      db.prepare('DELETE FROM store_metadata WHERE key = ?').run('taxonomy_version');

      expect(() => planTaxonomyMigration(db, '/missing-skills')).toThrow(
        /target "Water" is occupied/
      );
      expect(db.prepare('SELECT name FROM atom_types ORDER BY tier').all()).toEqual([
        { name: 'Hydrogen' },
        { name: 'Water' },
      ]);
    } finally {
      db.close();
    }
  });
});
