import { describe, it, expect } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { FALLBACK_OPUS, modelForTier } from '../src/core/models.js';
import { MockLlmClient } from '../src/core/llm.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/** `makeCtx()` hands back a MockLlmClient; annotating plain `RunContext` would
 *  widen `llm` to the interface and lose `enqueueText` / `calls`. */
type MockCtx = RunContext & { llm: MockLlmClient };

/**
 * Regression tests for L3 fallback tool access.
 *
 * Background: build-app runs that escalated to L3 fallback produced no output
 * on disk — only markdown-wrapped HTML in the result payload. Cause: the
 * fallback code path stamped "You have NO tools" into the prompt and never
 * forwarded `this.tools` / `ctx.tools` to the LLM, so even when write_file
 * was available nothing could call it.
 *
 * Fix: when both the atom's own tool declarations AND a ctx.tools executor
 * are present, selfPlan / selfExecute now surface them and wire the executor
 * into the completion request.
 */

const sampleTool: Tool = {
  name: 'write_file',
  description: 'Writes a file to disk.',
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

function makeL3WithTools(tools: Tool[]): L3Atom {
  const reg = new AtomRegistry(openDb(':memory:'));
  const type = reg.create(3, {
    description: 'd',
    systemPrompt: 'sys',
    tools,
    params: {},
    createdBy: 't',
  });
  return L3Atom.buildWithModel(type, reg, FALLBACK_OPUS);
}

describe('L3 fallback execute — tool access', () => {
  it('passes this.tools and ctx.tools into the LLM request when both are present', async () => {
    const l3 = makeL3WithTools([sampleTool]);
    l3.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    // Fallback execute skips plan validation, so one LLM reply is enough.
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await l3.execute(
      { description: 'build index.html' },
      makePlan({ reasoning: 'r', proposedAction: 'write_file', expectedOutput: 'e' }),
      ctx
    );

    const call = ctx.llm.calls[0]!;
    expect(call.model).toBe(modelForTier(1));
    expect(call.tools).toEqual([sampleTool]);
    expect(call.executor).toBe(executor);
  });

  it('omits tools when ctx.tools is not wired (research-brief-style runs)', async () => {
    const l3 = makeL3WithTools([sampleTool]);
    l3.setFallbackMode(true);
    const ctx = makeCtx(); // no tools
    ctx.llm.enqueueText(jsonText({ output: 'reasoning only', summary: 'ok' }));

    await l3.execute(
      { description: 'reason' },
      makePlan({ reasoning: 'r', proposedAction: 'think', expectedOutput: 'e' }),
      ctx
    );

    const call = ctx.llm.calls[0]!;
    expect(call.tools).toBeUndefined();
    expect(call.executor).toBeUndefined();
    expect(call.userContent).toMatch(/NO tool access/);
  });

  it('selfPlan advertises the tool catalog in fallback when tools are available', async () => {
    const l3 = makeL3WithTools([sampleTool]);
    l3.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }));

    await l3.plan({ description: 'build' }, ctx);

    const call = ctx.llm.calls[0]!;
    expect(call.userContent).toMatch(/HAVE tool access/);
    expect(call.userContent).toContain('- write_file:');
  });

  it('raises maxToolIterations when validate_html is in the fallback toolset', async () => {
    const l3 = makeL3WithTools([sampleTool, validatorTool]);
    l3.setFallbackMode(true);
    const executor = new RecordingExecutor();
    const ctx: MockCtx = { ...makeCtx(), tools: executor };
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));

    await l3.execute(
      { description: 'build' },
      makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
      ctx
    );

    const call = ctx.llm.calls[0]!;
    // Mirrors L1's 40-iteration budget for the validate → fix → re-validate
    // loop so fallback builds can actually converge.
    expect(call.maxToolIterations).toBe(40);
  });
});
