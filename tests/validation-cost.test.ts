import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/L2Atom.js';
import { PIN_HAIKU, PIN_SONNET, FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx, jsonText } from './helpers.js';

function newRegistry(): AtomRegistry {
  return new AtomRegistry(openDb(':memory:'));
}

const baseSeed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('validation cost discipline', () => {
  it('L2.validatePlan uses Haiku, not the L2 model', async () => {
    const reg = newRegistry();
    const l1Type = reg.create(1, baseSeed);
    const l2Type = reg.create(2, baseSeed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l2.validatePlan(
      l1,
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      { description: 'task' },
      ctx
    );

    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.model).toBe(PIN_HAIKU);
    expect(l2.model).toBe(PIN_SONNET);
    expect(ctx.llm.calls[0]!.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
  });

  it('L2.validateResult uses Haiku', async () => {
    const reg = newRegistry();
    const l1Type = reg.create(1, baseSeed);
    const l2Type = reg.create(2, baseSeed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l2.validateResult(
      l1,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 1, name: 'Hydrogen', viaFallback: false },
      },
      { description: 'task' },
      ctx
    );

    expect(ctx.llm.calls[0]!.model).toBe(PIN_HAIKU);
  });

  it('L3 validations use Haiku even though L3 itself runs Opus', async () => {
    const reg = newRegistry();
    const l2Type = reg.create(2, baseSeed);
    const l3Type = reg.create(3, baseSeed);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);

    expect(l3.model).toBe(FALLBACK_OPUS);
    expect(l3.validationModel).toBe(PIN_HAIKU);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l3.validatePlan(
      l2,
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      { description: 't' },
      ctx
    );
    await l3.validateResult(
      l2,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 2, name: l2.name, viaFallback: false },
      },
      { description: 't' },
      ctx
    );

    expect(ctx.llm.calls.map((c) => c.model)).toEqual([PIN_HAIKU, PIN_HAIKU]);
    // Both validation calls share the same system prompt → maximises cache hits.
    expect(ctx.llm.calls[0]!.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
    expect(ctx.llm.calls[1]!.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
  });

  it('validation params are tight (temp=0, small maxTokens)', async () => {
    const reg = newRegistry();
    const l1Type = reg.create(1, baseSeed);
    const l2Type = reg.create(2, baseSeed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l2.validatePlan(
      l1,
      { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
      { description: 'task' },
      ctx
    );

    const params = ctx.llm.calls[0]!.params;
    expect(params?.temperature).toBe(0);
    // Budget was raised from 512 → 2048 after earlier runs showed validator
    // responses truncated mid-JSON (stop_reason=max_tokens) when reasoning
    // went long, losing the modifications block and crashing the parser.
    // The ceiling still constrains spend while leaving room for a complete
    // verdict JSON; the prompt also instructs "reasoning ≤ 120 words" so
    // typical completions stay well under 512.
    expect(params?.maxTokens).toBeLessThanOrEqual(2048);
    expect(params?.maxTokens).toBeGreaterThanOrEqual(1024);
  });
});
