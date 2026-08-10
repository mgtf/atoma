import { describe, it, expect } from 'vitest';
import { RoutingLlmClient, splitProviderModel } from '../src/core/llmRouting.js';
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

describe('splitProviderModel — conservative prefix parsing', () => {
  it('routes only KNOWN provider prefixes', () => {
    expect(splitProviderModel('zai:glm-4.5-air', ['zai'])).toEqual({
      provider: 'zai',
      model: 'glm-4.5-air',
    });
  });

  it('leaves Ollama-style tags intact — a colon is not automatically a provider', () => {
    // qwen3:8b / glm-5.1:cloud are MODEL ids; "qwen3" is not a configured
    // provider, so the whole string stays a model for the default client.
    expect(splitProviderModel('qwen3:8b', ['zai'])).toEqual({ provider: null, model: 'qwen3:8b' });
    expect(splitProviderModel('glm-5.1:cloud', [])).toEqual({ provider: null, model: 'glm-5.1:cloud' });
  });

  it('no colon → default client', () => {
    expect(splitProviderModel('claude-opus-5', ['zai'])).toEqual({
      provider: null,
      model: 'claude-opus-5',
    });
  });
});

describe('RoutingLlmClient — per-tier provider dispatch', () => {
  it('sends prefixed models to their provider (prefix stripped) and the rest to the default', async () => {
    const dflt = fakeClient('default');
    const zai = fakeClient('zai');
    const router = new RoutingLlmClient(dflt, { zai });

    // The cross-vendor gradient: L1 on Z.ai, L3 on the default provider.
    const r1 = await router.complete({ model: 'zai:glm-4.5-air', systemPrompt: 's', userContent: 'u' });
    const r3 = await router.complete({ model: 'claude-opus-5', systemPrompt: 's', userContent: 'u' });

    expect(r1.text).toBe('zai');
    expect(zai.seen).toEqual(['glm-4.5-air']); // prefix stripped for the wire
    expect(r3.text).toBe('default');
    expect(dflt.seen).toEqual(['claude-opus-5']);
  });

  it('with no providers configured it is a pure passthrough, colons included', async () => {
    const dflt = fakeClient('default');
    const router = new RoutingLlmClient(dflt);
    await router.complete({ model: 'qwen3:8b', systemPrompt: 's', userContent: 'u' });
    expect(dflt.seen).toEqual(['qwen3:8b']);
  });
});

describe('RoutingLlmClient — mixed-case provider keys (audit rank-2)', () => {
  it('routes "zai:model" when the provider was registered as "ZAI"', async () => {
    const { RoutingLlmClient } = await import('../src/core/llmRouting.js');
    const calls: string[] = [];
    const mk = (tag: string) => ({
      complete: async (req: { model: string }) => {
        calls.push(`${tag}:${req.model}`);
        return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    });
    const router = new RoutingLlmClient(mk('default') as never, { ZAI: mk('zai') as never });
    await router.complete({ model: 'zai:glm-4.5-air', systemPrompt: 's', userContent: 'u' });
    // Old behavior: prefix matched `known` (lowercased) but the map lookup
    // missed the original-case key → the "unreachable" throw fired.
    expect(calls).toEqual(['zai:glm-4.5-air']);
  });
});
