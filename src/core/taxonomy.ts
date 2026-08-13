import type { Tier } from './types.js';

export type AgentRank = 'molecule' | 'cell' | 'tissue';

export interface TierTaxonomy {
  readonly tier: Tier;
  readonly rank: AgentRank;
  readonly label: 'Molecule' | 'Cell' | 'Tissue';
  readonly plural: 'Molecules' | 'Cells' | 'Tissues';
}

const BY_TIER: Readonly<Record<Tier, TierTaxonomy>> = {
  1: { tier: 1, rank: 'molecule', label: 'Molecule', plural: 'Molecules' },
  2: { tier: 2, rank: 'cell', label: 'Cell', plural: 'Cells' },
  3: { tier: 3, rank: 'tissue', label: 'Tissue', plural: 'Tissues' },
};

/** Numeric tiers remain the stable DB/trace/model-routing contract. */
export function taxonomyForTier(tier: Tier): TierTaxonomy {
  return BY_TIER[tier];
}
