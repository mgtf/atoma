import { z } from 'zod';
import { isAccountTierSelection, isValidTierModelSelection } from '../core/providerCatalog.js';
import { tierPinVariable, tryParseModelSelector, TIERS, type TierNumber } from './modelSelector.js';

/**
 * PER-TIER MODEL SELECTION — THE ONE CHOICE CONTRACT.
 * ===================================================
 *
 * The project's unit of configuration is the TIER (`ATOMA_MODEL_L1/L2/L3`).
 * Three consumers must not drift, and this file is their ONE definition:
 * the auth store's validators (per-principal and per-org rows), the run
 * environment builder (`projects/coordinator.ts`), and the Settings
 * selectors in the GL client.
 *
 * Every value is a full selector (`contracts/modelSelector.ts`), VALIDATED
 * AGAINST THE CATALOGUE, not free text (`core/providerCatalog.ts`): an unknown
 * model id is only discovered at the first BILLABLE call, mid-run, and
 * refusing it at the settings write is the cheap place to fail.
 *
 * `null` on a tier means "inherit": a member tier with null takes the org's
 * default where one is set, else the operator's host pin. Neither level ever
 * stores the resolved value — that would freeze today's model into the row.
 */

/**
 * ONE SHAPE, TWO ADMISSIBLE VALUE SPACES, both defined here.
 *
 * The `{l1,l2,l3}` triple is stated once, by this factory, and instantiated
 * twice: the ORG-level space accepts exactly the `api:` choices the catalogue
 * offers, and the ACCOUNT-level space additionally accepts the `sub:` and
 * `own:` families. The difference is the whole reason a subscription cannot be
 * inherited: an org default is read by every member by construction, so a
 * payer-bearing value there would need a fail-closed re-ask on every tenant
 * run — and a gate that fires constantly is a gate that gets ignored
 * (design 2026-08-28, D2).
 *
 * `null` still means "inherit" at both levels, and never means "subscription".
 */
function selectionSchema(accepts: (value: string) => boolean, message: string) {
  return z.string().trim().min(1).max(200).refine(accepts, { message }).nullable();
}

const orgSelection = selectionSchema(
  isValidTierModelSelection,
  'must be an api:<vendor>:<model> selector the catalogue offers'
);

export const tierModelPinsSchema = z.object({ l1: orgSelection, l2: orgSelection, l3: orgSelection });

/**
 * The account level, which MAY name a subscription. Storage verifies shape;
 * the ROUTE verifies authority, and the coordinator re-asks it per run — a
 * stored selector is data, never permission. ChatGPT is available on all tiers;
 * its tool-bearing calls are executed by Atoma's scoped host-side bridge.
 */
function accountSelection(tier: TierNumber) {
  return selectionSchema(
    (value) => isAccountTierSelection(value, tier),
    'must be a catalogue model or an account subscription available to this tier'
  );
}

export const accountTierModelPinsSchema = z.object({
  l1: accountSelection(1),
  l2: accountSelection(2),
  l3: accountSelection(3),
});

export type TierModelPins = z.infer<typeof tierModelPinsSchema>;

export const EMPTY_TIER_MODEL_PINS: TierModelPins = { l1: null, l2: null, l3: null };

/** Parsed at module load: a schema/example mismatch must fail tests at once. */
export const TIER_MODEL_PINS_EXAMPLE: TierModelPins = tierModelPinsSchema.parse({
  l1: 'api:anthropic:claude-haiku-4-5-20251001',
  l2: 'api:anthropic:claude-sonnet-5',
  l3: null,
});

/** `pins.l1` / `.l2` / `.l3` addressed by numeric tier, which is the storage identity. */
export function pinForTier(pins: TierModelPins, tier: TierNumber): string | null {
  return tier === 1 ? pins.l1 : tier === 2 ? pins.l2 : pins.l3;
}

/** Where a candidate came from. The chain is walked in this order. */
export const TIER_CHAIN_LEVELS = ['account', 'org', 'host'] as const;

export type TierChainLevel = (typeof TIER_CHAIN_LEVELS)[number];

export interface TierChainCandidate {
  readonly level: TierChainLevel;
  readonly value: string;
}

/**
 * THE PRECEDENCE CHAIN, walked once, here.
 *
 * `accept` is LEVEL-AWARE, which is what makes a subscription selector
 * admissible from an account pin and refusable everywhere else without the
 * caller restating the order. It has three answers, and they are not
 * interchangeable: `take` routes the candidate, `skip` falls through to the
 * next level (a credential nobody brought), and THROWING refuses the run (a
 * vendor you may not use, or an authority you no longer hold). Fall-through
 * is permitted within a payer; refusal is required across payers.
 */
export function resolveTierChain(
  candidates: readonly (TierChainCandidate | null)[],
  accept: (candidate: TierChainCandidate) => 'take' | 'skip'
): TierChainCandidate | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate.value.trim();
    if (!value) continue;
    const resolved: TierChainCandidate = { level: candidate.level, value };
    if (accept(resolved) === 'take') return resolved;
  }
  return null;
}

/** The three candidates for one tier, in precedence order, nulls preserved. */
export function tierChainCandidates(input: {
  readonly account?: TierModelPins | undefined;
  readonly org?: TierModelPins | undefined;
  readonly host?: string | null | undefined;
  readonly tier: TierNumber;
}): readonly (TierChainCandidate | null)[] {
  const account = input.account ? pinForTier(input.account, input.tier) : null;
  const org = input.org ? pinForTier(input.org, input.tier) : null;
  return [
    account === null ? null : { level: 'account', value: account },
    org === null ? null : { level: 'org', value: org },
    input.host ? { level: 'host', value: input.host } : null,
  ];
}

/**
 * What the account UI shows beside each tier as the "operator default": the
 * HOST snapshot's selector for that tier, or null where the host set none or
 * set something unparsable. Resolved from the env the caller holds, never
 * from a copy of anything — there are no built-in defaults to copy.
 */
export function operatorTierDefaults(
  env: NodeJS.ProcessEnv
): Record<'l1' | 'l2' | 'l3', string | null> {
  const out = { l1: null, l2: null, l3: null } as Record<'l1' | 'l2' | 'l3', string | null>;
  for (const tier of TIERS) {
    const value = env[tierPinVariable(tier)]?.trim();
    out[`l${tier}`] = value && tryParseModelSelector(value) ? value : null;
  }
  return out;
}
