import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryMetrics,
  MetricsLlmClient,
  pricesFor,
  DEFAULT_PRICES,
} from '../src/core/metrics.js';
import { MockLlmClient } from '../src/core/llm.js';

describe('pricesFor', () => {
  it('classifies Opus, Sonnet, Haiku model IDs', () => {
    expect(pricesFor('claude-opus-4-7').input).toBe(15);
    expect(pricesFor('claude-sonnet-4-6').input).toBe(3);
    expect(pricesFor('claude-haiku-4-5-20251001').input).toBe(1);
  });

  it('returns zero pricing for unknown models (summary still runs)', () => {
    const p = pricesFor('gpt-foo');
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });
});

describe('InMemoryMetrics', () => {
  it('aggregates calls per model and computes total USD cost', () => {
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 100,
      stopReason: 'end_turn',
    });
    m.record({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 50,
      stopReason: 'end_turn',
    });

    const s = m.summary();
    expect(s.totals.calls).toBe(2);

    const opus = s.perModel.find((p) => p.model === 'claude-opus-4-7')!;
    expect(opus.costUsd).toBeCloseTo(15, 3); // 1M input @ $15

    const haiku = s.perModel.find((p) => p.model.includes('haiku'))!;
    // 2M input @ $1 + 1M output @ $5 = $2 + $5 = $7
    expect(haiku.costUsd).toBeCloseTo(7, 3);

    expect(s.totals.costUsd).toBeCloseTo(22, 2);
  });

  it('applies the cached-input rate to cacheReadInputTokens', () => {
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,             // total seen by the model
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,    // all served from cache
      durationMs: 10,
      stopReason: 'end_turn',
    });
    const s = m.summary();
    const opus = s.perModel[0]!;
    // cacheReadInputTokens @ cached rate (1.5), non-cached portion is 0
    expect(opus.costUsd).toBeCloseTo(1.5, 3);
  });

  it('formatSummary produces a readable table', () => {
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 10,
      stopReason: 'end_turn',
    });
    const out = m.formatSummary();
    expect(out).toContain('claude-haiku');
    expect(out).toContain('TOTAL');
    expect(out).toContain('calls');
  });

  it('clear() resets recorded events', () => {
    const m = new InMemoryMetrics();
    m.record({
      model: 'x', inputTokens: 1, outputTokens: 1,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      durationMs: 0, stopReason: null,
    });
    expect(m.events).toHaveLength(1);
    m.clear();
    expect(m.events).toHaveLength(0);
  });

  it('accepts a custom PriceTable', () => {
    const cheap = [{ match: /./, prices: { input: 0.01, output: 0.01, cachedInput: 0.01 } }];
    const m = new InMemoryMetrics(cheap);
    m.record({
      model: 'anything',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 0,
      stopReason: null,
    });
    expect(m.summary().totals.costUsd).toBeCloseTo(0.02, 3);
  });
});

describe('MetricsLlmClient', () => {
  it('forwards to inner client and records metrics', async () => {
    const inner = new MockLlmClient();
    inner.enqueue({
      text: 'hello',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 20,
      },
    });
    const recorder = new InMemoryMetrics();
    const wrapped = new MetricsLlmClient(inner, recorder);

    const resp = await wrapped.complete({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 's',
      userContent: 'u',
    });
    expect(resp.text).toBe('hello');
    expect(recorder.events).toHaveLength(1);
    const e = recorder.events[0]!;
    expect(e.model).toBe('claude-haiku-4-5-20251001');
    expect(e.inputTokens).toBe(100);
    expect(e.outputTokens).toBe(50);
    expect(e.cacheCreationInputTokens).toBe(10);
    expect(e.cacheReadInputTokens).toBe(20);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failure event and re-throws when the inner client errors', async () => {
    const inner: any = { complete: vi.fn().mockRejectedValue(new Error('network')) };
    const recorder = new InMemoryMetrics();
    const wrapped = new MetricsLlmClient(inner, recorder);
    await expect(
      wrapped.complete({ model: 'm', systemPrompt: 's', userContent: 'u' })
    ).rejects.toThrow('network');
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]!.stopReason).toBe('error');
  });

  it('DEFAULT_PRICES covers the canonical Claude 4.x families', () => {
    expect(DEFAULT_PRICES.some((p) => p.match.test('claude-opus-4-7'))).toBe(true);
    expect(DEFAULT_PRICES.some((p) => p.match.test('claude-sonnet-4-6'))).toBe(true);
    expect(DEFAULT_PRICES.some((p) => p.match.test('claude-haiku-4-5-20251001'))).toBe(true);
  });
});
