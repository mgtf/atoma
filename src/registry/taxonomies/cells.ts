/**
 * Tier-2 supervisor identities drawn from plant, microbial and animal life.
 * The rank already says "Cell", so names avoid a generated suffix.
 */
export interface Cell {
  readonly ordinal: number;
  readonly name: string;
}

export const CELLS: readonly Cell[] = [
  { ordinal: 1, name: 'Tracheid' },
  { ordinal: 2, name: 'Sclereid' },
  { ordinal: 3, name: 'Idioblast' },
  { ordinal: 4, name: 'Protoplast' },
  { ordinal: 5, name: 'Trichome' },
  { ordinal: 6, name: 'Guard' },
  { ordinal: 7, name: 'Companion' },
  { ordinal: 8, name: 'Palisade' },
  { ordinal: 9, name: 'SieveElement' },
  { ordinal: 10, name: 'VesselElement' },
  { ordinal: 11, name: 'RootHair' },
  { ordinal: 12, name: 'Pollen' },
  { ordinal: 13, name: 'Spore' },
  { ordinal: 14, name: 'Gamete' },
  { ordinal: 15, name: 'Zygote' },
  { ordinal: 16, name: 'Diatom' },
  { ordinal: 17, name: 'Amoeba' },
  { ordinal: 18, name: 'Yeast' },
  { ordinal: 19, name: 'Choanocyte' },
  { ordinal: 20, name: 'Cnidocyte' },
  { ordinal: 21, name: 'Chromatophore' },
  { ordinal: 22, name: 'Photoreceptor' },
  { ordinal: 23, name: 'Neuron' },
  { ordinal: 24, name: 'Myocyte' },
  { ordinal: 25, name: 'Erythrocyte' },
  { ordinal: 26, name: 'Leukocyte' },
  { ordinal: 27, name: 'Hepatocyte' },
  { ordinal: 28, name: 'Osteocyte' },
  { ordinal: 29, name: 'Adipocyte' },
  { ordinal: 30, name: 'Keratinocyte' },
  { ordinal: 31, name: 'Melanocyte' },
  { ordinal: 32, name: 'Astrocyte' },
  { ordinal: 33, name: 'Microglia' },
  { ordinal: 34, name: 'Ependymocyte' },
  { ordinal: 35, name: 'Cardiomyocyte' },
  { ordinal: 36, name: 'Megakaryocyte' },
  { ordinal: 37, name: 'Trophoblast' },
  { ordinal: 38, name: 'Gametocyte' },
  { ordinal: 39, name: 'Cyanobacterium' },
  { ordinal: 40, name: 'Bacterium' },
];

export function nextAvailableCell(
  used: Set<number>,
  taken: ReadonlySet<string> = new Set()
): { ordinal: number; name: string } {
  for (const cell of CELLS) {
    if (!used.has(cell.ordinal) && !taken.has(cell.name)) {
      return { ordinal: cell.ordinal, name: cell.name };
    }
  }
  let n = CELLS.length + 1;
  while (used.has(n) || taken.has(`Cell${n}`)) n++;
  return { ordinal: n, name: `Cell${n}` };
}
