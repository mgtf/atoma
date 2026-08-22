import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import {
  L3_PARALLEL_OUTPUT_COLLISION_KEY,
  acceptL3RootPlan,
  l3ParallelOutputCoaching,
  parallelDeclaredOutputCollision,
} from '../src/atoms/l3RootPlan.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import type { Plan, Result } from '../src/core/types.js';

function plan(partial: {
  mode: Plan['aggregation']['mode'];
  subtasks: Plan['subtasks'];
}): Plan {
  return {
    reasoning: 'r',
    subtasks: partial.subtasks,
    aggregation: { mode: partial.mode },
    expectedOutput: 'e',
  };
}

describe('parallelDeclaredOutputCollision', () => {
  it('hits when two concat phases declare the same path', () => {
    const hit = parallelDeclaredOutputCollision(
      plan({
        mode: 'concat',
        subtasks: [
          { description: 'build', outputs: ['index.html'] },
          { description: 'also write', outputs: ['./index.html'] },
        ],
      })
    );
    expect(hit).toEqual({ mode: 'concat', paths: ['index.html'] });
  });

  it('hits llm-synthesize the same way — both modes are parallel', () => {
    const hit = parallelDeclaredOutputCollision(
      plan({
        mode: 'llm-synthesize',
        subtasks: [
          { description: 'a', outputs: ['app.js'] },
          { description: 'b', outputs: ['app.js'] },
        ],
      })
    );
    expect(hit?.mode).toBe('llm-synthesize');
    expect(hit?.paths).toEqual(['app.js']);
  });

  it('ignores sequential overlap — shared artefacts are the contract', () => {
    expect(
      parallelDeclaredOutputCollision(
        plan({
          mode: 'sequential',
          subtasks: [
            { description: 'scaffold', outputs: ['index.html'] },
            { description: 'extend', outputs: ['index.html'] },
          ],
        })
      )
    ).toBeNull();
  });

  it('ignores disjoint declared paths', () => {
    expect(
      parallelDeclaredOutputCollision(
        plan({
          mode: 'concat',
          subtasks: [
            { description: 'a', outputs: ['lib/parse.mjs'] },
            { description: 'b', outputs: ['lib/render.mjs'] },
          ],
        })
      )
    ).toBeNull();
  });

  it('ignores a parallel plan that omitted outputs — no lexical fallback', () => {
    expect(
      parallelDeclaredOutputCollision(
        plan({
          mode: 'concat',
          subtasks: [
            { description: 'write index.html then smoke it' },
            { description: 'also write index.html' },
          ],
        })
      )
    ).toBeNull();
  });

  it('does not treat one phase listing the same path twice as a collision', () => {
    expect(
      parallelDeclaredOutputCollision(
        plan({
          mode: 'concat',
          subtasks: [
            { description: 'a', outputs: ['index.html', './index.html'] },
            { description: 'b', outputs: ['other.js'] },
          ],
        })
      )
    ).toBeNull();
  });
});

describe('acceptL3RootPlan', () => {
  it('does not replan a clean parallel plan', async () => {
    const ctx = makeCtx();
    const clean = plan({
      mode: 'concat',
      subtasks: [
        { description: 'a', outputs: ['a.js'] },
        { description: 'b', outputs: ['b.js'] },
      ],
    });
    let replans = 0;
    const accepted = await acceptL3RootPlan({
      plan: clean,
      task: { description: 'two tools' },
      ctx,
      replan: async () => {
        replans += 1;
        return clean;
      },
    });
    expect(accepted).toBe(clean);
    expect(replans).toBe(0);
  });

  it('replans once with coaching, then honours a repeat', async () => {
    const ctx = makeCtx();
    const colliding = plan({
      mode: 'concat',
      subtasks: [
        { description: 'build', outputs: ['index.html'] },
        { description: 'docs', outputs: ['index.html'] },
      ],
    });
    const sequential = plan({
      mode: 'sequential',
      subtasks: colliding.subtasks,
    });
    const seen: string[] = [];
    const first = await acceptL3RootPlan({
      plan: colliding,
      task: { description: 'a page' },
      ctx,
      replan: async (task) => {
        seen.push(task.constraints?.join('\n') ?? '');
        return sequential;
      },
    });
    expect(first.aggregation.mode).toBe('sequential');
    expect(seen[0]).toContain('index.html');
    expect(seen[0]).toContain(l3ParallelOutputCoaching({ mode: 'concat', paths: ['index.html'] }).slice(0, 40));
    expect(ctx.mechanicalPlanRejections?.has(L3_PARALLEL_OUTPUT_COLLISION_KEY)).toBe(true);

    let replans = 0;
    const honoured = await acceptL3RootPlan({
      plan: colliding,
      task: { description: 'a page' },
      ctx,
      replan: async () => {
        replans += 1;
        return sequential;
      },
    });
    expect(honoured).toBe(colliding);
    expect(replans).toBe(0);
  });

  it('fails OPEN when the coached replan throws — the racy plan still runs', async () => {
    const ctx = makeCtx();
    const colliding = plan({
      mode: 'concat',
      subtasks: [
        { description: 'build', outputs: ['index.html'] },
        { description: 'docs', outputs: ['index.html'] },
      ],
    });
    const accepted = await acceptL3RootPlan({
      plan: colliding,
      task: { description: 'a page' },
      ctx,
      replan: async () => {
        throw new Error('aborted: deadline exceeded');
      },
    });
    // A race that still delivers beats a run that never starts: the coaching
    // is an improvement attempt, never a new way to lose the whole run.
    expect(accepted).toBe(colliding);
    // The one-shot is still spent — a later collision must not retry.
    expect(ctx.mechanicalPlanRejections?.has(L3_PARALLEL_OUTPUT_COLLISION_KEY)).toBe(true);
  });
});

describe('L3.handle — root plan has no parent validator', () => {
  function seed(): { l3: L3Atom } {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { description: 'tissue', systemPrompt: 'l3', tools: [], params: {}, createdBy: 't' });
    reg.create(2, { description: 'cell', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
    return { l3: L3Atom.buildWithModel(reg.getByName('Meristem')!, reg, 'claude-opus-5') };
  }

  const dummy: Result = {
    output: 'ok',
    summary: 'ok',
    trace: [],
    producedBy: { tier: 3, name: 'Meristem', viaFallback: false },
  };

  it('defaults an omitted N=1 aggregation to concat', async () => {
    const { l3 } = seed();
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' })
    );
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'one cohesive lifecycle',
          subtasks: [
            {
              description: 'write, serve, and probe index.html',
              outputs: ['index.html'],
            },
          ],
        }
      )
    );
    let executed: Plan | undefined;
    l3.execute = async (_task, plan) => {
      executed = plan;
      return dummy;
    };

    await l3.handle({ description: 'build one small web artefact' }, ctx);

    expect(executed?.subtasks).toHaveLength(1);
    expect(executed?.aggregation.mode).toBe('concat');
  });

  it('honours explicit concat when outputs do not collide', async () => {
    const { l3 } = seed();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'scrape A', outputs: ['a.json'] },
            { description: 'scrape B', outputs: ['b.json'] },
          ],
          aggregation: { mode: 'concat' },
        }
      )
    );
    let executed: Plan | undefined;
    l3.execute = async (_task, p) => {
      executed = p;
      return dummy;
    };
    await l3.handle({ description: 'two orthogonal scrapes' }, ctx);
    expect(executed?.aggregation.mode).toBe('concat');
    expect(ctx.mechanicalPlanRejections?.has(L3_PARALLEL_OUTPUT_COLLISION_KEY) ?? false).toBe(
      false
    );
  });

  it('spends one extra plan call when declared outputs collide, then executes the replan', async () => {
    const { l3 } = seed();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'build', outputs: ['index.html'] },
            { description: 'docs', outputs: ['index.html'] },
          ],
          aggregation: { mode: 'concat' },
        }
      )
    );
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'build', outputs: ['index.html'] },
            { description: 'docs', outputs: ['index.html'] },
          ],
          aggregation: { mode: 'sequential' },
        }
      )
    );
    let executed: Plan | undefined;
    l3.execute = async (_task, p) => {
      executed = p;
      return dummy;
    };
    await l3.handle({ description: 'a coupled page' }, ctx);
    expect(executed?.aggregation.mode).toBe('sequential');
    expect(ctx.llm.calls.some((c) => c.userContent.includes('MECHANICAL:'))).toBe(true);
  });

  it('keeps the ORIGINAL strategy when the replan parses a strategy but not a plan', async () => {
    // The desync this pins: `plan()` used to commit `pendingStrategy` BEFORE
    // validating the plan half of the pair. A coached replan that answered a
    // valid strategy plus a truncated/unparseable plan then failed open to
    // the ORIGINAL plan — but `execute()` consumed the REPLAN's strategy,
    // dispatching a reuse-shaped plan under a foreign strategy.
    const { l3 } = seed();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'build', outputs: ['index.html'] },
            { description: 'docs', outputs: ['index.html'] },
          ],
          aggregation: { mode: 'concat' },
        }
      )
    );
    // Replan: prefilter, then a pair whose strategy half is valid (and
    // DIFFERENT) while the plan half is missing `subtasks` — truncation.
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair({ strategy: 'create', reasoning: 'r' }, { reasoning: 'r' })
    );
    let executed: Plan | undefined;
    let consumedStrategy: { strategy?: string; target?: string } | null = null;
    l3.execute = async (_task, p) => {
      consumedStrategy = (l3 as unknown as {
        pendingStrategy: { strategy?: string; target?: string } | null;
      }).pendingStrategy;
      executed = p;
      return dummy;
    };
    await expect(l3.handle({ description: 'a coupled page' }, ctx)).resolves.toBe(dummy);
    expect(executed?.aggregation.mode).toBe('concat');
    expect(executed?.subtasks).toHaveLength(2);
    expect(consumedStrategy).toMatchObject({ strategy: 'reuse', target: 'Tracheid' });
  });

  it('executes the original plan when the coached strategy call explodes', async () => {
    const { l3 } = seed();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'build', outputs: ['index.html'] },
            { description: 'docs', outputs: ['index.html'] },
          ],
          aggregation: { mode: 'concat' },
        }
      )
    );
    // The replan reaches its prefilter, then the top-tier strategy call dies
    // the way the watchdog kills one near the deadline.
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Tracheid', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueue(() => {
      throw new Error('aborted: deadline exceeded');
    });
    let executed: Plan | undefined;
    l3.execute = async (_task, p) => {
      executed = p;
      return dummy;
    };
    await expect(l3.handle({ description: 'a coupled page' }, ctx)).resolves.toBe(dummy);
    expect(executed?.aggregation.mode).toBe('concat');
    expect(executed?.subtasks).toHaveLength(2);
  });
});
