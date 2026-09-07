import {
  parseModelSelector,
  tierPinVariable,
  TIERS,
  type ModelSelector,
  type TierNumber,
  MODEL_SELECTOR_GRAMMAR,
  ModelSelectorError,
} from '../contracts/modelSelector.js';

/**
 * PER-TIER MODEL SELECTION. The project's unit of configuration is the TIER
 * (decreasing model power L3→L1 is the whole thesis), so the env vars are
 * named by tier and each holds one full selector (`contracts/modelSelector.ts`):
 *
 *   ATOMA_MODEL_L1=<api|sub|own>:<vendor>:<model>
 *   ATOMA_MODEL_L2=…
 *   ATOMA_MODEL_L3=…
 *
 * ALL THREE ARE REQUIRED AND THERE IS NO DEFAULT (2026-09-07). A tier nobody
 * configured throws here, at the first read, naming the variable — never a
 * silent model choice on somebody's bill.
 *
 * Read at CALL time so tests and per-run env changes behave. Pass `env` when
 * the caller holds a snapshot (T10): `modelForTier` and the router must see
 * the same pins or the router constructs a client the atoms never request.
 * Validators/prefilters always ride the L1 tier's selector — validation is a
 * yes/no, it belongs on the cheapest capable model regardless of vendor.
 */
export function modelForTier(tier: TierNumber, env: NodeJS.ProcessEnv = process.env): string {
  return formatOrThrow(tier, env).raw;
}

/** The parsed form of `modelForTier`, for callers that route on it. */
export function selectorForTier(
  tier: TierNumber,
  env: NodeJS.ProcessEnv = process.env
): ModelSelector {
  return formatOrThrow(tier, env).selector;
}

function formatOrThrow(
  tier: TierNumber,
  env: NodeJS.ProcessEnv
): { raw: string; selector: ModelSelector } {
  const variable = tierPinVariable(tier);
  const value = env[variable]?.trim();
  if (!value) {
    throw new ModelSelectorError(
      `${variable} is not set. Every tier names its model as ${MODEL_SELECTOR_GRAMMAR}; there is no default.`
    );
  }
  const selector = parseModelSelector(value, variable);
  return { raw: value, selector };
}

/**
 * Copy ATOMA_MODEL_L1/L2/L3 from `from` onto `to` (default `process.env`).
 *
 * A missing or blank pin is DELETED on the target, not left as a leftover: a
 * snapshot that omits L1 must FAIL at the first read, not serve the host's
 * ambient pin. `startTask` uses this so atom `modelForTier()` calls — which
 * still read `process.env` at call time — agree with the snapshot the router
 * was built from.
 */
export function applyTierPins(from: NodeJS.ProcessEnv, to: NodeJS.ProcessEnv = process.env): void {
  for (const tier of TIERS) {
    const key = tierPinVariable(tier);
    const value = from[key]?.trim();
    if (value) to[key] = value;
    else delete to[key];
  }
}

/**
 * Some recent Anthropic reasoning models (e.g. `claude-opus-4-7` and later)
 * no longer accept `temperature` / `top_p` sampling params and return a 400
 * if you send them. Keep this list conservative: add a model here only once
 * the API confirms it rejects the param.
 *
 * GA aliases are suffix-less (`claude-opus-5`, `claude-sonnet-5`), so every
 * pattern must accept end-of-string as well as a `-` after the version.
 * Sonnet 5+ rejects NON-DEFAULT sampling params, and every call site here
 * pins an explicit temperature, so it belongs on the reject list too.
 */
export function modelSupportsSamplingParams(model: string): boolean {
  if (/^claude-opus-4-(?:[7-9]|\d{2,})(?:-|$)/.test(model)) return false;
  if (/^claude-opus-(?:[5-9]|\d{2,})(?:-|$)/.test(model)) return false;
  if (/^claude-sonnet-(?:[5-9]|\d{2,})(?:-|$)/.test(model)) return false;
  if (/^claude-(?:fable|mythos)-/.test(model)) return false;
  return true;
}

/**
 * `output_config: {effort}` support. Available on Sonnet 4.6+, Sonnet
 * 5+, Opus 4.5+ and Opus 5+ (and the Fable/Mythos tier); ERRORS on
 * Haiku 4.5 and Sonnet ≤4.5, so the client must gate before sending.
 * Same suffix-less-alias caution as modelSupportsSamplingParams: every
 * pattern accepts end-of-string after the version.
 */
export function modelSupportsEffort(model: string): boolean {
  if (/^claude-opus-4-(?:[5-9]|\d{2,})(?:-|$)/.test(model)) return true;
  if (/^claude-opus-(?:[5-9]|\d{2,})(?:-|$)/.test(model)) return true;
  if (/^claude-sonnet-4-(?:[6-9]|\d{2,})(?:-|$)/.test(model)) return true;
  if (/^claude-sonnet-(?:[5-9]|\d{2,})(?:-|$)/.test(model)) return true;
  if (/^claude-(?:fable|mythos)-/.test(model)) return true;
  return false;
}
