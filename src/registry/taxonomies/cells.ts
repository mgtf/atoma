export interface Cell {
  readonly ordinal: number;
  readonly name: string;
}

export const CELLS: readonly Cell[] = [
  { ordinal: 1, name: 'Neuron' },
  { ordinal: 2, name: 'Erythrocyte' },
  { ordinal: 3, name: 'Leukocyte' },
  { ordinal: 4, name: 'Macrophage' },
  { ordinal: 5, name: 'Hepatocyte' },
  { ordinal: 6, name: 'Myocyte' },
  { ordinal: 7, name: 'Osteocyte' },
  { ordinal: 8, name: 'Adipocyte' },
  { ordinal: 9, name: 'Keratinocyte' },
  { ordinal: 10, name: 'Melanocyte' },
  { ordinal: 11, name: 'Astrocyte' },
  { ordinal: 12, name: 'Oligodendrocyte' },
  { ordinal: 13, name: 'Enterocyte' },
  { ordinal: 14, name: 'Fibroblast' },
  { ordinal: 15, name: 'Chondrocyte' },
  { ordinal: 16, name: 'Platelet' },
  { ordinal: 17, name: 'Pneumocyte' },
  { ordinal: 18, name: 'Podocyte' },
  { ordinal: 19, name: 'Pericyte' },
  { ordinal: 20, name: 'Lymphocyte' },
];

export function nextAvailableCell(used: Set<number>): { ordinal: number; name: string } {
  for (const c of CELLS) {
    if (!used.has(c.ordinal)) return { ordinal: c.ordinal, name: c.name };
  }
  let n = CELLS.length + 1;
  while (used.has(n)) n++;
  return { ordinal: n, name: `Cell${n}` };
}
