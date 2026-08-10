import { describe, it, expect } from 'vitest';
import { AnthropicLlmClient } from '../src/core/llm.js';
import type { ToolExecutor } from '../src/core/types.js';

/**
 * Regression tests for fix #8a: the tool-use loop in AnthropicLlmClient
 * refuses to execute tools the LLM asked for but that are NOT in the
 * caller's declared tool list (`req.tools`). The gate catches a class of
 * failure observed in the Node/REST live run where SMOKE_DESIGN_GUIDANCE
 * taught an HTTP-scope L1 about validate_html and the model invoked it
 * anyway, because the shared InMemoryToolRegistry would happily run any
 * registered tool name regardless of declaration scope.
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

describe('tool-use loop — declared-tools scope enforcement (#8a)', () => {
  it('rejects an off-scope tool_use with an is_error tool_result and does NOT invoke the executor', async () => {
    const { sdk, calls } = makeFakeSdk([
      // LLM tries to call validate_html, but only "fetch_url" is declared.
      { kind: 'tool_use', toolName: 'validate_html', input: { url: 'http://x/' } },
      // After seeing the scope error, it gives up and returns text.
      { kind: 'text', text: 'giving up' },
    ]);

    let executorInvoked = false;
    // `has` answers true for everything on purpose: these fakes stand in for
    // the shared InMemoryToolRegistry, which WOULD run any registered name.
    // The gate under test is the declared-tools check, not the executor.
    const executor: ToolExecutor = {
      async execute(): Promise<string> {
        executorInvoked = true;
        return 'should-never-happen';
      },
      has: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    const seenInvocations: Array<{ name: string; error?: string; result?: unknown }> = [];
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        {
          name: 'fetch_url',
          description: 'fetch a url',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executor,
      onToolInvocation: (info) =>
        seenInvocations.push({ name: info.name, error: info.error, result: info.result }),
    });

    // Executor was NOT called — the scope gate short-circuited.
    expect(executorInvoked).toBe(false);

    // The off-scope call was still surfaced via onToolInvocation (with error),
    // so traces and the decomposition report still know it happened.
    expect(seenInvocations).toHaveLength(1);
    expect(seenInvocations[0]!.name).toBe('validate_html');
    expect(seenInvocations[0]!.error).toMatch(/NOT in your declared tools/);
    expect(seenInvocations[0]!.error).toMatch(/fetch_url/);
    expect(seenInvocations[0]!.result).toBeUndefined();

    // The follow-up round was sent — the SDK saw a tool_result block with the
    // error message, so the model knew it should stop calling validate_html.
    expect(calls.length).toBe(2);
    // Second call's last user message carries the tool_result with is_error.
    const secondUserMsg = calls[1]!.params.messages.at(-1)!;
    expect(secondUserMsg.role).toBe('user');
    const contentArr = Array.isArray(secondUserMsg.content) ? secondUserMsg.content : [];
    const errBlock = contentArr.find(
      (b: { type?: string; is_error?: boolean }) => b.type === 'tool_result' && b.is_error === true
    );
    expect(errBlock).toBeTruthy();
  });

  it('still invokes the executor for in-scope tool_use calls (scope gate is selective, not blanket)', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'fetch_url', input: { url: 'http://x/' } },
      { kind: 'text', text: 'done' },
    ]);

    let executorInvokedWith: string | null = null;
    const executor: ToolExecutor = {
      async execute(name: string): Promise<string> {
        executorInvokedWith = name;
        return 'ok';
      },
      has: () => true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        {
          name: 'fetch_url',
          description: 'fetch a url',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executor,
    });
    expect(executorInvokedWith).toBe('fetch_url');
  });

  it('the error message lists ALL declared tool names so the model can course-correct', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'ghost', input: {} },
      { kind: 'text', text: 'giving up' },
    ]);
    const executor: ToolExecutor = {
      async execute(): Promise<string> { return 'x'; },
      has: () => true,
    };
    let seen: { error?: string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      tools: [
        { name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } },
        { name: 'run_shell', description: 'r', inputSchema: { type: 'object', properties: {} } },
      ],
      executor,
      onToolInvocation: (info) => {
        seen = { error: info.error };
      },
    });
    expect(seen).not.toBeNull();
    const msg = (seen as unknown as { error: string }).error;
    expect(msg).toMatch(/write_file/);
    expect(msg).toMatch(/run_shell/);
    // The allowlist clause — the comma-joined list after "may only
    // invoke:" and before the next "." — must not include the rejected
    // tool name. The full message does mention the rejected name
    // separately ("Do not call ghost again"), which is intentional
    // coaching, not scope leakage.
    const afterMarker = msg.split('You may only invoke: ')[1] ?? '';
    const allowlistClause = afterMarker.split('.')[0] ?? '';
    expect(allowlistClause).not.toMatch(/ghost/);
  });

  it('leaves the loop behaviour unchanged when req.tools is absent (no scope to enforce)', async () => {
    const { sdk } = makeFakeSdk([
      { kind: 'tool_use', toolName: 'anything', input: {} },
      { kind: 'text', text: 'done' },
    ]);
    let executorInvokedWith: string | null = null;
    const executor: ToolExecutor = {
      async execute(name: string): Promise<string> {
        executorInvokedWith = name;
        return 'ok';
      },
      has: () => true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(sdk as any);
    await client.complete({
      model: 'claude-haiku-test',
      systemPrompt: 's',
      userContent: 'u',
      // No tools array — the gate is disabled because there's no declared
      // scope to enforce.
      executor,
    });
    expect(executorInvokedWith).toBe('anything');
  });
});
