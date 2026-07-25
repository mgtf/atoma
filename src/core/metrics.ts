import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from './types.js';

export interface LlmCallMetrics {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly durationMs: number;
  readonly stopReason: string | null;
}

export interface MetricsRecorder {
  record(m: LlmCallMetrics): void;
}

/**
 * USD per million tokens, approximate. Hardcoded for common Claude 4.x family
 * identifiers; unknown models fall back to zero so the summary still runs.
 * Override with a custom PriceTable in the InMemoryMetrics constructor.
 */
export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
}

export type PriceTable = ReadonlyArray<{
  readonly match: RegExp;
  readonly prices: ModelPrices;
}>;

export const DEFAULT_PRICES: PriceTable = [
  // Current-generation Opus (4.5 through 5) is $5/$25 — the old 15/75/1.5
  // row was Claude 3 Opus pricing and overstated every Opus call 3×, which
  // in turn made the "L3 always pays one Opus plan" tradeoff look 3× more
  // expensive than it really is. Pin an older Opus 4.0/4.1 ($15/$75) via a
  // custom PriceTable if you ever need one.
  { match: /opus/i,   prices: { input: 5,  output: 25, cachedInput: 0.5 } },
  { match: /sonnet/i, prices: { input: 3,  output: 15, cachedInput: 0.3 } },
  { match: /haiku/i,  prices: { input: 1,  output: 5,  cachedInput: 0.1 } },
];

export function pricesFor(model: string, table: PriceTable = DEFAULT_PRICES): ModelPrices {
  for (const entry of table) if (entry.match.test(model)) return entry.prices;
  return { input: 0, output: 0, cachedInput: 0 };
}

/**
 * USD cost for a single LLM call given Anthropic's disjoint token
 * counters. Per docs:
 *   "total_input_tokens = cache_read_input_tokens +
 *    cache_creation_input_tokens + input_tokens"
 * where `input_tokens` is ONLY the content after the last cache
 * breakpoint — NOT a grand total. 5-minute cache writes are billed at
 * 1.25× the base input price.
 *
 * Exported so both `InMemoryMetrics.summary` and `RecordingLlmClient`
 * (viz) use the same formula — previously they had two copies that
 * drifted; the viz copy still had the old subtractive bug and produced
 * negative costs on runs with heavy cache reads.
 */
export const CACHE_CREATE_MULTIPLIER_5M = 1.25;

export function estimateCostUsd(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  },
  prices: ModelPrices
): number {
  return (
    (usage.inputTokens * prices.input +
      usage.cacheReadInputTokens * prices.cachedInput +
      usage.cacheCreationInputTokens * prices.input * CACHE_CREATE_MULTIPLIER_5M +
      usage.outputTokens * prices.output) /
    1_000_000
  );
}

export interface ModelAggregate {
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface MetricsSummary {
  readonly perModel: ModelAggregate[];
  readonly totals: Omit<ModelAggregate, 'model'> & { model: 'TOTAL' };
}

/**
 * Simple in-memory aggregator. Keeps raw events for debugging and produces a
 * per-model summary with estimated USD cost using the configured PriceTable.
 * Thread-unsafe (single-process, single-event-loop assumption).
 */
export class InMemoryMetrics implements MetricsRecorder {
  public readonly events: LlmCallMetrics[] = [];
  private readonly prices: PriceTable;

  constructor(prices: PriceTable = DEFAULT_PRICES) {
    this.prices = prices;
  }

  record(m: LlmCallMetrics): void {
    this.events.push(m);
  }

  clear(): void {
    this.events.length = 0;
  }

  summary(): MetricsSummary {
    const buckets = new Map<string, ModelAggregate>();
    for (const e of this.events) {
      const p = pricesFor(e.model, this.prices);
      const cost = estimateCostUsd(e, p);
      const prev = buckets.get(e.model) ?? {
        model: e.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        costUsd: 0,
      };
      buckets.set(e.model, {
        model: e.model,
        calls: prev.calls + 1,
        inputTokens: prev.inputTokens + e.inputTokens,
        outputTokens: prev.outputTokens + e.outputTokens,
        cacheReadInputTokens: prev.cacheReadInputTokens + e.cacheReadInputTokens,
        cacheCreationInputTokens: prev.cacheCreationInputTokens + e.cacheCreationInputTokens,
        durationMs: prev.durationMs + e.durationMs,
        costUsd: prev.costUsd + cost,
      });
    }
    const perModel = [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd);
    type Totals = Omit<ModelAggregate, 'model'> & { model: 'TOTAL' };
    const totals: Totals = perModel.reduce<Totals>(
      (acc, m) => ({
        model: 'TOTAL',
        calls: acc.calls + m.calls,
        inputTokens: acc.inputTokens + m.inputTokens,
        outputTokens: acc.outputTokens + m.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + m.cacheReadInputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + m.cacheCreationInputTokens,
        durationMs: acc.durationMs + m.durationMs,
        costUsd: acc.costUsd + m.costUsd,
      }),
      {
        model: 'TOTAL',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        costUsd: 0,
      }
    );
    return { perModel, totals };
  }

  /** Human-readable one-page report. */
  formatSummary(): string {
    const s = this.summary();
    const rows = [
      ['model', 'calls', 'in', 'out', 'cache_read', 'cost_usd'],
      ...s.perModel.map((m) => [
        m.model,
        String(m.calls),
        String(m.inputTokens),
        String(m.outputTokens),
        String(m.cacheReadInputTokens),
        m.costUsd.toFixed(4),
      ]),
      [
        'TOTAL',
        String(s.totals.calls),
        String(s.totals.inputTokens),
        String(s.totals.outputTokens),
        String(s.totals.cacheReadInputTokens),
        s.totals.costUsd.toFixed(4),
      ],
    ];
    const widths = rows[0]!.map((_, col) =>
      Math.max(...rows.map((r) => r[col]!.length))
    );
    const fmt = (r: string[]): string =>
      r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
    const divider = widths.map((w) => '-'.repeat(w)).join('  ');
    return [fmt(rows[0]!), divider, ...rows.slice(1, -1).map(fmt), divider, fmt(rows[rows.length - 1]!)].join('\n');
  }
}

/**
 * Decorator LlmClient that forwards every request to an inner client and
 * records timing + usage to a MetricsRecorder. Compose around AnthropicLlmClient
 * when you want observability; leave it off in tests that don't need metrics.
 */
export class MetricsLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly recorder: MetricsRecorder
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    let resp: LlmCompletionResponse;
    try {
      resp = await this.inner.complete(req);
    } catch (err) {
      // Still record the failed call so it shows up in totals.
      this.recorder.record({
        model: req.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: Date.now() - started,
        stopReason: 'error',
      });
      throw err;
    }
    this.recorder.record({
      model: req.model,
      inputTokens: resp.usage.inputTokens,
      outputTokens: resp.usage.outputTokens,
      cacheCreationInputTokens: resp.usage.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: resp.usage.cacheReadInputTokens ?? 0,
      durationMs: Date.now() - started,
      stopReason: resp.stopReason,
    });
    return resp;
  }
}
