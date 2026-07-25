import { describe, it, expect } from 'vitest';
import {
  resolveLatestOpus,
  modelSupportsSamplingParams,
  FALLBACK_OPUS,
  PIN_SONNET,
  PIN_HAIKU,
} from '../src/core/models.js';

function fakeClient(opts: {
  listImpl: () => Promise<{ data: Array<{ id: string; created_at: string }> }>;
}): any {
  return {
    models: {
      list: (_params?: unknown) => opts.listImpl(),
    },
  };
}

describe('resolveLatestOpus', () => {
  it('picks the most recent Opus model by created_at', async () => {
    const client = fakeClient({
      listImpl: async () => ({
        data: [
          { id: 'claude-opus-4-7', created_at: '2025-12-01T00:00:00Z' },
          { id: 'claude-opus-4-6', created_at: '2025-06-01T00:00:00Z' },
          { id: 'claude-sonnet-4-6', created_at: '2025-10-01T00:00:00Z' },
        ],
      }),
    });
    const model = await resolveLatestOpus(client);
    expect(model).toBe('claude-opus-4-7');
  });

  it('prefers a future Opus over the current when the API lists it', async () => {
    const client = fakeClient({
      listImpl: async () => ({
        data: [
          { id: 'claude-opus-5-0', created_at: '2026-09-01T00:00:00Z' },
          { id: 'claude-opus-4-7', created_at: '2025-12-01T00:00:00Z' },
        ],
      }),
    });
    expect(await resolveLatestOpus(client)).toBe('claude-opus-5-0');
  });

  it('falls back to hardcoded when the API call fails', async () => {
    const client = fakeClient({
      listImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(await resolveLatestOpus(client)).toBe(FALLBACK_OPUS);
  });

  it('falls back to hardcoded when no Opus is present', async () => {
    const client = fakeClient({
      listImpl: async () => ({
        data: [{ id: 'claude-sonnet-4-6', created_at: '2025-10-01T00:00:00Z' }],
      }),
    });
    expect(await resolveLatestOpus(client)).toBe(FALLBACK_OPUS);
  });
});

describe('modelSupportsSamplingParams', () => {
  it('rejects sampling params on Opus 4.7+', () => {
    expect(modelSupportsSamplingParams('claude-opus-4-7')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-4-8')).toBe(false);
    expect(modelSupportsSamplingParams(FALLBACK_OPUS)).toBe(false);
  });

  it('rejects sampling params on real GA suffix-less Opus 5+ aliases', () => {
    // `resolveLatestOpus` returns these exact alias forms — the regexes must
    // match them without a trailing `-N` (regression: claude-opus-5 slipped
    // through and every L3 plan 400ed on `temperature`).
    expect(modelSupportsSamplingParams('claude-opus-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-5-0')).toBe(false);
    expect(modelSupportsSamplingParams('claude-opus-6')).toBe(false);
  });

  it('rejects sampling params on Sonnet 5+ and Fable/Mythos tiers', () => {
    expect(modelSupportsSamplingParams('claude-sonnet-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-fable-5')).toBe(false);
    expect(modelSupportsSamplingParams('claude-mythos-5')).toBe(false);
  });

  it('keeps sampling params on the current pinned worker tiers', () => {
    expect(modelSupportsSamplingParams(PIN_SONNET)).toBe(true);
    expect(modelSupportsSamplingParams(PIN_HAIKU)).toBe(true);
    expect(modelSupportsSamplingParams('claude-opus-4-6')).toBe(true);
  });
});
