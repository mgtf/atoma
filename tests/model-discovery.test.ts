import { describe, it, expect } from 'vitest';
import {
  resolveLatestOpus,
  modelSupportsSamplingParams,
  modelSupportsEffort,
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

  it('keeps sampling params on Haiku and older sonnet/opus', () => {
    // Haiku 4.5 is the only pin that still accepts sampling params.
    // PIN_SONNET / FALLBACK_OPUS are now 5-series (reject them).
    expect(modelSupportsSamplingParams(PIN_HAIKU)).toBe(true);
    expect(modelSupportsSamplingParams('claude-opus-4-6')).toBe(true);
    expect(modelSupportsSamplingParams('claude-sonnet-4-5')).toBe(true);
  });

  it('current pins (Sonnet 5 / Opus 5) reject sampling params', () => {
    expect(modelSupportsSamplingParams(PIN_SONNET)).toBe(false);
    expect(modelSupportsSamplingParams(FALLBACK_OPUS)).toBe(false);
  });
});

describe('modelSupportsEffort', () => {
  it('true for Sonnet 4.6+/5, Opus 4.5+/5, Fable/Mythos', () => {
    expect(modelSupportsEffort('claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsEffort('claude-sonnet-5')).toBe(true);
    expect(modelSupportsEffort('claude-opus-4-5')).toBe(true);
    expect(modelSupportsEffort('claude-opus-5')).toBe(true);
    expect(modelSupportsEffort('claude-fable-5')).toBe(true);
    // The current pins qualify.
    expect(modelSupportsEffort(PIN_SONNET)).toBe(true);
    expect(modelSupportsEffort(FALLBACK_OPUS)).toBe(true);
  });

  it('false for Haiku 4.5 and Sonnet <=4.5 (the param errors there)', () => {
    expect(modelSupportsEffort(PIN_HAIKU)).toBe(false);
    expect(modelSupportsEffort('claude-sonnet-4-5')).toBe(false);
    expect(modelSupportsEffort('claude-sonnet-4-0')).toBe(false);
  });
});
