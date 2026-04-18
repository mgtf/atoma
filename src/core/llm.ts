import Anthropic from '@anthropic-ai/sdk';
import { modelSupportsSamplingParams } from './models.js';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
} from './types.js';

const MAX_TOOL_ITERATIONS = 12;

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

    const sendRequest = (includeSampling: boolean) =>
      this.client.messages.create({
        model: req.model,
        max_tokens: req.params?.maxTokens ?? 8192,
        ...(includeSampling
          ? {
              temperature: req.params?.temperature ?? 0.2,
              ...(req.params?.topP !== undefined ? { top_p: req.params.topP } : {}),
            }
          : {}),
        system: systemBlocks,
        ...(tools.length > 0 ? { tools } : {}),
        messages,
      });

    let finalResponse: Anthropic.Messages.Message | null = null;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let response: Anthropic.Messages.Message;
      try {
        response = await sendRequest(samplingOk);
      } catch (err) {
        // Defensive fallback: if the model rejects temperature/top_p (e.g. a
        // newer reasoning model not yet listed in modelSupportsSamplingParams),
        // retry once without sampling params instead of failing the whole run.
        if (iter === 0 && samplingOk && isSamplingParamDeprecatedError(err)) {
          response = await sendRequest(false);
        } else {
          throw err;
        }
      }

      agg.inputTokens += response.usage.input_tokens;
      agg.outputTokens += response.usage.output_tokens;
      agg.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;
      agg.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;

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
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalResponse) {
      throw new Error(
        `AnthropicLlmClient: hit MAX_TOOL_ITERATIONS=${MAX_TOOL_ITERATIONS} without a final response`
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
