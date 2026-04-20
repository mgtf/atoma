import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { L3Atom, buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { EscalationSignal } from '../src/core/errors.js';
import { makeCtx, jsonText } from './helpers.js';
import type { Atom, Supervisor } from '../src/core/atom.js';
import type {
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Verdict,
} from '../src/core/types.js';

/**
 * Regression tests for the anti-Frankenstein branchOnEscalation fix.
 *
 * Background: before this fix, when a child atom failed its plan loop and
 * the supervisor branched it, the new branch inherited the parent's
 * system prompt verbatim (only an `additionalContext` line was added).
 * That kept domain-biased prompts alive across branches — a
 * "platformer builder" parent, branched to handle a dashboard task, kept
 * introducing itself as a platformer builder and kept emitting platformer
 * plans. The escalation loop couldn't break the bias.
 *
 * Fix: branchOnEscalation now emits `systemPromptReplace` with a fresh
 * narrow template focused on the CURRENT task, plus `descriptionReplace`
 * aligned with that task. The branched atom starts clean.
 */

const seed = {
  description: 'legacy platformer builder',
  systemPrompt: 'You are Hydrogen, a WebGL platformer builder. Do platformer things.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('buildNarrowL1Prompt', () => {
  it('bakes the subtask description into the prompt', () => {
    const prompt = buildNarrowL1Prompt('build a Snake game grid renderer');
    expect(prompt).toContain('Your current subtask: build a Snake game grid renderer');
    expect(prompt).toContain('ONE narrow responsibility');
    // "IGNORE its domain" spans a line break in the template; match
    // with a regex so the assertion doesn't depend on the exact wrap.
    expect(prompt).toMatch(/IGNORE its[\s\S]*domain/);
  });

  it('includes the standard web-artefact build loop guidance', () => {
    const prompt = buildNarrowL1Prompt('anything');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('start_static_server');
    expect(prompt).toContain('validate_html');
    expect(prompt).toMatch(/Up to 4 iterations/);
  });

  it('includes the shared smoke-test design guidance (IIFE + __test pattern + loop discipline)', () => {
    // Shared block between the escalation branch path and the
    // create-fresh-L1 path. Guards against someone trimming it.
    const prompt = buildNarrowL1Prompt('build anything');
    expect(prompt).toMatch(/SMOKE-TEST DESIGN/);
    expect(prompt).toMatch(/pure EXPRESSION/);
    expect(prompt).toMatch(/window\.__test/);
    expect(prompt).toMatch(/SMOKE-LOOP DISCIPLINE/);
    expect(prompt).toMatch(/cumulative over[\s\S]*sliding window/);
  });
});

describe('createSubtaskL1 — fresh-L1 system prompt carries the same smoke guidance', () => {
  it('new L1s created inline (not via escalation branch) get the shared SMOKE_DESIGN_GUIDANCE block', async () => {
    // Regression: earlier the smoke guidance only lived in
    // buildNarrowL1Prompt (the escalation-branch path), so freshly-
    // created L1s on the fanout happy path missed it and kept
    // hitting the IIFE / simulate-input pitfalls. This test wires a
    // minimal L2 through fan-out-with-create so we can inspect the
    // system prompt the registry actually stored.
    const { AtomRegistry } = await import('../src/registry/atomRegistry.js');
    const { openDb } = await import('../src/registry/db.js');
    const { L2Atom } = await import('../src/atoms/L2Atom.js');
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    const water = L2Atom.fromType(l2Type, reg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = (water as any).createSubtaskL1(
      { description: 'build a chess puzzle grid', preferredChild: undefined },
      { action: 'create', seed: undefined },
      { description: 'parent task' }
    );
    expect(created.systemPrompt).toMatch(/SMOKE-TEST DESIGN/);
    expect(created.systemPrompt).toMatch(/window\.__test/);
    expect(created.systemPrompt).toMatch(/SMOKE-LOOP DISCIPLINE/);
    // And the fresh-L1 preamble is still present — we ADDED the
    // guidance, we did not replace the original contract.
    expect(created.systemPrompt).toContain(
      'You are an L1 element with ONE narrow responsibility.'
    );
    expect(created.systemPrompt).toContain(
      'Subtask you were handed: build a chess puzzle grid'
    );
  });
});

describe('buildNarrowL2Prompt', () => {
  it('bakes the subtask description and fan-out guidance into the prompt', () => {
    const prompt = buildNarrowL2Prompt('orchestrate a Snake build');
    expect(prompt).toContain('Your current subtask: orchestrate a Snake build');
    expect(prompt).toContain('orthogonal L1 leaf subtasks');
    expect(prompt).toContain('NEVER execute tools yourself');
  });
});

/**
 * Minimal FakeL2 supervisor used to drive superviseLoop on an L1 child
 * without a real L2.plan/execute. We queue verdicts to force the loop to
 * exhaust its plan iterations, then assert what branchOnEscalation wrote.
 */
class FakeL2 extends (class extends (Object as unknown as new () => Atom) {})
  implements Supervisor<L1Atom> {
  readonly tier: Tier = 2;
  readonly model = 'sonnet';
  readonly name = 'Water';
  readonly ordinal = 1;
  private pv: Verdict[] = [];

  constructor() {
    super();
  }
  queuePlanVerdict(v: Verdict): void {
    this.pv.push(v);
  }
  async validatePlan(): Promise<Verdict> {
    const v = this.pv.shift();
    if (!v) throw new Error('no queued plan verdict');
    return v;
  }
  async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'ok' };
  }
  // Unused Atom fields; declared to satisfy the Supervisor<L1Atom> compile surface.
  isFallbackMode(): boolean {
    return false;
  }
  setFallbackMode(_on: boolean): void {
    /* no-op */
  }
  injectContext(_text: string): void {
    /* no-op */
  }
  applyModifications(): void {
    /* no-op */
  }
  async plan(): Promise<Plan> {
    throw new Error('not used');
  }
  async execute(): Promise<Result> {
    throw new Error('not used');
  }
}

describe('L2 branchOnEscalation — resets the L1 prompt to the current subtask', () => {
  it('writes a systemPromptReplace aligned with the subtask, not inherited from parent', async () => {
    // Setup: registry with a Frankenstein L1 (name says generic, prompt says platformer).
    const reg = new AtomRegistry(openDb(':memory:'));
    const parent = reg.create(1, seed); // Hydrogen
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'L2 prompt',
      tools: [],
      params: {},
      createdBy: 'test',
    });

    // Real L2Atom so we can pull its private hooks via running execute.
    // Instead of going through the full execute → we directly test the
    // hooks factory via an integration: give Water a plan that rejects
    // 5× and escalates on an L1Atom child. When branchOnEscalation fires,
    // the new branch in the registry must have a RESET prompt.
    const water = L2Atom.fromType(l2Type, reg);
    // Force fallback off so execute takes the hooks path. Not needed — we
    // go through a direct superviseLoop call with manually built hooks
    // to isolate the branchOnEscalation behaviour.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: SupervisionHooks<L1Atom> = (water as any).makeL1Hooks(
      makeCtx(),
      'build a Tetris grid with scoring'
    );
    expect(typeof hooks.branchOnEscalation).toBe('function');

    // Invoke the hook directly — simulating superviseLoop's escalation path.
    const child = L1Atom.fromType(parent);
    await hooks.branchOnEscalation(child, [], 'escalation-plan');

    // The registry should now contain a NEW L1 with a fresh narrow prompt
    // that mentions the subtask description, NOT the parent's platformer
    // instructions.
    const allL1 = reg.listByTier(1);
    expect(allL1.length).toBe(2); // original + branch
    const branched = allL1.find((t) => t.name !== parent.name)!;
    expect(branched.systemPrompt).toContain('Your current subtask: build a Tetris grid with scoring');
    expect(branched.systemPrompt).toMatch(/IGNORE its[\s\S]*domain/);
    // The PARENT-specific Frankenstein content must be absent from the
    // branched child. Parent's prompt was about Mario-style platformers
    // ("Goomba", "platformer builder", jumping physics) — none of that
    // should have bled through since we did a full systemPromptReplace.
    expect(branched.systemPrompt).not.toMatch(/Goomba/);
    expect(branched.systemPrompt).not.toContain('Do platformer things');
    // Description also replaced — the Frankenstein "platformer builder"
    // label is gone from the description body.
    expect(branched.description).toMatch(/L1 narrow builder for: build a Tetris grid/);
  });
});

describe('L3 branchOnEscalation — resets the L2 prompt to the current subtask', () => {
  it('writes a systemPromptReplace aligned with the L2 subtask', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const parent = reg.create(2, {
      description: 'l2 legacy',
      systemPrompt: 'You are a platformer orchestrator. Do platformer things.',
      tools: [],
      params: {},
      createdBy: 'test',
    }); // Water
    reg.create(3, {
      description: 'l3',
      systemPrompt: 'L3 prompt',
      tools: [],
      params: {},
      createdBy: 'test',
    }); // Neuron
    const neuron = L3Atom.buildWithModel(reg.getByName('Neuron')!, reg, FALLBACK_OPUS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: SupervisionHooks<L2Atom> = (neuron as any).makeL2Hooks(
      makeCtx(),
      'orchestrate a dashboard build'
    );
    const child = L2Atom.fromType(parent, reg);
    await hooks.branchOnEscalation(child, [], 'escalation-plan');

    const branchedL2 = reg.listByTier(2).find((t) => t.name !== 'Water')!;
    expect(branchedL2.systemPrompt).toContain(
      'Your current subtask: orchestrate a dashboard build'
    );
    expect(branchedL2.systemPrompt).not.toContain('platformer');
    expect(branchedL2.description).toMatch(/L2 narrow orchestrator for: orchestrate a dashboard/);
  });
});

/**
 * End-to-end integration: superviseLoop escalates after enough plan
 * rejections, branchOnEscalation fires, the branched L1 ends up in the
 * registry with a reset prompt. superviseLoop then enters the parent's
 * fallback (not re-thrown), so we assert on the FINAL registry state
 * rather than on a rejection.
 */
describe('superviseLoop → branchOnEscalation integration', () => {
  it('records a branched L1 with a reset prompt in the registry', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const parent = reg.create(1, seed);
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: [],
      params: {},
      createdBy: 'test',
    });
    const water = L2Atom.fromType(l2Type, reg);

    const ctx = makeCtx();
    // Queue plan responses the child L1 will emit. After enough
    // rejections the maxPlanIterations cap fires EscalationSignal.
    for (let i = 0; i < 30; i++) {
      ctx.llm.enqueueText(
        jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' })
      );
    }
    // After escalation, water falls back: selfPlan + selfExecute fire
    // additional LLM calls. Parse-tolerant so these don't need to be
    // well-formed plans.
    for (let i = 0; i < 5; i++) {
      ctx.llm.enqueueText(
        jsonText({ output: 'fallback done', summary: 'ok' })
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: SupervisionHooks<L1Atom> = (water as any).makeL1Hooks(
      ctx,
      'make a snake game'
    );
    // Monkey-patch water's validatePlan to always reject (forcing escalation
    // via max plan iterations). Restore after so we don't leak the override.
    const origValidate = water.validatePlan.bind(water);
    (water as unknown as { validatePlan: (...a: unknown[]) => Promise<Verdict> }).validatePlan =
      async (): Promise<Verdict> => ({
        approved: false,
        reasoning: 'not enough visible deliverables',
        scope: 'ephemeral',
        modifications: {},
      });

    const child = L1Atom.fromType(parent);
    // Loop does not re-throw: it escalates internally then takes the
    // parent-fallback path. We don't care about the final Result here,
    // only about the registry side-effect of branchOnEscalation.
    try {
      await superviseLoop(water, child, { description: 't' }, ctx, hooks);
    } catch {
      /* absorbed — fallback LLM call queue may be exhausted */
    }

    // Restore original (hygiene).
    (water as unknown as { validatePlan: typeof origValidate }).validatePlan = origValidate;

    // A new L1 was branched with a reset prompt that mentions the
    // subtask description passed to makeL1Hooks.
    const branched = reg.listByTier(1).find((t) => t.name !== parent.name);
    expect(branched).toBeDefined();
    expect(branched!.systemPrompt).toContain('make a snake game');
    expect(branched!.systemPrompt).not.toMatch(/Do platformer things/);
  });
});

// Keep FakeL2 / EscalationSignal referenced so the TS compiler and linter
// don't flag them as unused (they exist for future explicit tests).
void FakeL2;
void EscalationSignal;
