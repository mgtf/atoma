import { describe, it, expect } from 'vitest';
import { AnthropicLlmClient, DEFAULT_MAX_TOOL_ITERATIONS } from '../src/core/llm.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * Regression tests for the MAX_TOOL_ITERATIONS rework:
 *  - default budget is the bumped constant
 *  - per-call `maxToolIterations` caps the loop
 *  - on budget exhaustion we gracefully finalize with a tools-disabled
 *    round-trip instead of throwing
 */

interface SdkCall {
  params: {
    tools?: unknown;
    messages: Array<{ role: string; content: unknown }>;
  };
  hadTools: boolean;
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

const echoExecutor: ToolExecutor = {
  async execute(name: string): Promise<string> {
    return `ok:${name}`;
  },
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

    // The first two calls advertise tools; the finalization call must NOT.
    expect(calls[0]!.hadTools).toBe(true);
    expect(calls[1]!.hadTools).toBe(true);
    expect(calls[2]!.hadTools).toBe(false);

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
});
