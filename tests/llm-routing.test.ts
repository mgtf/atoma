import { describe, it, expect } from 'vitest';
import { RoutingLlmClient } from '../src/core/llmRouting.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../src/core/types.js';

function fakeClient(tag: string): LlmClient & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      seen.push(req.model);
      return { text: tag, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const base = { systemPrompt: 's', userContent: 'u' };

describe('RoutingLlmClient — one selector, one transport', () => {
  it('dispatches on the selector\'s transport and hands the transport the bare model id', async () => {
    const anthropic = fakeClient('anthropic');
    const zai = fakeClient('zai');
    const ollama = fakeClient('ollama');
    const claude = fakeClient('claude-cli');
    const codex = fakeClient('codex');
    const openai = fakeClient('openai');
    const router = new RoutingLlmClient({
      'anthropic-api': anthropic,
      'zai-api': zai,
      ollama,
      'claude-cli': claude,
      'codex-cli': codex,
      'openai-api': openai,
    });
    await router.complete({ ...base, model: 'api:anthropic:claude-sonnet-5' });
    await router.complete({ ...base, model: 'api:zai:glm-4.5-air' });
    // Ollama tags carry their own colons: the third segment is the REST.
    await router.complete({ ...base, model: 'api:ollama:qwen3:8b' });
    await router.complete({ ...base, model: 'sub:anthropic:sonnet' });
    await router.complete({ ...base, model: 'sub:openai:gpt-5.6-sol' });
    await router.complete({ ...base, model: 'own:openai:gpt-5.6-terra' });
    await router.complete({ ...base, model: 'api:openai:gpt-5.4-mini' });
    expect(anthropic.seen).toEqual(['claude-sonnet-5']);
    expect(zai.seen).toEqual(['glm-4.5-air']);
    expect(ollama.seen).toEqual(['qwen3:8b']);
    expect(claude.seen).toEqual(['sonnet']);
    // Host and personal ChatGPT logins ride the same Codex transport; the
    // credential home, not the client, tells them apart.
    expect(codex.seen).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(openai.seen).toEqual(['gpt-5.4-mini']);
  });

  it('has no default client: an unbuilt transport is a hard failure, not a silent fallback', async () => {
    const router = new RoutingLlmClient({ 'anthropic-api': fakeClient('a') });
    await expect(router.complete({ ...base, model: 'api:zai:glm-4.5-air' })).rejects.toThrow(
      /no client for transport "zai-api"/
    );
  });

  it('refuses a request whose model is not a selector, with the grammar in the message', async () => {
    const router = new RoutingLlmClient({ 'anthropic-api': fakeClient('a') });
    await expect(router.complete({ ...base, model: 'claude-sonnet-5' })).rejects.toThrow(
      /is not a model selector; expected <api\|sub\|own>/
    );
    await expect(router.complete({ ...base, model: 'zai:glm-4.5-air' })).rejects.toThrow(
      /is not a model selector/
    );
  });

  it('passes servedModel through UNTOUCHED — the router names transports, never models', async () => {
    const codex: LlmClient = {
      async complete(): Promise<LlmCompletionResponse> {
        return {
          text: 'x',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          servedModel: 'gpt-5.6-sol',
        };
      },
    };
    const router = new RoutingLlmClient({ 'codex-cli': codex });
    const response = await router.complete({ ...base, model: 'sub:openai:claude-opus-5' });
    expect(response.servedModel).toBe('gpt-5.6-sol');
  });
});
