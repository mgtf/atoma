export interface Tissue {
  readonly ordinal: number;
  readonly name: string;
}

/**
 * Tier-3 supervisors use botanical tissue names: natural, non-medical and
 * compositionally above tier-2 cells. The rank already says "Tissue", so
 * names do not carry a redundant suffix.
 */
export const TISSUES: readonly Tissue[] = [
  { ordinal: 1, name: 'Meristem' },
  { ordinal: 2, name: 'Xylem' },
  { ordinal: 3, name: 'Phloem' },
  { ordinal: 4, name: 'Cambium' },
  { ordinal: 5, name: 'Epidermis' },
  { ordinal: 6, name: 'Mesophyll' },
  { ordinal: 7, name: 'Parenchyma' },
  { ordinal: 8, name: 'Collenchyma' },
  { ordinal: 9, name: 'Sclerenchyma' },
  { ordinal: 10, name: 'Periderm' },
  { ordinal: 11, name: 'Endodermis' },
  { ordinal: 12, name: 'Rhizodermis' },
  { ordinal: 13, name: 'Exodermis' },
  { ordinal: 14, name: 'Phellem' },
  { ordinal: 15, name: 'Phelloderm' },
  { ordinal: 16, name: 'Aerenchyma' },
  { ordinal: 17, name: 'Chlorenchyma' },
  { ordinal: 18, name: 'Prosenchyma' },
  { ordinal: 19, name: 'Tapetum' },
  { ordinal: 20, name: 'Cork' },
];

export function nextAvailableTissue(used: Set<number>): { ordinal: number; name: string } {
  for (const tissue of TISSUES) {
    if (!used.has(tissue.ordinal)) return { ordinal: tissue.ordinal, name: tissue.name };
  }
  let n = TISSUES.length + 1;
  while (used.has(n)) n++;
  return { ordinal: n, name: `Tissue${n}` };
}
