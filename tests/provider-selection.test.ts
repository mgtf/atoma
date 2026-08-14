import { describe, it, expect } from 'vitest';
import {
  makeBaseClient,
  referencedProviderNames,
  resolveBaseProviderKind,
} from '../src/run/providers.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { ClaudeCliLlmClient } from '../src/core/llmClaudeCli.js';
import { OllamaLlmClient } from '../src/core/llmOllama.js';
import type Anthropic from '@anthropic-ai/sdk';

describe('base provider selection — one rule for runner and curriculum', () => {
  it('defaults to Anthropic and recognises Ollama', () => {
    expect(resolveBaseProviderKind()).toBe('anthropic');
    expect(resolveBaseProviderKind('ANTHROPIC')).toBe('anthropic');
    expect(resolveBaseProviderKind('ollama')).toBe('ollama');
  });

  it('normalises both Claude subscription aliases', () => {
    expect(resolveBaseProviderKind('claude-cli')).toBe('claude-cli');
    expect(resolveBaseProviderKind('claude')).toBe('claude-cli');
  });

  it('rejects Codex as a base provider and names the safe tier-pin form', () => {
    expect(() => resolveBaseProviderKind('codex')).toThrow(/structurally refused at L1/);
    expect(() => resolveBaseProviderKind('codex')).toThrow(/ATOMA_MODEL_L3=codex:/);
  });

  it('rejects unknown values instead of silently billing Anthropic', () => {
    expect(() => resolveBaseProviderKind('claud')).toThrow(/unknown ATOMA_LLM provider "claud"/);
  });

  it('lists only configured cross-provider tier prefixes in tier order', () => {
    expect(
      referencedProviderNames({
        ATOMA_MODEL_L1: 'zai:glm-4.5-air',
        ATOMA_MODEL_L2: 'codex:gpt-5.6-sol',
        ATOMA_MODEL_L3: 'zai:glm-5',
      })
    ).toEqual(['zai', 'codex']);
    // Ollama model tags legitimately contain colons; an unknown prefix stays
    // a model id for the base provider.
    expect(referencedProviderNames({ ATOMA_MODEL_L1: 'qwen3:8b' })).toEqual([]);
  });

  it('delegates the pin parse to splitProviderModel — an empty model rejects at scan time', () => {
    // referencedProviderNames used to re-implement the first-colon walk
    // byte-for-byte (the two-copies-of-one-rule drift class); delegation
    // means the "zai:" typo now fails at provider construction with the
    // env-var shape in the message, not at the first LLM call.
    expect(() => referencedProviderNames({ ATOMA_MODEL_L2: 'zai:' })).toThrow(
      /zai:<model-id>/
    );
  });
});

describe('makeBaseClient — ONE construction switch for runner and curriculum', () => {
  it('builds the claude-cli client for both subscription aliases', () => {
    // The bare `claude` alias is the one curriculum's hand-rolled copy of
    // this switch historically missed (it silently fell into the Anthropic
    // path); pin the full alias→construction chain.
    expect(makeBaseClient(resolveBaseProviderKind('claude'))).toBeInstanceOf(ClaudeCliLlmClient);
    expect(makeBaseClient('claude-cli')).toBeInstanceOf(ClaudeCliLlmClient);
  });

  it('builds Ollama from the injected env (OLLAMA_BASE_URL / OLLAMA_MODEL)', async () => {
    const client = makeBaseClient('ollama', {
      env: { OLLAMA_BASE_URL: 'http://stub-host:1234', OLLAMA_MODEL: 'stub-model:tag' },
    });
    expect(client).toBeInstanceOf(OllamaLlmClient);
    // Prove the env values reached the constructor rather than being
    // re-read from process.env: one stubbed round-trip.
    const seen: { url: string; model: string }[] = [];
    const prevFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (input: unknown, init?: { body?: string }) => {
      seen.push({
        url: String(input),
        model: (JSON.parse(init?.body ?? '{}') as { model?: string }).model ?? '',
      });
      return new Response(
        JSON.stringify({ model: 'stub-model:tag', message: { role: 'assistant', content: 'ok' }, done: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    try {
      await client.complete({ model: 'claude-opus-5', systemPrompt: 's', userContent: 'u' });
    } finally {
      globalThis.fetch = prevFetch;
    }
    expect(seen).toEqual([{ url: 'http://stub-host:1234/api/chat', model: 'stub-model:tag' }]);
  });

  it('anthropic REQUIRES a constructed SDK client and throws a naming error without one', () => {
    // makeAnthropicClient() exits the process when no credential resolves;
    // only the caller knows whether demanding one is appropriate, so the
    // switch never constructs it implicitly.
    expect(() => makeBaseClient('anthropic')).toThrow(/opts\.anthropic/);
    const fake = { messages: { create: async () => ({}) } } as unknown as Anthropic;
    expect(makeBaseClient('anthropic', { anthropic: fake })).toBeInstanceOf(AnthropicLlmClient);
  });
});
