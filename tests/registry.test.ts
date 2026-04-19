import { describe, it, expect, beforeEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

function makeRegistry(): AtomRegistry {
  return new AtomRegistry(openDb(':memory:'));
}

const baseSeed = {
  description: 'test element',
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

  it('assigns Hydrogen for the first L1 type', () => {
    const t = r.create(1, baseSeed);
    expect(t.name).toBe('Hydrogen');
    expect(t.ordinal).toBe(1);
    expect(t.tier).toBe(1);
    expect(t.version).toBe(1);
  });

  it('assigns Helium, Lithium for subsequent L1 types', () => {
    r.create(1, baseSeed);
    const he = r.create(1, baseSeed);
    const li = r.create(1, baseSeed);
    expect(he.name).toBe('Helium');
    expect(li.name).toBe('Lithium');
  });

  it('assigns Water / Methane for L2, Neuron for L3', () => {
    expect(r.create(2, { ...baseSeed, description: 'l2-a' }).name).toBe('Water');
    expect(r.create(2, { ...baseSeed, description: 'l2-b' }).name).toBe('Methane');
    expect(r.create(3, { ...baseSeed, description: 'l3-a' }).name).toBe('Neuron');
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
    const branched = r.branch('Hydrogen', { systemPromptAppend: 'extra' }, 'tester');
    expect(branched.name).toBe('Helium');
    expect(branched.tier).toBe(1);
    expect(branched.systemPrompt).toContain('extra');
  });

  it('branch respects an overrideName when no collision', () => {
    r.create(1, baseSeed);
    const b = r.branch('Hydrogen', { systemPromptAppend: 'x' }, 'tester', 'CustomName');
    expect(b.name).toBe('CustomName');
    expect(b.tier).toBe(1);
  });

  it('branch auto-suffixes overrideName on collision instead of throwing', () => {
    r.create(1, baseSeed);
    const first = r.branch('Hydrogen', { systemPromptAppend: 'a' }, 'tester', 'Oxide');
    expect(first.name).toBe('Oxide');

    const second = r.branch('Hydrogen', { systemPromptAppend: 'b' }, 'tester', 'Oxide');
    expect(second.name).toBe('Oxide-2');

    const third = r.branch('Hydrogen', { systemPromptAppend: 'c' }, 'tester', 'Oxide');
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
    expect(tier1.map((t) => t.name)).toEqual(['Hydrogen', 'Helium']);
    expect(r.listByTier(2).length).toBe(1);
  });

  it('getByName returns the type regardless of tier', () => {
    r.create(1, baseSeed);
    r.create(2, { ...baseSeed, description: 'water-ish' });
    expect(r.getByName('Water')?.tier).toBe(2);
    expect(r.getByName('Hydrogen')?.tier).toBe(1);
  });
});
