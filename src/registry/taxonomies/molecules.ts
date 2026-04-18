export interface Molecule {
  readonly ordinal: number;
  readonly name: string;
}

export const MOLECULES: readonly Molecule[] = [
  { ordinal: 1, name: 'Water' },
  { ordinal: 2, name: 'Methane' },
  { ordinal: 3, name: 'Ammonia' },
  { ordinal: 4, name: 'CarbonDioxide' },
  { ordinal: 5, name: 'Glucose' },
  { ordinal: 6, name: 'Sucrose' },
  { ordinal: 7, name: 'Ethanol' },
  { ordinal: 8, name: 'Methanol' },
  { ordinal: 9, name: 'Acetone' },
  { ordinal: 10, name: 'Benzene' },
  { ordinal: 11, name: 'Caffeine' },
  { ordinal: 12, name: 'Serotonin' },
  { ordinal: 13, name: 'Dopamine' },
  { ordinal: 14, name: 'Adrenaline' },
  { ordinal: 15, name: 'Insulin' },
  { ordinal: 16, name: 'Hemoglobin' },
  { ordinal: 17, name: 'Chlorophyll' },
  { ordinal: 18, name: 'DNA' },
  { ordinal: 19, name: 'RNA' },
  { ordinal: 20, name: 'ATP' },
  { ordinal: 21, name: 'Urea' },
  { ordinal: 22, name: 'Cholesterol' },
  { ordinal: 23, name: 'Testosterone' },
  { ordinal: 24, name: 'Estrogen' },
  { ordinal: 25, name: 'Cortisol' },
  { ordinal: 26, name: 'Melatonin' },
  { ordinal: 27, name: 'Histamine' },
  { ordinal: 28, name: 'Glycine' },
  { ordinal: 29, name: 'Alanine' },
  { ordinal: 30, name: 'Lysine' },
  { ordinal: 31, name: 'Tryptophan' },
  { ordinal: 32, name: 'Nicotine' },
  { ordinal: 33, name: 'Aspirin' },
  { ordinal: 34, name: 'Penicillin' },
  { ordinal: 35, name: 'Lactose' },
  { ordinal: 36, name: 'Fructose' },
  { ordinal: 37, name: 'Citrate' },
  { ordinal: 38, name: 'Oxytocin' },
  { ordinal: 39, name: 'Thyroxine' },
  { ordinal: 40, name: 'Keratin' },
];

export function nextAvailableMolecule(used: Set<number>): { ordinal: number; name: string } {
  for (const m of MOLECULES) {
    if (!used.has(m.ordinal)) return { ordinal: m.ordinal, name: m.name };
  }
  let n = MOLECULES.length + 1;
  while (used.has(n)) n++;
  return { ordinal: n, name: `Molecule${n}` };
}
