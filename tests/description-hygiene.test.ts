import { describe, it, expect } from 'vitest';
import {
  AtomRegistry,
  tokenBagKey,
  normalizeNameKey,
} from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { DB } from '../src/registry/db.js';

/**
 * Tests for the description-hygiene toolkit: fuzzy duplicate detection and
 * `registry.describe` for targeted description replacement.
 *
 * Background: the strict `normalizeNameKey` is order-sensitive by design so
 * `WebGLMinesweeper` and `MinesweeperWebGL` stay distinct. In practice these
 * ARE the same atom in the user's mental model and inflate the catalogue
 * under the prefilter. `--fuzzy` dedupe + a `describe` CLI gives the
 * operator a way to clean drift and merge word-order variants manually.
 */

const baseSeed = {
  description: 'test molecule',
  systemPrompt: 'be terse',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('tokenBagKey', () => {
  it('collapses case, punctuation, and word order into a canonical key', () => {
    // Length prefix + sorted char histogram. All four names below reduce
    // to 16 chars + the same sorted letter bag.
    const key = tokenBagKey('WebGLMinesweeper');
    expect(tokenBagKey('MinesweeperWebGL')).toBe(key);
    expect(tokenBagKey('minesweeper-webgl')).toBe(key);
    expect(tokenBagKey('MINESWEEPER WEBGL')).toBe(key);
    expect(key.startsWith('16:')).toBe(true);
  });

  it('order-insensitive unlike normalizeNameKey (word-order-sensitive)', () => {
    expect(normalizeNameKey('WebGLMinesweeper')).not.toBe(
      normalizeNameKey('MinesweeperWebGL')
    );
    expect(tokenBagKey('WebGLMinesweeper')).toBe(tokenBagKey('MinesweeperWebGL'));
  });

  it('keeps ordinal-suffixed branches distinct from the base (length differs)', () => {
    // `Minesweeper-2` is what `branch` auto-suffixes on collision and
    // should stay a separate group unless the operator explicitly merges.
    expect(tokenBagKey('WebGLMinesweeper')).not.toBe(
      tokenBagKey('WebGLMinesweeper-2')
    );
  });

  it('still separates genuinely different names', () => {
    expect(tokenBagKey('Water')).not.toBe(tokenBagKey('Methane'));
    expect(tokenBagKey('Minesweeper')).not.toBe(tokenBagKey('Tetris'));
  });
});

describe('AtomRegistry.findDuplicateGroups({ fuzzy: true })', () => {
  function seed(db: DB): void {
    const insert = db.prepare(
      `INSERT INTO atom_types
       (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version, atom_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, lower(hex(randomblob(16))))`
    );
    const now = new Date().toISOString();
    insert.run(1, 1, 'WebGLMinesweeper', 'd', 's', '[]', '{}', 't', now);
    insert.run(1, 2, 'MinesweeperWebGL', 'd', 's', '[]', '{}', 't', now);
    insert.run(1, 3, 'Minesweeper-WebGL', 'd', 's', '[]', '{}', 't', now);
    insert.run(1, 4, 'Fluorine', 'd', 's', '[]', '{}', 't', now);
  }

  it('strict mode leaves word-order variants as separate groups', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seed((r as any).db as DB);

    const groups = r.findDuplicateGroups();
    const hit = groups.find((g) => g.tier === 1 && g.types.length >= 3);
    // Strict key does NOT collapse WebGLMinesweeper ↔ MinesweeperWebGL,
    // so we only see the two "MinesweeperWebGL"-keyed variants in a group.
    expect(hit).toBeFalsy();
  });

  it('fuzzy mode collapses word-order variants into one group', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seed((r as any).db as DB);

    const groups = r.findDuplicateGroups({ fuzzy: true });
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g!.types.map((t) => t.name).sort()).toEqual(
      ['Minesweeper-WebGL', 'MinesweeperWebGL', 'WebGLMinesweeper'].sort()
    );
    expect(g!.types.some((t) => t.name === 'Fluorine')).toBe(false);
  });
});

describe('AtomRegistry.describe', () => {
  it('rewrites the description via patch + descriptionReplace', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, { ...baseSeed, description: 'Mario-like platformer builder.' });
    const updated = r.describe(
      'Water',
      'Single-page Minesweeper builder (WebGL + canvas overlay).',
      'operator'
    );
    expect(updated.description).toMatch(/Minesweeper builder/);
    expect(updated.version).toBe(2);
    // History is preserved — v1 snapshot archived.
    expect(r.versionsOf('Water').length).toBe(1);
  });

  it('preserves branch-provenance tails while replacing the core description', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, { ...baseSeed, description: 'parent' });
    const branched = r.branch('Water', {}, 'tester', 'Minesweeper-WebGL');
    expect(branched.description).toMatch(/\(branched from Water\)$/);

    const updated = r.describe(
      branched.name,
      'WebGL Minesweeper builder: 10x10 grid, flag icons, mine counts.',
      'operator'
    );
    expect(updated.description).toMatch(/^WebGL Minesweeper builder/);
    // Provenance tail survives the rewrite so ancestry is not lost.
    expect(updated.description).toMatch(/\(branched from Water\)$/);
  });

  it('resets counters because describe is still a patch (behaviour changed)', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, baseSeed);
    r.recordSuccess('Water');
    r.recordSuccess('Water');
    expect(r.getByName('Water')!.successes).toBe(2);

    r.describe('Water', 'fresh description');

    const after = r.getByName('Water')!;
    expect(after.description).toBe('fresh description');
    expect(after.successes).toBe(0);
    expect(after.failures).toBe(0);
  });
});
