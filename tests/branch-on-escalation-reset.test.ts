import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import { L3Atom, buildNarrowL2Prompt } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { SMOKE_DESIGN_GUIDANCE } from '../src/atoms/prompts.js';
import { EscalationSignal } from '../src/core/errors.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';
import type { Atom, Supervisor } from '../src/core/atom.js';
import type {
  Plan,
  Result,
  Tier,
  Verdict,
} from '../src/core/types.js';

const WEB_TOOLS = makeTools([
  'write_file',
  'read_file',
  'list_files',
  'start_static_server',
  'validate_html',
]);

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
  description: 'platformer builder',
  systemPrompt: 'You are Water, a WebGL platformer builder. Do platformer things.',
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

  it('includes the standard web-artefact build loop guidance when tools match the web bucket', () => {
    const prompt = buildNarrowL1Prompt('anything', WEB_TOOLS);
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('start_static_server');
    expect(prompt).toContain('validate_html');
    expect(prompt).toMatch(/Up to 4 iterations/);
  });

  it('includes the shared smoke-test design guidance when tools match the web bucket', () => {
    // Shared block between the escalation branch path and the
    // create-fresh-L1 path. Only appears for the WEB bucket — HTTP and
    // unknown buckets skip it (fix #8b).
    const prompt = buildNarrowL1Prompt('build anything', WEB_TOOLS);
    expect(prompt).toMatch(/SMOKE-TEST DESIGN/);
    expect(prompt).toMatch(/pure EXPRESSION/);
    expect(prompt).toMatch(/window\.__test/);
    expect(prompt).toMatch(/SMOKE-LOOP DISCIPLINE/);
    expect(prompt).toMatch(/cumulative over[\s\S]*sliding window/);
  });

  it('uses the HTTP canonical sequence when tools match the http-server-build+probe bucket', () => {
    const httpTools = makeTools([
      'write_file',
      'read_file',
      'list_files',
      'run_shell',
      'fetch_url',
      'start_node_server',
    ]);
    const prompt = buildNarrowL1Prompt('build a REST API', httpTools);
    // HTTP-specific markers from CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES.
    expect(prompt).toMatch(/LISTENING_ON_PORT/);
    expect(prompt).toMatch(/start_node_server/);
    expect(prompt).toMatch(/fetch_url/);
    // MUST NOT leak web/smoke guidance — this is the whole point of #8b.
    expect(prompt).not.toMatch(/SMOKE-TEST DESIGN/);
    expect(prompt).not.toMatch(/validate_html/);
    expect(prompt).not.toMatch(/start_static_server/);
  });

  it('falls back to a generic tools-only template when the toolset matches no known bucket', () => {
    // Emphasis of the generic branch: NO smoke guidance, NO validate_html
    // narrative. Just "use only what you were given".
    const prompt = buildNarrowL1Prompt('ad-hoc task', makeTools(['rare_a', 'rare_b']));
    expect(prompt).not.toMatch(/SMOKE-TEST DESIGN/);
    expect(prompt).not.toMatch(/validate_html/);
    expect(prompt).not.toMatch(/start_node_server/);
    expect(prompt).toMatch(/ONLY the/);
  });

  it('defaults childTools to [] and produces a valid generic prompt (backwards compat)', () => {
    // Callers that haven't migrated to passing tools yet still get a
    // sensible fallback.
    const prompt = buildNarrowL1Prompt('anything');
    expect(prompt).toContain('Your current subtask: anything');
    expect(prompt).not.toMatch(/SMOKE-TEST DESIGN/);
  });
});

describe('createSubtaskL1 — fresh-L1 system prompt carries the same smoke guidance', () => {
  it('the smoke guidance leads with COST: one object smoke, not one assertion per call', () => {
    // Measured (habit-tracker, 2026-08-09, clean machine): 66
    // validate_html calls carrying 64 distinct smokes, 45 of them
    // PASSING — one element verified per browser round-trip, ~9 minutes
    // of page loads. Nothing in the guidance mentioned that a call is
    // expensive, and the existing loop-discipline rules only fire on
    // REPEATED failures, which never happened. The same rule also cures
    // the "smoke check failed: false" opacity: a bare boolean carries no
    // diagnosis, a returned object comes back with its values.
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/MOST EXPENSIVE tool/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/structured OBJECT/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/explicit aggregate `ok`/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/explicit `ok === true`.*authoritative/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/Raw state fields may legitimately be false/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/omit `ok`.*object fail/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/If you are past\s+five/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/copy the exact.*byte-for-byte/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/"#increment-btn".*"incrementBtn"/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/"On Fire".*"Beginner"/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/getter-only property/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/get name\(\).*this\.name =/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/statusText.*not writable state/s);
    // Reworded 2026-08-23: the sequence rule now covers the shapes the
    // DETECTOR covers (any repeated control plus reset/clear), because a
    // double theme toggle matched the detector and not the old sentence —
    // `a786358a` call #17 exactly. It also states the mutual exclusivity,
    // which previously reached only the L2/L3 planning prompts and never the
    // tier that writes the smoke.
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/increments, toggles.*or resets.*final state/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/MUTUALLY EXCLUSIVE/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/interactions: \[\]/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/class\/style\/color.*labels alone are insufficient/s);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/for \(let i = 0; i < thresholdFromContract/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/derive thresholds\s+and required labels from the task/);
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/Object\.values\(checks\)\.every\(Boolean\)/);
    // Reworded 2026-08-21: the rule survived, the vague half did not. The
    // guidance now names the MECHANISM (a synchronous computed read on a
    // transitioned property is stale) instead of calling literals "brittle",
    // and it says the tool REFUSES the literal comparison pre-flight.
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(
      /Never compare a computed value to an rgb\(\)\/rgba\(\) LITERAL/
    );
    expect(SMOKE_DESIGN_GUIDANCE).toMatch(/refused pre-flight/);
  });

  it('new L1s that inherit validate_html from the L2 toolset get SMOKE_DESIGN_GUIDANCE', async () => {
    // Regression: earlier the smoke guidance only lived in
    // buildNarrowL1Prompt (the escalation-branch path), so freshly-
    // created L1s on the fanout happy path missed it and kept
    // hitting the IIFE / simulate-input pitfalls. After #8b the block
    // is only appended when the child's merged tools include
    // validate_html (the web bucket) — so this test wires an L2 with
    // the web toolset so the merged child tools carry validate_html
    // and the guidance kicks in.
    const { AtomRegistry } = await import('../src/registry/atomRegistry.js');
    const { openDb } = await import('../src/registry/db.js');
    const { L2Atom } = await import('../src/atoms/L2Atom.js');
    const reg = new AtomRegistry(openDb(':memory:'));
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'l2',
      tools: WEB_TOOLS,
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
      'You are an L1 molecule builder with ONE narrow responsibility.'
    );
    expect(created.systemPrompt).not.toContain('build a chess puzzle grid');
  });
});

describe('buildNarrowL2Prompt', () => {
  it('bakes the subtask description and fan-out guidance into the prompt', () => {
    const prompt = buildNarrowL2Prompt('orchestrate a Snake build');
    expect(prompt).toContain('Your current subtask: orchestrate a Snake build');
    expect(prompt).toContain('orthogonal L1 molecule subtasks');
    expect(prompt).toContain('NEVER execute tools yourself');
  });
});

/**
 * Minimal FakeL2 supervisor used to drive superviseLoop on an L1 child
 * without a real L2.plan/execute. We queue verdicts to force the loop to
 * exhaust its plan iterations, then assert what branchOnEscalation wrote.
 */
/**
 * `Atom` is abstract, so the empty class expression that used to sit between
 * FakeL2 and this cast had to implement `tier`/`model`/`plan`/`execute`
 * itself (TS2656) — FakeL2 declares them one level down. The intermediate
 * class added nothing else, so it is gone; FakeL2 extends the cast directly
 * and supplies every abstract member.
 */
class FakeL2 extends (Object as unknown as new () => Atom)
  implements Supervisor<L1Atom> {
  readonly tier: Tier = 2;
  readonly model = 'sonnet';
  override readonly name = 'Tracheid';
  override readonly ordinal = 1;
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
  override isFallbackMode(): boolean {
    return false;
  }
  override setFallbackMode(_on: boolean): void {
    /* no-op */
  }
  override injectContext(input: import('../src/contracts/llmTrace.js').ContextBlockInput) {
    return { id: 'unused', source: input.source, text: input.text };
  }
  override applyModifications(): void {
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
    const parent = reg.create(1, seed); // Water
    const l2Type = reg.create(2, {
      description: 'l2',
      systemPrompt: 'L2 prompt',
      tools: [],
      params: {},
      createdBy: 'test',
    });

    // Real L2Atom so we can pull its private hooks via running execute.
    // Instead of going through the full execute → we directly test the
    // hooks factory via an integration: give Tracheid a plan that rejects
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
    const recovery = await hooks.branchOnEscalation(child, [], 'escalation-plan');

    // The registry should now contain a NEW L1 with a fresh narrow prompt
    // that does not persist the subtask or the parent's platformer
    // instructions.
    const allL1 = reg.listByTier(1);
    expect(allL1.length).toBe(2); // original + branch
    const branched = allL1.find((t) => t.name !== parent.name)!;
    expect(branched.systemPrompt).not.toContain('build a Tetris grid with scoring');
    expect(recovery?.contextBlocks().map(b => b.text).join('\n')).toContain('build a Tetris grid with scoring');
    const reused = L1Atom.fromType(branched);
    expect(reused.toLlmRequest('plan', { userContent: 'build a clock' }).systemPrompt).not.toContain('Tetris');
    expect(branched.systemPrompt).toMatch(/IGNORE its[\s\S]*domain/);
    // The PARENT-specific Frankenstein content must be absent from the
    // branched child. Parent's prompt was about Mario-style platformers
    // ("Goomba", "platformer builder", jumping physics) — none of that
    // should have bled through since we did a full systemPromptReplace.
    expect(branched.systemPrompt).not.toMatch(/Goomba/);
    expect(branched.systemPrompt).not.toContain('Do platformer things');
    // Description also replaced — the Frankenstein "platformer builder"
    // label is gone from the description body.
    // Fix 2: the branch path now writes a capability-first description
    // so escalations can't re-theme the registry with whatever task
    // happened to trigger them. The task narrative now lives only in the recovery instance context.
    expect(branched.description).not.toMatch(/Tetris|platformer|Goomba|Mario/i);
    expect(branched.description).not.toMatch(/narrow builder for:/);
    expect(branched.description).toMatch(/builder|scribe|toolset/);
  });
});

describe('L3 branchOnEscalation — resets the L2 prompt to the current subtask', () => {
  it('writes a systemPromptReplace aligned with the L2 subtask', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const parent = reg.create(2, {
      description: 'l2 base',
      systemPrompt: 'You are a platformer orchestrator. Do platformer things.',
      tools: [],
      params: {},
      createdBy: 'test',
    }); // Tracheid
    reg.create(3, {
      description: 'l3',
      systemPrompt: 'L3 prompt',
      tools: [],
      params: {},
      createdBy: 'test',
    }); // Meristem
    const tissue = L3Atom.buildWithModel(reg.getByName('Meristem')!, reg, FALLBACK_OPUS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: SupervisionHooks<L2Atom> = (tissue as any).makeL2Hooks(
      makeCtx(),
      'orchestrate a dashboard build'
    );
    const child = L2Atom.fromType(parent, reg);
    const recovery = await hooks.branchOnEscalation(child, [], 'escalation-plan');

    const branchedL2 = reg.listByTier(2).find((t) => t.name !== 'Tracheid')!;
    expect(branchedL2.systemPrompt).not.toContain('orchestrate a dashboard build');
    expect(recovery?.contextBlocks().map(b => b.text).join('\n')).toContain('orchestrate a dashboard build');
    expect(branchedL2.systemPrompt).not.toContain('platformer');
    expect(branchedL2.description).not.toMatch(/dashboard|platformer/i);
    expect(branchedL2.description).not.toMatch(/narrow orchestrator for:/);
    expect(branchedL2.description).toMatch(/orchestrator|toolset/);
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

    // The branch is reusable; the current subtask is not persisted.
    const branched = reg.listByTier(1).find((t) => t.name !== parent.name);
    expect(branched).toBeDefined();
    expect(branched!.systemPrompt).not.toContain('make a snake game');
    expect(branched!.systemPrompt).not.toMatch(/Do platformer things/);
  });
});

// Keep FakeL2 / EscalationSignal referenced so the TS compiler and linter
// don't flag them as unused (they exist for future explicit tests).
void FakeL2;
void EscalationSignal;
