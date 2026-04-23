import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from '../src/core/models.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Regression test for the L3.prefilter L1-affinity enrichment.
 *
 * Without the enrichment, L3.prefilter's catalog view showed only each
 * L2's own description. A task requiring file-scribe L1 work
 * ("Node library + README + tests") escalated because no L2
 * description mentioned file-scribe capability — forcing a full
 * Opus plan call (~$0.12/run) just to conclude "route to Methane,
 * its L1 children include the file scribe anyway".
 *
 * Fix: when building the prefilter catalog, each L2 description is
 * suffixed with "(dispatches leaves to: <child names + short
 * descriptions>)" so Haiku sees the L1 affinities and can match
 * multi-bucket tasks without escalating.
 */

const seed = {
  description: 'root cell',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

/**
 * Extract the multi-line block of a single L2 catalog entry from the
 * prefilter userContent. The catalog is rendered as
 *   - <Name>: <base>\n    REACHABLE L1 CHILDREN ...\n      - <child>\n ...
 * so we slice from the first occurrence of "- <Name>:" to the next
 * line starting with "  - " (next catalog entry) or the next empty
 * line (end of catalog section).
 */
function extractCatalogBlock(userContent: string, l2Name: string): string {
  const lines = userContent.split('\n');
  const startIdx = lines.findIndex((l) => l.trimStart().startsWith(`- ${l2Name}:`));
  if (startIdx < 0) return '';
  const block: string[] = [lines[startIdx]!];
  // Catalog items are indented by exactly 2 spaces ("  - Name: ...");
  // child items inside a REACHABLE L1 CHILDREN block use 6 spaces
  // ("      - Child: ..."). We stop ONLY at the next 2-space catalog
  // entry or an empty separator, so the nested child lines are
  // captured in the block.
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^ {2}- \w+:/.test(line)) break;
    if (line.trim() === '') break;
    block.push(line);
  }
  return block.join('\n');
}

function seedRegistry() {
  const reg = new AtomRegistry(openDb(':memory:'));
  const l3 = reg.create(3, seed);
  // Two L2 orchestrators with distinct descriptions.
  reg.create(2, {
    ...seed,
    description: 'single-file web artefact orchestrator',
    createdBy: 'bootstrap-canonical',
  });
  reg.create(2, {
    ...seed,
    description: 'Node HTTP server orchestrator',
    createdBy: 'bootstrap-canonical-http',
  });
  // Three canonical L1s seeded with the markers the enrichment recognises.
  reg.create(1, {
    ...seed,
    description: 'single-file web artefact builder: writes index.html, serves, validates',
    createdBy: 'bootstrap-canonical',
  });
  reg.create(1, {
    ...seed,
    description: 'Node HTTP server builder: writes server code, boots node, probes endpoints',
    createdBy: 'bootstrap-canonical-http',
  });
  reg.create(1, {
    ...seed,
    description: 'file scribe: reads, writes, and lists workspace files',
    createdBy: 'bootstrap-canonical-filescribe',
  });
  return { reg, l3Type: l3 };
}

describe('L3.plan prefilter catalog — L1 affinity enrichment (#X)', () => {
  it('appends each L2 description with its L1 children (canonical L1s reachable via that L2)', async () => {
    const { reg, l3Type } = seedRegistry();
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    // Mock Haiku's response — the content doesn't matter, we're inspecting
    // the userContent the client received.
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Methane',
        confidence: 'high',
        reasoning: 'test',
      })
    );
    await l3.plan({ description: 'some task' }, ctx);

    const prefilterCall = ctx.llm.calls[0]!;
    const user = prefilterCall.userContent;

    // Each L2 catalog line carries a REACHABLE L1 CHILDREN block on its own line.
    expect(user).toMatch(/REACHABLE L1 CHILDREN/);
    // The block appears once per L2 (Water + Methane).
    const occurrences = (user.match(/REACHABLE L1 CHILDREN/g) ?? []).length;
    expect(occurrences).toBe(2);

    // Both L2s see all three canonical L1s (canonicals are reachable
    // from any L2 via tier-1 prefilter).
    expect(user).toContain('Hydrogen');
    expect(user).toContain('Helium');
    expect(user).toContain('Lithium');
  });

  it('also includes L1s dynamically created by a specific L2 (createdBy link)', async () => {
    const { reg, l3Type } = seedRegistry();
    // Simulate a past run where Methane dynamically created a custom L1.
    reg.create(1, {
      ...seed,
      description: 'bespoke JWT handler for the auth flow',
      createdBy: 'Methane',
    });

    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Methane',
        confidence: 'high',
        reasoning: 'test',
      })
    );
    await l3.plan({ description: 'some task' }, ctx);

    const user = ctx.llm.calls[0]!.userContent;
    // The block is now multi-line: extract the Methane block (from the
    // "Methane:" line down to the next catalog entry's "- " line) and
    // assert the custom L1 appears in it.
    const methaneBlock = extractCatalogBlock(user, 'Methane');
    expect(methaneBlock).toMatch(/bespoke JWT handler/);
    // Water's block should NOT list the Methane-owned custom child.
    const waterBlock = extractCatalogBlock(user, 'Water');
    expect(waterBlock).not.toMatch(/bespoke JWT handler/);
  });

  it('emits a bare L2 description (no dispatches tail) when the registry has no L1s yet', async () => {
    // Fresh registry with only L3 and L2s, no L1 canonicals.
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    reg.create(2, { ...seed, description: 'orchestrator', createdBy: 'bootstrap-canonical' });
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Water',
        confidence: 'high',
        reasoning: 'test',
      })
    );
    await l3.plan({ description: 't' }, ctx);
    const user = ctx.llm.calls[0]!.userContent;
    expect(user).toMatch(/Water: orchestrator/);
    expect(user).not.toMatch(/dispatches leaves to:/);
  });
});
