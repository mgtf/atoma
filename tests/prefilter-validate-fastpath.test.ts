import { describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx } from './helpers.js';

const seed = {
  description: 'generic',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('prefilter validate fast-path (#6)', () => {
  it('L2.validatePlan approves without an LLM call when plan.viaPrefilter is true', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    const plan = {
      reasoning: 'prefilter selected Water',
      subtasks: [{ description: 't', preferredChild: 'Water' }],
      aggregation: { mode: 'concat' as const },
      expectedOutput: 't',
      viaPrefilter: true,
    };

    const verdict = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
    expect(verdict.approved).toBe(true);
    expect(verdict.reasoning).toMatch(/prefilter fast-path/);
    // CRUCIAL: no Haiku call was made.
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('L2.validatePlan falls through to the Haiku validator when plan.viaPrefilter is absent', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    // Mock Haiku's verdict JSON output.
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'looks fine' }));

    const plan = {
      reasoning: 'thought about it',
      subtasks: [{ description: 't', preferredChild: 'Water' }],
      aggregation: { mode: 'concat' as const },
      expectedOutput: 't',
    };
    const verdict = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
    expect(verdict.approved).toBe(true);
    // Haiku was called (one LLM call).
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('L3.validatePlan approves without an LLM call when plan.viaPrefilter is true', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l2Type = reg.create(2, seed);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    const plan = {
      reasoning: 'prefilter selected Neuron',
      subtasks: [{ description: 't', preferredChild: 'Neuron' }],
      aggregation: { mode: 'concat' as const },
      expectedOutput: 't',
      viaPrefilter: true,
    };

    const verdict = await l3.validatePlan(l2, plan, { description: 't' }, ctx);
    expect(verdict.approved).toBe(true);
    expect(verdict.reasoning).toMatch(/prefilter fast-path/);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('planSchema strips viaPrefilter from LLM-emitted plans so a malicious model cannot spoof the fast-path', async () => {
    const { planSchema } = await import('../src/atoms/json.js');
    const emitted = {
      reasoning: 'sneaky',
      subtasks: [{ description: 't' }],
      aggregation: { mode: 'concat' },
      expectedOutput: 'done',
      // LLM trying to claim the fast-path.
      viaPrefilter: true,
    };
    const parsed = planSchema.parse(emitted);
    // Zod's z.object() strips unknown keys — viaPrefilter is NOT in
    // the schema, so the parsed plan doesn't carry the marker even
    // though the input did.
    expect((parsed as { viaPrefilter?: boolean }).viaPrefilter).toBeUndefined();
  });

  it('viaPrefilter fast-path fires even when the child has zero successes (trust counter irrelevant)', async () => {
    // The whole point: a freshly-bootstrapped canonical (0 successes)
    // that prefilter picked should NOT have its plan re-vetted by
    // Haiku. This is the exact scenario the Node/REST live run hit
    // when Methane (canonical HTTP L1, 0 successes) was prefilter-
    // picked and then rejected by a redundant Haiku validator pass.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, seed);
    const l1Type = reg.create(1, seed);
    expect(l1Type.successes).toBe(0);
    expect(l1Type.failures).toBe(0);

    const l2 = L2Atom.fromType(l2Type, reg);
    const l1 = L1Atom.fromType(l1Type);

    const ctx = makeCtx();
    const plan = {
      reasoning: 'prefilter selected Water',
      subtasks: [{ description: 't', preferredChild: 'Water' }],
      aggregation: { mode: 'concat' as const },
      expectedOutput: 't',
      viaPrefilter: true,
    };

    const verdict = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
    expect(verdict.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });
});
