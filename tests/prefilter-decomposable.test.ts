import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { STRATEGY_MAX_TOKENS } from '../src/atoms/cost.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

const seed = {
  description: 'generic',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('prefilter decomposable hint', () => {
  it('L2.plan: decomposable=false → existing short-circuit (single-subtask, no Sonnet call)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'file scribe' });
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'high',
        decomposable: false,
        reasoning: 'atomic task',
      })
    );

    const plan = await l2.plan({ description: 'write a single file' }, ctx);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0]!.preferredChild).toBe('Hydrogen');
    // Prefilter only — no Sonnet call.
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('L2.plan: decomposable=true → falls through to Sonnet plan WITH the hint in userContent', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'file scribe' });
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);

    const ctx = makeCtx();
    // Prefilter: reuse Hydrogen, decomposable
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Hydrogen',
        confidence: 'high',
        decomposable: true,
        reasoning: 'multi-artefact task',
      })
    );
    // Sonnet plan: two subtasks, both preferring Hydrogen
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'use Hydrogen' },
        {
          reasoning: 'decomposed',
          subtasks: [
            { description: 'write package.json', preferredChild: 'Hydrogen' },
            { description: 'write index.js', preferredChild: 'Hydrogen' },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'both files',
        }
      )
    );

    const plan = await l2.plan(
      { description: 'create package.json AND index.js' },
      ctx
    );
    // Both prefilter + Sonnet were called.
    expect(ctx.llm.calls).toHaveLength(2);
    // Sonnet call was the full plan call (capped to STRATEGY_MAX_TOKENS).
    const sonnetCall = ctx.llm.calls[1]!;
    expect(sonnetCall.params?.maxTokens).toBe(STRATEGY_MAX_TOKENS);
    // Sonnet saw the hint in userContent.
    expect(sonnetCall.userContent).toContain('== PREFILTER HINT ==');
    expect(sonnetCall.userContent).toContain('Hydrogen');
    expect(sonnetCall.userContent).toContain('decomposable');
    // Plan came back with the two subtasks Sonnet emitted.
    expect(plan.subtasks).toHaveLength(2);
  });

  it('L2.plan: decomposable=true but catalog empty → no prefilter, full plan path unchanged', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonTextPair(
        {
          strategy: 'create',
          seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} },
          reasoning: 'r',
        },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );

    await l2.plan({ description: 't' }, ctx);
    // Only the Sonnet plan call ran — no prefilter (empty L1 catalog), no hint.
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('== PREFILTER HINT ==');
  });

  it('L3.plan: decomposable=true → falls through to Opus plan WITH the hint', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    reg.create(2, { ...seed, description: 'single-file web artefact orchestrator' });
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Water',
        confidence: 'high',
        decomposable: true,
        reasoning: 'multi-phase build',
      })
    );
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'use Water' },
        {
          reasoning: 'split server and client',
          subtasks: [
            { description: 'server', preferredChild: 'Water' },
            { description: 'client', preferredChild: 'Water' },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'both',
        }
      )
    );

    const plan = await l3.plan(
      { description: 'build a server AND a client' },
      ctx
    );
    expect(ctx.llm.calls).toHaveLength(2);
    const opusCall = ctx.llm.calls[1]!;
    expect(opusCall.userContent).toContain('== PREFILTER HINT ==');
    expect(opusCall.userContent).toContain('Water');
    expect(plan.subtasks).toHaveLength(2);
  });

  it('L3.plan: ALWAYS falls through to Opus, regardless of decomposable flag', async () => {
    // L3 deliberately gives up the skeletal-plan shortcut that L2 keeps:
    // even when the prefilter says "reuse + non-decomposable", L3 still
    // runs the Opus plan, with the target carried forward as a routing
    // hint. The framework's value at the top tier is decomposition
    // reasoning — collapsing that to a 1-subtask routing decision wastes
    // the tier and produced visibly broken Pong-type runs (one big L2
    // delegation, no phase-by-phase smoke).
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    reg.create(2, { ...seed, description: 'orchestrator' });
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Water',
        confidence: 'high',
        // decomposable omitted: would have short-circuited under the
        // old contract; under the new contract L3 still calls Opus.
        reasoning: 'atomic',
      })
    );
    // Opus plan call follows.
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'use Water' },
        {
          reasoning: 'opus plan',
          subtasks: [
            { description: 'whole task', preferredChild: 'Water' },
          ],
          aggregation: { mode: 'concat' },
          expectedOutput: 'done',
        }
      )
    );

    const plan = await l3.plan({ description: 'single artefact' }, ctx);
    // 2 calls now: prefilter + Opus plan. The shortcut is gone.
    expect(ctx.llm.calls).toHaveLength(2);
    // The Opus call must have received the prefilter hint in its userContent.
    expect(ctx.llm.calls[1]!.userContent).toContain('== PREFILTER HINT ==');
    expect(ctx.llm.calls[1]!.userContent).toContain('Water');
    // And no `viaPrefilter` flag — only the L2 skeletal shortcut sets that.
    expect(plan).not.toHaveProperty('viaPrefilter');
    expect(plan.subtasks).toHaveLength(1);
  });
});
