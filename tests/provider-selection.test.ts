import { describe, it, expect } from 'vitest';
import {
  assertTransportHonoursCredentials,
  buildTierClients,
  describeTierSelectors,
  makeTransportClient,
  tierSelectors,
} from '../src/run/providers.js';
import { makeAnthropicClient } from '../src/run/auth.js';
import { RunnerConfigError } from '../src/core/errors.js';
import { ModelSelectorError } from '../src/contracts/modelSelector.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { ClaudeCliLlmClient } from '../src/core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../src/core/llmCodexCli.js';
import { OllamaLlmClient } from '../src/core/llmOllama.js';
import { OpenAiLlmClient } from '../src/core/llmOpenAi.js';

const KEYED = {
  ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5-20251001',
  ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
  ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5',
  ANTHROPIC_API_KEY: 'host-key',
};

describe('the child re-checks what the parent authorised', () => {
  // 2026-08-28, Q8. `assertTransportHonoursCredentials` had never fired on a
  // project run: `runTask` supplies no credential snapshot and `spawnRun`
  // replaces the child env wholesale, so the coordinator was the sole gate at
  // the boundary the payer decision crosses. It is armed for a tenant run now,
  // and it has to permit exactly the tiers the parent authorised — a gate that
  // refuses the feature it protects is not a gate.
  it('permits a sub: tier the parent named, and refuses one it did not', () => {
    const authorised = { ...KEYED, ATOMA_MODEL_L2: 'sub:anthropic:sonnet', ATOMA_SUBSCRIPTION_TIERS: 'l2' };
    expect(() => assertTransportHonoursCredentials(authorised)).not.toThrow();
    // Same pin, a tier the parent did not authorise.
    expect(() =>
      assertTransportHonoursCredentials({ ...authorised, ATOMA_MODEL_L3: 'sub:anthropic:opus' })
    ).toThrow(/ATOMA_MODEL_L3=sub:anthropic:opus cannot honour a supplied credential snapshot/);
    // No authorisation at all: the historical refusal, unchanged.
    expect(() =>
      assertTransportHonoursCredentials({ ...KEYED, ATOMA_MODEL_L2: 'sub:anthropic:sonnet' })
    ).toThrow(/cannot honour a supplied credential snapshot/);
    // The parent may authorise the ChatGPT-backed Codex route on a supervisor
    // tier, host login or the requester's own.
    expect(() =>
      assertTransportHonoursCredentials({ ...KEYED, ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol', ATOMA_SUBSCRIPTION_TIERS: 'l3' })
    ).not.toThrow();
    expect(() =>
      assertTransportHonoursCredentials({ ...KEYED, ATOMA_MODEL_L3: 'own:openai:gpt-5.6-sol', ATOMA_SUBSCRIPTION_TIERS: 'l3' })
    ).not.toThrow();
    expect(() =>
      assertTransportHonoursCredentials({ ...KEYED, ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol', ATOMA_SUBSCRIPTION_TIERS: 'l2' })
    ).toThrow(/cannot honour a supplied credential snapshot/);
  });
});

describe('tierSelectors — the three required pins, parsed once', () => {
  it('names every missing variable at once, and says there is no default', () => {
    expect(() => tierSelectors({})).toThrow(ModelSelectorError);
    expect(() => tierSelectors({})).toThrow(
      /ATOMA_MODEL_L1, ATOMA_MODEL_L2, ATOMA_MODEL_L3 are not set.*there is no default/
    );
    expect(() => tierSelectors({ ...KEYED, ATOMA_MODEL_L2: '' })).toThrow(/ATOMA_MODEL_L2 is not set/);
  });

  it('refuses own: from a host environment unless the caller admits it (a tenant child)', () => {
    const own = { ...KEYED, ATOMA_MODEL_L3: 'own:openai:gpt-5.6-sol' };
    expect(() => tierSelectors(own)).toThrow(/own:\) is an account setting/);
    expect(tierSelectors(own, { allowOwn: true })[3]).toEqual({
      mode: 'own',
      vendor: 'openai',
      model: 'gpt-5.6-sol',
    });
  });

  it('accepts Codex on L1 for its host-side tool loop', () => {
    expect(tierSelectors({ ...KEYED, ATOMA_MODEL_L1: 'sub:openai:gpt-5.4-mini' })[1]).toEqual({ mode: 'sub', vendor: 'openai', model: 'gpt-5.4-mini' });
  });

  it('describes the gradient for the run banner', () => {
    expect(describeTierSelectors(tierSelectors(KEYED))).toBe(
      'L1=api:anthropic:claude-haiku-4-5-20251001  L2=api:anthropic:claude-sonnet-5  L3=api:anthropic:claude-opus-5'
    );
  });
});

describe('makeTransportClient — ONE construction switch per transport', () => {
  it('builds the Claude Code client for sub:anthropic', () => {
    expect(makeTransportClient('claude-cli')).toBeInstanceOf(ClaudeCliLlmClient);
  });

  it('builds Ollama from the injected env (OLLAMA_BASE_URL / OLLAMA_MODEL)', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return new Response(
        JSON.stringify({
          model: 'stub',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    try {
      const client = makeTransportClient('ollama', {
        env: { OLLAMA_BASE_URL: 'http://ollama.test:11434/', OLLAMA_MODEL: 'stub' },
      });
      expect(client).toBeInstanceOf(OllamaLlmClient);
      await client.complete({ model: 'qwen3:8b', systemPrompt: 's', userContent: 'u' });
      expect(calls[0]).toMatch(/^http:\/\/ollama\.test:11434\/api\/chat/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds anthropic-api from a caller-supplied SDK client or from the snapshot', () => {
    const supplied = makeAnthropicClient({ ANTHROPIC_API_KEY: 'sk-supplied' });
    expect(makeTransportClient('anthropic-api', { anthropic: supplied })).toBeInstanceOf(AnthropicLlmClient);
    expect(makeTransportClient('anthropic-api', { env: { ANTHROPIC_API_KEY: 'sk-snapshot' } })).toBeInstanceOf(
      AnthropicLlmClient
    );
  });

  it('builds Z.ai and OpenAI from the injected snapshot, and names the missing key otherwise', () => {
    expect(() => makeTransportClient('zai-api', { env: {} })).toThrow(/ZAI_API_KEY/);
    expect(makeTransportClient('zai-api', { env: { ZAI_API_KEY: 'zai-key-from-snapshot' } })).toBeInstanceOf(
      AnthropicLlmClient
    );
    expect(() => makeTransportClient('openai-api', { env: {} })).toThrow(/api:openai requires OPENAI_API_KEY/);
    expect(makeTransportClient('openai-api', { env: { OPENAI_API_KEY: 'sk-openai' } })).toBeInstanceOf(
      OpenAiLlmClient
    );
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

  it('builds tier clients from the SNAPSHOT, not from process.env', () => {
    const previous = process.env['ATOMA_MODEL_L1'];
    process.env['ATOMA_MODEL_L1'] = 'api:zai:from-process-env';
    try {
      // Only the transports the SNAPSHOT's selectors reach are built, each
      // from the snapshot's own credentials — the ambient Z.ai pin is ignored.
      const built = buildTierClients({
        ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5-20251001',
        ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
        ATOMA_MODEL_L3: 'api:openai:gpt-5.6-sol',
        ANTHROPIC_API_KEY: 'sk-from-snapshot',
        OPENAI_API_KEY: 'sk-openai-from-snapshot',
      });
      expect(Object.keys(built).sort()).toEqual(['anthropic-api', 'openai-api']);
      expect(built['openai-api']).toBeInstanceOf(OpenAiLlmClient);
      // Codex construction takes the same snapshot so CODEX_HOME can bind a
      // run to one principal profile instead of the ambient host login;
      // `own:` is admissible only where the caller says so.
      const codex = buildTierClients(
        {
          ATOMA_MODEL_L1: 'api:zai:glm-4.5-air',
          ATOMA_MODEL_L2: 'own:openai:gpt-5.6-terra',
          ATOMA_MODEL_L3: 'sub:anthropic:opus',
          ZAI_API_KEY: 'zai-key-from-snapshot',
          CODEX_HOME: '/profiles/principal-a/codex',
        },
        { allowOwn: true }
      );
      expect(Object.keys(codex).sort()).toEqual(['claude-cli', 'codex-cli', 'zai-api']);
      expect(codex['codex-cli']).toBeInstanceOf(CodexCliLlmClient);
      expect(codex['claude-cli']).toBeInstanceOf(ClaudeCliLlmClient);
      expect(codex['zai-api']).toBeInstanceOf(AnthropicLlmClient);
    } finally {
      if (previous === undefined) delete process.env['ATOMA_MODEL_L1'];
      else process.env['ATOMA_MODEL_L1'] = previous;
    }
  });

  it('refuses a subscription selector that cannot read the snapshot it was handed', () => {
    const keyed = {
      ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5-20251001',
      ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
      ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5',
      ANTHROPIC_API_KEY: 'sk-ant-tenant',
    };
    expect(() => assertTransportHonoursCredentials(keyed)).not.toThrow();
    expect(() =>
      assertTransportHonoursCredentials({ ...keyed, ATOMA_MODEL_L2: 'sub:anthropic:sonnet' })
    ).toThrow(RunnerConfigError);
    expect(() =>
      assertTransportHonoursCredentials({ ...keyed, ATOMA_MODEL_L2: 'sub:anthropic:sonnet' })
    ).toThrow(/ATOMA_MODEL_L2=sub:anthropic:sonnet cannot honour a supplied credential snapshot/);
    expect(() =>
      assertTransportHonoursCredentials({ ...keyed, ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol' })
    ).toThrow(/codex-cli selector binds to a machine-local login/);
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
