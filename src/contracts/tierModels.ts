import { z } from 'zod';
import { FALLBACK_OPUS, PIN_HAIKU, PIN_SONNET, modelForTier } from '../core/models.js';

/**
 * PER-PRINCIPAL TIER MODEL PINS.
 * ==============================
 *
 * The project's unit of configuration is the TIER (`ATOMA_MODEL_L1/L2/L3`),
 * and a viz account can now choose its own per-tier model. This file is the
 * ONE definition of what a viewer is allowed to choose, read by three
 * consumers that must not drift: the auth store's validator, the run
 * environment builder, and the Settings selector in the GL client.
 *
 * A CLOSED LIST, not free text, for two reasons:
 *
 * - `projectRunEnvironment` refuses any pin containing `:` — a tenant run may
 *   not be routed to another provider. Choices drawn from `core/models.ts`
 *   cannot contain one, so the refusal never fires on a legitimate choice and
 *   stays available as a last line of defence.
 * - An unknown model id is only discovered at the first BILLABLE call, mid-run.
 *   Refusing it at the settings write is the cheap place to fail.
 *
 * `null` on a tier means "operator default": the run inherits whatever the
 * host environment pins, or the built-in tier default. Never store the
 * resolved default — that would freeze today's model into the account.
 */

export const TIER_MODEL_CHOICES = [PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS] as const;

export type TierModelChoice = (typeof TIER_MODEL_CHOICES)[number];

const tierModelChoiceSchema = z.enum(TIER_MODEL_CHOICES).nullable();

export const tierModelPinsSchema = z.object({
  l1: tierModelChoiceSchema,
  l2: tierModelChoiceSchema,
  l3: tierModelChoiceSchema,
});

export type TierModelPins = z.infer<typeof tierModelPinsSchema>;

export const EMPTY_TIER_MODEL_PINS: TierModelPins = { l1: null, l2: null, l3: null };

/** Parsed at module load: a schema/example mismatch must fail tests at once. */
export const TIER_MODEL_PINS_EXAMPLE: TierModelPins = tierModelPinsSchema.parse({
  l1: PIN_HAIKU,
  l2: PIN_SONNET,
  l3: null,
});

/** `pins.l1` / `.l2` / `.l3` addressed by numeric tier, which is the storage identity. */
export function pinForTier(pins: TierModelPins, tier: 1 | 2 | 3): TierModelChoice | null {
  return tier === 1 ? pins.l1 : tier === 2 ? pins.l2 : pins.l3;
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
