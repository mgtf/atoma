import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OLLAMA_DEFAULT_CONTEXT_LENGTH,
  OllamaLlmClient,
  ollamaContextLength,
} from '../src/core/llmOllama.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * Unit tests for the Ollama-backed LlmClient. The atom tier never
 * cares which provider underlies `ctx.llm` as long as the contract
 * (request shape + LlmCompletionResponse) holds, so this suite
 * focuses on that contract:
 *   - system+user → Ollama `messages` with the right roles;
 *   - our `Tool[]` → Ollama `tools` with OpenAI-style function schema;
 *   - tool_calls in the response trigger the tool loop (executor +
 *     onToolInvocation), tool_result messages are appended to the
 *     conversation before the next request;
 *   - declared-tools scope (#8a) rejects off-scope tool calls without
 *     hitting the executor;
 *   - usage is aggregated across tool-loop iterations.
 *
 * No network calls — we stub `globalThis.fetch` to replay scripted
 * Ollama responses.
 */

type FetchArgs = Parameters<typeof fetch>;

type Stub = (...args: FetchArgs) => Promise<Response>;

/**
 * The fetch input can be a string, a URL or a Request. Typing the stub
 * properly (it used to be `RequestInfo`, a DOM type absent from this project's
 * `lib`, which silently degraded to `any`) made that visible — `String()` on a
 * Request would assert against '[object Object]' and pass for the wrong
 * reason.
 */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installFetchStub(stub: Stub): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prev = (globalThis as any).fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = stub;
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = prev;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OllamaLlmClient', () => {
  let calls: FetchArgs[];
  let restore: () => void;

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    if (restore) restore();
  });

  it('POSTs a single /api/chat with system + user messages when no tool calls come back', async () => {
    restore = installFetchStub(async (input, init) => {
      calls.push([input, init]);
      return jsonResponse({
        model: 'glm-5.1:cloud',
        message: { role: 'assistant', content: 'hello back' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 3,
      });
    });

    const client = new OllamaLlmClient({ defaultModel: 'glm-5.1:cloud' });
    const resp = await client.complete({
      model: 'claude-haiku-4-5-20251001', // Anthropic pin → collapses onto defaultModel
      systemPrompt: 'you are a helper',
      userContent: 'hi',
    });

    expect(resp.text).toBe('hello back');
    expect(resp.stopReason).toBe('stop');
    expect(resp.usage.inputTokens).toBe(10);
    expect(resp.usage.outputTokens).toBe(3);
    expect(resp.usage.cacheReadInputTokens).toBe(0); // Ollama has no cache

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(urlOf(url)).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('glm-5.1:cloud');
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.stream).toBe(false);
  });

  it('maps our Tool[] into OpenAI-style function tools', async () => {
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      return jsonResponse({
        model: 'x',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        done_reason: 'stop',
      });
    });
    const client = new OllamaLlmClient();
    await client.complete({
      model: 'claude-opus-5', // Anthropic pin → collapses onto defaultModel
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        {
          name: 'write_file',
          description: 'write a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    });
    const body = JSON.parse(calls[0]![1]!.body as string);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'write a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]);
  });

  it('runs a tool-use loop when the model emits tool_calls (executor invoked, result appended)', async () => {
    let step = 0;
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      step++;
      if (step === 1) {
        // First round: model requests a tool_call.
        return jsonResponse({
          model: 'x',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                function: {
                  name: 'write_file',
                  arguments: { path: 'a.txt', content: 'hello' },
                },
              },
            ],
          },
          done: false,
          prompt_eval_count: 10,
          eval_count: 5,
        });
      }
      // Second round: model returns a final text.
      return jsonResponse({
        model: 'x',
        message: { role: 'assistant', content: 'all done' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 15,
        eval_count: 8,
      });
    });

    const executorCalls: Array<{ name: string; args: unknown }> = [];
    const executor: ToolExecutor = {
      async execute(name, args) {
        executorCalls.push({ name, args });
        return { ok: true, path: (args as { path?: string }).path ?? '?' };
      },
      has: () => true,
    };
    const seenInvocations: Array<{ name: string; args: unknown; result?: unknown }> = [];

    const client = new OllamaLlmClient();
    const resp = await client.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'do it',
      tools: [
        {
          name: 'write_file',
          description: 'write',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executor,
      onToolInvocation: (info) =>
        seenInvocations.push({ name: info.name, args: info.args, result: info.result }),
    });

    expect(resp.text).toBe('all done');
    expect(executorCalls).toEqual([
      { name: 'write_file', args: { path: 'a.txt', content: 'hello' } },
    ]);
    expect(seenInvocations).toHaveLength(1);
    expect(seenInvocations[0]!.name).toBe('write_file');
    expect((seenInvocations[0]!.result as { ok: boolean }).ok).toBe(true);

    // Round 2's messages must include the tool_result appended after
    // the assistant's tool_calls turn.
    const round2Body = JSON.parse(calls[1]![1]!.body as string);
    expect(round2Body.messages).toHaveLength(4);
    expect(round2Body.messages[2].role).toBe('assistant');
    expect(round2Body.messages[2].tool_calls).toBeTruthy();
    expect(round2Body.messages[3].role).toBe('tool');
    expect(round2Body.messages[3].tool_call_id).toBe('tc1');
    expect(round2Body.messages[3].name).toBe('write_file');

    // Usage aggregates across both rounds.
    expect(resp.usage.inputTokens).toBe(25);
    expect(resp.usage.outputTokens).toBe(13);
  });

  it('enforces declared-tools scope (#8a) across the Ollama path too', async () => {
    let step = 0;
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      step++;
      if (step === 1) {
        return jsonResponse({
          model: 'x',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'validate_html', arguments: { url: 'x' } } },
            ],
          },
          done: false,
        });
      }
      return jsonResponse({
        model: 'x',
        message: { role: 'assistant', content: 'giving up' },
        done: true,
        done_reason: 'stop',
      });
    });

    let executorInvoked = false;
    const executor: ToolExecutor = {
      async execute(): Promise<unknown> {
        executorInvoked = true;
        return 'never';
      },
      has: () => true,
    };
    const seen: Array<{ name: string; error?: string; result?: unknown }> = [];

    const client = new OllamaLlmClient();
    await client.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        {
          name: 'fetch_url',
          description: 'fetch',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executor,
      onToolInvocation: (info) =>
        seen.push({ name: info.name, error: info.error, result: info.result }),
    });

    expect(executorInvoked).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('validate_html');
    expect(seen[0]!.error).toMatch(/NOT in your declared tools/);
    expect(seen[0]!.error).toMatch(/fetch_url/);
    expect(seen[0]!.result).toBeUndefined();

    // The tool_result appended to the round-2 conversation carries the
    // error text so the model sees why the call was rejected.
    const round2Body = JSON.parse(calls[1]![1]!.body as string);
    const toolMsg = round2Body.messages[round2Body.messages.length - 1];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toMatch(/NOT in your declared tools/);
  });

  it('normalises a pseudo-final return without a second Ollama round-trip', async () => {
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      return jsonResponse({
        model: 'x',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc-final',
              function: {
                name: 'return',
                arguments: { output: '{"ok":true}', summary: 'verified' },
              },
            },
          ],
        },
        done: false,
      });
    });
    const client = new OllamaLlmClient();
    const response = await client.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        {
          name: 'write_file',
          description: 'write',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executor: { execute: async () => 'unexpected', has: () => true },
    });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(response.text)).toEqual({
      output: { ok: true },
      summary: 'verified',
    });
  });

  it('throws with a descriptive error when Ollama returns a non-200', async () => {
    restore = installFetchStub(async () => {
      return new Response('model not found', { status: 404 });
    });
    const client = new OllamaLlmClient();
    await expect(
      client.complete({ model: 'x', systemPrompt: 's', userContent: 'u' })
    ).rejects.toThrow(/Ollama HTTP 404/);
  });

  it('reports the SERVED model: pins collapse onto defaultModel, explicit tags stay verbatim', async () => {
    // Pricing on req.model billed Claude rates for local/GLM tokens — the
    // observability layers price on servedModel (review 2026-08-14 §1.13).
    restore = installFetchStub(async () =>
      jsonResponse({ model: 'x', message: { role: 'assistant', content: 'ok' }, done: true })
    );
    const client = new OllamaLlmClient({ defaultModel: 'glm-5.1:cloud' });
    const collapsed = await client.complete({
      model: 'claude-opus-5',
      systemPrompt: 's',
      userContent: 'u',
    });
    expect(collapsed.servedModel).toBe('glm-5.1:cloud');
    const verbatim = await client.complete({
      model: 'qwen3:8b',
      systemPrompt: 's',
      userContent: 'u',
    });
    expect(verbatim.servedModel).toBe('qwen3:8b');
  });

  it('attaches the usage aggregated SO FAR to an error leaving the tool loop (partialUsage parity)', async () => {
    // Mirror of AnthropicLlmClient.raise (e15d810): a run killed on round 2
    // used to lose round 1's paid tokens — MetricsLlmClient recorded zeros
    // (review 2026-08-14 §1.13).
    let step = 0;
    restore = installFetchStub(async () => {
      step++;
      if (step === 1) {
        return jsonResponse({
          model: 'x',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc1', function: { name: 'write_file', arguments: { path: 'a' } } }],
          },
          done: false,
          prompt_eval_count: 10,
          eval_count: 5,
        });
      }
      return new Response('boom', { status: 500 });
    });
    const client = new OllamaLlmClient();
    const executor: ToolExecutor = { execute: async () => 'ok', has: () => true };
    let caught: unknown;
    try {
      await client.complete({
        model: 'x',
        systemPrompt: 's',
        userContent: 'u',
        tools: [{ name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } }],
        executor,
      });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toMatch(/Ollama HTTP 500/);
    expect((caught as { partialUsage?: unknown }).partialUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('forwards temperature / maxTokens as Ollama options', async () => {
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      return jsonResponse({
        model: 'x',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      });
    });
    const client = new OllamaLlmClient();
    await client.complete({
      model: 'x',
      systemPrompt: 's',
      userContent: 'u',
      params: { temperature: 0, maxTokens: 500 },
    });
    const body = JSON.parse(calls[0]![1]!.body as string);
    expect(body.options).toEqual({
      num_ctx: OLLAMA_DEFAULT_CONTEXT_LENGTH,
      temperature: 0,
      num_predict: 500,
    });
  });

  it('always pins a context large enough for atoma prompts', async () => {
    restore = installFetchStub(async (_i, init) => {
      calls.push([_i, init]);
      return jsonResponse({
        model: 'x',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      });
    });
    const client = new OllamaLlmClient();
    await client.complete({ model: 'x', systemPrompt: 's', userContent: 'u' });
    const body = JSON.parse(calls[0]![1]!.body as string);
    expect(body.options).toEqual({ num_ctx: OLLAMA_DEFAULT_CONTEXT_LENGTH });
    expect(ollamaContextLength('16384')).toBe(16_384);
    expect(ollamaContextLength('4096')).toBe(OLLAMA_DEFAULT_CONTEXT_LENGTH);
    expect(ollamaContextLength('invalid')).toBe(OLLAMA_DEFAULT_CONTEXT_LENGTH);
  });

  it('respects a custom baseUrl + defaultModel', async () => {
    restore = installFetchStub(async (input, init) => {
      calls.push([input, init]);
      return jsonResponse({
        model: 'custom',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      });
    });
    const client = new OllamaLlmClient({
      baseUrl: 'http://remote:9999/',
      defaultModel: 'llama3.3:70b',
      contextLength: 65_536,
    });
    await client.complete({ model: 'claude-opus-5', systemPrompt: 's', userContent: 'u' });
    expect(urlOf(calls[0]![0])).toBe('http://remote:9999/api/chat');
    const body = JSON.parse(calls[0]![1]!.body as string);
    expect(body.model).toBe('llama3.3:70b');
    expect(body.options.num_ctx).toBe(65_536);
  });
});

/**
 * Per-call inactivity clock (2026-08-15 wedging investigation, layer B):
 * Ollama was the ONLY transport without one — a wedged non-streaming
 * /api/chat held the await for the run's entire remaining budget, invisible
 * to the advisory abort and below the watchdog's deadline. The clock aborts
 * the fetch with an attributed error; the caller's outer signal keeps
 * precedence and its reason survives verbatim.
 */
describe('OllamaLlmClient — per-call inactivity clock', () => {
  const hangRespectingSignal: Stub = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        },
        { once: true }
      );
    });

  it('aborts a wedged /api/chat after callTimeoutMs with an attributed error', async () => {
    const restore = installFetchStub(hangRespectingSignal);
    try {
      const client = new OllamaLlmClient({ defaultModel: 'stub', callTimeoutMs: 25 });
      await expect(
        client.complete({ model: 'stub', systemPrompt: 's', userContent: 'u' })
      ).rejects.toThrow(/per-call inactivity clock/);
    } finally {
      restore();
    }
  });

  it('the outer signal still wins, and its reason survives verbatim', async () => {
    const restore = installFetchStub(hangRespectingSignal);
    try {
      const client = new OllamaLlmClient({ defaultModel: 'stub', callTimeoutMs: 60_000 });
      const outer = new AbortController();
      const pending = client.complete({
        model: 'stub',
        systemPrompt: 's',
        userContent: 'u',
        signal: outer.signal,
      });
      setTimeout(() => outer.abort(new Error('outer deadline says stop')), 10);
      await expect(pending).rejects.toThrow(/outer deadline says stop/);
    } finally {
      restore();
    }
  });
});
