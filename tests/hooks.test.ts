import { describe, it, expect } from 'vitest';
import { Atom, type Supervisor } from '../src/core/atom.js';
import type {
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Verdict,
} from '../src/core/types.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

class C extends Atom {
  readonly tier: Tier = 1;
  readonly model = 'fake';
  async plan(_t: Task, _ctx: RunContext): Promise<Plan> {
    return makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' });
  }
  async execute(_t: Task, _p: Plan, _ctx: RunContext): Promise<Result> {
    return {
      output: 'ok',
      summary: 's',
      trace: [],
      producedBy: { tier: 1, name: this.name, viaFallback: false },
    };
  }
}

class P extends Atom implements Supervisor<C> {
  readonly tier: Tier = 2;
  readonly model = 'fake';
  private p: Verdict[] = [];
  private r: Verdict[] = [];
  queueP(v: Verdict): void { this.p.push(v); }
  queueR(v: Verdict): void { this.r.push(v); }
  async validatePlan(): Promise<Verdict> {
    const v = this.p.shift(); if (!v) throw new Error('no pv'); return v;
  }
  async validateResult(): Promise<Verdict> {
    const v = this.r.shift(); if (!v) throw new Error('no rv'); return v;
  }
  async plan(): Promise<Plan> {
    return makePlan({ reasoning: 'self', proposedAction: 'self', expectedOutput: 'o' });
  }
  async execute(): Promise<Result> {
    return {
      output: 'parent',
      summary: 's',
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

function mkParent(): P {
  return new P({ name: 'parent', ordinal: 0, systemPrompt: 'p', tools: [], params: {} });
}
function mkChild(): C {
  return new C({ name: 'child', ordinal: 1, systemPrompt: 'c', tools: [], params: {} });
}

describe('supervise loop outcome hooks', () => {
  it('calls onApproved exactly once when the loop finishes with an approved result', async () => {
    const parent = mkParent();
    const child = mkChild();
    parent.queueP({ approved: true, reasoning: 'ok' });
    parent.queueR({ approved: true, reasoning: 'ok' });

    let approvedCalls = 0;
    let failedCalls = 0;
    const hooks: SupervisionHooks<C> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {},
      onApproved: async () => { approvedCalls++; },
      onFailed: async () => { failedCalls++; },
    };

    await superviseLoop(parent, child, { description: 't' }, makeCtx(), hooks);
    expect(approvedCalls).toBe(1);
    expect(failedCalls).toBe(0);
  });

  it('calls onFailed when the loop escalates, before branchOnEscalation', async () => {
    const parent = mkParent();
    const child = mkChild();
    // force escalation on first plan iteration
    const ctx = makeCtx({ limits: { maxPlanIterations: 0, maxExecIterations: 0 } });

    let failedCalls = 0;
    let branchedCalls = 0;
    let orderCorrect = false;
    const hooks: SupervisionHooks<C> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {
        branchedCalls++;
        if (failedCalls === 1) orderCorrect = true;
      },
      onFailed: async () => {
        failedCalls++;
      },
    };

    await superviseLoop(parent, child, { description: 't' }, ctx, hooks);
    expect(failedCalls).toBe(1);
    expect(branchedCalls).toBe(1);
    expect(orderCorrect).toBe(true);
  });

  it('onApproved is NOT called when the loop escalates', async () => {
    const parent = mkParent();
    const child = mkChild();
    const ctx = makeCtx({ limits: { maxPlanIterations: 0, maxExecIterations: 0 } });
    let approvedCalls = 0;
    const hooks: SupervisionHooks<C> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {},
      onApproved: async () => { approvedCalls++; },
    };
    await superviseLoop(parent, child, { description: 't' }, ctx, hooks);
    expect(approvedCalls).toBe(0);
  });
});
