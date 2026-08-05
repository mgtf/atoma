import Anthropic from '@anthropic-ai/sdk';
import { modelSupportsEffort, modelSupportsSamplingParams } from './models.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
  ToolInvocationInfo,
} from './types.js';

/** Default per-call cap on tool-use iterations. Callers can override via `LlmCompletionRequest.maxToolIterations`. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 24;

/**
 * Cap on the serialized size of a single tool_result sent back to the model.
 * Tool outputs are otherwise unbounded (`read_file` returns whole files,
 * `run_shell` up to its 2 MB maxBuffer ≈ 500K tokens — beyond Haiku's whole
 * 200K context window), and every byte stays resident in the transcript for
 * the REST of the tool loop, re-billed on each iteration. 20K chars ≈ 5K
 * tokens keeps any single result useful while bounding both cost and the
 * context-overflow crash vector. Observers (`onToolInvocation`) still get
 * the untruncated result — only the model-facing payload is elided.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * Hint appended alongside the final tool_result batch when the budget is
 * exhausted. Tells the model it has NO more tool access this turn and must
 * produce its final response as text now. Kept short so it doesn't steer the
 * content of the final answer beyond "stop calling tools".
 */
const BUDGET_EXHAUSTED_HINT =
  'TOOL BUDGET EXHAUSTED for this turn. You have no more tool access. ' +
  'Produce the final response now as plain text (or structured JSON if the task requires it). ' +
  'Do NOT attempt to call any more tools — tools are disabled for this message.';

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly client: Anthropic) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      {
        type: 'text',
        text: req.systemPrompt,
        ...(req.cacheSystem !== false ? { cache_control: { type: 'ephemeral' } } : {}),
      },
    ];

    const tools = toAnthropicTools(req.tools ?? [], req.cacheTools !== false);
    const samplingOk = modelSupportsSamplingParams(req.model);
    // `output_config: {effort}` — sent only when the caller asked for it
    // AND the model accepts it (Haiku 4.5 rejects the param with a 400).
    const effort =
      req.params?.effort !== undefined && modelSupportsEffort(req.model)
        ? req.params.effort
        : undefined;

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: req.userContent },
    ];

    const agg = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    const sdkOptions: { signal?: AbortSignal } = {};
    if (req.signal) sdkOptions.signal = req.signal;

    // Attach the usage aggregated SO FAR to any error leaving this loop.
    // A run killed mid-loop (deadline abort, transport 400 on round 7)
    // used to lose every token it had already paid for — MetricsLlmClient
    // recorded zeros, burn-in rows showed llm=? / cost=null, and the
    // cost curve silently understated exactly the runs that hurt most.
    const raise = (err: unknown): never => {
      try {
        (err as { partialUsage?: typeof agg }).partialUsage = { ...agg };
      } catch {
        // frozen/exotic abort reasons can't carry properties — fine.
      }
      throw err;
    };

    const sendRequest = (
      opts: { includeSampling: boolean; disableTools?: boolean }
    ): Promise<Anthropic.Messages.Message> =>
      this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.params?.maxTokens ?? 16384,
          ...(opts.includeSampling
            ? {
                temperature: req.params?.temperature ?? 0.2,
                ...(req.params?.topP !== undefined ? { top_p: req.params.topP } : {}),
              }
            : {}),
          ...(effort !== undefined
            ? ({ output_config: { effort } } as Record<string, unknown>)
            : {}),
          system: systemBlocks,
          // Tool declarations render at position 0 of the prompt, so REMOVING
          // them on the finalization round-trip would invalidate the entire
          // prompt cache (tools + system + messages) on the largest request
          // of the whole loop. `tool_choice: none` forbids tool use while
          // leaving the cached prefix byte-identical — tool_choice changes
          // do not invalidate the tools/system cache tiers.
          ...(tools.length > 0
            ? {
                tools,
                ...(opts.disableTools ? { tool_choice: { type: 'none' as const } } : {}),
              }
            : {}),
          messages,
        },
        sdkOptions
      );

    const accumulate = (response: Anthropic.Messages.Message): void => {
      agg.inputTokens += response.usage.input_tokens;
      agg.outputTokens += response.usage.output_tokens;
      agg.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;
      agg.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
    };

    const budget = Math.max(1, req.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS);
    let finalResponse: Anthropic.Messages.Message | null = null;

    for (let iter = 0; iter < budget; iter++) {
      // Short-circuit the tool loop between iterations as soon as the caller
      // (usually `RunContext.signal`) aborts. Without this check we would
      // cheerfully kick off the next HTTP call and only error out mid-flight.
      if (req.signal?.aborted) {
        raise(req.signal.reason ?? new Error('aborted'));
      }
      let response: Anthropic.Messages.Message;
      try {
        response = await sendRequest({ includeSampling: samplingOk });
      } catch (err) {
        // Defensive fallback: if the model rejects temperature/top_p (e.g. a
        // newer reasoning model not yet listed in modelSupportsSamplingParams),
        // retry once without sampling params instead of failing the whole run.
        if (iter === 0 && samplingOk && isSamplingParamDeprecatedError(err)) {
          response = await sendRequest({ includeSampling: false });
        } else {
          throw raise(err);
        }
      }

      accumulate(response);

      const shouldLoop =
        response.stop_reason === 'tool_use' &&
        req.executor !== undefined &&
        response.content.some((b) => b.type === 'tool_use');

      if (!shouldLoop) {
        finalResponse = response;
        break;
      }

      // Append the assistant turn verbatim so tool_use ids line up.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      );
      // Declared-tools scope enforcement (#8a). The LLM sees a tool
      // DECLARATION list (req.tools) — and should only invoke those —
      // but the shared InMemoryToolRegistry registered at runtime has
      // every available tool. Without a scope gate, a model that
      // learned about e.g. validate_html from an unrelated guidance
      // block can ASK for it and the executor will happily run it,
      // then the result gets fed back as signal (observed in the
      // Node/REST live run: HTTP-scope atoms invoking validate_html
      // on a JSON API because SMOKE_DESIGN_GUIDANCE taught the
      // pattern, resulting in validator rejections and escalation
      // cascades). We gate on the declared-tool names here: off-
      // list requests are turned into a descriptive tool_result
      // error without hitting the executor, so the model sees the
      // rejection as part of its conversation and can course-correct.
      // If req.tools is empty or absent, the gate is disabled (no
      // declaration = no scope to enforce).
      const declaredToolNames =
        req.tools && req.tools.length > 0
          ? new Set(req.tools.map((t) => t.name))
          : null;
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const args = (tu.input ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        if (declaredToolNames && !declaredToolNames.has(tu.name)) {
          const declaredList = [...declaredToolNames].sort().join(', ');
          const errMsg = `tool "${tu.name}" is NOT in your declared tools. You may only invoke: ${declaredList}. Do not call "${tu.name}" again for this task.`;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: errMsg,
            is_error: true,
          });
          notifyToolInvocation(req.onToolInvocation, {
            name: tu.name,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
          continue;
        }
        try {
          const result = await req.executor!.execute(tu.name, args);
          // Compact stringify — the pretty-print indent of the old
          // `JSON.stringify(result, null, 2)` was pure token overhead on
          // every tool result of every iteration.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: truncateToolResultContent(
              typeof result === 'string' ? result : JSON.stringify(result)
            ),
          });
          notifyToolInvocation(req.onToolInvocation, {
            name: tu.name,
            args,
            result,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: truncateToolResultContent(`tool "${tu.name}" failed: ${errMsg}`),
            is_error: true,
          });
          notifyToolInvocation(req.onToolInvocation, {
            name: tu.name,
            args,
            error: errMsg,
            durationMs: Date.now() - startedAt,
            startedAt,
          });
        }
      }

      // Rolling cache breakpoint: each iteration the request looks like
      // system + [user task] + [asst tool_use + user tool_result]*N.
      // Anthropic's prompt caching caches up to the last cache_control-
      // marked block. By moving the breakpoint forward each round, we pay
      // 10% input price for everything up to the PREVIOUS breakpoint and
      // only full price for the newest delta.
      //
      // Why this matters: without a rolling breakpoint, the only cached
      // segment is the system prompt. Haiku 4.5's minimum cacheable prompt
      // is 4096 tokens — our L1 narrow prompts sit around 800 tokens, so
      // caching the system prompt alone silently fails the length check
      // and produces 0 cache reads. With the breakpoint on a growing
      // conversation, the prefix quickly exceeds 4096 and caching kicks
      // in for the rest of the tool loop.
      //
      // Anthropic caps breakpoints at 4 PER REQUEST. Leaving stale
      // cache_control markers on previous rounds' tool_result blocks
      // compounds every iteration and eventually trips a
      // "A maximum of 4 blocks with cache_control may be provided.
      // Found 5." 400 error. The pattern MUST remove the prior
      // breakpoint before placing the new one — "moving", not
      // "accumulating". We leave the system and last-tool breakpoints
      // intact and only manage the one on the user turn.
      clearRollingBreakpoint(messages);
      if (toolResults.length > 0) {
        const last = toolResults[toolResults.length - 1]!;
        (last as Anthropic.Messages.ToolResultBlockParam & {
          cache_control?: { type: 'ephemeral' };
        }).cache_control = { type: 'ephemeral' };
      }

      const isLastIter = iter === budget - 1;
      if (isLastIter) {
        // Graceful finalization: we just consumed the last slot on tool
        // execution but have no budget left to call the model with tools
        // again. Attach a short "tools disabled, finalize now" hint to the
        // tool_result batch and do ONE tools-disabled round-trip to coax a
        // text-only final response. This replaces the old hard throw.
        messages.push({
          role: 'user',
          content: [
            ...toolResults,
            { type: 'text', text: BUDGET_EXHAUSTED_HINT },
          ],
        });
        if (req.signal?.aborted) {
          raise(req.signal.reason ?? new Error('aborted'));
        }
        const finalResp = await sendRequest({
          includeSampling: samplingOk,
          disableTools: true,
        });
        accumulate(finalResp);
        finalResponse = finalResp;
        break;
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalResponse) {
      throw new Error(
        `AnthropicLlmClient: tool loop exited without a final response (budget=${budget})`
      );
    }

    const text = finalResponse.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      text,
      stopReason: finalResponse.stop_reason,
      usage: {
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cacheCreationInputTokens: agg.cacheCreationInputTokens || undefined,
        cacheReadInputTokens: agg.cacheReadInputTokens || undefined,
      },
    };
  }
}

/**
 * Swallow-on-error dispatcher for the `onToolInvocation` observer callback.
 * Observability hooks must never break the tool-use loop — if the recorder
 * throws, we log-and-continue rather than aborting the call.
 */
function notifyToolInvocation(
  cb: ((info: ToolInvocationInfo) => void) | undefined,
  info: ToolInvocationInfo
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // intentionally empty — observer failure must not poison execution
  }
}

/**
 * Head/tail elision for oversized tool results. Keeps the opening of the
 * output (usually the part the model asked for) and the tail (where shell
 * errors and exit summaries land), with an explicit marker so the model
 * knows content was dropped rather than absent.
 */
export function truncateToolResultContent(
  content: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS
): string {
  if (content.length <= maxChars) return content;
  const head = content.slice(0, Math.floor(maxChars * 0.7));
  const tail = content.slice(content.length - Math.floor(maxChars * 0.2));
  const dropped = content.length - head.length - tail.length;
  return (
    `${head}\n` +
    `[... tool output truncated: ${dropped} chars omitted. ` +
    `If you need the missing part, request a narrower output ` +
    `(smaller file, quieter command, more specific probe) ...]\n` +
    `${tail}`
  );
}

function isSamplingParamDeprecatedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { status?: number; message?: string };
  if (anyErr.status !== 400) return false;
  const msg = (anyErr.message ?? '').toLowerCase();
  return (
    msg.includes('`temperature` is deprecated') ||
    msg.includes('`top_p` is deprecated') ||
    msg.includes('temperature is deprecated') ||
    msg.includes('top_p is deprecated')
  );
}

/**
 * Strip any `cache_control` markers we previously placed on user turn
 * content blocks (tool_result or text). Anthropic caps cache breakpoints
 * at 4 per request — the rolling-breakpoint pattern depends on MOVING
 * the breakpoint forward, not accumulating one per iteration. We leave
 * the system-prompt and last-tool breakpoints alone (they live on
 * separate params, not on `messages`) so callers keep their 2 fixed
 * breakpoints and we manage the single rolling one on messages.
 */
function clearRollingBreakpoint(
  messages: Anthropic.Messages.MessageParam[]
): void {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
}

function toAnthropicTools(
  tools: Tool[],
  cacheLast: boolean
): Anthropic.Messages.ToolUnion[] {
  if (tools.length === 0) return [];
  return tools.map((t, i) => {
    const def: Anthropic.Messages.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    };
    if (cacheLast && i === tools.length - 1) {
      return { ...def, cache_control: { type: 'ephemeral' } };
    }
    return def;
  });
}

/**
 * Mock client for tests. Responds from a queue of canned replies, or from a function
 * that inspects the request and produces a reply.
 */
export class MockLlmClient implements LlmClient {
  private queue: (LlmCompletionResponse | ((req: LlmCompletionRequest) => LlmCompletionResponse))[] = [];
  public readonly calls: LlmCompletionRequest[] = [];

  enqueue(reply: LlmCompletionResponse | ((req: LlmCompletionRequest) => LlmCompletionResponse)): void {
    this.queue.push(reply);
  }

  enqueueText(text: string): void {
    this.queue.push({
      text,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`MockLlmClient: no queued reply for request (model=${req.model})`);
    }
    if (typeof next === 'function') return next(req);
    return next;
  }
}
