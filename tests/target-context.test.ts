import { describe, it, expect } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { buildTargetContext, llmVerdict } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * Regression tests for delegation-target context injection.
 *
 * Background: in the 23:48 build-app run, Neuron (L3) rejected a valid
 *   { proposedAction: 'delegate leaf task to L1 "Fluorine"' }
 * plan with hallucinated reasoning ("Fluorine builds generic web apps
 * without WebGL specialization") because the validator only saw the name
 * "Fluorine" — Fluorine's actual description ("Builds, serves, and
 * validates a single-file WebGL Minesweeper game") was nowhere in the
 * userContent. The fix injects a compact `Delegation target(s):` block
 * with the target's description + trust counters, so Haiku judges on
 * facts rather than name-based guesses.
 */

const fluorineSeed = {
  description:
    'Builds, serves, and validates a single-file WebGL Minesweeper game, iterating until validation passes.',
  systemPrompt: 'You are Fluorine, an L1 molecule worker.',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('buildTargetContext', () => {
  it('returns undefined for plans with no recognizable target', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed);
    const plan = {
      reasoning: 'r',
      proposedAction: 'think about it',
      expectedOutput: 'an answer',
    };
    expect(buildTargetContext(plan, reg)).toBeUndefined();
  });

  it('extracts `L1 "Name"` patterns from proposedAction', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed); // becomes "Water"
    reg.describe('Water', 'WebGL Minesweeper builder with headless validation.');

    const plan = {
      reasoning: 'prefilter selected Water',
      proposedAction: 'delegate leaf task to L1 "Water"',
      expectedOutput: 'done',
    };
    const ctx = buildTargetContext(plan, reg);
    expect(ctx).toBeDefined();
    expect(ctx!).toMatch(/Water \(L1/);
    expect(ctx!).toMatch(/WebGL Minesweeper builder/);
  });

  it('falls back to a whole-word catalog scan when no quoted-name pattern', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed);
    reg.describe('Water', 'Single-file WebGL Minesweeper builder.');

    const plan = {
      reasoning: 'r',
      proposedAction: 'hand the work to Water and await its output',
      expectedOutput: 'a URL',
    };
    const ctx = buildTargetContext(plan, reg);
    expect(ctx).toBeDefined();
    expect(ctx!).toContain('Water');
  });

  it('shows trust counters so the validator knows what has historically worked', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed);
    reg.recordSuccess('Water');
    reg.recordSuccess('Water');
    reg.recordSuccess('Water');

    const plan = {
      reasoning: 'r',
      proposedAction: 'delegate leaf task to L1 "Water"',
      expectedOutput: 'e',
    };
    const ctx = buildTargetContext(plan, reg)!;
    expect(ctx).toMatch(/✓3\/✗0/);
  });

  it('strips branch-provenance tails so the description is clean', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed);
    reg.branch('Water', {}, 'tester', 'WebGLMinesweeper');
    // Its raw description now has "(branched from Water)" appended.
    const raw = reg.getByName('WebGLMinesweeper')!.description;
    expect(raw).toMatch(/\(branched from Water\)$/);

    const plan = {
      reasoning: 'r',
      proposedAction: 'delegate leaf task to L1 "WebGLMinesweeper"',
      expectedOutput: 'e',
    };
    const ctx = buildTargetContext(plan, reg)!;
    expect(ctx).not.toMatch(/\(branched from Water\)/);
    expect(ctx).toMatch(/WebGLMinesweeper \(L1/);
  });

  it('skips unknown names (regex matches a name not in the registry)', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed); // Water exists

    const plan = {
      reasoning: 'r',
      proposedAction: 'delegate leaf task to L1 "Phlogiston"', // not in registry
      expectedOutput: 'e',
    };
    expect(buildTargetContext(plan, reg)).toBeUndefined();
  });
});

describe('llmVerdict — injects targetContext into userContent', () => {
  it('passes the Delegation target(s) block when targetContext is provided', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    const child = new L1Atom({
      name: 'Fluorine',
      ordinal: 9,
      systemPrompt: 's',
      tools: [],
      params: {},
    });

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Meristem',
      supervisorTier: 3,
      subject: 'PLAN',
      child,
      task: { description: 'build a WebGL game' },
      payload: {
        reasoning: 'r',
        proposedAction: 'delegate leaf task to L1 "Fluorine"',
        expectedOutput: 'e',
      },
      targetContext:
        '  - Fluorine (L1, v2, ✓3/✗0): WebGL Minesweeper builder with validation loop.',
    });

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).toContain('Delegation target(s):');
    expect(userContent).toContain('Fluorine (L1, v2, ✓3/✗0)');
    expect(userContent).toContain('WebGL Minesweeper builder');
  });

  it('omits the block cleanly when no targetContext is provided', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    const child = new L1Atom({
      name: 'Fluorine',
      ordinal: 9,
      systemPrompt: 's',
      tools: [],
      params: {},
    });

    await llmVerdict({
      ctx,
      model: 'claude-haiku-test',
      supervisorName: 'Meristem',
      supervisorTier: 3,
      subject: 'PLAN',
      child,
      task: { description: 't' },
      payload: { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' },
    });

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).not.toContain('Delegation target(s):');
  });
});

describe('L2Atom.validatePlan — end-to-end target injection', () => {
  it('auto-injects the L1 target description when validating a delegation plan', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, fluorineSeed);
    reg.describe(
      'Water',
      'WebGL Minesweeper builder with headless validation.'
    );
    const l2Type = reg.create(2, {
      description: 'L2',
      systemPrompt: 's',
      tools: [],
      params: {},
      createdBy: 't',
    });
    const l2 = L2Atom.fromType(l2Type, reg);

    const l1 = L1Atom.fromType(reg.getByName('Water')!);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await l2.validatePlan(
      l1,
      makePlan({
        reasoning: 'r',
        proposedAction: 'delegate leaf task to L1 "Water"',
        expectedOutput: 'e',
      }),
      { description: 't' },
      ctx
    );

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).toContain('Delegation target(s):');
    expect(userContent).toMatch(/Water \(L1[^)]+\): WebGL Minesweeper/);
  });
});
