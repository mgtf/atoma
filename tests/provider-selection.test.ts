import { describe, it, expect } from 'vitest';
import {
  assertTransportHonoursCredentials,
  buildReferencedProviders,
  makeBaseClient,
  referencedProviderNames,
  resolveBaseProviderKind,
} from '../src/run/providers.js';
import { makeAnthropicClient } from '../src/run/auth.js';
import { RunnerConfigError } from '../src/core/errors.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { ClaudeCliLlmClient } from '../src/core/llmClaudeCli.js';
import { OllamaLlmClient } from '../src/core/llmOllama.js';
import type Anthropic from '@anthropic-ai/sdk';

describe('the child re-checks what the parent authorised', () => {
  // 2026-08-28, Q8. `assertTransportHonoursCredentials` had never fired on a
  // project run: `runTask` supplies no credential snapshot and `spawnRun`
  // replaces the child env wholesale, so the coordinator was the sole gate at
  // the boundary the payer decision crosses. It is armed for a tenant run now,
  // and it has to permit exactly the pins the parent translated — a gate that
  // refuses the feature it protects is not a gate.
  it('permits a claude-cli pin the parent named, and refuses one it did not', () => {
    const authorised = {
      ATOMA_MODEL_L2: 'claude-cli:sonnet',
      ATOMA_SUBSCRIPTION_TIERS: 'l2',
      ANTHROPIC_API_KEY: 'host-key',
    };
    expect(() => assertTransportHonoursCredentials('anthropic', authorised)).not.toThrow();
    // Same pin, a tier the parent did not authorise.
    expect(() =>
      assertTransportHonoursCredentials('anthropic', {
        ...authorised,
        ATOMA_MODEL_L3: 'claude-cli:opus',
      })
    ).toThrow(/cannot honour a supplied credential snapshot/);
    // No authorisation at all: the historical refusal, unchanged.
    expect(() =>
      assertTransportHonoursCredentials('anthropic', { ATOMA_MODEL_L2: 'claude-cli:sonnet' })
    ).toThrow(/cannot honour a supplied credential snapshot/);
    // The parent may authorise the ChatGPT-backed Codex route on a supervisor tier.
    expect(() =>
      assertTransportHonoursCredentials('anthropic', {
        ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
        ATOMA_SUBSCRIPTION_TIERS: 'l3',
      })
    ).not.toThrow();
    expect(() =>
      assertTransportHonoursCredentials('anthropic', {
        ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
        ATOMA_SUBSCRIPTION_TIERS: 'l2',
      })
    ).toThrow(/cannot honour a supplied credential snapshot/);
  });

  it('lets the whole-deployment regime through only when the parent said base', () => {
    expect(() =>
      assertTransportHonoursCredentials('claude-cli', { ATOMA_SUBSCRIPTION_TIERS: 'base' })
    ).not.toThrow();
    expect(() => assertTransportHonoursCredentials('claude-cli', {})).toThrow(
      /binds to the machine/
    );
  });
});

describe('base provider selection — one rule for runner and curriculum', () => {
  it('defaults to Anthropic and recognises Z.ai and Ollama', () => {
    expect(resolveBaseProviderKind()).toBe('anthropic');
    expect(resolveBaseProviderKind('ANTHROPIC')).toBe('anthropic');
    expect(resolveBaseProviderKind('ollama')).toBe('ollama');
    expect(resolveBaseProviderKind('ZAI')).toBe('zai');
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
    // The client carries a credential snapshot and only the caller knows
    // whether an Anthropic credential should be demanded at all, so the
    // switch never constructs one implicitly.
    expect(() => makeBaseClient('anthropic')).toThrow(/opts\.anthropic/);
    const fake = { messages: { create: async () => ({}) } } as unknown as Anthropic;
    expect(makeBaseClient('anthropic', { anthropic: fake })).toBeInstanceOf(AnthropicLlmClient);
  });

  it('builds Z.ai as the base provider from the injected snapshot', () => {
    expect(() => makeBaseClient('zai', { env: {} })).toThrow(/ZAI_API_KEY/);
    expect(
      makeBaseClient('zai', {
        env: { ZAI_API_KEY: 'zai-key-from-snapshot' },
      })
    ).toBeInstanceOf(AnthropicLlmClient);
  });
});

describe('makeAnthropicClient — credentials are a per-run value, not process state', () => {
  it('resolves the key from the SNAPSHOT, not from process.env', () => {
    // T10 (docs/saas-architecture.md): one process must be able to serve two
    // credentials. Reading process.env at construction time made that
    // impossible; the snapshot argument is what makes it possible.
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-process-env';
    try {
      const client = makeAnthropicClient({ ANTHROPIC_API_KEY: 'sk-ant-from-snapshot' });
      expect(client.apiKey).toBe('sk-ant-from-snapshot');
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('ATOMA_AUTH=cli drops the key WITHOUT mutating the caller environment', () => {
    // The defect: the old implementation ran `delete process.env['ANTHROPIC_API_KEY']`
    // to make the SDK skip the env key. Mutating the parent process to steer a
    // constructor makes the function unusable in any process serving a second
    // credential, and leaks across every later call in the same process.
    const snapshot: NodeJS.ProcessEnv = {
      ATOMA_AUTH: 'cli',
      ANTHROPIC_API_KEY: 'sk-ant-should-be-ignored',
    };
    const client = makeAnthropicClient(snapshot);
    expect(client.apiKey).toBeNull();
    expect(snapshot['ANTHROPIC_API_KEY']).toBe('sk-ant-should-be-ignored');
  });

  it('passes a bearer token through and never exits the process', () => {
    const client = makeAnthropicClient({ ANTHROPIC_AUTH_TOKEN: 'bearer-token' });
    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBe('bearer-token');
  });

  it('builds tier-pinned providers from the SNAPSHOT, not from process.env', () => {
    const previous = process.env['ATOMA_MODEL_L1'];
    process.env['ATOMA_MODEL_L1'] = 'zai:from-process-env';
    try {
      // The snapshot pins no cross-provider tier, so nothing is built even
      // though the ambient environment asks for Z.ai.
      expect(buildReferencedProviders({})).toEqual({});
      // …and a pin IN the snapshot is honoured, with its key read from the
      // same snapshot rather than from the process.
      const built = buildReferencedProviders({
        ATOMA_MODEL_L1: 'zai:glm-4.5-air',
        ZAI_API_KEY: 'zai-key-from-snapshot',
      });
      expect(Object.keys(built)).toEqual(['zai']);
    } finally {
      if (previous === undefined) delete process.env['ATOMA_MODEL_L1'];
      else process.env['ATOMA_MODEL_L1'] = previous;
    }
  });

  it('refuses a transport that cannot read the snapshot it was handed', () => {
    expect(() => assertTransportHonoursCredentials('claude-cli')).toThrow(RunnerConfigError);
    expect(() => assertTransportHonoursCredentials('claude-cli')).toThrow(
      /cannot honour a supplied credential snapshot/
    );
    // The transports that CAN read it are untouched.
    expect(() => assertTransportHonoursCredentials('anthropic')).not.toThrow();
    expect(() => assertTransportHonoursCredentials('ollama')).not.toThrow();
    // A key-bearing base with a machine-bound TIER pin used to slip through
    // (review 2026-08-18 §1.6): the gate only inspected ATOMA_LLM.
    expect(() =>
      assertTransportHonoursCredentials('anthropic', { ATOMA_MODEL_L2: 'claude-cli:sonnet' })
    ).toThrow(/tier pin "claude-cli:"/);
    expect(() =>
      assertTransportHonoursCredentials('anthropic', { ATOMA_MODEL_L3: 'codex:gpt-5.6-sol' })
    ).toThrow(/tier pin "codex:"/);
  });

  it('returns a client with no credential rather than killing the process', () => {
    // The SDK resolves credentials on the first REQUEST, so construction
    // cannot fail here. The old code caught a throw that never happens and
    // called process.exit(1) — unreachable, and fatal to a hosted process if
    // it ever became reachable.
    const client = makeAnthropicClient({});
    expect(client.apiKey).toBeNull();
    expect(client.authToken).toBeNull();
  });
});
