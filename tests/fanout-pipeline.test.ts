import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';

/**
 * End-to-end fan-out pipeline tests for `L2Atom.execute`.
 *
 * Every L1 child in these tests is pre-seeded with enough successes to
 * cross the trust threshold (`shouldTrustType` returns true), so L2's
 * validator short-circuits via `trustedApproval` and never burns an LLM
 * call. Each subtask then consumes exactly TWO queued responses —
 * L1.plan + L1.execute — in deterministic FIFO order (Promise.all +
 * MockLlmClient preserve first-awaited-first-served under a single
 * event loop).
 *
 * Dequeue order for an N=3 fan-out:
 *   1. prefilter (escalate so strategy-pair LLM call fires)
 *   2. strategy+plan pair from L2.plan
 *   3-5. L1.plan response for subtasks A, B, C (FIFO)
 *   6-8. L1.execute response for subtasks A, B, C (FIFO)
 */

const seed = {
  description: 'd',
  systemPrompt: 'p',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('L2.execute — fan-out over N orthogonal subtasks', () => {
  it('runs 3 subtasks in parallel and concat-aggregates outputs', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const a = reg.create(1, seed); // Hydrogen
    const b = reg.create(1, seed); // Helium
    const c = reg.create(1, seed); // Lithium
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) {
      reg.recordSuccess(a.name);
      reg.recordSuccess(b.name);
      reg.recordSuccess(c.name);
    }
    const l2Type = reg.create(2, seed);
    const sucrose = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    // 1. Prefilter: force escalation so the strategy+plan pair LLM call fires.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    // 2. strategy+plan pair.
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: a.name, reasoning: 'pf' },
        {
          reasoning: 'decompose',
          subtasks: [
            { description: 'do A', preferredChild: a.name },
            { description: 'do B', preferredChild: b.name },
            { description: 'do C', preferredChild: c.name },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'three pieces',
        }
      )
    );
    // 3-5. L1.plan for each subtask.
    for (const _ of ['A', 'B', 'C']) {
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    }
    // 6-8. L1.execute for each subtask (FIFO order follows subtask order).
    for (const label of ['A', 'B', 'C']) {
      ctx.llm.enqueueText(
        jsonText({
          output: {
            value: label,
            probes: [{ cmd: `echo ${label}`, exitCode: 0, stdout: `${label}\n` }],
          },
          summary: `did ${label}`,
        })
      );
    }

    const task = { description: 'full job' };
    const plan = await sucrose.plan(task, ctx);
    expect(plan.subtasks).toHaveLength(3);

    const result = await sucrose.execute(task, plan, ctx);

    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output).toEqual([
      expect.objectContaining({ value: 'A' }),
      expect.objectContaining({ value: 'B' }),
      expect.objectContaining({ value: 'C' }),
    ]);
    expect(result.evidence?.map((w) => w.cmd)).toEqual(['echo A', 'echo B', 'echo C']);
    expect(result.summary).toMatch(/3 subtasks aggregated \(concat\)/);
    expect(result.producedBy).toEqual({
      tier: 2,
      name: sucrose.name,
      viaFallback: false,
    });
  });

  it('auto-creates a fresh L1 when a subtask has an unknown preferredChild (planner hallucination)', async () => {
    // Regression: Sonnet sometimes invents a chemical-element name for
    // `preferredChild` that isn't in the catalog (e.g. "Carbon" when only
    // Hydrogen exists). We used to crash the whole fan-out on
    // RegistryNotFoundError — now we auto-create a fresh L1 whose
    // description matches the subtask and run the supervise loop against
    // it, so N-1 healthy subtasks don't die alongside the confused one.
    //
    // The newly-created L1 starts with 0 successes so Sucrose's validator
    // fires LLM calls to approve its plan + result. We use a fallback
    // handler (enqueued LAST) that matches any remaining request and
    // responds role-aware — plan, execute, or verdict — so the test
    // tolerates the FIFO/microtask ordering of the 2 parallel subtasks
    // without manually counting slots.
    const reg = new AtomRegistry(openDb(':memory:'));
    const h = reg.create(1, seed); // Hydrogen — trusted
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(h.name);
    const l2Type = reg.create(2, seed);
    const l2 = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    // Prefilter escalate + strategy-pair: deterministic.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'skip' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [
            { description: 'A', preferredChild: 'Hydrogen' },
            // Hallucinated name — NOT in registry. Should auto-create.
            { description: 'B', preferredChild: 'Carbon' },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'e',
        }
      )
    );

    // Role-aware handler that covers whatever remaining calls fire
    // (plan / execute / validate) in whatever order the event loop
    // schedules them. Queue it enough times to cover the worst case:
    // 2 plans, 2 executes, 2 verdicts (plan+result for the untrusted
    // auto-created child). Extra handlers are harmless.
    const roleAware = (req: {
      systemPrompt: string;
      userContent: string;
    }): { text: string; stopReason: string; usage: { inputTokens: number; outputTokens: number } } => {
      const isValidate = req.systemPrompt.startsWith('You validate');
      const isExecute = /plan has been APPROVED/.test(req.userContent);
      let text: string;
      if (isValidate) {
        text = jsonText({ approved: true, reasoning: 'ok' });
      } else if (isExecute) {
        text = jsonText({ output: 'B-out', summary: 'did it' });
      } else {
        text = jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' });
      }
      return { text, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    };
    for (let i = 0; i < 10; i++) ctx.llm.enqueue(roleAware);

    const task = { description: 't' };
    const plan = await l2.plan(task, ctx);
    const result = await l2.execute(task, plan, ctx);

    // Both subtasks ran to completion despite the hallucinated name.
    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as unknown[]).length).toBe(2);

    // A new L1 was auto-created for the "Carbon" subtask → catalog grew.
    const l1Names = reg.listByTier(1).map((t) => t.name);
    expect(l1Names).toContain('Hydrogen');
    expect(l1Names.length).toBe(2);
    const newL1 = reg.listByTier(1).find((t) => t.name !== 'Hydrogen')!;
    // As of the capability-first description policy, freshly-created
    // L1s advertise a tool-signature-derived label instead of echoing
    // the subtask narrative. This test's fixture L2 has no tools, so
    // the canonical fallback is the tier-1 "custom leaf toolset" label.
    expect(newL1.description).toMatch(/custom leaf toolset/);
    expect(newL1.description).not.toMatch(/L1 for subtask/);
  });

  it('degenerate N=1 preserves the pre-fan-out result shape (single, unwrapped)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const h = reg.create(1, seed);
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess(h.name);
    const l2Type = reg.create(2, seed);
    const l2 = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    // Prefilter picks Hydrogen → synthetic plan with 1 subtask.
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'high',
        reasoning: 'direct match',
      })
    );
    ctx.llm.enqueueText(
      jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
    );
    ctx.llm.enqueueText(jsonText({ output: 'single', summary: 'done' }));

    const task = { description: 't' };
    const plan = await l2.plan(task, ctx);
    expect(plan.subtasks).toHaveLength(1);

    const result = await l2.execute(task, plan, ctx);
    // Degenerate unwrap: the one sub-result is returned directly, NOT
    // wrapped in an array. This is the backwards-compat guarantee.
    expect(result.output).toBe('single');
    expect(result.summary).toBe('done');
    expect(result.producedBy.name).toBe('Hydrogen');
    expect(result.producedBy.tier).toBe(1);
  });

  it('subtask.inputs flows into each child Task.inputs', async () => {
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
            { description: 'A', preferredChild: a.name, inputs: { seed: 1 } },
            { description: 'B', preferredChild: b.name, inputs: { seed: 2 } },
          ],
          aggregation: { mode: 'concat' },
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

    const plan = await l2.plan({ description: 't' }, ctx);
    await l2.execute({ description: 't' }, plan, ctx);

    // Pull L1.plan calls (those whose userContent includes "You are atom"
    // — the L1 plan template preamble) and check the `Inputs:` line each
    // L1 saw. Order is FIFO so L1-A is the first, L1-B the second.
    const l1PlanCalls = ctx.llm.calls.filter((c) =>
      /You are atom.*tier 1/.test(c.userContent)
    );
    expect(l1PlanCalls.length).toBeGreaterThanOrEqual(2);
    expect(l1PlanCalls[0]!.userContent).toContain('Inputs: {"seed":1}');
    expect(l1PlanCalls[1]!.userContent).toContain('Inputs: {"seed":2}');
  });
});
