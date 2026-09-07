import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { TrustFastPathInfo } from '../src/core/types.js';

const seed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('trust fast-path in validators', () => {
  it('L2.validatePlan skips the LLM call when the child type is trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);                 // Tracheid (L2 itself)
    const l1Type = reg.create(1, seed);  // Water
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const ctx = makeCtx();  // no queued responses — LLM must not be called

    const verdict = await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('L2.validateResult also skips when trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const ctx = makeCtx();

    const v = await l2.validateResult(
      l1,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
      },
      { description: 't' },
      ctx
    );
    expect(v.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('trust is revoked after a single failure', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    reg.recordFailure(l1Type.name);

    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'real verdict' }));

    const v = await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    expect(v.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(1);  // LLM was called this time
  });

  it('invokes ctx.recordTrust on every fast-path approval (observability)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l1Type.name);
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const trustEvents: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (i: TrustFastPathInfo) => trustEvents.push(i) };

    await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    await l2.validateResult(
      l1,
      {
        output: 'x',
        summary: 's',
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
      },
      { description: 't' },
      ctx
    );

    expect(trustEvents).toHaveLength(2);
    expect(trustEvents[0]!.subject).toBe('PLAN');
    expect(trustEvents[0]!.supervisorName).toBe('Tracheid');
    expect(trustEvents[0]!.childName).toBe('Water');
    expect(trustEvents[0]!.successes).toBe(TRUST_THRESHOLD_SUCCESSES);
    expect(trustEvents[0]!.reasoning).toMatch(/trust fast-path/);
    expect(trustEvents[1]!.subject).toBe('RESULT');
  });

  it('does NOT invoke recordTrust when the LLM path is taken (not trusted)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, seed); // zero successes, not trusted
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const l1 = L1Atom.fromType(reg.getByName('Water')!);

    const trustEvents: TrustFastPathInfo[] = [];
    const ctx = { ...makeCtx(), recordTrust: (i: TrustFastPathInfo) => trustEvents.push(i) };
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'real verdict' }));

    await l2.validatePlan(
      l1,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );

    expect(trustEvents).toHaveLength(0);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('L3 validators skip LLM calls once the child L2 type is trusted', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(l2Type.name);

    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    const vp = await l3.validatePlan(
      l2,
      makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }),
      { description: 't' },
      ctx
    );
    const vr = await l3.validateResult(
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
    expect(vp.approved).toBe(true);
    expect(vr.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });
});
