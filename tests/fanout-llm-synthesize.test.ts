import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { keptWithoutSynthesis, synthesizeOrKeep } from '../src/atoms/dispatch.js';

/**
 * Phase 2/3 — `llm-synthesize` aggregation mode.
 *
 * When `plan.aggregation.mode === 'llm-synthesize'`, the supervisor's
 * own model is called ONE more time with the N sub-results and the
 * `instruction` string, producing a single unified Result. This test
 * covers the end-to-end merge flow.
 */

const seed = {
  description: 'd',
  systemPrompt: 'p',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('L2.execute — llm-synthesize aggregation', () => {
  it('calls the supervisor LLM once with all sub-results and the merge instruction', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
    }
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: a.name, reasoning: 'pf' },
        {
          reasoning: 'decompose',
          subtasks: [
            { description: 'build layout', preferredChild: a.name },
            { description: 'build logic', preferredChild: b.name },
          ],
          aggregation: {
            mode: 'llm-synthesize',
            instruction: 'Assemble layout and logic into one index.html',
          },
          expectedOutput: 'full app',
        }
      )
    );
    // 2 L1 plans
    for (const _ of ['A', 'B'])
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    // 2 L1 executes
    ctx.llm.enqueueText(
      jsonText({ output: '<div>layout</div>', summary: 'layout fragment' })
    );
    ctx.llm.enqueueText(
      jsonText({ output: '<script>logic</script>', summary: 'logic fragment' })
    );
    // 1 synthesise merge call
    ctx.llm.enqueueText(
      jsonText({
        output: '<html><div>layout</div><script>logic</script></html>',
        summary: 'assembled',
      })
    );

    const plan = await l2.plan({ description: 'full app' }, ctx);
    const result = await l2.execute({ description: 'full app' }, plan, ctx);

    expect(result.output).toBe(
      '<html><div>layout</div><script>logic</script></html>'
    );
    expect(result.summary).toBe('assembled');

    // Last LLM call is the synthesize — verify it saw both sub-results.
    const mergeCall = ctx.llm.calls[ctx.llm.calls.length - 1]!;
    expect(mergeCall.userContent).toContain('Assemble layout and logic');
    expect(mergeCall.userContent).toContain('<div>layout</div>');
    expect(mergeCall.userContent).toContain('<script>logic</script>');
    expect(mergeCall.userContent).toContain('Sub-results:');
  });

  it('falls back to the tolerant payload parser when the merge response is prose', async () => {
    // Safety net: if the supervisor emits free-form text instead of the
    // JSON envelope, `parsePayloadTolerant` wraps it as output+summary
    // rather than crashing the aggregation.
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
    }
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);

    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: a.name, reasoning: 'pf' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'A', preferredChild: a.name },
            { description: 'B', preferredChild: b.name },
          ],
          aggregation: { mode: 'llm-synthesize' },
          expectedOutput: 'e',
        }
      )
    );
    for (const _ of ['A', 'B'])
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    for (const label of ['A', 'B'])
      ctx.llm.enqueueText(jsonText({ output: label, summary: 's' }));
    // Merge returns prose — no JSON envelope.
    ctx.llm.enqueueText('Here is the merged prose output.');

    const plan = await l2.plan({ description: 't' }, ctx);
    const result = await l2.execute({ description: 't' }, plan, ctx);

    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('merged prose');
    expect(result.summary).toMatch(/fallback produced non-JSON output/);
  });
});

describe('a synthesis the run deadline interrupts keeps its sub-results (2026-09-25 review, 1.2c)', () => {
  function synthesisRun(abortWith: unknown, deadlineAt: number | null = Date.now() + 60_000) {
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed);
    const b = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
    }
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);
    const controller = new AbortController();
    const ctx = { ...makeCtx(), signal: controller.signal, ...(deadlineAt === null ? {} : { deadlineAt }) };
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', target: a.name, reasoning: 'pf' },
      { reasoning: 'decompose', subtasks: [
        { description: 'build layout', preferredChild: a.name },
        { description: 'build logic', preferredChild: b.name },
      ], aggregation: { mode: 'llm-synthesize', instruction: 'Assemble' }, expectedOutput: 'full app' },
    ));
    for (const _ of ['A', 'B']) ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ output: '<div>layout</div>', summary: 'layout fragment' }));
    ctx.llm.enqueueText(jsonText({ output: '<script>logic</script>', summary: 'logic fragment' }));
    // The merge call: the deadline (or a cancellation) falls while it is in flight,
    // and the transport never answers.
    ctx.llm.enqueue(() => { controller.abort(abortWith); return new Promise(() => {}); });
    return { l2, ctx };
  }

  it('lands the complete sub-results, naming the missing synthesis, when the deadline falls', async () => {
    const { l2, ctx } = synthesisRun(new DOMException('Execution deadline', 'TimeoutError'));
    const plan = await l2.plan({ description: 'full app' }, ctx);
    const out = await l2.execute({ description: 'full app' }, plan, ctx);
    expect(out.output).toEqual(['<div>layout</div>', '<script>logic</script>']);
    expect(out.unfinishedPhases).toEqual(['synthesis of 2 sub-results (the run deadline fell during it)']);
    expect(out.summary).toContain('layout fragment');
  });

  it('rethrows an explicit cancellation instead of landing on it', async () => {
    const { l2, ctx } = synthesisRun(new Error('Cancelled by operator'));
    const plan = await l2.plan({ description: 'full app' }, ctx);
    await expect(l2.execute({ description: 'full app' }, plan, ctx)).rejects.toThrow('Cancelled by operator');
  });

  it('honours a library caller\'s own timeout as a cancellation when there is no run deadline', async () => {
    const { l2, ctx } = synthesisRun(new DOMException('Caller timeout', 'TimeoutError'), null);
    const plan = await l2.plan({ description: 'full app' }, ctx);
    await expect(l2.execute({ description: 'full app' }, plan, ctx)).rejects.toThrow('Caller timeout');
  });
});

describe('a landed synthesis says why it kept its sub-results (2026-09-25 adversarial review)', () => {
  it('names the failure, not a closed window, when the landing synthesis call errors', async () => {
    const warnings: string[] = [];
    const ctx = { ...makeCtx(), deadlineAt: Date.now() + 60_000 };
    const logged = { ...ctx, logger: { ...ctx.logger, warn: (message: string) => { warnings.push(message); } } };
    const kept = await synthesizeOrKeep(logged, true, () => Promise.reject(new Error('provider 529 overloaded')));
    expect(kept).toEqual({ keptBecause: 'it failed while landing: provider 529 overloaded' });
    expect(warnings).toEqual([expect.stringContaining('it failed while landing: provider 529 overloaded')]);
    const producedBy = { tier: 2 as const, name: 'Cell1', viaFallback: false };
    const sub = { output: 'a', summary: 's', trace: [], producedBy };
    expect(keptWithoutSynthesis([sub, sub], producedBy, (kept as { keptBecause: string }).keptBecause).unfinishedPhases)
      .toEqual(['synthesis of 2 sub-results (it failed while landing: provider 529 overloaded)']);
  });
});
