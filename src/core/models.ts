
// Current-generation pins (2026-07): Opus 5 costs the same as 4.7
// ($5/$25) with better decomposition; Sonnet 5 is near-Opus on agentic
// work at $3/$15 ($2/$10 intro until 2026-08-31). Both reject sampling
// params (handled by modelSupportsSamplingParams) and run adaptive
// thinking by default — thinking tokens count against max_tokens, which
// is why STRATEGY_MAX_TOKENS in atoms/cost.ts is sized with headroom.
// Haiku 4.5 remains the cheapest current-gen model (no Haiku 5).
export const FALLBACK_OPUS = 'claude-opus-5';
export const PIN_SONNET = 'claude-sonnet-5';
export const PIN_HAIKU = 'claude-haiku-4-5-20251001';

/**
 * PROVIDER-AGNOSTIC per-tier model selection. The project's unit of
 * configuration is the TIER (decreasing model power L3→L1 is the whole
 * thesis), not any vendor's model family — so the env vars are named by
 * tier and accept ANY model id the active LlmClient can serve:
 *
 *   ATOMA_MODEL_L1=...   default: claude-haiku-4-5-20251001
 *   ATOMA_MODEL_L2=...   default: claude-sonnet-5
 *   ATOMA_MODEL_L3=...   default: claude-opus-5 (or live-resolved Opus)
 *
 * Read at CALL time so tests and per-run env changes behave. Pass `env`
 * when the caller holds a snapshot (T10): `modelForTier` and
 * `buildReferencedProviders` must see the same pins or the router
 * constructs a client the atoms never request. Notes per provider: under
 * claude-cli, aliases work ('sonnet' for L3 is the no-Opus-on-this-plan
 * escape hatch — the L1/L2 gradient below survives); under ollama, a
 * non-`claude-*` value is honoured verbatim per tier (see
 * resolveOllamaModel); validators/prefilters always ride the L1 tier's
 * model — validation is a yes/no, it belongs on the cheapest capable
 * model regardless of vendor.
 */
export function modelForTier(tier: 1 | 2 | 3, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[`ATOMA_MODEL_L${tier}`];
  if (value && value.trim().length > 0) return value.trim();
  return tier === 1 ? PIN_HAIKU : tier === 2 ? PIN_SONNET : FALLBACK_OPUS;
}

/**
 * Copy ATOMA_MODEL_L1/L2/L3 from `from` onto `to` (default `process.env`).
 *
 * A missing or blank pin is DELETED on the target, not left as a leftover:
 * a snapshot that omits L1 must serve the default Haiku, not the host's
 * ambient pin. `startTask` uses this so atom `modelForTier()` calls — which
 * still read `process.env` at call time — agree with the snapshot the
 * router was built from.
 */
export function applyTierPins(from: NodeJS.ProcessEnv, to: NodeJS.ProcessEnv = process.env): void {
  for (const tier of [1, 2, 3] as const) {
    const key = `ATOMA_MODEL_L${tier}`;
    const value = from[key]?.trim();
    if (value) to[key] = value;
    else delete to[key];
  }
}

/**
 * Structural view of the one SDK capability the resolver needs. Declared
 * here (the provider layer) so callers above this layer — L3Atom — can
 * type their optional client parameter WITHOUT importing the Anthropic
 * SDK: tier code stays provider-neutral (P5/P6), and any client exposing
 * a compatible `models.list` works.
 */
export interface ModelListingClient {
  models: {
    list(args: { limit: number }): Promise<{
      data: { id: string; created_at?: string | null }[];
    }>;
  };
}

export async function resolveLatestOpus(client: ModelListingClient): Promise<string> {
  try {
    const page = await client.models.list({ limit: 100 });
    const opus = page.data
      .filter((m) => /opus/i.test(m.id))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const top = opus[0];
    if (!top) return FALLBACK_OPUS;
    return top.id;
  } catch {
    return FALLBACK_OPUS;
  }
}

/**
 * Some recent Anthropic reasoning models (e.g. `claude-opus-4-7` and later)
 * no longer accept `temperature` / `top_p` sampling params and return a 400
 * if you send them. Keep this list conservative: add a model here only once
 * the API confirms it rejects the param.
 *
 * GA aliases are suffix-less (`claude-opus-5`, `claude-sonnet-5`), so every
 * pattern must accept end-of-string as well as a `-` after the version —
 * `resolveLatestOpus` returns exactly those alias forms. Sonnet 5+ rejects
 * NON-DEFAULT sampling params, and every call site here pins an explicit
 * temperature, so it belongs on the reject list too.
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
