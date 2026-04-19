import { randomUUID } from 'node:crypto';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tier,
} from '../core/types.js';
import { pricesFor, type PriceTable, DEFAULT_PRICES } from '../core/metrics.js';
import type { TraceRecorder, VizLlmEvent } from './trace.js';

const VALIDATION_MARKER =
  'You validate agent outputs in a three-tier LLM orchestration system.';
const PREFILTER_MARKER =
  'You pre-filter catalog lookups for a three-tier LLM orchestrator.';

type Classification = Pick<VizLlmEvent, 'role' | 'actor' | 'child' | 'subject'>;

/**
 * Infer caller/role from request shape. Relies on stable markers in the
 * current prompt constants (VALIDATION_SYSTEM_PROMPT, PREFILTER_SYSTEM_PROMPT,
 * and the `You are atom "X" (tier N)` preamble used by every plan/execute
 * userContent). Keep in sync if those prompts are reworded.
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

  if (req.systemPrompt.startsWith(PREFILTER_MARKER)) {
    return { role: 'prefilter' };
  }

  const actorMatch = req.userContent.match(
    /You are (?:atom\s+)?"?([^"\n]+?)"?\s*\(tier\s*(\d)/
  );
  const actor: VizLlmEvent['actor'] | undefined =
    actorMatch && actorMatch[1] && actorMatch[2]
      ? { name: actorMatch[1].trim(), tier: Number(actorMatch[2]) as Tier }
      : undefined;

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
    try {
      const resp = await this.inner.complete(req);
      const usage = {
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        cacheReadInputTokens: resp.usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: resp.usage.cacheCreationInputTokens ?? 0,
      };
      const p = pricesFor(req.model, this.prices);
      const costUsd =
        ((usage.inputTokens - usage.cacheReadInputTokens) * p.input +
          usage.cacheReadInputTokens * p.cachedInput +
          usage.cacheCreationInputTokens * p.input +
          usage.outputTokens * p.output) /
        1_000_000;
      this.recorder.record({
        id: randomUUID(),
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
      });
      return resp;
    } catch (err) {
      this.recorder.record({
        id: randomUUID(),
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
      });
      throw err;
    }
  }
}
