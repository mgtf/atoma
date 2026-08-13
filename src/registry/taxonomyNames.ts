import type { Tier } from '../core/types.js';
import { ELEMENTS } from '../contracts/toolTaxonomy.js';
import { MOLECULES } from './taxonomies/molecules.js';
import { CELLS } from './taxonomies/cells.js';
import { TISSUES } from './taxonomies/tissues.js';

const LEGACY_MOLECULE_NAME_COUNT = 40;
const LEGACY_CELL_NAMES = [
  'Neuron',
  'Erythrocyte',
  'Leukocyte',
  'Macrophage',
  'Hepatocyte',
  'Myocyte',
  'Osteocyte',
  'Adipocyte',
  'Keratinocyte',
  'Melanocyte',
  'Astrocyte',
  'Oligodendrocyte',
  'Enterocyte',
  'Fibroblast',
  'Chondrocyte',
  'Platelet',
  'Pneumocyte',
  'Podocyte',
  'Pericyte',
  'Lymphocyte',
] as const;

function nameAt(
  entries: readonly { readonly ordinal?: number; readonly number?: number; readonly name: string }[],
  ordinal: number,
  fallback: string
): string {
  const found = entries.find((entry) => (entry.ordinal ?? entry.number) === ordinal);
  return found?.name ?? `${fallback}${ordinal}`;
}

export function legacyTaxonomyName(tier: Tier, ordinal: number): string {
  switch (tier) {
    case 1:
      return nameAt(ELEMENTS, ordinal, 'Element');
    case 2:
      return ordinal <= LEGACY_MOLECULE_NAME_COUNT
        ? nameAt(MOLECULES, ordinal, 'Molecule')
        : `Molecule${ordinal}`;
    case 3:
      return ordinal <= LEGACY_CELL_NAMES.length
        ? LEGACY_CELL_NAMES[ordinal - 1]!
        : `Cell${ordinal}`;
  }
}

export function currentTaxonomyName(tier: Tier, ordinal: number): string {
  switch (tier) {
    case 1:
      return nameAt(MOLECULES, ordinal, 'Molecule');
    case 2:
      return nameAt(CELLS, ordinal, 'Cell');
    case 3:
      return nameAt(TISSUES, ordinal, 'Tissue');
  }
}

function legacyOrdinal(tier: Tier, name: string): number | undefined {
  if (tier === 1) {
    const element = ELEMENTS.find((entry) => entry.name === name);
    if (element) return element.number;
    const fallback = /^Element(\d+)$/.exec(name);
    return fallback ? Number(fallback[1]) : undefined;
  }
  if (tier === 2) {
    const molecule = MOLECULES
      .slice(0, LEGACY_MOLECULE_NAME_COUNT)
      .find((entry) => entry.name === name);
    if (molecule) return molecule.ordinal;
    const fallback = /^Molecule(\d+)$/.exec(name);
    return fallback ? Number(fallback[1]) : undefined;
  }
  const index = LEGACY_CELL_NAMES.indexOf(name as (typeof LEGACY_CELL_NAMES)[number]);
  if (index >= 0) return index + 1;
  const fallback = /^Cell(\d+)$/.exec(name);
  return fallback ? Number(fallback[1]) : undefined;
}

/**
 * Display projection for immutable pre-v2 traces.
 *
 * Structured snapshots provide an ordinal, which prevents a custom override
 * that happens to resemble a legacy name from being rewritten. Actor/child
 * refs carry only tier+name, so those fall back to the old curated lookup.
 */
export function currentDisplayName(
  tierValue: number | undefined,
  name: string | undefined,
  ordinal?: number
): string | undefined {
  if (!name || (tierValue !== 1 && tierValue !== 2 && tierValue !== 3)) return name;
  const tier = tierValue;
  if (ordinal !== undefined) {
    return legacyTaxonomyName(tier, ordinal) === name
      ? currentTaxonomyName(tier, ordinal)
      : name;
  }
  const inferred = legacyOrdinal(tier, name);
  return inferred === undefined ? name : currentTaxonomyName(tier, inferred);
}
