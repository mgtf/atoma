import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  Tool,
} from './types.js';

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

    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.params?.maxTokens ?? 2048,
      temperature: req.params?.temperature ?? 0.2,
      ...(req.params?.topP !== undefined ? { top_p: req.params.topP } : {}),
      system: systemBlocks,
      ...(tools.length > 0 ? { tools } : {}),
      messages: [{ role: 'user', content: req.userContent }],
    });

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      text,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
      },
    };
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
