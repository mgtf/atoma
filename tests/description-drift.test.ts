import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Regression tests for the "description drift" fix:
 * 1. `branch` must not accumulate "(branched from X) (branched from Y) ..."
 *    chains in the persisted description.
 * 2. The prefilter catalog given to Haiku must show the core description
 *    WITHOUT the (branched from X) tail — that noise confuses the model
 *    and bloats the prompt.
 * 3. `patch` with `descriptionReplace` must update the canonical
 *    description so validators can heal drifted types at runtime.
 */

const l2Seed = {
  description: 'orchestrates WebGL game builds',
  systemPrompt: 'l2 sys',
  tools: [],
  params: { temperature: 0.2, maxTokens: 1024 },
  createdBy: 'test',
};

const l1Seed = {
  description: 'builds a single-file WebGL Mario-like platformer',
  systemPrompt: 'l1 sys',
  tools: [],
  params: { temperature: 0.2, maxTokens: 1024 },
  createdBy: 'test',
};

describe('description drift — branch + prefilter', () => {
  it('branch-of-branch does not pile up (branched from X) suffixes', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, l1Seed);
    const a = r.branch('Hydrogen', { systemPromptAppend: 'a' }, 't', 'A');
    const b = r.branch('A', { systemPromptAppend: 'b' }, 't', 'B');
    const c = r.branch('B', { systemPromptAppend: 'c' }, 't', 'C');
    // Each descendant carries EXACTLY one "(branched from <parent>)" tail.
    for (const atom of [a, b, c]) {
      const matches = atom.description.match(/\(branched from [^)]+\)/g) ?? [];
      expect(matches.length).toBe(1);
    }
    expect(c.description).toBe(
      'builds a single-file WebGL Mario-like platformer (branched from B)'
    );
  });

  it('prefilter sees core descriptions only — provenance tail stripped', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(2, l2Seed);
    r.create(1, l1Seed); // Hydrogen
    // Chain-branch to produce a long provenance tail on the persisted description.
    r.branch('Hydrogen', { systemPromptAppend: 'a' }, 't', 'A');
    r.branch('A', { systemPromptAppend: 'b' }, 't', 'B');
    const b = r.getByName('B')!;
    // Pre-condition: the persisted description DOES carry a provenance tail.
    expect(b.description).toMatch(/\(branched from /);

    const l2 = L2Atom.fromType(r.getByName('Water')!, r);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'B', confidence: 'high', reasoning: 'match' })
    );
    await l2.plan({ description: 'build a game' }, ctx);

    // The prefilter userContent is the first call; catalog lines must NOT
    // contain any "(branched from ...)" — those are stripped before Haiku.
    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).toContain('- B:');
    expect(userContent).not.toContain('(branched from');
  });

  it('L3 prefilter also strips provenance from the L2 catalog', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const l3Type = r.create(3, l2Seed);
    r.create(2, l2Seed);
    r.branch('Water', { systemPromptAppend: 'a' }, 't', 'WaterA');
    r.branch('WaterA', { systemPromptAppend: 'b' }, 't', 'WaterB');
    const wb = r.getByName('WaterB')!;
    expect(wb.description).toMatch(/\(branched from /);

    const l3 = L3Atom.buildWithModel(l3Type, r, FALLBACK_OPUS);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'WaterB', confidence: 'high', reasoning: 'match' })
    );
    await l3.plan({ description: 'something' }, ctx);

    const userContent = ctx.llm.calls[0]!.userContent;
    expect(userContent).not.toContain('(branched from');
  });
});
