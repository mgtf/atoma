import type Anthropic from '@anthropic-ai/sdk';

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

export async function resolveLatestOpus(client: Anthropic): Promise<string> {
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
