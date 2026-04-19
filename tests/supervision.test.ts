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
import {
  MAX_SAME_REASON_REJECTS,
  normalizeReason,
  superviseLoop,
  type SupervisionHooks,
} from '../src/core/supervisor.js';
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

  describe('repeat-rejection short-circuit', () => {
    it('escalates after N consecutive plan rejects with the same normalized reasoning', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: 'needs more detail — it really does',
          modifications: { systemPromptAppend: 'try harder' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      // Give a generous iteration budget so the early short-circuit is the
      // only path that can end the loop.
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      // Should have escalated on the Nth identical reject, NOT eaten the
      // full maxPlanIterations budget.
      expect(child.planCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('treats surface-level punctuation / casing differences as the same reasoning', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      const variants = [
        'Needs more detail.',
        'NEEDS MORE DETAIL!',
        'needs   more detail...',
      ];
      for (const reasoning of variants) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning,
          modifications: { systemPromptAppend: 'try' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      await superviseLoop(parent, child, { description: 'go' }, ctx, hooks);
      expect(child.planCount).toBe(3);
      expect(branched).toBe(1);
    });

    it('does NOT short-circuit when reasoning genuinely varies between rejects', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      const reasonings = [
        'missing a step',
        'wrong tool choice',
        'needs more specificity',
        'ok now',
      ];
      for (const r of reasonings.slice(0, 3)) {
        parent.queuePlanVerdict({
          approved: false,
          reasoning: r,
          modifications: { systemPromptAppend: 'try' },
          scope: 'ephemeral',
        });
      }
      parent.queuePlanVerdict({ approved: true, reasoning: reasonings[3]! });
      parent.queueResultVerdict({ approved: true, reasoning: 'ok' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          throw new Error('should not have escalated');
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 10, maxExecIterations: 10 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('an approved plan resets the repeat counter, letting later rejects accumulate fresh', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      // Two identical rejects, then approval → counter resets →
      // we can tolerate another full window of new identical rejects.
      const rej = (r: string): Verdict => ({
        approved: false,
        reasoning: r,
        modifications: { systemPromptAppend: 'try' },
        scope: 'ephemeral',
      });
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict(rej('r-bad'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict(rej('same gripe'));
      parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
      parent.queueResultVerdict({ approved: true, reasoning: 'great' });
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          throw new Error('must not escalate');
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(result.producedBy.viaFallback).toBe(false);
    });

    it('same-gripe streak on RESULT also triggers short-circuit', async () => {
      const parent = new FakeParent();
      const child = new FakeChild('A');
      for (let i = 0; i < MAX_SAME_REASON_REJECTS; i++) {
        parent.queuePlanVerdict({ approved: true, reasoning: 'ok' });
        parent.queueResultVerdict({
          approved: false,
          reasoning: 'deliverable missing the URL',
          modifications: { systemPromptAppend: 'add url' },
          scope: 'ephemeral',
        });
      }
      let branched = 0;
      const hooks: SupervisionHooks<FakeChild> = {
        applyByScope: async (c) => c,
        branchOnEscalation: async () => {
          branched++;
        },
      };
      const ctx = makeCtx({
        limits: { maxPlanIterations: 20, maxExecIterations: 20 },
      });
      const result = await superviseLoop(
        parent,
        child,
        { description: 'go' },
        ctx,
        hooks
      );
      expect(child.execCount).toBe(MAX_SAME_REASON_REJECTS);
      expect(branched).toBe(1);
      expect(result.producedBy.viaFallback).toBe(true);
    });

    it('normalizeReason collapses punctuation, casing, and whitespace to a stable key', () => {
      expect(normalizeReason('Foo, BAR!')).toBe(normalizeReason('foo bar'));
      expect(normalizeReason('  foo\n\t bar  ')).toBe('foo bar');
      expect(normalizeReason('Résumé — OK.')).toBe('résumé ok');
      expect(normalizeReason('')).toBe('');
    });
  });
});
