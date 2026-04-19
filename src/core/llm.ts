import Anthropic from '@anthropic-ai/sdk';
import { modelSupportsSamplingParams } from './models.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
} from './types.js';

/** Default per-call cap on tool-use iterations. Callers can override via `LlmCompletionRequest.maxToolIterations`. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 24;

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

    const sendRequest = (
      opts: { includeSampling: boolean; omitTools?: boolean }
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
          system: systemBlocks,
          ...(tools.length > 0 && !opts.omitTools ? { tools } : {}),
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
        throw req.signal.reason ?? new Error('aborted');
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
          throw err;
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
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        try {
          const result = await req.executor!.execute(
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `tool "${tu.name}" failed: ${(err as Error).message}`,
            is_error: true,
          });
        }
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
          throw req.signal.reason ?? new Error('aborted');
        }
        const finalResp = await sendRequest({
          includeSampling: samplingOk,
          omitTools: true,
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
