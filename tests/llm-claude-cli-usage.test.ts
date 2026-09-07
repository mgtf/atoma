import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SERVED-MODEL + PARTIAL-USAGE contracts of the claude-cli transport
 * (review 2026-08-14 §1.13).
 *
 * This transport maps tier pins onto CLI aliases (haiku/sonnet/opus), so
 * pricing on the raw pin misattributes tokens — the response now reports
 * the alias it actually invoked as `servedModel`. And the non-success
 * result path computed mapped usage then DISCARDED it on the throw, so a
 * failed call lost tokens that were already billed; the error now carries
 * them as `partialUsage` (the AnthropicLlmClient.raise contract, e15d810).
 */

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  tool: (name: string) => ({ name }),
  createSdkMcpServer: (options: unknown) => options,
}));

const { ClaudeCliLlmClient } = await import('../src/core/llmClaudeCli.js');

const REQ = {
  model: 'claude-haiku-4-5',
  systemPrompt: 's',
  userContent: 'u',
};

function resultOnlyStream(msg: Record<string, unknown>) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield msg;
    },
  });
}

beforeEach(() => {
  queryMock.mockReset();
  delete process.env['ATOMA_CLAUDE_MODEL'];
});

describe('tool-budget finalization', () => {
  const request = () => ({
    ...REQ,
    maxToolIterations: 1,
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
    executor: { has: () => true, execute: vi.fn(async () => 'observed bytes') },
  });
  const exhausted = () => resultOnlyStream({
    type: 'result', subtype: 'error_max_turns', session_id: 'this-query-session',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
  });

  it('resumes only the exhausted session without any tools and sums both usages', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'success', result: '{"output":"observed bytes","summary":"done"}',
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 50 },
    }));
    const response = await new ClaudeCliLlmClient().complete(request());
    expect(response.text).toContain('"summary":"done"');
    expect(response).not.toHaveProperty('resumeSessionId');
    expect(response.usage).toEqual({ inputTokens: 13, outputTokens: 9, cacheReadInputTokens: 150, cacheCreationInputTokens: 0 });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]![0].options).toMatchObject({
      resume: 'this-query-session', model: 'haiku', maxTurns: 1,
      tools: [], mcpServers: {}, allowedTools: [], strictMcpConfig: true,
      settingSources: [],
    });
  });

  it('keeps the original and finalization usage when finalization fails', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'error_during_execution',
      usage: { input_tokens: 3, output_tokens: 4 },
    }));
    await expect(new ClaudeCliLlmClient().complete(request())).rejects.toMatchObject({
      partialUsage: { inputTokens: 13, outputTokens: 9, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('does not recursively retry a failed tools-disabled finalization', async () => {
    queryMock.mockImplementationOnce(exhausted()).mockImplementationOnce(resultOnlyStream({
      type: 'result', subtype: 'error_max_turns', session_id: 'this-query-session',
      usage: { input_tokens: 3, output_tokens: 4 },
    }));
    await expect(new ClaudeCliLlmClient().complete(request())).rejects.toThrow('error_max_turns');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('servedModel — the CLI alias actually invoked, not the pin', () => {
  it('reports the resolved alias on a successful call', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'success',
        result: 'done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3 },
      })
    );
    const client = new ClaudeCliLlmClient();
    const resp = await client.complete(REQ);
    expect(resp.text).toBe('done');
    expect(resp.servedModel).toBe('haiku');
  });

  it('reports the alias on the salvage path too (non-success result with assistant text)', async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial payload' }] },
        };
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          usage: { input_tokens: 5, output_tokens: 2 },
        };
      },
    }));
    const client = new ClaudeCliLlmClient();
    const resp = await client.complete({ ...REQ, model: 'claude-sonnet-5' });
    expect(resp.text).toBe('partial payload');
    expect(resp.servedModel).toBe('sonnet');
  });
});

describe('partialUsage — usage computed from the result message is not discarded on throw', () => {
  it('attaches the mapped usage when the query ends without output', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'error_during_execution',
        usage: { input_tokens: 42, output_tokens: 6, cache_read_input_tokens: 900 },
      })
    );
    const client = new ClaudeCliLlmClient();
    let caught: unknown;
    try {
      await client.complete(REQ);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toMatch(/ended without output/);
    expect((caught as { partialUsage?: unknown }).partialUsage).toEqual({
      inputTokens: 42,
      outputTokens: 6,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    });
  });

  it('sums BOTH attempts on the transport-error retry throw — two paid calls, not zero', async () => {
    queryMock.mockImplementation(
      resultOnlyStream({
        type: 'result',
        subtype: 'success',
        result: 'API Error: 529 Overloaded',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      })
    );
    const client = new ClaudeCliLlmClient();
    let caught: unknown;
    try {
      await client.complete(REQ);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toMatch(/transport error \(after 1 retry\)/);
    expect((caught as { partialUsage?: unknown }).partialUsage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  }, 20000);
});
