import { describe, it, expect } from 'vitest';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText } from './helpers.js';
import type { RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * Regression tests for L2 fallback tool access — companion to the L3
 * fallback fix. When Neuron escalates and Sucrose falls back, Sucrose also
 * needs real tool access to actually write files / start servers. Earlier
 * runs produced "FALLBACK_NO_TOOLS" payloads with HTML as prose, which the
 * L3 supervisor rightly rejected, wasting the remaining budget.
 */

const writeTool: Tool = {
  name: 'write_file',
  description: 'Writes a file.',
  inputSchema: { type: 'object', properties: {} },
};

const validatorTool: Tool = {
  name: 'validate_html',
  description: 'Headless browser validator.',
  inputSchema: { type: 'object', properties: {} },
};

class RecordingExecutor implements ToolExecutor {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  has(_name: string): boolean {
    return true;
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return { ok: true };
  }
}

function makeL2WithTools(tools: Tool[]): L2Atom {
  const reg = new AtomRegistry(openDb(':memory:'));
  const type = reg.create(2, {
    description: 'd',
    systemPrompt: 'sys',
    tools,
    params: {},
    createdBy: 't',
  });
  return L2Atom.fromType(type, reg);
}

describe('L2 fallback execute — tool access', () => {
  it('forwards this.tools and ctx.tools into the completion request', async () => {
    const l2 = makeL2WithTools([writeTool]);
    l2.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: RunContext = { ...makeCtx(), tools: executor };
    (ctx.llm as { enqueueText: (s: string) => void }).enqueueText(
      jsonText({ output: 'done', summary: 'ok' })
    );

    await l2.execute(
      { description: 'build' },
      { reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' },
      ctx
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (ctx.llm as any).calls[0] as { tools?: Tool[]; executor?: ToolExecutor };
    expect(call.tools).toEqual([writeTool]);
    expect(call.executor).toBe(executor);
  });

  it('stays reasoning-only when ctx.tools is not wired (research-brief-style runs)', async () => {
    const l2 = makeL2WithTools([writeTool]);
    l2.setFallbackMode(true);
    const ctx = makeCtx(); // no tools executor
    ctx.llm.enqueueText(jsonText({ output: 'text', summary: 's' }));

    await l2.execute(
      { description: 'reason' },
      { reasoning: 'r', proposedAction: 'think', expectedOutput: 'e' },
      ctx
    );

    const call = ctx.llm.calls[0]!;
    expect(call.tools).toBeUndefined();
    expect(call.executor).toBeUndefined();
    expect(call.userContent).toMatch(/NO tool access/);
  });

  it('raises the tool-iteration budget when validate_html is in the toolset', async () => {
    const l2 = makeL2WithTools([writeTool, validatorTool]);
    l2.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: RunContext = { ...makeCtx(), tools: executor };
    (ctx.llm as { enqueueText: (s: string) => void }).enqueueText(
      jsonText({ output: 'done', summary: 'ok' })
    );

    await l2.execute(
      { description: 'build' },
      { reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' },
      ctx
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (ctx.llm as any).calls[0] as { maxToolIterations?: number };
    expect(call.maxToolIterations).toBe(40);
  });

  it('selfPlan catalogs the tools so the LLM knows what it can call', async () => {
    const l2 = makeL2WithTools([writeTool]);
    l2.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: RunContext = { ...makeCtx(), tools: executor };
    (ctx.llm as { enqueueText: (s: string) => void }).enqueueText(
      jsonText({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' })
    );

    await l2.plan({ description: 'build' }, ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (ctx.llm as any).calls[0] as { userContent: string };
    expect(call.userContent).toMatch(/HAVE tool access/);
    expect(call.userContent).toContain('- write_file:');
  });
});
