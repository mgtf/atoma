import { describe, it, expect } from 'vitest';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { MockLlmClient } from '../src/core/llm.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/** `makeCtx()` hands back a MockLlmClient; annotating plain `RunContext` would
 *  widen `llm` to the interface and lose `enqueueText` / `calls`. */
type MockCtx = RunContext & { llm: MockLlmClient };

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
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await l2.execute(
      { description: 'build' },
      makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
      ctx
    );

    const call = ctx.llm.calls[0]!;
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
      makePlan({ reasoning: 'r', proposedAction: 'think', expectedOutput: 'e' }),
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
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await l2.execute(
      { description: 'build' },
      makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
      ctx
    );

    const call = ctx.llm.calls[0]!;
    expect(call.maxToolIterations).toBe(40);
  });

  it('selfPlan catalogs the tools so the LLM knows what it can call', async () => {
    const l2 = makeL2WithTools([writeTool]);
    l2.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }));

    await l2.plan({ description: 'build' }, ctx);

    const call = ctx.llm.calls[0]!;
    expect(call.userContent).toMatch(/HAVE tool access/);
    expect(call.userContent).toContain('- write_file:');
  });
});
