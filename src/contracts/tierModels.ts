import { z } from 'zod';
import { FALLBACK_OPUS, PIN_HAIKU, PIN_SONNET, modelForTier } from '../core/models.js';
import { isValidTierModelSelection } from '../core/providerCatalog.js';
import { isHostSubscriptionSelection } from './runPayers.js';

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
 * VALIDATED AGAINST THE CATALOGUE, not free text (`core/providerCatalog.ts`),
 * for three reasons:
 *
 * - A selection may now be a full `provider:model` selector (org-level
 *   defaults and member overrides alike): the run child builds a routing
 *   client per referenced provider when the org has configured its key. The
 *   catalogue contains exactly the credential-honouring providers
 *   `docs/saas-architecture.md` permits on the tenant plane; claude-cli and
 *   codex cannot appear in a stored choice.
 * - An unknown model id is only discovered at the first BILLABLE call,
 *   mid-run. Refusing it at the settings write is the cheap place to fail.
 * - The historical bare-id spelling (one of the built-in Anthropic pins,
 *   no provider prefix) stays VALID so existing principal rows keep their
 *   meaning; new writes are encouraged onto the explicit prefix form by the
 *   UI, which always writes one.
 *
 * `null` on a tier means "inherit": a member tier with null takes the org's
 * default where one is set, else the operator's host pin or built-in tier
 * default. Neither level ever stores the resolved value — that would freeze
 * today's model into the row.
 */

export const TIER_MODEL_CHOICES = [PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS] as const;

export type TierModelChoice = (typeof TIER_MODEL_CHOICES)[number];

/**
 * ONE SHAPE, TWO ADMISSIBLE VALUE SPACES, both defined here.
 *
 * The `{l1,l2,l3}` triple is stated once, by this factory, and instantiated
 * twice: the ORG-level space accepts exactly what the provider catalogue
 * offers, and the ACCOUNT-level space additionally accepts the non-routable
 * host-subscription sentinel (`contracts/runPayers.ts`). The difference is the
 * whole reason the sentinel cannot be inherited: an org default is read by
 * every member by construction, so a payer-bearing value there would need a
 * fail-closed re-ask on every tenant run — and a gate that fires constantly is
 * a gate that gets ignored (design 2026-08-28, D2).
 *
 * `null` still means "inherit" at both levels, and never means "subscription".
 */
function tierPinsSchemaFor(accepts: (value: string) => boolean, message: string) {
  const selection = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(accepts, { message })
    .nullable();
  return z.object({ l1: selection, l2: selection, l3: selection });
}

export const tierModelPinsSchema = tierPinsSchemaFor(
  isValidTierModelSelection,
  'must be a model offered by the provider catalogue'
);

/**
 * The account level, which MAY name the host subscription. Storage verifies
 * shape; the ROUTE verifies authority, and the coordinator re-asks it per run
 * — a stored sentinel is data, never permission.
 */
export const accountTierModelPinsSchema = tierPinsSchemaFor(
  (value) => isValidTierModelSelection(value) || isHostSubscriptionSelection(value),
  'must be a catalogue model or the host subscription'
);

export type TierModelPins = z.infer<typeof tierModelPinsSchema>;

export const EMPTY_TIER_MODEL_PINS: TierModelPins = { l1: null, l2: null, l3: null };

/** Parsed at module load: a schema/example mismatch must fail tests at once. */
export const TIER_MODEL_PINS_EXAMPLE: TierModelPins = tierModelPinsSchema.parse({
  l1: PIN_HAIKU,
  // The explicit-selector spelling the UI writes today:
  l2: 'anthropic:claude-sonnet-5',
  l3: null,
});

/** `pins.l1` / `.l2` / `.l3` addressed by numeric tier, which is the storage identity. */
export function pinForTier(pins: TierModelPins, tier: 1 | 2 | 3): string | null {
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
 * Replaces `effectiveTierSelection`, which documented itself as "the exact
 * function both the coordinator and the Settings API reuse instead of
 * re-implementing precedence" and had ZERO callers, while
 * `projectRunEnvironment` re-implemented the walk inline as three parallel
 * candidate arrays — with a THIRD level (the host env) this contract did not
 * model, and named this function in its own docstring as though it called it.
 * One concept, two definitions, exactly what the root AGENTS.md warns about,
 * in the file a fourth kind of value has to edit (design 2026-08-28, D12).
 *
 * `accept` is LEVEL-AWARE, which is what makes the host-subscription sentinel
 * admissible from an account pin and refusable everywhere else without the
 * caller restating the order. It has three answers, and they are not
 * interchangeable: `take` routes the candidate, `skip` falls through to the
 * next level (a credential nobody brought), and THROWING refuses the run (a
 * provider you may not use, or an authority you no longer hold). Fall-through
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
  readonly tier: 1 | 2 | 3;
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
 * What the account UI must show beside each tier as its "operator default"
 * label. Resolved from the HOST snapshot the caller holds, never from a
 * hardcoded copy of the tier defaults.
 */
export function operatorTierDefaults(
  env: NodeJS.ProcessEnv
): Record<'l1' | 'l2' | 'l3', string> {
  return {
    l1: modelForTier(1, env),
    l2: modelForTier(2, env),
    l3: modelForTier(3, env),
  };
}
