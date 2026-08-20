import { randomUUID } from 'node:crypto';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from '../core/types.js';
import {
  pricesFor,
  estimateCostUsd,
  partialUsageOf,
  type PriceTable,
  DEFAULT_PRICES,
} from '../core/metrics.js';
import { citeContext } from '../contracts/llmTrace.js';
import type { TraceRecorder, VizLlmEvent } from './trace.js';

type Classification = Pick<VizLlmEvent, 'role' | 'actor' | 'child' | 'subject'>;

/** Role/actor/child/subject come from the request stamp. No prompt archaeology. */
function stamped(req: LlmCompletionRequest): Classification {
  return {
    role: req.role ?? 'unknown',
    ...(req.actor ? { actor: req.actor } : {}),
    ...(req.child ? { child: req.child } : {}),
    ...(req.subject ? { subject: req.subject } : {}),
  };
}

/**
 * LlmClient decorator that captures prompts + response into a TraceRecorder.
 * Stackable with MetricsLlmClient — order doesn't matter, both only observe.
 */
export class RecordingLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly recorder: TraceRecorder,
    private readonly prices: PriceTable = DEFAULT_PRICES
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    const cls = stamped(req);
    const toolNames = req.tools?.map((tool) => tool.name);
    const context = req.context?.map((block) => citeContext(block));
    const envelope = {
      ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
      ...(context && context.length > 0 ? { context } : {}),
    };
    // Pre-allocate the LLM event id so tool events can cite it via
    // `llmEventId`, letting the viz UI group tool calls under the LLM turn
    // that produced them (instead of a post-hoc nearest-match).
    const llmEventId = randomUUID();
    if (req.context) {
      const seen = new Set(
        (this.recorder.currentRun?.events ?? [])
          .filter((event) => event.kind === 'context')
          .map((event) => event.id)
      );
      for (const block of req.context) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        const cited = citeContext(block);
        try {
          this.recorder.record({
            id: block.id,
            ts: started,
            kind: 'context',
            source: cited.source,
            chars: cited.chars,
            preview: cited.preview,
            llmEventId,
            ...(cited.skillId !== undefined ? { skillId: cited.skillId } : {}),
            ...(cls.actor ? { actor: cls.actor } : {}),
            ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
          });
        } catch {
          // Observability must never break the call itself.
        }
      }
    }
    // In-flight marker: lets the polling UI render "happening NOW" (and an
    // ended run render an unpaired start as "interrupted"). The completion
    // or error event below supersedes it via llmEventId.
    try {
      this.recorder.record({
        id: randomUUID(),
        ts: started,
        kind: 'llm-start',
        llmEventId,
        model: req.model,
        role: cls.role,
        ...(cls.actor ? { actor: cls.actor } : {}),
        ...(cls.child ? { child: cls.child } : {}),
        ...(cls.subject ? { subject: cls.subject } : {}),
        ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
      });
    } catch {
      // Observability must never break the call itself.
    }
    // Wrap the request with our own onToolInvocation observer. We preserve
    // any caller-provided callback (chain-of-responsibility style) so a
    // hypothetical future metrics or audit decorator can nest cleanly.
    const upstreamObserver = req.onToolInvocation;
    const wrappedReq: LlmCompletionRequest = {
      ...req,
      onToolInvocation: (info) => {
        try {
          const ev: import('./trace.js').VizToolEvent = {
            id: randomUUID(),
            ts: info.startedAt,
            kind: 'tool',
            llmEventId,
            name: info.name,
            args: info.args,
            durationMs: info.durationMs,
          };
          if (cls.actor) ev.actor = cls.actor;
          if (info.result !== undefined) ev.result = info.result;
          if (info.error !== undefined) ev.error = info.error;
          // Echo the fan-out lane id so the viz can group this tool call
          // with the rest of its subtask chain.
          if (req.branchId !== undefined) ev.branchId = req.branchId;
          this.recorder.record(ev);
        } catch {
          // Never let trace recording break the tool loop.
        }
        upstreamObserver?.(info);
      },
    };
    try {
      const resp = await this.inner.complete(wrappedReq);
      const usage = {
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        cacheReadInputTokens: resp.usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: resp.usage.cacheCreationInputTokens ?? 0,
      };
      // Price on the model the transport ACTUALLY invoked (codex maps
      // `claude-opus-5` → gpt-5.6-sol, Ollama collapses pins onto its
      // defaultModel, claude-cli maps pins onto aliases) — same rule as
      // MetricsLlmClient, so trace and CSV agree (review 2026-08-14 §1.13).
      // The event's `model` stays req.model: the pin is the routing
      // identity the viz shows; the served identity rides alongside.
      const p = pricesFor(resp.servedModel ?? req.model, this.prices);
      // Shared formula lives in src/core/metrics.ts (estimateCostUsd)
      // so the viz and the metrics summary never drift apart. Before
      // the extraction, this file had an independent (and buggy) copy
      // that subtracted cache_read from inputTokens and produced
      // negative totals on cache-heavy runs.
      const costUsd = estimateCostUsd(usage, p);
      this.recorder.record({
        id: llmEventId,
        ts: started,
        kind: 'llm',
        model: req.model,
        ...(resp.servedModel !== undefined ? { servedModel: resp.servedModel } : {}),
        systemPrompt: req.systemPrompt,
        userContent: req.userContent,
        response: resp.text,
        stopReason: resp.stopReason,
        durationMs: Date.now() - started,
        usage,
        costUsd,
        ...cls,
        ...envelope,
        ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
      });
      return resp;
    } catch (err) {
      // Read the usage the transport aggregated before dying (attached as
      // `partialUsage` by each transport's raise path) — the SAME reader
      // MetricsLlmClient uses. Hardcoded zeros here made the trace say
      // $0.00 for the exact event the CSV priced from the partial tokens:
      // two observability layers contradicting each other about one call
      // (review 2026-08-14 §1.13).
      const partial = partialUsageOf(err);
      const usage = partial ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      this.recorder.record({
        id: llmEventId,
        ts: started,
        kind: 'llm',
        model: req.model,
        systemPrompt: req.systemPrompt,
        userContent: req.userContent,
        response: '',
        stopReason: 'error',
        durationMs: Date.now() - started,
        usage,
        costUsd: estimateCostUsd(usage, pricesFor(req.model, this.prices)),
        error: (err as Error).message,
        ...cls,
        ...envelope,
        ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
      });
      throw err;
    }
  }
}
