import { describe, it, expect } from 'vitest';
import {
  AnthropicLlmClient,
  DEFAULT_MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_CHARS,
  truncateToolResultContent,
} from '../src/core/llm.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * Regression tests for the MAX_TOOL_ITERATIONS rework:
 *  - default budget is the bumped constant
 *  - per-call `maxToolIterations` caps the loop
 *  - on budget exhaustion we gracefully finalize with a tools-disabled
 *    round-trip instead of throwing — tools stay DECLARED (cache prefix
 *    preserved) but `tool_choice: none` forbids their use
 */

interface SdkCall {
  params: {
    tools?: unknown;
    tool_choice?: { type: string };
    messages: Array<{ role: string; content: unknown }>;
  };
  hadTools: boolean;
  toolChoice: string | undefined;
}

type Reply =
  | { kind: 'tool_use'; toolName: string; input?: Record<string, unknown> }
  | { kind: 'text'; text: string };

/**
 * Builds a fake Anthropic SDK whose `messages.create` consumes a queued
 * reply script. Each reply is either a `tool_use` (triggers another loop)
 * or a `text` (final response).
 */
function makeFakeSdk(queue: Reply[]): {
  sdk: { messages: { create: (...a: unknown[]) => Promise<unknown> } };
  calls: SdkCall[];
} {
  const calls: SdkCall[] = [];
  let toolUseId = 0;
  const sdk = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (params: any): Promise<unknown> => {
        calls.push({
          params,
          hadTools: Array.isArray(params.tools) && params.tools.length > 0,
          toolChoice: params.tool_choice?.type,
        });
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `fake SDK ran out of replies after ${calls.length} call(s)`
          );
        }
        if (next.kind === 'text') {
          return {
            content: [{ type: 'text', text: next.text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        toolUseId += 1;
        return {
          content: [
            {
              type: 'tool_use',
              id: `tu_${toolUseId}`,
              name: next.toolName,
              input: next.input ?? {},
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  return { sdk, calls };
}

// The fakes below accept ANY tool name, so `has` honestly answers true for
// everything. The tool-use loop never calls it (the declared-tools gate is
// what filters names) — it is part of the `ToolExecutor` contract, nothing
// more.
const echoExecutor: ToolExecutor = {
  async execute(name: string): Promise<string> {
    return `ok:${name}`;
  },
  has: () => true,
};

const echoTool = {
  name: 'echo',
  description: 'echo',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

describe('AnthropicLlmClient tool-iteration budget', () => {
  it('exposes a default budget of DEFAULT_MAX_TOOL_ITERATIONS', () => {
    expect(DEFAULT_MAX_TOOL_ITERATIONS).toBeGreaterThanOrEqual(24);
  });

  it('honours per-call maxToolIterations by finalizing when the cap is hit', async () => {
    // Script: 2 tool_use rounds, then the SDK would normally return more
    // tool_use — but we cap at 2, so the client should do ONE tools-disabled
    // round-trip at the boundary to extract a final text response.
    const finalText = JSON.stringify({ output: 'done', summary: 'forced' });
    const { sdk, calls } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo' },
      { kind: 'tool_use', toolName: 'echo' },
      { kind: 'text', text: finalText },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const resp = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 2,
    });

    expect(resp.text).toBe(finalText);
    expect(calls.length).toBe(3);

    // Every call keeps the tool declarations (dropping them would invalidate
    // the whole prompt cache on the loop's largest request); the finalization
    // call instead forbids tool use via tool_choice: none.
    expect(calls[0]!.hadTools).toBe(true);
    expect(calls[0]!.toolChoice).toBeUndefined();
    expect(calls[1]!.hadTools).toBe(true);
    expect(calls[1]!.toolChoice).toBeUndefined();
    expect(calls[2]!.hadTools).toBe(true);
    expect(calls[2]!.toolChoice).toBe('none');

    // The finalization user turn must carry our "budget exhausted" hint so
    // the model actually stops trying to call tools.
    const lastUserMsg = calls[2]!.params.messages.at(-1)!;
    expect(lastUserMsg.role).toBe('user');
    const contentArr = Array.isArray(lastUserMsg.content) ? lastUserMsg.content : [];
    const hintBlock = contentArr.find(
      (b: { type?: string; text?: string }) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.includes('TOOL BUDGET EXHAUSTED')
    );
    expect(hintBlock).toBeTruthy();
  });

  it('does not inject a finalization turn when the model finishes on its own', async () => {
    const finalText = JSON.stringify({ output: 'direct', summary: 'no loop' });
    const { sdk, calls } = makeFakeSdk([{ kind: 'text', text: finalText }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const resp = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 5,
    });

    expect(resp.text).toBe(finalText);
    expect(calls.length).toBe(1);
    expect(calls[0]!.hadTools).toBe(true);
  });

  it('invokes onToolInvocation for each successful tool call with args + result', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo', input: { x: 1 } },
      { kind: 'tool_use', toolName: 'echo', input: { x: 2 } },
      { kind: 'text', text: 'done' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);

    const seen: Array<{ name: string; args: unknown; result?: unknown; error?: string }> = [];
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 5,
      onToolInvocation: (info) =>
        seen.push({ name: info.name, args: info.args, result: info.result, error: info.error }),
    });

    expect(seen).toEqual([
      { name: 'echo', args: { x: 1 }, result: 'ok:echo', error: undefined },
      { name: 'echo', args: { x: 2 }, result: 'ok:echo', error: undefined },
    ]);
  });

  it('invokes onToolInvocation with an error when the tool executor throws', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo', input: {} },
      { kind: 'text', text: 'done' },
    ]);
    const boomExecutor: ToolExecutor = {
      async execute(): Promise<unknown> {
        throw new Error('boom');
      },
      has: () => true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const seen: Array<{ name: string; error?: string; result?: unknown }> = [];
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: boomExecutor,
      maxToolIterations: 3,
      onToolInvocation: (info) =>
        seen.push({ name: info.name, error: info.error, result: info.result }),
    });
    expect(seen).toEqual([
      { name: 'echo', error: 'boom', result: undefined },
    ]);
  });

  it('swallows observer exceptions so the tool loop keeps running', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo', input: {} },
      { kind: 'text', text: 'still-ok' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const resp = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 3,
      onToolInvocation: () => {
        throw new Error('observer crashed');
      },
    });
    expect(resp.text).toBe('still-ok');
  });

  it('aggregates usage across loop + finalization calls', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo' },
      { kind: 'text', text: 'ok' },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const resp = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 1,
    });

    // Each fake reply reports (1, 1); with budget=1 we do one tool_use round
    // + one finalization round = 2 calls total.
    expect(resp.usage.inputTokens).toBe(2);
    expect(resp.usage.outputTokens).toBe(2);
  });

  it('keeps sampling disabled after a deprecation 400 on a later tool-loop round', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let toolUseId = 0;
    const sdk = {
      messages: {
        create: async (params: Record<string, unknown>): Promise<unknown> => {
          requests.push(params);
          // Round 1 succeeds with sampling, so the fallback cannot be limited
          // to iter=0. The provider only reveals the incompatibility on the
          // second request in this simulated model rollout.
          if (requests.length === 2) {
            throw Object.assign(new Error('`temperature` is deprecated for this model'), {
              status: 400,
            });
          }
          if (requests.length === 4) {
            return {
              content: [{ type: 'text', text: 'finalized' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          toolUseId += 1;
          return {
            content: [
              { type: 'tool_use', id: `tu_${toolUseId}`, name: 'echo', input: {} },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);

    const resp = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 2,
    });

    expect(resp.text).toBe('finalized');
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => Object.hasOwn(request, 'temperature'))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect((requests[3]!['tool_choice'] as { type?: string }).type).toBe('none');
  });

  it('retries a sampling deprecation first reported by budget finalization', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const sdk = {
      messages: {
        create: async (params: Record<string, unknown>): Promise<unknown> => {
          requests.push(params);
          if (requests.length === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tu_1', name: 'echo', input: {} }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 2, output_tokens: 3 },
            };
          }
          if (requests.length === 2) {
            throw Object.assign(new Error('temperature is deprecated for this model'), {
              status: 400,
            });
          }
          return {
            content: [{ type: 'text', text: 'finalized without sampling' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 7 },
          };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);

    const response = await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: echoExecutor,
      maxToolIterations: 1,
    });

    expect(response.text).toBe('finalized without sampling');
    expect(response.usage.inputTokens).toBe(7);
    expect(response.usage.outputTokens).toBe(10);
    expect(requests.map((request) => Object.hasOwn(request, 'temperature'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(requests.slice(1).map((request) =>
      (request['tool_choice'] as { type?: string }).type
    )).toEqual(['none', 'none']);
  });
});

describe('tool_result truncation', () => {
  it('truncateToolResultContent keeps short content verbatim', () => {
    expect(truncateToolResultContent('hello')).toBe('hello');
  });

  it('truncateToolResultContent elides the middle with an explicit marker', () => {
    const big = 'H'.repeat(30_000) + 'MIDDLE' + 'T'.repeat(30_000);
    const out = truncateToolResultContent(big);
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 300);
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
    expect(out).toContain('tool output truncated');
    expect(out).not.toContain('MIDDLE');
  });

  it('truncates the model-facing tool_result but hands the observer the full result', async () => {
    const bigOutput = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 3);
    const bigExecutor: ToolExecutor = {
      async execute(): Promise<string> {
        return bigOutput;
      },
      has: () => true,
    };
    const { sdk, calls } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'echo' },
      { kind: 'text', text: 'done' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const seen: unknown[] = [];
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [echoTool],
      executor: bigExecutor,
      maxToolIterations: 5,
      onToolInvocation: (info) => seen.push(info.result),
    });

    // Observer (viz/trace) keeps the untruncated result.
    expect(seen).toEqual([bigOutput]);

    // The second SDK call carries the tool_result turn — its content must be
    // capped and marked, not the raw 60K-char payload.
    const toolResultTurn = calls[1]!.params.messages.at(-1)!;
    expect(toolResultTurn.role).toBe('user');
    const blocks = toolResultTurn.content as Array<{ type: string; content?: string }>;
    const tr = blocks.find((b) => b.type === 'tool_result')!;
    expect(tr.content!.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 300);
    expect(tr.content!).toContain('tool output truncated');
  });
});
