import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * L3's truncation default for `aggregation`.
 *
 * `planSchema` defaults a missing `aggregation` to `concat` as an
 * anti-truncation net. That is right at L2 (concat is a legitimate L2
 * mode) and WRONG at L3: measured over every analysable archived L3 plan,
 * 83/83 emitted `sequential`, and `concat` fans the phases out through
 * Promise.all over a SHARED workspace while dropping the
 * previousStepSummary threading. A missing field means a truncated
 * response — the moment we know least — so the fallback must be the
 * low-blast-radius mode. Found while measuring the (rejected) plan-
 * templating proposal; defence in depth on a path never yet exercised
 * (zero truncations observed in the corpus).
 */

function seedRegistry(): AtomRegistry {
  const reg = new AtomRegistry(openDb(':memory:'));
  reg.create(3, { description: 'cell', systemPrompt: 'l3', tools: [], params: {}, createdBy: 't' });
  reg.create(2, { description: 'molecule', systemPrompt: 'l2', tools: [], params: {}, createdBy: 't' });
  return reg;
}

describe('L3.plan — aggregation truncation default', () => {
  it('degrades a MISSING aggregation to sequential, not to the shared concat default', async () => {
    const reg = seedRegistry();
    const l3 = L3Atom.buildWithModel(reg.getByName('Neuron')!, reg, 'claude-opus-5');
    const ctx = makeCtx();
    // Tier prefilter (L3 always defers to the Opus plan, carrying the hint).
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    // Opus plan pair with NO `aggregation` key — the truncated shape.
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'r' },
        { reasoning: 'r', subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }] }
      )
    );
    const plan = await l3.plan({ description: 'a phased build' }, ctx);
    expect(plan.aggregation?.mode).toBe('sequential');
  });

  it('honours an EXPLICIT concat — the degradation must not override intent', async () => {
    const reg = seedRegistry();
    const l3 = L3Atom.buildWithModel(reg.getByName('Neuron')!, reg, 'claude-opus-5');
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'r' },
        {
          reasoning: 'r',
          subtasks: [{ description: 'scrape A' }, { description: 'scrape B' }],
          aggregation: { mode: 'concat' },
        }
      )
    );
    const plan = await l3.plan({ description: 'two orthogonal scrapes' }, ctx);
    expect(plan.aggregation?.mode).toBe('concat');
  });

  it('L2 keeps the SHARED concat default — the change is L3-only', async () => {
    const reg = seedRegistry();
    reg.create(1, { description: 'leaf', systemPrompt: 'l1', tools: [], params: {}, createdBy: 't' });
    const l2 = L2Atom.fromType(reg.getByName('Water')!, reg, []);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no clear match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Hydrogen', reasoning: 'r' },
        { reasoning: 'r', subtasks: [{ description: 'leaf work' }] }
      )
    );
    const plan = await l2.plan({ description: 'a leaf task' }, ctx);
    expect(plan.aggregation?.mode).toBe('concat');
  });
});
