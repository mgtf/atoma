import { describe, it, expect, beforeEach } from 'vitest';
import {
  AtomRegistry,
  normalizeNameKey,
  stripBranchProvenance,
  isSafeAtomName,
} from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

function makeRegistry(): AtomRegistry {
  return new AtomRegistry(openDb(':memory:'));
}

const baseSeed = {
  description: 'test molecule',
  systemPrompt: 'be terse',
  tools: [],
  params: { temperature: 0 },
  createdBy: 'test',
};

describe('AtomRegistry', () => {
  let r: AtomRegistry;
  beforeEach(() => {
    r = makeRegistry();
  });

  it('assigns Water for the first L1 molecule', () => {
    const t = r.create(1, baseSeed);
    expect(t.name).toBe('Water');
    expect(t.ordinal).toBe(1);
    expect(t.tier).toBe(1);
    expect(t.version).toBe(1);
  });

  it('assigns Methane, Ammonia for subsequent L1 molecules', () => {
    r.create(1, baseSeed);
    const he = r.create(1, baseSeed);
    const li = r.create(1, baseSeed);
    expect(he.name).toBe('Methane');
    expect(li.name).toBe('Ammonia');
  });

  it('assigns Tracheid / Sclereid for L2, Meristem for L3', () => {
    expect(r.create(2, { ...baseSeed, description: 'l2-a' }).name).toBe('Tracheid');
    expect(r.create(2, { ...baseSeed, description: 'l2-b' }).name).toBe('Sclereid');
    expect(r.create(3, { ...baseSeed, description: 'l3-a' }).name).toBe('Meristem');
  });

  it('patch increments version and archives the prior state', () => {
    const h = r.create(1, baseSeed);
    const patched = r.patch(
      h.name,
      { systemPromptReplace: 'updated prompt' },
      'tester',
      'smoke'
    );
    expect(patched.version).toBe(2);
    expect(patched.systemPrompt).toBe('updated prompt');
    const versions = r.versionsOf(h.name);
    expect(versions.length).toBe(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('patch is a no-op when modifications are empty (no version bump, no archive)', () => {
    const h = r.create(1, baseSeed);
    r.recordSuccess(h.name);
    r.recordSuccess(h.name);

    const out = r.patch(h.name, {}, 'tester', 'diagnostic only');

    expect(out.version).toBe(1);
    expect(out.successes).toBe(2);
    expect(out.failures).toBe(0);
    expect(out.systemPrompt).toBe(baseSeed.systemPrompt);
    expect(r.versionsOf(h.name)).toEqual([]);
  });

  it('patch is a no-op when mods only contain empty/nullish fields', () => {
    const h = r.create(1, baseSeed);
    const out = r.patch(
      h.name,
      { addTools: [], removeTools: [], additionalContext: '' },
      'tester'
    );
    expect(out.version).toBe(1);
    expect(r.versionsOf(h.name)).toEqual([]);
  });

  it('patch with addTools: [] keeps counters intact (effective no-op)', () => {
    const h = r.create(1, baseSeed);
    r.recordSuccess(h.name);
    const out = r.patch(h.name, { addTools: [] }, 'tester');
    expect(out.version).toBe(1);
    expect(out.successes).toBe(1);
  });

  it('branch creates a new type with the next available name', () => {
    r.create(1, baseSeed);
    const branched = r.branch('Water', { systemPromptAppend: 'extra' }, 'tester');
    expect(branched.name).toBe('Methane');
    expect(branched.tier).toBe(1);
    expect(branched.systemPrompt).toContain('extra');
  });

  it('branch respects an overrideName when no collision', () => {
    r.create(1, baseSeed);
    const b = r.branch('Water', { systemPromptAppend: 'x' }, 'tester', 'CustomName');
    expect(b.name).toBe('CustomName');
    expect(b.tier).toBe(1);
  });

  it('branch auto-suffixes overrideName on collision instead of throwing', () => {
    r.create(1, baseSeed);
    const first = r.branch('Water', { systemPromptAppend: 'a' }, 'tester', 'Oxide');
    expect(first.name).toBe('Oxide');

    const second = r.branch('Water', { systemPromptAppend: 'b' }, 'tester', 'Oxide');
    expect(second.name).toBe('Oxide-2');

    const third = r.branch('Water', { systemPromptAppend: 'c' }, 'tester', 'Oxide');
    expect(third.name).toBe('Oxide-3');

    // Ordinals must still be unique within the tier.
    const ordinals = r.listByTier(1).map((t) => t.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('listByTier returns only that tier in ordinal order', () => {
    r.create(1, baseSeed);
    r.create(2, { ...baseSeed, description: 'molecule' });
    r.create(1, baseSeed);
    const tier1 = r.listByTier(1);
    expect(tier1.map((t) => t.name)).toEqual(['Water', 'Methane']);
    expect(r.listByTier(2).length).toBe(1);
  });

  it('getByName returns the type regardless of tier', () => {
    r.create(1, baseSeed);
    r.create(2, { ...baseSeed, description: 'water-ish' });
    expect(r.getByName('Tracheid')?.tier).toBe(2);
    expect(r.getByName('Water')?.tier).toBe(1);
  });

  it('an overrideName cannot squat a curated pool name the allocator has yet to issue', () => {
    // REGRESSION. `nextAvailable` keys on ORDINALS, so it will still hand out
    // molecule #4's curated name later; `branch`'s collision guard only saw
    // names that were live AT BRANCH TIME. An LLM validator emitting
    // `branchName: "CarbonDioxide"` therefore parked that name on ordinal 2,
    // and the create() that eventually reached ordinal 4 died on
    // `UNIQUE constraint failed: atom_types.name` — mid-run, mid-spend, on a
    // path the model reaches just by picking a plausible chemical name.
    const base = r.create(1, baseSeed);
    const squatter = r.branch(base.name, {}, 'tester', 'CarbonDioxide');
    expect(squatter.name).toBe('CarbonDioxide-2');

    // The pool stays canonical: molecule #4 still gets its own name, and
    // creation past that ordinal no longer throws.
    const issued: string[] = [];
    for (let i = 0; i < 4; i += 1) issued.push(r.create(1, baseSeed).name);
    expect(issued).toContain('CarbonDioxide');
    expect(r.getByName('CarbonDioxide')!.ordinal).toBe(4);
  });

  it('a `<Rank><n>` fallback-shaped overrideName suffixes without spinning', () => {
    // The reserved-name test runs against the RAW name, not the normalized
    // key: `Molecule5-2` normalizes to `molecule52`, which matches the
    // fallback shape, so a key-based test would reject every suffix the
    // suffix loop itself produces and never terminate.
    const base = r.create(1, baseSeed);
    expect(r.branch(base.name, {}, 'tester', 'Molecule5').name).toBe('Molecule5-2');
    expect(r.branch(base.name, {}, 'tester', 'Molecule5').name).toBe('Molecule5-3');
  });

  it('a genuinely novel overrideName still passes through untouched', () => {
    // The reservation must not swallow the case `registry dedupe` exists for:
    // task-themed LLM names are exactly what enters the catalogue here.
    const base = r.create(1, baseSeed);
    expect(r.branch(base.name, {}, 'tester', 'Minesweeper-WebGL').name).toBe('Minesweeper-WebGL');
  });

  describe('history + rollback (roll-forward to the past)', () => {
    it('rollback restores an archived version as a NEW live version with counters reset', () => {
      const h = r.create(1, { ...baseSeed, systemPrompt: 'v1 prompt', params: { maxTokens: 4000 } });
      r.patch(h.name, { systemPromptReplace: 'v2 prompt', params: { maxTokens: 9000, temperature: 0.2 } }, 'tester');
      r.patch(h.name, { systemPromptReplace: 'v3 prompt' }, 'tester');
      r.recordSuccess(h.name);
      r.recordSuccess(h.name);

      const restored = r.rollback(h.name, 1, 'operator');
      // Roll-forward: version keeps rising, history stays append-only.
      expect(restored.version).toBe(4);
      expect(restored.systemPrompt).toBe('v1 prompt');
      // EXACT params restore — the later-added `temperature` key is GONE,
      // which the applyMods merge could never do.
      expect(restored.params).toEqual({ maxTokens: 4000 });
      // The restored behaviour re-earns trust.
      expect(restored.successes).toBe(0);
      expect(restored.failures).toBe(0);
      // v3 was archived on the way out, with a rollback-attributed reason.
      const hist = r.listVersions(h.name);
      expect(hist.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(hist[2]!.systemPrompt).toBe('v3 prompt');
      expect(hist[2]!.reason).toMatch(/rollback to v1/);
    });

    it('rollback to a content-identical version is a no-op (counters preserved)', () => {
      const h = r.create(1, { ...baseSeed, systemPrompt: 'same' });
      r.patch(h.name, { systemPromptReplace: 'other' }, 'tester');
      r.rollback(h.name, 1); // live v3 == v1 content
      r.recordSuccess(h.name);
      const before = r.getByName(h.name)!;
      const out = r.rollback(h.name, 1); // v1 content == live content → no-op
      expect(out.version).toBe(before.version);
      expect(out.successes).toBe(1);
    });

    it('rollback rejects the live version and unknown versions with actionable errors', () => {
      const h = r.create(1, baseSeed);
      r.patch(h.name, { systemPromptReplace: 'v2' }, 'tester');
      expect(() => r.rollback(h.name, 2)).toThrow(/already the live version/);
      expect(() => r.rollback(h.name, 7)).toThrow(/no archived v7 .*archived: 1.*live: v2/);
      expect(() => r.rollback('Nonexistium', 1)).toThrow();
    });

    it('listVersions carries full content; versionsOf stays the light variant', () => {
      const h = r.create(1, { ...baseSeed, systemPrompt: 'v1 prompt' });
      r.patch(h.name, { systemPromptReplace: 'v2 prompt' }, 'tester', 'why');
      const full = r.listVersions(h.name);
      expect(full).toHaveLength(1);
      expect(full[0]!.systemPrompt).toBe('v1 prompt');
      expect(full[0]!.modifiedBy).toBe('tester');
      expect(full[0]!.tools).toEqual(h.tools);
      const light = r.versionsOf(h.name);
      expect(light[0]).not.toHaveProperty('systemPrompt');
    });
  });

  describe('semantic duplicate handling', () => {
    it('normalizeNameKey collapses case + punctuation to a common key', () => {
      expect(normalizeNameKey('Minesweeper-WebGL')).toBe('minesweeperwebgl');
      expect(normalizeNameKey('minesweeper_webgl')).toBe('minesweeperwebgl');
      expect(normalizeNameKey('Minesweeper WebGL')).toBe('minesweeperwebgl');
      expect(normalizeNameKey('minesweeper.webgl')).toBe('minesweeperwebgl');
      // Word order is intentionally NOT normalized — this is a pragmatic
      // collision check, not a semantic-similarity engine.
      expect(normalizeNameKey('WebGLMinesweeper')).toBe('webglminesweeper');
      expect(normalizeNameKey('MinesweeperWebGL')).toBe('minesweeperwebgl');
    });

    it('branch auto-suffixes semantic-duplicate overrideNames (case / punctuation variants)', () => {
      r.create(1, baseSeed);
      const a = r.branch(
        'Water',
        { systemPromptAppend: 'a' },
        'tester',
        'Minesweeper-WebGL'
      );
      expect(a.name).toBe('Minesweeper-WebGL');

      // Different casing / separator → same normalized key → must be suffixed.
      // NOTE: this case used to read 'minesweeper webgl', with a SPACE. That
      // name is now refused by `isSafeAtomName` and the branch falls back to
      // the taxonomy — deliberately. An atom name is also the skill store's
      // namespace directory, and `SkillRegistry.loadFor('minesweeper webgl')`
      // THROWS ("unsafe skill path component"), so the registry was minting
      // names that crashed the skill machinery on first touch. The
      // semantic-duplicate behaviour under test here is unchanged; only the
      // fixture had to become a name the whole system can represent.
      const b = r.branch(
        'Water',
        { systemPromptAppend: 'b' },
        'tester',
        'minesweeper_webgl'
      );
      // Falls through the entire `-N` ladder until the normalized key is free.
      expect(b.name.startsWith('minesweeper_webgl-')).toBe(true);
      expect(b.name).not.toBe('minesweeper_webgl');
      // The normalized key is guaranteed distinct from the first branch.
      expect(normalizeNameKey(b.name)).not.toBe(normalizeNameKey(a.name));
    });

    it('refuses an overrideName the skill store could not namespace by', () => {
      // A name with a space passed every registry check and then threw in
      // SkillRegistry.sanitise the moment any skill was loaded for it. The
      // two layers now agree on what a name may be.
      r.create(1, baseSeed);
      const b = r.branch('Water', { systemPromptAppend: 'a' }, 'tester', 'minesweeper webgl');
      expect(b.name).not.toContain(' ');
      expect(isSafeAtomName(b.name)).toBe(true);
    });

    it('branch on a genuinely different name is untouched', () => {
      r.create(1, baseSeed);
      r.branch('Water', { systemPromptAppend: 'a' }, 'tester', 'Minesweeper-WebGL');
      // Different word order → different normalized key → no collision.
      const b = r.branch(
        'Water',
        { systemPromptAppend: 'b' },
        'tester',
        'WebGLMinesweeper'
      );
      expect(b.name).toBe('WebGLMinesweeper');
    });

    it('findDuplicateGroups surfaces same-tier same-key clusters only', () => {
      // `branch` now prevents new semantic duplicates from entering the
      // registry, so we can't *create* dupes through the public API.
      // The dedupe tool exists precisely to clean up DBs that accumulated
      // duplicates BEFORE that guard was added — we simulate that legacy
      // state by using separate DB instances and inserting pre-existing
      // rows via raw SQL (same tier, names that normalize to the same key).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (r as any).db as import('../src/registry/db.js').DB;
      const insert = db.prepare(
        `INSERT INTO atom_types
         (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version, atom_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, lower(hex(randomblob(16))))`
      );
      const now = new Date().toISOString();
      insert.run(1, 1, 'Minesweeper-WebGL', 'd', 's', '[]', '{}', 't', now);
      insert.run(1, 2, 'minesweeper_webgl', 'd', 's', '[]', '{}', 't', now);
      insert.run(1, 3, 'MINESWEEPER WEBGL', 'd', 's', '[]', '{}', 't', now);
      insert.run(1, 4, 'WebGLMinesweeper', 'd', 's', '[]', '{}', 't', now); // different key → lone
      insert.run(2, 1, 'Tracheid', 'd', 's', '[]', '{}', 't', now);

      const groups = r.findDuplicateGroups();
      const mine = groups.find(
        (g) => g.tier === 1 && g.key === 'minesweeperwebgl'
      );
      expect(mine).toBeTruthy();
      expect(mine!.types.length).toBe(3);
      // WebGLMinesweeper (different word order → different key) is NOT in
      // the duplicate group — the pragmatic normalization is order-sensitive
      // by design.
      expect(mine!.types.some((t) => t.name === 'WebGLMinesweeper')).toBe(false);
      // Tracheid is alone on its tier → no group at all.
      expect(groups.some((g) => g.tier === 2)).toBe(false);
    });

    it('mergeInto sums counters, archives losers under the winner, and deletes loser rows', () => {
      // Simulate a legacy polluted DB (branch now prevents the dupes).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (r as any).db as import('../src/registry/db.js').DB;
      const insert = db.prepare(
        `INSERT INTO atom_types
         (tier, ordinal, name, description, system_prompt, tools_json, params_json, created_by, created_at, version, successes, failures, atom_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, lower(hex(randomblob(16))))`
      );
      const now = new Date().toISOString();
      insert.run(1, 1, 'Widget', 'd', 's', '[]', '{}', 't', now, 1, 0);
      insert.run(1, 2, 'dup-a', 'd', 'sa', '[]', '{}', 't', now, 1, 0);
      insert.run(1, 3, 'dup-b', 'd', 'sb', '[]', '{}', 't', now, 1, 1);

      const refreshed = r.mergeInto('Widget', ['dup-a', 'dup-b']);
      expect(refreshed.successes).toBe(3);
      expect(refreshed.failures).toBe(1);

      for (const name of ['dup-a', 'dup-b']) {
        expect(r.getByName(name)).toBeNull();
      }
      const hist = r.versionsOf('Widget');
      expect(hist.length).toBeGreaterThanOrEqual(2);
      expect(hist.some((h) => (h.reason ?? '').includes('merged from dup-a'))).toBe(true);
      expect(hist.some((h) => (h.reason ?? '').includes('merged from dup-b'))).toBe(true);
    });

    it('mergeInto refuses to cross tier boundaries', () => {
      r.create(1, baseSeed);
      r.create(2, { ...baseSeed, description: 'm' });
      expect(() => r.mergeInto('Tracheid', ['Water'])).toThrow(/cannot merge/);
    });

    it('branch on a tier with no existing types does not crash on the normalized-key probe', () => {
      // Regression guard: a fresh empty tier must let `branch` succeed
      // without attempting to compare against an empty key set.
      r.create(2, { ...baseSeed, description: 'l2-seed' });
      // Tier 2 is the only populated tier — branching on Tracheid should work.
      const b = r.branch('Tracheid', { systemPromptAppend: 'x' }, 't', 'NovelName');
      expect(b.name).toBe('NovelName');
    });

    it('mergeInto is a no-op with an empty loser list', () => {
      const h = r.create(1, baseSeed);
      const out = r.mergeInto(h.name, []);
      expect(out.name).toBe(h.name);
      expect(out.successes).toBe(0);
    });
  });

  describe('branch-provenance description handling', () => {
    it('stripBranchProvenance peels every trailing (branched from X) suffix', () => {
      expect(
        stripBranchProvenance('core text (branched from A)')
      ).toBe('core text');
      expect(
        stripBranchProvenance(
          'core text (branched from A) (branched from B) (branched from C)'
        )
      ).toBe('core text');
      expect(stripBranchProvenance('plain text')).toBe('plain text');
      // Interior (branched from ...) phrases should NOT be stripped.
      expect(
        stripBranchProvenance('note (branched from A) follow-up')
      ).toBe('note (branched from A) follow-up');
    });

    it('branch sets description to "<core> (branched from <source>)" — single suffix only', () => {
      r.create(1, baseSeed);
      const b1 = r.branch(
        'Water',
        { systemPromptAppend: 'a' },
        'tester',
        'ChildA'
      );
      expect(b1.description).toBe('test molecule (branched from Water)');

      // Branching again from the already-branched type must NOT produce
      // "(branched from Water) (branched from ChildA)". The
      // Water-provenance tail of the source is peeled first.
      const b2 = r.branch(
        'ChildA',
        { systemPromptAppend: 'b' },
        'tester',
        'ChildB'
      );
      expect(b2.description).toBe('test molecule (branched from ChildA)');
      expect(
        (b2.description.match(/\(branched from/g) ?? []).length
      ).toBe(1);
    });

    it('patch with descriptionReplace updates the canonical description (and bumps the version)', () => {
      const h = r.create(1, baseSeed);
      const patched = r.patch(
        h.name,
        { descriptionReplace: 'NEW purpose sentence' },
        'tester',
        'fix drift'
      );
      expect(patched.description).toBe('NEW purpose sentence');
      expect(patched.version).toBe(2);
      // A fresh read from the DB reflects it too.
      expect(r.getByName(h.name)?.description).toBe('NEW purpose sentence');
    });

    it('descriptionReplace preserves an existing (branched from X) tail', () => {
      r.create(1, baseSeed);
      const b = r.branch('Water', { systemPromptAppend: 'a' }, 'tester', 'Child');
      const patched = r.patch(
        b.name,
        { descriptionReplace: 'NEW purpose' },
        'tester',
        'describe drift fix'
      );
      // Core text replaced; branch-provenance tail kept so we don't lose
      // ancestry info.
      expect(patched.description).toBe('NEW purpose (branched from Water)');
    });

    it('description-only patch bumps the version (it\'s meaningful, not a no-op)', () => {
      const h = r.create(1, baseSeed);
      const patched = r.patch(
        h.name,
        { descriptionReplace: 'just a description change' },
        'tester'
      );
      expect(patched.version).toBe(2);
    });

    it('patch with byte-identical description + prompt + tools + params stays a no-op', () => {
      const h = r.create(1, baseSeed);
      const patched = r.patch(
        h.name,
        { descriptionReplace: h.description },
        'tester'
      );
      expect(patched.version).toBe(1);
    });
  });
});
