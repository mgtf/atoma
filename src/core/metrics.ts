import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from './types.js';

export interface LlmCallMetrics {
  readonly model: string;
  /**
   * The model as the CALLER asked for it, prefix intact — `req.model`, before
   * a transport collapsed it onto what it actually served. `model` above is
   * priced and must stay the served id; this one is what says WHO PAID, and it
   * is the only place the distinction survives. Optional so every existing
   * recorder and fixture keeps compiling; absent means "same as `model`".
   *
   * Added 2026-08-28 with the per-tier host subscription: a mixed run bills an
   * organisation's key for some calls and spends the operator's own login for
   * others, and a single `costUsd` that blends real spend with the notional
   * API-price equivalent of subscription tokens is a figure that contradicts
   * the journal row beside it.
   */
  readonly requestedModel?: string;
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
  // Z.ai GLM family (matched with or without a routing prefix, e.g.
  // "zai:glm-4.5-air"). APPROXIMATE mid-family numbers — Z.ai prices per
  // model vary widely (Air/Flash tiers are far cheaper than flagships);
  // override with a custom PriceTable for billing-grade accounting.
  { match: /glm/i,    prices: { input: 0.6, output: 2.2, cachedInput: 0.11 } },
  // OpenAI GPT-5.6 family, reached through the `codex:` provider prefix
  // (e.g. "codex:gpt-5.6-sol") — matched WITH or WITHOUT the prefix, like
  // the GLM row. API list prices as of 2026-08-11; cached input is 10% of
  // base across the family. Order matters: the specific slugs must precede
  // the generic /gpt-5/i fallback, since `pricesFor` takes the FIRST match.
  //
  // WHY PRICE THEM AT ALL WHEN THE SUBSCRIPTION BILLS NOTHING PER TOKEN.
  // Because leaving them unmatched means `pricesFor` returns 0/0/0 and
  // every Codex call reads as FREE — which would make any tiering
  // comparison flattering and false, since the spend has merely moved to
  // another subscription. Same convention as the claude-cli transport:
  // what the tokens WOULD cost at API prices. Note the honest consequence
  // for L3 — gpt-5.6-sol at $5/$30 is DEARER on output than Opus 5's
  // $5/$25, so pinning L3 here is a subscription saving, not an API one.
  { match: /gpt-5\.6-sol/i,   prices: { input: 5,   output: 30,  cachedInput: 0.5 } },
  { match: /gpt-5\.6-terra/i, prices: { input: 2,   output: 12,  cachedInput: 0.2 } },
  { match: /gpt-5\.6-luna/i,  prices: { input: 0.2, output: 1.2, cachedInput: 0.02 } },
  // APPROXIMATE mid-family fallback for the older/smaller slugs
  // (gpt-5.5, gpt-5.4, gpt-5.4-mini). Override with a custom PriceTable
  // for billing-grade accounting.
  { match: /gpt-5/i,          prices: { input: 2,   output: 12,  cachedInput: 0.2 } },
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

/**
 * WHAT THE SUBSCRIPTION SPENT, separated from what a key spent.
 *
 * The number is what those tokens WOULD have cost at API list prices — the
 * convention this file already states for the codex rows — not a bill: on a
 * subscription nothing is charged per token. It exists so a mixed run's single
 * `costUsd` stops silently blending an organisation's real spend with the
 * operator's notional one, which is the contradiction the journal row would
 * otherwise carry from its first day (design 2026-08-28, Q3).
 *
 * Reads `requestedModel`, because that is the only field where the payer
 * survives: `model` is what the transport served, and `claude-cli` maps every
 * pin onto a bare alias, so by the time pricing sees it the prefix is gone.
 */
export function subscriptionCostUsd(
  events: readonly LlmCallMetrics[],
  isSubscriptionModel: (requestedModel: string) => boolean,
  table: PriceTable = DEFAULT_PRICES
): number {
  let total = 0;
  for (const event of events) {
    const requested = event.requestedModel ?? event.model;
    if (!isSubscriptionModel(requested)) continue;
    total += estimateCostUsd(event, pricesFor(event.model, table));
  }
  return total;
}

/**
 * Usage a transport aggregated BEFORE its error, attached to the thrown
 * error as `partialUsage` (the mechanism AnthropicLlmClient.raise
 * established in e15d810; Ollama and claude-cli mirror it — review
 * 2026-08-14 §1.13). ONE reader for both observability layers:
 * MetricsLlmClient and RecordingLlmClient used to disagree about the same
 * failed call — the CSV carried the partial tokens while the trace wrote
 * $0 — so trace and cost curve contradicted each other about one event.
 */
export interface PartialUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export function partialUsageOf(err: unknown): PartialUsage | undefined {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  const p = (err as { partialUsage?: unknown }).partialUsage;
  if (p === null || typeof p !== 'object') return undefined;
  const u = p as Partial<PartialUsage>;
  // Missing counters default to 0 rather than rejecting the whole object:
  // a transport that only tracks input/output (Ollama has no cache) still
  // gets its paid tokens counted.
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
  };
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
      // Record the failed call WITH whatever usage the loop aggregated
      // before dying (attached by each transport's raise path). Zeros meant
      // a run killed on round 7 of a tool loop reported none of the six
      // rounds it PAID for — burn-in rows showed llm=? / cost=null and
      // the curve understated exactly the runs that hurt most.
      const partial = partialUsageOf(err);
      this.recorder.record({
        model: req.model,
        requestedModel: req.model,
        inputTokens: partial?.inputTokens ?? 0,
        outputTokens: partial?.outputTokens ?? 0,
        cacheCreationInputTokens: partial?.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: partial?.cacheReadInputTokens ?? 0,
        durationMs: Date.now() - started,
        stopReason: 'error',
      });
      throw err;
    }
    this.recorder.record({
      // Price on the model the transport ACTUALLY invoked, not the tier
      // pin: `codex:claude-opus-5` served gpt-5.6-sol tokens but hit the
      // /opus/i price row, Ollama collapses every pin onto its configured
      // defaultModel, claude-cli maps pins onto aliases (review 2026-08-14
      // §1.13). Transports that serve req.model verbatim omit servedModel.
      model: resp.servedModel ?? req.model,
      // A failed call keeps its partial tokens AND its payer; so does this one.
      requestedModel: req.model,
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
