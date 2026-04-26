import { describe, it, expect, beforeEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * Phase B — sequential aggregation mode.
 *
 * Runs an N=3 sequential plan through L2.handleDirect and asserts:
 *   - subtasks dispatched ONE AT A TIME (verified via LLM call ordering;
 *     a parallel dispatch would interleave the L1 plans/executes, but
 *     a sequential one finishes child #1 entirely before starting #2).
 *   - each child after the first receives `previousStepSummary` in its
 *     `Inputs:` block — the runtime threads the prior step's `summary`
 *     into the next step's task.inputs.
 *   - the aggregated result carries the LAST step's output (not concat),
 *     matching the new sequential aggregate contract in L2Atom.aggregate.
 *
 * Tests use a single L1 child (Hydrogen) to keep mocking simple — the
 * sequential semantics are about HOW we dispatch, not WHAT child each
 * subtask uses.
 */

const seed = {
  description: 'orchestrator',
  systemPrompt: 'You are an L2.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('L2.execute — sequential dispatch', () => {
  let reg: AtomRegistry;

  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, {
      ...seed,
      description: 'web builder',
      systemPrompt: 'You are an L1.',
    });
    // Force trust fast-path on Hydrogen so validators don't fire.
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Hydrogen');
  });

  it('threads previousStepSummary into each subsequent subtask and returns last-step output', async () => {
    const water = L2Atom.fromType(reg.getByName('Water')!, reg);
    const ctx = makeCtx();

    // L2 prefilter (Haiku) — escalate so the full Sonnet plan runs and we
    // can supply a sequential plan via the mock.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    // L2 plan: 3 sequential phases all targeting Hydrogen.
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'reuse' },
        {
          reasoning: 'phased build',
          subtasks: [
            { description: 'phase-1: scaffold', preferredChild: 'Hydrogen' },
            { description: 'phase-2: extend', preferredChild: 'Hydrogen' },
            { description: 'phase-3: smoke', preferredChild: 'Hydrogen' },
          ],
          aggregation: { mode: 'sequential' },
          expectedOutput: 'final artefact',
        }
      )
    );
    // 3 L1 plan/execute pairs. Each L1 plan call gets a deterministic stub;
    // each execute returns a labelled summary so we can verify threading.
    for (const phase of ['phase-1', 'phase-2', 'phase-3']) {
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: phase, expectedOutput: 'e' })
      );
      ctx.llm.enqueueText(
        jsonText({ output: `output-${phase}`, summary: `summary-${phase}` })
      );
    }

    const result = await water.handleDirect({ description: 'phased pong' }, ctx);

    // 1) The final aggregated result is the LAST phase's output (not a concat).
    expect(result.output).toBe('output-phase-3');
    expect(result.summary).toContain('3 sequential phases');
    expect(result.summary).toContain('summary-phase-3');

    // 2) The L1 PLAN calls for phase 2 and phase 3 must contain the
    // previous step's summary in their userContent (via task.inputs).
    // Calls (in order):
    //   #0 prefilter Haiku
    //   #1 L2 Sonnet plan
    //   #2 L1 plan phase-1     ← no previousStepSummary
    //   #3 L1 execute phase-1
    //   #4 L1 plan phase-2     ← previousStepSummary = summary-phase-1
    //   #5 L1 execute phase-2
    //   #6 L1 plan phase-3     ← previousStepSummary = summary-phase-2
    //   #7 L1 execute phase-3
    expect(ctx.llm.calls).toHaveLength(8);
    const planPhase1 = ctx.llm.calls[2]!.userContent;
    const planPhase2 = ctx.llm.calls[4]!.userContent;
    const planPhase3 = ctx.llm.calls[6]!.userContent;
    // Phase 1 has no prior step → no threading marker in its inputs.
    expect(planPhase1).not.toContain('"previousStepSummary":');
    // Phase 2 sees phase 1's summary; phase 3 sees phase 2's summary.
    // We assert the threaded summary text directly (the runtime serialises
    // task.inputs into the L1 plan userContent as JSON).
    expect(planPhase2).toContain('summary-phase-1');
    expect(planPhase3).toContain('summary-phase-2');
    expect(planPhase3).not.toContain('summary-phase-1'); // only the IMMEDIATE prior step is threaded
  });

  it('parallel modes (concat) still dispatch via Promise.all without threading', async () => {
    const water = L2Atom.fromType(reg.getByName('Water')!, reg);
    const ctx = makeCtx();

    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'reuse' },
        {
          reasoning: 'orthogonal',
          subtasks: [
            { description: 'leaf-A', preferredChild: 'Hydrogen' },
            { description: 'leaf-B', preferredChild: 'Hydrogen' },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'list',
        }
      )
    );
    // Promise.all runs both subtasks concurrently against a synchronous
    // mock. JS resolves them in submission order, so the call sequence
    // is: plan-A, plan-B, exec-A, exec-B (NOT interleaved per-subtask).
    for (const phase of ['A', 'B']) {
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: phase, expectedOutput: 'e' })
      );
    }
    for (const phase of ['A', 'B']) {
      ctx.llm.enqueueText(
        jsonText({ output: `output-${phase}`, summary: `summary-${phase}` })
      );
    }

    const result = await water.handleDirect({ description: 'fan-out' }, ctx);

    // Concat: array of outputs, no last-step privilege.
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output).toEqual(['output-A', 'output-B']);
    // Concat mode does not thread previous output: no L1 plan call's
    // task.inputs should carry previousStepSummary. We check the JSON
    // form (`"previousStepSummary":` — with the quoted key + colon) so
    // we don't false-positive on the L2 plan prompt that explains the
    // feature in human prose.
    for (const call of ctx.llm.calls) {
      expect(call.userContent).not.toContain('"previousStepSummary":');
    }
  });
});
