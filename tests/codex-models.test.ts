import { describe, expect, it, vi } from 'vitest';
import { CodexModelCache, readCodexModels } from '../src/auth/codexModels.js';
import { assertPersonalCodexModels, type CodexModel } from '../src/contracts/codexModels.js';
import { accountTierModelPinsSchema } from '../src/contracts/tierModels.js';

const model: CodexModel = {
  id: 'future-model', label: 'Future model', isDefault: true,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low'],
};
const wire = { model: model.id, displayName: model.label, isDefault: true,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] };

describe('account model discovery', () => {
  it('reads every page, keeps provider slugs and filters hidden models', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: [{ ...wire, model: 'hidden', hidden: true }, wire], nextCursor: 'next',
    }).mockResolvedValueOnce({ data: [{ ...wire, model: 'another-model' }], nextCursor: null });
    expect((await readCodexModels(request)).map((entry) => entry.id)).toEqual(['future-model', 'another-model']);
    expect(request.mock.calls[1]).toEqual(['model/list', { limit: 100, includeHidden: false, cursor: 'next' }]);
  });

  it('refuses repeated cursors and malformed responses without guessing a catalogue', async () => {
    await expect(readCodexModels(vi.fn().mockResolvedValue({ data: [wire], nextCursor: 'loop' }))).rejects.toThrow('repeated');
    await expect(readCodexModels(vi.fn().mockResolvedValue({ data: [{ model: 'missing-fields' }] }))).rejects.toThrow();
  });

  it('isolates generations, coalesces requests, expires and marks a failed refresh stale', async () => {
    let now = 0;
    const cache = new CodexModelCache(() => now);
    const read = vi.fn(async () => [model]);
    const [a, b] = await Promise.all([cache.get('alice:one', read), cache.get('alice:one', read)]);
    expect(a).toEqual(b);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get('alice:one', read);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get('alice:two', read);
    await cache.get('bob:one', read);
    expect(read).toHaveBeenCalledTimes(3);
    now = 300_001;
    expect(cache.peek('alice:one').state).toBe('stale');
    const failed = await cache.get('alice:one', async () => { throw new Error('secret provider diagnostic'); });
    expect(failed).toEqual({ ...a, state: 'stale' });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect((await cache.get('alice:one', read, true)).state).toBe('ready');
  });

  it('preserves unknown stored pins but refuses unavailable models at admission', () => {
    const pins = accountTierModelPinsSchema.parse({ l1: 'own:openai:future-model', l2: null, l3: null });
    const ready = { state: 'ready', checkedAt: null, models: [model] } as const;
    expect(() => assertPersonalCodexModels(Object.values(pins), { ...ready, models: [model] })).not.toThrow();
    expect(() => assertPersonalCodexModels(Object.values(pins), { ...ready, models: [] })).toThrow('unavailable');
    expect(() => assertPersonalCodexModels(Object.values(pins), { ...ready, state: 'stale', models: [model] })).toThrow('refreshed');
  });
});
