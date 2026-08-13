import { randomUUID } from 'node:crypto';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tier,
} from '../core/types.js';
import {
  pricesFor,
  estimateCostUsd,
  type PriceTable,
  DEFAULT_PRICES,
} from '../core/metrics.js';
import type { TraceRecorder, VizLlmEvent } from './trace.js';

const VALIDATION_MARKER =
  'You validate agent outputs in a three-tier LLM orchestration system.';
const PREFILTER_MARKER =
  'You pre-filter catalog lookups for a three-tier LLM orchestrator.';
const SKILL_PREFILTER_MARKER =
  'You match a subtask against a catalog of learned skills';

type Classification = Pick<VizLlmEvent, 'role' | 'actor' | 'child' | 'subject'>;

/**
 * Infer caller/role from request shape. Relies on stable markers in the
 * current prompt constants (VALIDATION_SYSTEM_PROMPT, PREFILTER_SYSTEM_PROMPT,
 * SKILL_PREFILTER_SYSTEM_PROMPT, and the tier-aware
 * `You are molecule|cell|tissue "X" (tier N)` preamble used by every
 * plan/execute userContent). Legacy `atom` traces remain accepted.
 */
function classify(req: LlmCompletionRequest): Classification {
  if (req.systemPrompt.startsWith(VALIDATION_MARKER)) {
    const supMatch = req.userContent.match(
      /Supervisor:\s*"([^"]+)"\s*\(tier\s*(\d)\)/
    );
    const chMatch = req.userContent.match(
      /Child:\s*"([^"]+)"\s*\(tier\s*(\d)\)/
    );
    const subj: 'PLAN' | 'RESULT' | undefined = /^PLAN:/m.test(req.userContent)
      ? 'PLAN'
      : /^RESULT:/m.test(req.userContent)
        ? 'RESULT'
        : undefined;
    const out: Classification = {
      role: subj === 'RESULT' ? 'validate-result' : 'validate-plan',
    };
    if (supMatch && supMatch[1] && supMatch[2]) {
      out.actor = { name: supMatch[1], tier: Number(supMatch[2]) as Tier };
    }
    if (chMatch && chMatch[1] && chMatch[2]) {
      out.child = { name: chMatch[1], tier: Number(chMatch[2]) as Tier };
    }
    if (subj) out.subject = subj;
    return out;
  }

  const actorMatch = req.userContent.match(
    /You are (?:(?:atom|molecule|cell|tissue)\s+)?"?([^"\n]+?)"?\s*\(tier\s*(\d)/
  );
  const actor: VizLlmEvent['actor'] | undefined =
    actorMatch && actorMatch[1] && actorMatch[2]
      ? { name: actorMatch[1].trim(), tier: Number(actorMatch[2]) as Tier }
      : undefined;

  // The skill prefilter has its own system prompt (SKILL_PREFILTER_SYSTEM_
  // PROMPT in cost.ts) but plays the same role in the call graph — map both
  // markers onto 'prefilter' so the UI lane stays unified.
  if (
    req.systemPrompt.startsWith(PREFILTER_MARKER) ||
    req.systemPrompt.startsWith(SKILL_PREFILTER_MARKER)
  ) {
    return actor ? { role: 'prefilter', actor } : { role: 'prefilter' };
  }

  // Skill-lifecycle calls (distill / compile / revise) ride the supervisor's
  // Sonnet slot but are NOT plans — without this marker check they fell into
  // the default 'plan' branch with no extractable actor, and the "Right now"
  // banner rendered `? is deciding how to break the task down` while the
  // model was actually compiling a skill (observed on a 14s Sonnet call).
  if (
    req.userContent.startsWith('You are distilling') ||
    req.userContent.startsWith('You are revising a SKILL') ||
    req.userContent.startsWith('You are PROMOTING a SKILL')
  ) {
    return actor ? { role: 'skill', actor } : { role: 'skill' };
  }

  if (/FALLBACK/.test(req.userContent)) {
    const role: VizLlmEvent['role'] =
      /reasoning-only|Return JSON:\s*\{"output"/.test(req.userContent)
        ? 'fallback-execute'
        : 'fallback-plan';
    return actor ? { role, actor } : { role };
  }
  if (/plan has been APPROVED/.test(req.userContent)) {
    return actor ? { role: 'execute', actor } : { role: 'execute' };
  }
  return actor ? { role: 'plan', actor } : { role: 'plan' };
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
    const cls = classify(req);
    // Pre-allocate the LLM event id so tool events can cite it via
    // `llmEventId`, letting the viz UI group tool calls under the LLM turn
    // that produced them (instead of a post-hoc nearest-match).
    const llmEventId = randomUUID();
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
      const p = pricesFor(req.model, this.prices);
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
        systemPrompt: req.systemPrompt,
        userContent: req.userContent,
        response: resp.text,
        stopReason: resp.stopReason,
        durationMs: Date.now() - started,
        usage,
        costUsd,
        ...cls,
        ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
      });
      return resp;
    } catch (err) {
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
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0,
        error: (err as Error).message,
        ...cls,
        ...(req.branchId !== undefined ? { branchId: req.branchId } : {}),
      });
      throw err;
    }
  }
}
