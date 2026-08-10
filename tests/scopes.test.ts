import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { Atom, type Supervisor } from '../src/core/atom.js';
import type { Plan, Result, RunContext, Task, Tier, Verdict } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

class FakeL2 extends Atom implements Supervisor<L1Atom> {
  readonly tier: Tier = 2;
  readonly model = 'sonnet';
  private pv: Verdict[] = [];
  private rv: Verdict[] = [];
  public selfPlans = 0;
  public selfExecs = 0;

  constructor() {
    super({ name: 'Water', ordinal: 1, systemPrompt: 'p', tools: [], params: {} });
  }
  queuePlan(v: Verdict) { this.pv.push(v); }
  queueResult(v: Verdict) { this.rv.push(v); }
  async validatePlan(): Promise<Verdict> {
    const v = this.pv.shift(); if (!v) throw new Error('no pv'); return v;
  }
  async validateResult(): Promise<Verdict> {
    const v = this.rv.shift(); if (!v) throw new Error('no rv'); return v;
  }
  async plan(_t: Task, _ctx: RunContext): Promise<Plan> {
    this.selfPlans++;
    return makePlan({ reasoning: 'self', proposedAction: 'self', expectedOutput: 'o' });
  }
  async execute(_t: Task, _p: Plan, _ctx: RunContext): Promise<Result> {
    this.selfExecs++;
    return {
      output: 'self',
      summary: 's',
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

function l2Hooks(registry: AtomRegistry, supervisor: FakeL2): SupervisionHooks<L1Atom> {
  return {
    applyByScope: async (child, verdict) => {
      if (verdict.scope === 'ephemeral') {
        child.applyModifications(verdict.modifications);
        return child;
      }
      if (verdict.scope === 'patch') {
        const patched = registry.patch(child.name, verdict.modifications, supervisor.name, verdict.reasoning);
        return L1Atom.fromType(patched);
      }
      const branched = registry.branch(child.name, verdict.modifications, supervisor.name, verdict.branchName);
      return L1Atom.fromType(branched);
    },
    branchOnEscalation: async (child, _t, reason) => {
      registry.branch(child.name, { additionalContext: reason }, supervisor.name);
    },
  };
}

describe('mutation scopes via L2 hooks + registry', () => {
  it('ephemeral: no DB write, instance mutated', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const h = reg.create(1, {
      description: 'test', systemPrompt: 'base', tools: [], params: {}, createdBy: 'test',
    });
    const ctx = makeCtx();
    // plan / execute responses for L1
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));

    const l2 = new FakeL2();
    // reject first plan with ephemeral, approve second, approve result
    l2.queuePlan({
      approved: false, reasoning: 'meh',
      modifications: { systemPromptAppend: 'be terse' }, scope: 'ephemeral',
    });
    l2.queuePlan({ approved: true, reasoning: 'ok' });
    l2.queueResult({ approved: true, reasoning: 'ok' });

    await superviseLoop(l2, L1Atom.fromType(h), { description: 'x' }, ctx, l2Hooks(reg, l2));

    // registry still has version 1, no patched/branched rows
    const fromDb = reg.getByName('Hydrogen');
    expect(fromDb?.version).toBe(1);
    expect(reg.listByTier(1).length).toBe(1);
  });

  it('patch: new version in DB, fresh instance hydrated', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const h = reg.create(1, {
      description: 'test', systemPrompt: 'base', tools: [], params: {}, createdBy: 'test',
    });
    const ctx = makeCtx();
    // plan, plan, execute
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));

    const l2 = new FakeL2();
    l2.queuePlan({
      approved: false, reasoning: 'update canonical',
      modifications: { systemPromptReplace: 'improved canonical prompt' }, scope: 'patch',
    });
    l2.queuePlan({ approved: true, reasoning: 'ok' });
    l2.queueResult({ approved: true, reasoning: 'ok' });

    await superviseLoop(l2, L1Atom.fromType(h), { description: 'x' }, ctx, l2Hooks(reg, l2));

    const fromDb = reg.getByName('Hydrogen');
    expect(fromDb?.version).toBe(2);
    expect(fromDb?.systemPrompt).toBe('improved canonical prompt');
  });

  it('branch: creates a new L1 type with a new element name', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const h = reg.create(1, {
      description: 'test', systemPrompt: 'base', tools: [], params: {}, createdBy: 'test',
    });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));

    const l2 = new FakeL2();
    l2.queuePlan({
      approved: false, reasoning: 'branch it',
      modifications: { systemPromptAppend: 'new direction' }, scope: 'branch',
    });
    l2.queuePlan({ approved: true, reasoning: 'ok' });
    l2.queueResult({ approved: true, reasoning: 'ok' });

    await superviseLoop(l2, L1Atom.fromType(h), { description: 'x' }, ctx, l2Hooks(reg, l2));

    const tier1 = reg.listByTier(1);
    expect(tier1.map((t) => t.name)).toEqual(['Hydrogen', 'Helium']);
    const he = reg.getByName('Helium');
    expect(he?.systemPrompt).toContain('new direction');
  });
});
