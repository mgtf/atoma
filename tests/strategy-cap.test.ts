import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { STRATEGY_MAX_TOKENS } from '../src/atoms/cost.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

const seed = {
  description: 'with a greedy ceiling',
  systemPrompt: 'sys',
  tools: [],
  params: { maxTokens: 8192, temperature: 0.2 },
  createdBy: 'test',
};

describe('strategy maxTokens cap', () => {
  it('L2.plan caps maxTokens to STRATEGY_MAX_TOKENS even when the atom type is greedy', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed); // Water (empty tier-1 catalog → no prefilter, full plan path)
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);

    const ctx = makeCtx();
    // Full plan path returns a [strategy, plan] pair
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} }, reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );

    await l2.plan({ description: 't' }, ctx);
    const lastCall = ctx.llm.calls[ctx.llm.calls.length - 1]!;
    expect(lastCall.params?.maxTokens).toBe(STRATEGY_MAX_TOKENS);
  });

  it('L3.plan caps maxTokens to STRATEGY_MAX_TOKENS', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} }, reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );

    await l3.plan({ description: 't' }, ctx);
    const lastCall = ctx.llm.calls[ctx.llm.calls.length - 1]!;
    expect(lastCall.params?.maxTokens).toBe(STRATEGY_MAX_TOKENS);
  });

  it('prefilter path does not hit the strategy call (no strategy cap applies)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'fetches URLs' });  // Hydrogen
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);

    const ctx = makeCtx();
    // prefilter picks Hydrogen
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'high',
        reasoning: 'matches',
      })
    );

    await l2.plan({ description: 'fetch example.com' }, ctx);
    // Only the prefilter call happened; strategy call was skipped
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.params?.maxTokens).toBeLessThanOrEqual(256);
  });
});
