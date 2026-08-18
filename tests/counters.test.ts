import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

const seed = {
  description: 'seed',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('AtomRegistry success/failure counters', () => {
  it('new types start with zero successes and failures', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const h = r.create(1, seed);
    expect(h.successes).toBe(0);
    expect(h.failures).toBe(0);
    expect(r.getByName('Water')?.successes).toBe(0);
  });

  it('recordSuccess bumps the counter', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, seed);
    r.recordSuccess('Water');
    r.recordSuccess('Water');
    expect(r.getByName('Water')?.successes).toBe(2);
  });

  it('recordFailure bumps the counter independently', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, seed);
    r.recordFailure('Water');
    expect(r.getByName('Water')?.failures).toBe(1);
    expect(r.getByName('Water')?.successes).toBe(0);
  });

  it('patch resets both counters (behaviour has changed — past wins do not carry)', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, seed);
    for (let i = 0; i < 5; i++) r.recordSuccess('Water');
    r.recordFailure('Water');
    expect(r.getByName('Water')?.successes).toBe(5);

    r.patch('Water', { systemPromptReplace: 'new' }, 'tester');

    const after = r.getByName('Water')!;
    expect(after.version).toBe(2);
    expect(after.successes).toBe(0);
    expect(after.failures).toBe(0);
  });

  it('branch produces a fresh type with zeroed counters', () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(1, seed);
    for (let i = 0; i < 4; i++) r.recordSuccess('Water');
    const he = r.branch('Water', { systemPromptAppend: 'x' }, 'tester');
    expect(he.name).toBe('Methane');
    expect(he.successes).toBe(0);
    expect(he.failures).toBe(0);
    // original unaffected
    expect(r.getByName('Water')?.successes).toBe(4);
  });
});
