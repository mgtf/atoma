import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../src/core/llm.js';

/**
 * The client sends `output_config: {effort}` only when the caller pins
 * an effort AND the model supports it (Haiku 4.5 rejects the param with
 * a 400). Plan/strategy call sites pin 'medium'; validators/prefilters
 * on Haiku must never carry it.
 */
function fakeSdk() {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  return { create, client: { messages: { create } } as any };
}

describe('output_config.effort gating', () => {
  it('sends effort on an effort-capable model (Sonnet 5)', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-sonnet-5',
      systemPrompt: 's',
      userContent: 'u',
      params: { maxTokens: 8000, effort: 'medium' },
    });
    expect(create.mock.calls[0]![0].output_config).toEqual({ effort: 'medium' });
  });

  it('OMITS effort on Haiku (the param errors there)', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 's',
      userContent: 'u',
      params: { effort: 'medium' },
    });
    expect(create.mock.calls[0]![0].output_config).toBeUndefined();
  });

  it('omits effort entirely when the caller did not ask for one', async () => {
    const { create, client } = fakeSdk();
    await new AnthropicLlmClient(client).complete({
      model: 'claude-sonnet-5',
      systemPrompt: 's',
      userContent: 'u',
      params: { maxTokens: 8000 },
    });
    expect(create.mock.calls[0]![0].output_config).toBeUndefined();
  });
});
