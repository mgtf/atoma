import { z } from 'zod';
import { FALLBACK_OPUS, PIN_HAIKU, PIN_SONNET, modelForTier } from '../core/models.js';
import { isValidTierModelSelection } from '../core/providerCatalog.js';

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
 * One selection as STORAGE accepts it: bare historical id OR full selector.
 * The stricter per-write rules live in the schemas below.
 */
const storedSelectionSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isValidTierModelSelection, {
    message: 'must be a model offered by the provider catalogue',
  })
  .nullable();

export const tierModelPinsSchema = z.object({
  l1: storedSelectionSchema,
  l2: storedSelectionSchema,
  l3: storedSelectionSchema,
});

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

/**
 * Effective selection for one tier across BOTH preference levels:
 * the account's own pin wins, an org default fills a null, and a fully null
 * chain yields `null`, whose meaning stays "operator default". Pure, and
 * therefore the exact function both the coordinator and the Settings API
 * reuse instead of re-implementing precedence.
 */
export function effectiveTierSelection(input: {
  readonly org?: TierModelPins | undefined;
  readonly account: TierModelPins;
}): TierModelPins {
  const resolve = (tier: 1 | 2 | 3): string | null =>
    pinForTier(input.account, tier) ?? (input.org ? pinForTier(input.org, tier) : null);
  return { l1: resolve(1), l2: resolve(2), l3: resolve(3) };
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
