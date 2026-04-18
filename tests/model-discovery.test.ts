import { describe, it, expect } from 'vitest';
import { resolveLatestOpus, FALLBACK_OPUS } from '../src/core/models.js';

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
