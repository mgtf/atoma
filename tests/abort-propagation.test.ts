import { describe, it, expect } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { llmVerdict } from '../src/atoms/L2Atom.js';
import { prefilterStrategy } from '../src/atoms/cost.js';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * Regression test for the earlier bug where `ctx.signal` never reached the
 * Anthropic SDK, so a global run-deadline could not abort in-flight calls.
 * Every call site that goes through `ctx.llm.complete` MUST now include
 * `signal: ctx.signal` so the SDK transport can honour it. We verify by
 * inspecting what MockLlmClient received.
 */

describe('abort signal propagation — every LLM call site threads ctx.signal', () => {
  it('L1.plan forwards ctx.signal', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
    );
    const atom = new L1Atom({
      name: 'Hydrogen',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
    await atom.plan({ description: 'x' }, ctx);
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('L1.execute forwards ctx.signal', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: 'o', summary: 's' }));
    const atom = new L1Atom({
      name: 'Hydrogen',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
    await atom.execute(
      { description: 'x' },
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      ctx
    );
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('L2.plan forwards ctx.signal', async () => {
    const ctx = makeCtx();
    const db = openDb(':memory:');
    const registry = new AtomRegistry(db);
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );
    const atom = new L2Atom({
      name: 'Water',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
      registry,
    });
    await atom.plan({ description: 'x' }, ctx);
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('L3.plan forwards ctx.signal', async () => {
    const ctx = makeCtx();
    const db = openDb(':memory:');
    const registry = new AtomRegistry(db);
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );
    const l3Type = registry.create(3, {
      description: 'd',
      systemPrompt: 's',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    const atom = L3Atom.buildWithModel(l3Type, registry, 'claude-opus-4-test');
    await atom.plan({ description: 'x' }, ctx);
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('llmVerdict forwards ctx.signal', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const child = new L1Atom({
      name: 'Hydrogen',
      ordinal: 1,
      systemPrompt: 's',
      tools: [],
      params: {},
    });
    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Water',
      supervisorTier: 2,
      subject: 'PLAN',
      child,
      task: { description: 't' },
      payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
    });
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('prefilterStrategy forwards ctx.signal', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Hydrogen', reasoning: 'matches' })
    );
    await prefilterStrategy({
      ctx,
      task: { description: 't' },
      catalog: [{ name: 'Hydrogen', description: 'does hydrogen stuff' }],
    });
    expect(ctx.llm.calls[0]!.signal).toBe(ctx.signal);
  });

  it('AnthropicLlmClient aborts between tool-loop iterations when the signal fires', async () => {
    // We fake an SDK that just records the options it was invoked with so we
    // can assert the `signal` hand-off, then throw so we don't loop.
    const calls: Array<{ signal?: AbortSignal }> = [];
    const fakeSdk = {
      messages: {
        create: async (
          _params: unknown,
          options?: { signal?: AbortSignal }
        ): Promise<never> => {
          const captured: { signal?: AbortSignal } = {};
          if (options?.signal) captured.signal = options.signal;
          calls.push(captured);
          throw new Error('synthetic-stop');
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new AnthropicLlmClient(fakeSdk as any);

    const ac = new AbortController();
    await expect(
      client.complete({
        model: 'claude-haiku-test',
        systemPrompt: 's',
        userContent: 'u',
        signal: ac.signal,
      })
    ).rejects.toThrow('synthetic-stop');

    expect(calls.length).toBe(1);
    expect(calls[0]!.signal).toBe(ac.signal);

    // And if the signal was already aborted before the call, we short-circuit
    // without hitting the SDK at all.
    ac.abort(new Error('deadline'));
    await expect(
      client.complete({
        model: 'claude-haiku-test',
        systemPrompt: 's',
        userContent: 'u',
        signal: ac.signal,
      })
    ).rejects.toThrow('deadline');
    expect(calls.length).toBe(1);
  });
});
