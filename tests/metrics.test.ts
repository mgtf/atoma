import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryMetrics,
  MetricsLlmClient,
  pricesFor,
  DEFAULT_PRICES,
} from '../src/core/metrics.js';
import { MockLlmClient } from '../src/core/llm.js';
import type { LlmClient } from '../src/core/types.js';

describe('pricesFor', () => {
  it('classifies Opus, Sonnet, Haiku model IDs', () => {
    // Opus 4.5+/5 list price is $5/M input — NOT the Claude 3 Opus $15/M.
    expect(pricesFor('claude-opus-4-7').input).toBe(5);
    expect(pricesFor('claude-opus-4-7').output).toBe(25);
    expect(pricesFor('claude-opus-5').input).toBe(5);
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
    expect(opus.costUsd).toBeCloseTo(5, 3); // 1M input @ $5

    const haiku = s.perModel.find((p) => p.model.includes('haiku'))!;
    // 2M input @ $1 + 1M output @ $5 = $2 + $5 = $7
    expect(haiku.costUsd).toBeCloseTo(7, 3);

    expect(s.totals.costUsd).toBeCloseTo(12, 2);
  });

  it('applies the cached-input rate to cacheReadInputTokens (Anthropic counters are disjoint)', () => {
    // Per Anthropic docs: "total_input_tokens = cache_read_input_tokens
    // + cache_creation_input_tokens + input_tokens". input_tokens is
    // ONLY the content after the last cache breakpoint — NOT a grand
    // total — so a call served entirely from cache reports
    // input_tokens=0, cache_read_input_tokens=N.
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-opus-4-7',
      inputTokens: 0,                     // nothing new after the breakpoint
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,    // all served from cache
      durationMs: 10,
      stopReason: 'end_turn',
    });
    const s = m.summary();
    const opus = s.perModel[0]!;
    // 1M @ cached_input rate ($0.5) = $0.5
    expect(opus.costUsd).toBeCloseTo(0.5, 3);
  });

  it('applies the 1.25x write-cost multiplier to cacheCreationInputTokens (5-min TTL)', () => {
    // Per Anthropic docs: "5-minute cache write tokens are 1.25 times
    // the base input tokens price". Earlier versions billed cache
    // creation at 1x input, under-reporting cost by 20% on any prompt
    // that primed a new cache entry.
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 0,
      durationMs: 10,
      stopReason: 'end_turn',
    });
    // Haiku input = $1/M, cache create = $1 × 1.25 = $1.25/M
    expect(m.summary().perModel[0]!.costUsd).toBeCloseTo(1.25, 3);
  });

  it('produces non-negative cost even when cache_read vastly exceeds input_tokens (regression)', () => {
    // Regression for the bug observed on a chess-puzzle run: the
    // Potassium L1 tool-loop had input_tokens=8193 and
    // cache_read_input_tokens=1_523_986. With the old subtractive
    // formula, (input - cache_read) went deeply negative and the total
    // summary printed costUsd: -$0.92. Under the correct disjoint
    // formula, cost is strictly positive.
    const m = new InMemoryMetrics();
    m.record({
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 8_193,
      outputTokens: 55_801,
      cacheCreationInputTokens: 139_408,
      cacheReadInputTokens: 1_523_986,
      durationMs: 400_000,
      stopReason: 'end_turn',
    });
    const cost = m.summary().perModel[0]!.costUsd;
    expect(cost).toBeGreaterThan(0);
    // Sanity: roughly
    //   8193 @ $1   = $0.008
    //   1.52M @ $.1 = $0.152
    //   139k @ $1.25= $0.174
    //   55.8k @ $5  = $0.279
    //   → ~$0.613
    expect(cost).toBeCloseTo(0.613, 1);
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
    const inner: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error('network')),
    };
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

describe('partial usage survives a mid-loop death (audit rank-12)', () => {
  it('MetricsLlmClient records the tokens attached to the error', async () => {
    const { InMemoryMetrics, MetricsLlmClient } = await import('../src/core/metrics.js');
    const metrics = new InMemoryMetrics();
    const dying = {
      complete: async () => {
        const err = new Error('deadline abort on round 7') as Error & {
          partialUsage?: Record<string, number>;
        };
        // What AnthropicLlmClient.raise() attaches: six rounds already paid.
        err.partialUsage = {
          inputTokens: 1200, outputTokens: 3400,
          cacheCreationInputTokens: 500, cacheReadInputTokens: 90_000,
        };
        throw err;
      },
    };
    const client = new MetricsLlmClient(dying, metrics);
    await expect(
      client.complete({ model: 'claude-haiku-4-5', systemPrompt: 's', userContent: 'u' })
    ).rejects.toThrow(/deadline abort/);
    const sum = metrics.summary();
    // The paid-for tokens are in the totals instead of zeros.
    expect(sum.totals.calls).toBe(1);
    expect(sum.totals.inputTokens).toBe(1200);
    expect(sum.totals.outputTokens).toBe(3400);
    expect(sum.totals.cacheReadInputTokens).toBe(90_000);
  });
});
