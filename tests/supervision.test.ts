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

class FakeChild extends Atom {
  readonly tier: Tier = 1;
  readonly model = 'fake';
  public planCount = 0;
  public execCount = 0;

  constructor(public label: string) {
    super({
      name: `child:${label}`,
      ordinal: 0,
      systemPrompt: 'x',
      tools: [],
      params: {},
    });
  }

  async plan(_task: Task, _ctx: RunContext): Promise<Plan> {
    this.planCount++;
    return {
      reasoning: 'r',
      proposedAction: `${this.label}#plan:${this.planCount}`,
      expectedOutput: 'out',
    };
  }

  async execute(_task: Task, _plan: Plan, _ctx: RunContext): Promise<Result> {
    this.execCount++;
    return {
      output: `${this.label}:output`,
      summary: `${this.label}:summary`,
      trace: [],
      producedBy: { tier: 1, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

class FakeParent extends Atom implements Supervisor<FakeChild> {
  readonly tier: Tier = 2;
  readonly model = 'fake-parent';
  private planVerdicts: Verdict[] = [];
  private resultVerdicts: Verdict[] = [];
  public selfPlans = 0;
  public selfExecs = 0;

  constructor() {
    super({
      name: 'parent',
      ordinal: 0,
      systemPrompt: 'p',
      tools: [],
      params: {},
    });
  }

  queuePlanVerdict(v: Verdict): void {
    this.planVerdicts.push(v);
  }
  queueResultVerdict(v: Verdict): void {
    this.resultVerdicts.push(v);
  }

  async validatePlan(_c: FakeChild, _p: Plan, _t: Task, _ctx: RunContext): Promise<Verdict> {
    const v = this.planVerdicts.shift();
    if (!v) throw new Error('no planVerdict queued');
    return v;
  }

  async validateResult(_c: FakeChild, _r: Result, _t: Task, _ctx: RunContext): Promise<Verdict> {
    const v = this.resultVerdicts.shift();
    if (!v) throw new Error('no resultVerdict queued');
    return v;
  }

  async plan(_t: Task, _ctx: RunContext): Promise<Plan> {
    this.selfPlans++;
    return { reasoning: 'parent', proposedAction: 'self', expectedOutput: 'o' };
  }

  async execute(_t: Task, _p: Plan, _ctx: RunContext): Promise<Result> {
    this.selfExecs++;
    return {
      output: 'parent-output',
      summary: 'self-exec',
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }
}

function makeHooks(
  opts?: Partial<SupervisionHooks<FakeChild>>
): SupervisionHooks<FakeChild> & { branchCalls: number; appliedCount: number } {
  const state = { branchCalls: 0, appliedCount: 0 };
  return {
    applyByScope:
      opts?.applyByScope ??
      (async (child, _v) => {
        state.appliedCount++;
        return child;
      }),
    branchOnEscalation:
      opts?.branchOnEscalation ??
      (async (_c, _t, _r) => {
        state.branchCalls++;
      }),
    ...state,
  };
}

describe('superviseLoop', () => {
  it('completes when plan then result are approved', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
    parent.queueResultVerdict({ approved: true, reasoning: 'ok' });

    const hooks = makeHooks();
    const ctx = makeCtx();

    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
    expect(result.output).toBe('A:output');
    expect(child.planCount).toBe(1);
    expect(child.execCount).toBe(1);
  });

  it('rejects plan, applies ephemeral mods, loops, then succeeds', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');
    let appliedCount = 0;

    parent.queuePlanVerdict({
      approved: false,
      reasoning: 'needs more detail',
      modifications: { systemPromptAppend: 'try harder' },
      scope: 'ephemeral',
    });
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok now' });
    parent.queueResultVerdict({ approved: true, reasoning: 'good' });

    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c, _v) => {
        appliedCount++;
        return c;
      },
      branchOnEscalation: async () => {},
    };

    const result = await superviseLoop(parent, child, { description: 'go' }, makeCtx(), hooks);
    expect(child.planCount).toBe(2);
    expect(child.execCount).toBe(1);
    expect(appliedCount).toBe(1);
    expect(result.output).toBe('A:output');
  });

  it('escalates when maxPlanIterations is exhausted, parent self-execs, branch is created', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // queue 3 rejections for the 3 allowed plan iterations
    for (let i = 0; i < 3; i++) {
      parent.queuePlanVerdict({
        approved: false,
        reasoning: 'still no good',
        modifications: { systemPromptAppend: 'try' },
        scope: 'ephemeral',
      });
    }

    let branched = 0;
    let traceLength = 0;
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async (_c, trace, _r) => {
        branched++;
        traceLength = trace.length;
      },
    };

    const ctx = makeCtx({ limits: { maxPlanIterations: 3, maxExecIterations: 3 } });
    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);

    expect(branched).toBe(1);
    expect(traceLength).toBeGreaterThan(0);
    expect(parent.selfPlans).toBe(1);
    expect(parent.selfExecs).toBe(1);
    expect(result.producedBy.viaFallback).toBe(true);
    expect(result.output).toBe('parent-output');
  });

  it('escalates when maxExecIterations is exhausted on result rejections', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // each cycle: plan approved, result rejected, back to plan
    for (let i = 0; i < 2; i++) {
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({
        approved: false,
        reasoning: 'bad result',
        modifications: { systemPromptAppend: 'do better' },
        scope: 'ephemeral',
      });
    }
    // third cycle: plan approved, then we hit execIter limit
    parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });

    let branched = 0;
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {
        branched++;
      },
    };

    const ctx = makeCtx({ limits: { maxPlanIterations: 10, maxExecIterations: 2 } });
    const result = await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);

    expect(branched).toBe(1);
    expect(result.producedBy.viaFallback).toBe(true);
  });

  it('fallbackMode flag is lowered after escalation completes', async () => {
    const parent = new FakeParent();
    const child = new FakeChild('A');

    // force escalation immediately (maxPlanIterations=0 → throws on first check)
    const ctx = makeCtx({ limits: { maxPlanIterations: 0, maxExecIterations: 0 } });
    const hooks: SupervisionHooks<FakeChild> = {
      applyByScope: async (c) => c,
      branchOnEscalation: async () => {},
    };

    expect(parent.isFallbackMode()).toBe(false);
    await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
    expect(parent.isFallbackMode()).toBe(false);
  });
});
