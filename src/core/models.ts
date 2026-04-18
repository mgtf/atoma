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
