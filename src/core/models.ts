import type Anthropic from '@anthropic-ai/sdk';

export const FALLBACK_OPUS = 'claude-opus-4-7';
export const PIN_SONNET = 'claude-sonnet-4-6';
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
