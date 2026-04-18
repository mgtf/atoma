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

  it('branch creates a new type with the next available name', () => {
    r.create(1, baseSeed);
    const branched = r.branch('Hydrogen', { systemPromptAppend: 'extra' }, 'tester');
    expect(branched.name).toBe('Helium');
    expect(branched.tier).toBe(1);
    expect(branched.systemPrompt).toContain('extra');
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
