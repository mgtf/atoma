import { describe, it, expect } from 'vitest';
import {
  nextAvailableElement,
  ELEMENTS,
  BUILTIN_TOOL_ELEMENTS,
} from '../src/registry/taxonomies/elements.js';
import { nextAvailableMolecule, MOLECULES } from '../src/registry/taxonomies/molecules.js';
import { nextAvailableCell, CELLS } from '../src/registry/taxonomies/cells.js';
import { nextAvailableTissue, TISSUES } from '../src/registry/taxonomies/tissues.js';

describe('allocators', () => {
  it('curates the largest name pool for the most numerous agent rank', () => {
    expect([MOLECULES.length, CELLS.length, TISSUES.length]).toEqual([118, 40, 20]);
    const names = [...MOLECULES, ...CELLS, ...TISSUES].map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('elements classify tools rather than agent tiers', () => {
    expect(BUILTIN_TOOL_ELEMENTS[0]).toMatchObject({
      number: 1,
      name: 'Hydrogen',
      symbol: 'H',
      toolName: 'write_file',
    });
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

  it('tier-1 molecules start with Water', () => {
    expect(nextAvailableMolecule(new Set())).toEqual({ ordinal: 1, name: 'Water' });
  });

  it('tier-2 cells start with botanical Tracheid and do not repeat the rank suffix', () => {
    expect(nextAvailableCell(new Set())).toEqual({ ordinal: 1, name: 'Tracheid' });
    expect(CELLS.every((cell) => !/Cell$/.test(cell.name))).toBe(true);
  });

  it('tier-3 tissues start with botanical Meristem', () => {
    expect(nextAvailableTissue(new Set())).toEqual({ ordinal: 1, name: 'Meristem' });
  });

  it('agent ranks extend with systematic names past their curated lists', () => {
    const mUsed = new Set<number>();
    for (const m of MOLECULES) mUsed.add(m.ordinal);
    expect(nextAvailableMolecule(mUsed).name).toBe(`Molecule${MOLECULES.length + 1}`);

    const cUsed = new Set<number>();
    for (const c of CELLS) cUsed.add(c.ordinal);
    expect(nextAvailableCell(cUsed).name).toBe(`Cell${CELLS.length + 1}`);

    const tUsed = new Set<number>();
    for (const tissue of TISSUES) tUsed.add(tissue.ordinal);
    expect(nextAvailableTissue(tUsed).name).toBe(`Tissue${TISSUES.length + 1}`);
  });
});
