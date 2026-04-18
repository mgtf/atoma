import { describe, it, expect } from 'vitest';
import {
  nextAvailableElement,
  ELEMENTS,
} from '../src/registry/taxonomies/elements.js';
import { nextAvailableMolecule, MOLECULES } from '../src/registry/taxonomies/molecules.js';
import { nextAvailableCell, CELLS } from '../src/registry/taxonomies/cells.js';

describe('allocators', () => {
  it('first element allocated is Hydrogen', () => {
    expect(nextAvailableElement(new Set())).toEqual({ ordinal: 1, name: 'Hydrogen' });
  });

  it('second element allocated is Helium', () => {
    expect(nextAvailableElement(new Set([1]))).toEqual({ ordinal: 2, name: 'Helium' });
  });

  it('skips used ordinals', () => {
    expect(nextAvailableElement(new Set([1, 2, 3]))).toEqual({ ordinal: 4, name: 'Beryllium' });
  });

  it('extends past 118 with systematic Element${n}', () => {
    const used = new Set<number>();
    for (const e of ELEMENTS) used.add(e.number);
    expect(nextAvailableElement(used)).toEqual({ ordinal: 119, name: 'Element119' });
  });

  it('molecules start with Water', () => {
    expect(nextAvailableMolecule(new Set())).toEqual({ ordinal: 1, name: 'Water' });
  });

  it('cells start with Neuron', () => {
    expect(nextAvailableCell(new Set())).toEqual({ ordinal: 1, name: 'Neuron' });
  });

  it('molecules/cells extend with systematic names past the curated list', () => {
    const mUsed = new Set<number>();
    for (const m of MOLECULES) mUsed.add(m.ordinal);
    expect(nextAvailableMolecule(mUsed).name).toBe(`Molecule${MOLECULES.length + 1}`);

    const cUsed = new Set<number>();
    for (const c of CELLS) cUsed.add(c.ordinal);
    expect(nextAvailableCell(cUsed).name).toBe(`Cell${CELLS.length + 1}`);
  });
});
