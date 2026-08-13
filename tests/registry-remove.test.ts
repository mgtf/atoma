import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

/**
 * Tests for AtomRegistry.remove — the OPERATOR deletion used by the
 * CLI `remove` command to clean up dynamic-creation debris (the
 * mislabelled clone series the lying kitchen-sink capability label
 * used to spawn). Nothing in the supervise loop calls this.
 */

const seed = {
  description: 'orchestrator',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'SomeParent',
};

describe('AtomRegistry.remove', () => {
  it('removes the type from the live catalog and returns its final state', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const created = reg.create(1, seed);
    reg.patch(created.name, { systemPromptAppend: 'v2' }, 'test');
    reg.patch(created.name, { systemPromptAppend: 'v3' }, 'test');
    expect(reg.getByName(created.name)!.version).toBe(3);

    const removed = reg.remove(created.name);
    expect(removed).not.toBeNull();
    expect(removed!.name).toBe(created.name);
    expect(removed!.version).toBe(3);
    expect(reg.getByName(created.name)).toBeNull();
    expect(reg.listByTier(1)).toHaveLength(0);
  });

  it('returns null for an unknown name (no-op)', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    expect(reg.remove('Ghost')).toBeNull();
  });

  it('does NOT reclaim the taxonomy ordinal — the next create gets a fresh name', () => {
    // Reusing a freed ordinal would let a future atom silently inherit
    // a dead atom's identity in old run traces.
    const reg = new AtomRegistry(openDb(':memory:'));
    const first = reg.create(1, seed); // Water, ordinal 1
    const second = reg.create(1, seed); // Methane, ordinal 2
    reg.remove(first.name);
    const third = reg.create(1, seed);
    expect(third.name).not.toBe(first.name);
    expect(third.ordinal).toBeGreaterThan(second.ordinal);
  });

  it('leaves unrelated types and their histories untouched', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const keep = reg.create(1, seed);
    const drop = reg.create(1, seed);
    reg.patch(keep.name, { systemPromptAppend: 'v2' }, 'test');
    reg.recordSuccess(keep.name);

    reg.remove(drop.name);

    const kept = reg.getByName(keep.name)!;
    expect(kept.version).toBe(2);
    // Patch reset counters, then one success was recorded... order:
    // patch (reset) happened BEFORE recordSuccess, so 1 survives.
    expect(kept.successes).toBe(1);
  });
});
