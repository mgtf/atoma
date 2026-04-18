import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../src/core/llm.js';

describe('AnthropicLlmClient prompt caching', () => {
  it('marks system prompt with cache_control=ephemeral by default', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const fakeClient = { messages: { create } } as any;
    const llm = new AnthropicLlmClient(fakeClient);
    await llm.complete({
      model: 'x',
      systemPrompt: 'sys',
      userContent: 'u',
    });
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]![0];
    expect(args.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks last tool with cache_control=ephemeral', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        { name: 'a', description: 'a', inputSchema: {} },
        { name: 'b', description: 'b', inputSchema: {} },
      ],
    });
    const args = create.mock.calls[0]![0];
    expect(args.tools[0].cache_control).toBeUndefined();
    expect(args.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('can disable caching via flags', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const llm = new AnthropicLlmClient({ messages: { create } } as any);
    await llm.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      cacheSystem: false,
      tools: [{ name: 'a', description: 'a', inputSchema: {} }],
      cacheTools: false,
    });
    const args = create.mock.calls[0]![0];
    expect(args.system[0].cache_control).toBeUndefined();
    expect(args.tools[0].cache_control).toBeUndefined();
  });
});
