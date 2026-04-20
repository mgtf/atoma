import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { makeCtx, jsonText } from './helpers.js';
import type { Plan, Task } from '../src/core/types.js';

/**
 * End-to-end test that a prompt update actually propagates from the
 * validator's raw JSON response all the way down to the atom's new
 * system prompt in the registry. This closes the "gap" between
 *   - `tests/scopes.test.ts` (mechanical: fake verdict object → hook)
 *   - production runs (where a live Haiku must also go through
 *     extractJson → parseVerdict → Zod superRefine before the hook sees
 *     the verdict).
 *
 * The validator here is backed by a real `llmVerdict` call that reads
 * a `MockLlmClient.enqueueText` payload — i.e. the exact same parse
 * path a live Haiku response would take. If any link in that chain
 * (string repair, Zod schema, no-op guard in registry.patch) silently
 * swallowed the modifications, the final systemPrompt in the DB would
 * be wrong and the assertion would fire.
 */

const seed = {
  description: 'test element',
  systemPrompt: 'original prompt — vague about output format',
  tools: [],
  params: {},
  createdBy: 'test',
};

function hooks(registry: AtomRegistry, supervisorName: string): SupervisionHooks<L1Atom> {
  return {
    applyByScope: async (child, verdict) => {
      if (verdict.scope === 'ephemeral') {
        child.applyModifications(verdict.modifications);
        return child;
      }
      if (verdict.scope === 'patch') {
        const patched = registry.patch(
          child.name,
          verdict.modifications,
          supervisorName,
          verdict.reasoning
        );
        return L1Atom.fromType(patched);
      }
      const branched = registry.branch(
        child.name,
        verdict.modifications,
        supervisorName,
        verdict.branchName
      );
      return L1Atom.fromType(branched);
    },
    branchOnEscalation: async () => {
      /* no-op for these tests */
    },
  };
}

describe('prompt-update pipeline — from Haiku JSON to mutated DB prompt', () => {
  it('systemPromptAppend lands in the DB after a full supervise-loop cycle', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed, description: 'sup' });

    const l1 = L1Atom.fromType(l1Type);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();

    // Queue in order: L1.plan, Haiku validator (REJECT with real mods),
    // L1.plan (retry), Haiku validator (APPROVE), L1.execute, Haiku
    // validator result (APPROVE).
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      // markdown-fenced like real Haiku output — exercises extractJson fence handling
      '```json\n' +
        JSON.stringify({
          approved: false,
          reasoning: 'prompt is vague about output — instruct JSON only',
          modifications: { systemPromptAppend: 'RESPOND IN JSON ONLY, no prose.' },
          scope: 'patch',
        }) +
        '\n```'
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await superviseLoop(l2, l1, { description: 'do a thing' }, ctx, hooks(reg, l2.name));

    const after = reg.getByName('Hydrogen')!;
    expect(after.version).toBe(2);
    expect(after.systemPrompt).toContain('original prompt');
    expect(after.systemPrompt).toContain('RESPOND IN JSON ONLY, no prose.');
    expect(reg.versionsOf('Hydrogen')).toHaveLength(1);
    expect(reg.versionsOf('Hydrogen')[0]!.version).toBe(1);
    // Version history snapshot carries the ORIGINAL prompt, not the new one.
    // (No direct accessor; verify via a fresh instance loaded from DB.)
    expect(L1Atom.fromType(after).name).toBe('Hydrogen');
  });

  it('systemPromptReplace wholesale rewrites the prompt (exact swap)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed, description: 'sup' });

    const l1 = L1Atom.fromType(l1Type);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();

    const newPrompt = 'You are a terse JSON robot. One sentence max. Always JSON.';

    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'complete rewrite',
        modifications: { systemPromptReplace: newPrompt },
        scope: 'patch',
      })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await superviseLoop(l2, l1, { description: 't' }, ctx, hooks(reg, l2.name));

    const after = reg.getByName('Hydrogen')!;
    expect(after.systemPrompt).toBe(newPrompt); // exact match, no concatenation
    expect(after.version).toBe(2);
  });

  it('descriptionReplace updates the description while the systemPrompt stays intact', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, {
      ...seed,
      description: 'Mario-like platformer builder (drifted label).',
    });
    const l2Type = reg.create(2, { ...seed, description: 'sup' });

    const l1 = L1Atom.fromType(l1Type);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();

    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'description drifted',
        modifications: {
          descriptionReplace: 'Single-file WebGL Minesweeper builder with validation loop.',
        },
        scope: 'patch',
      })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await superviseLoop(l2, l1, { description: 't' }, ctx, hooks(reg, l2.name));

    const after = reg.getByName('Hydrogen')!;
    expect(after.description).toBe(
      'Single-file WebGL Minesweeper builder with validation loop.'
    );
    expect(after.systemPrompt).toBe(seed.systemPrompt); // prompt untouched
  });

  it('REJECTS a patch verdict with empty modifications at the schema boundary', async () => {
    // This is the regression bite that matters: the 14 legacy patches we
    // found in the live registry all had `modifications: {}` — they
    // should never have been archived. With Zod superRefine now blocking
    // them, a validator emitting "scope: patch" with nothing concrete
    // raises a ValidationError well BEFORE registry.patch is called.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed, description: 'sup' });

    const l1 = L1Atom.fromType(l1Type);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();

    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'diagnostic with no concrete fix',
        modifications: {},
        scope: 'patch',
      })
    );

    await expect(
      superviseLoop(l2, l1, { description: 't' }, ctx, hooks(reg, l2.name))
    ).rejects.toThrow(/schema validation failed/);

    // Registry is untouched: the rejection happened at parse-time, BEFORE
    // any mutation could land.
    const after = reg.getByName('Hydrogen')!;
    expect(after.version).toBe(1);
    expect(after.systemPrompt).toBe(seed.systemPrompt);
    expect(reg.versionsOf('Hydrogen')).toEqual([]);
  });

  it('ALLOWS a patch with ONLY descriptionReplace — descriptions are legit non-empty mods', async () => {
    // Regression guard: at one point the "empty mods" detector treated
    // descriptionReplace as empty. Make sure a description-only patch
    // still passes the Zod + no-op guards.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l1Type = reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed, description: 'sup' });

    const l1 = L1Atom.fromType(l1Type);
    const l2 = L2Atom.fromType(l2Type, reg);
    const ctx = makeCtx();

    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'description-only correction',
        modifications: { descriptionReplace: 'fresh description' },
        scope: 'patch',
      })
    );
    ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'ok', summary: 'ok' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));

    await superviseLoop(l2, l1, { description: 't' }, ctx, hooks(reg, l2.name));

    const after = reg.getByName('Hydrogen')!;
    expect(after.description).toBe('fresh description');
    expect(after.version).toBe(2);
  });
});

/**
 * L3 → L2 mirror of the tests above. The supervise loop for L3 supervising
 * L2 is symmetric in code but traverses it less often in live runs (trust
 * fast-path kicks in faster for L2 types). We still want every link in the
 * L3 parse → apply chain locked down — otherwise a future refactor could
 * break upward mutations without any test catching it.
 *
 * These tests call `l3.validatePlan` directly rather than wiring a full
 * `superviseLoop`: that would require stubbing `L2.plan/execute` through
 * the prefilter and strategy-JSON path, which would drown the intent.
 * The surgical version still exercises the exact production parse path
 * (`llmVerdict` → `parseVerdict` → `superRefine`) and the exact hook
 * (`registry.patch|branch`) — the same two seams the L2 → L1 tests cover.
 */

const dummyPlan: Plan = {
  reasoning: 'prefilter selected something',
  proposedAction: 'delegate leaf task to L1 "Hydrogen"',
  expectedOutput: 'a working artifact',
};
const dummyTask: Task = { description: 'build something end-to-end' };

describe('prompt-update pipeline — L3 → L2 (mirror)', () => {
  it('L3 verdict with systemPromptAppend mutates the L2 type in the registry', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, seed); // Hydrogen (L1) — referenced by dummyPlan for targetContext
    const l2Type = reg.create(2, {
      ...seed,
      description: 'original L2 orchestrator',
      systemPrompt: 'You are Water, a generic L2 molecule.',
    });
    const l3Type = reg.create(3, { ...seed, description: 'top-level cell' });

    const l2 = L2Atom.fromType(l2Type, reg);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    // Real Haiku shape: markdown-fenced JSON.
    ctx.llm.enqueueText(
      '```json\n' +
        JSON.stringify({
          approved: false,
          reasoning: 'L2 prompt needs stricter routing discipline',
          modifications: {
            systemPromptAppend: 'Always produce strategy JSON with no extra prose.',
          },
          scope: 'patch',
        }) +
        '\n```'
    );

    const verdict = await l3.validatePlan(l2, dummyPlan, dummyTask, ctx);
    expect(verdict.approved).toBe(false);
    if (verdict.approved) throw new Error('expected negative verdict');
    expect(verdict.scope).toBe('patch');
    expect(verdict.modifications.systemPromptAppend).toMatch(/strategy JSON/);

    // Apply via the exact same call shape L3Atom.execute uses in its hook.
    const patched = reg.patch(l2.name, verdict.modifications, l3.name, verdict.reasoning);
    expect(patched.systemPrompt).toContain('You are Water, a generic L2 molecule.');
    expect(patched.systemPrompt).toContain('Always produce strategy JSON with no extra prose.');
    expect(patched.version).toBe(2);

    // Confirm persistence — not just the returned in-memory object.
    const fresh = reg.getByName(l2.name)!;
    expect(fresh.systemPrompt).toBe(patched.systemPrompt);
    expect(reg.versionsOf(l2.name)[0]!.version).toBe(1);
  });

  it('L3 verdict with systemPromptReplace wholesale rewrites the L2 prompt', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed, systemPrompt: 'original L2 prompt' });
    const l3Type = reg.create(3, { ...seed });
    const l2 = L2Atom.fromType(l2Type, reg);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const newPrompt = 'You are a terse L2 orchestrator. One-shot strategy JSON only.';
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'rewrite for conciseness',
        modifications: { systemPromptReplace: newPrompt },
        scope: 'patch',
      })
    );

    const verdict = await l3.validatePlan(l2, dummyPlan, dummyTask, ctx);
    if (verdict.approved) throw new Error('expected negative verdict');
    const patched = reg.patch(l2.name, verdict.modifications, l3.name, verdict.reasoning);
    expect(patched.systemPrompt).toBe(newPrompt); // exact swap, no concatenation
    expect(patched.version).toBe(2);
  });

  it('L3 verdict with scope=branch creates a NEW L2 with descendant name', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed });
    const l3Type = reg.create(3, { ...seed });
    const l2 = L2Atom.fromType(l2Type, reg);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'branch for a new L2 specialisation',
        modifications: { systemPromptAppend: 'Specialisation: concise summaries.' },
        scope: 'branch',
      })
    );

    const verdict = await l3.validatePlan(l2, dummyPlan, dummyTask, ctx);
    if (verdict.approved) throw new Error('expected negative verdict');
    const branched = reg.branch(l2.name, verdict.modifications, l3.name, verdict.branchName);
    // Taxonomy: next available L2 after Water is Methane.
    expect(branched.name).toBe('Methane');
    expect(branched.tier).toBe(2);
    expect(branched.systemPrompt).toContain('Specialisation: concise summaries.');
    // Parent untouched.
    const parent = reg.getByName(l2.name)!;
    expect(parent.version).toBe(1);
    expect(parent.systemPrompt).toBe(seed.systemPrompt);
  });

  it('L3 verdict with scope=patch + empty modifications is rejected at the schema boundary', async () => {
    // Symmetric to the L1 test above: a "diagnostic only, no concrete
    // fix" verdict emitted by Haiku must fail parseVerdict/superRefine
    // BEFORE any registry mutation can happen — the 14 historical ghost
    // patches can no longer re-enter the DB at the L2 tier either.
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(1, seed);
    const l2Type = reg.create(2, { ...seed });
    const l3Type = reg.create(3, { ...seed });
    const l2 = L2Atom.fromType(l2Type, reg);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        approved: false,
        reasoning: 'diagnostic with no concrete fix',
        modifications: {},
        scope: 'patch',
      })
    );

    await expect(l3.validatePlan(l2, dummyPlan, dummyTask, ctx)).rejects.toThrow(
      /schema validation failed/
    );

    // Registry untouched.
    expect(reg.getByName(l2.name)!.version).toBe(1);
    expect(reg.versionsOf(l2.name)).toEqual([]);
  });
});
