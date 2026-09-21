import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import { shouldTrustType } from '../src/atoms/cost.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import { FALLBACK_OPUS } from './tier-pins.js';

const seed = { description: 'Reusable worker', systemPrompt: 'Execute the requested work.',
  tools: [], params: {}, createdBy: 'test' };
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('recoverable atom trust', () => {
  it.each([1, 2] as const)('recovers the actual L%s validation fast path after historical failures', async (tier) => {
    const db = openDb(':memory:');
    try {
      const registry = new AtomRegistry(db);
      const type = registry.create(tier, seed);
      const supervisorType = registry.create(tier === 1 ? 2 : 3, seed);
      const supervisor = tier === 1 ? L2Atom.fromType(supervisorType, registry) :
        L3Atom.buildWithModel(supervisorType, registry, FALLBACK_OPUS);
      const child = tier === 1 ? L1Atom.fromType(type) : L2Atom.fromType(type, registry);
      for (let i = 0; i < 11; i++) registry.recordSuccess(type.name);
      for (let i = 0; i < 9; i++) registry.recordFailure(type.name);
      const ctx = makeCtx();
      const validate = () => {
        if (supervisor instanceof L2Atom && child instanceof L1Atom) {
          return supervisor.validatePlan(child, makePlan(), { description: 'inspect' }, ctx);
        }
        if (supervisor instanceof L3Atom && child instanceof L2Atom) {
          return supervisor.validatePlan(child, makePlan(), { description: 'inspect' }, ctx);
        }
        throw new Error('invalid test rank pairing');
      };
      registry.recordSuccess(type.name);
      registry.recordSuccess(type.name);
      ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'reviewed' }));
      await validate();
      expect(ctx.llm.calls).toHaveLength(1);
      registry.recordSuccess(type.name);
      const verdict = await validate();
      expect(verdict.approved).toBe(true);
      expect(verdict.reasoning).toContain('3 consecutive successes');
      expect(ctx.llm.calls).toHaveLength(1);
      expect(registry.getByName(type.name)).toMatchObject({ successes: 14, failures: 9, consecutiveSuccesses: 3 });
      registry.recordFailure(type.name);
      ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'reviewed again' }));
      await validate();
      expect(ctx.llm.calls).toHaveLength(2);
    } finally { db.close(); }
  });

  it('retains history on improvement and rollback, but requires new behavior to earn trust', () => {
    const db = openDb(':memory:');
    try {
      const registry = new AtomRegistry(db);
      const type = registry.create(1, seed);
      registry.recordFailure(type.name);
      for (let i = 0; i < 3; i++) registry.recordSuccess(type.name);
      expect(shouldTrustType(registry.describe(type.name, 'Better capability label'))).toBe(true);
      const patched = registry.patch(type.name, { systemPromptAppend: 'Verify the output.' }, 'reviewer');
      expect(patched).toMatchObject({ atomId: type.atomId, successes: 3, failures: 1, consecutiveSuccesses: 0 });
      expect(shouldTrustType(patched)).toBe(false);
      for (let i = 0; i < 3; i++) registry.recordSuccess(type.name);
      expect(shouldTrustType(registry.getByName(type.name)!)).toBe(true);
      const restored = registry.rollback(type.name, 1);
      expect(restored).toMatchObject({ successes: 6, failures: 1, consecutiveSuccesses: 0 });
      expect(projectCounters(readLedger(db)).get(type.atomId)).toEqual({ successes: 6, failures: 1 });
      expect(readLedger(db).filter((event) => event.kind === 'type-trust-reset')).toHaveLength(2);
    } finally { db.close(); }
  });

  it('never manufactures recent evidence by merging histories or compensating counters', () => {
    const db = openDb(':memory:');
    try {
      const registry = new AtomRegistry(db);
      const first = registry.create(1, seed);
      const second = registry.create(1, seed);
      for (const type of [first, second]) for (let i = 0; i < 3; i++) registry.recordSuccess(type.name);
      const merged = registry.mergeInto(first.name, [second.name]);
      expect(merged).toMatchObject({ successes: 6, failures: 0, consecutiveSuccesses: 0 });
      for (let i = 0; i < 3; i++) registry.recordSuccess(first.name);
      const corrected = registry.compensateCounters(first.name, { successes: -1, reason: 'Invalid observation' });
      expect(shouldTrustType(corrected)).toBe(false);
      expect(projectCounters(readLedger(db)).get(first.atomId)).toEqual({ successes: 8, failures: 0 });
    } finally { db.close(); }
  });

  it('migrates a pre-series file without guessing mixed outcome order and preserves recovery across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-trust-recovery-'));
    directories.push(dir);
    const path = join(dir, 'store.db');
    const old = openDb(path);
    const registry = new AtomRegistry(old);
    const clean = registry.create(1, seed);
    const mixed = registry.create(1, seed);
    for (const type of [clean, mixed]) for (let i = 0; i < 11; i++) registry.recordSuccess(type.name);
    registry.recordFailure(mixed.name);
    old.exec('ALTER TABLE atom_types DROP COLUMN consecutive_successes');
    old.close();
    const migrated = openDb(path);
    try {
      const next = new AtomRegistry(migrated);
      expect(next.getByName(clean.name)).toMatchObject({ successes: 11, failures: 0, consecutiveSuccesses: 11 });
      expect(next.getByName(mixed.name)).toMatchObject({ successes: 11, failures: 1, consecutiveSuccesses: 0 });
      for (let i = 0; i < 3; i++) next.recordSuccess(mixed.name);
    } finally { migrated.close(); }
    const reopened = openDb(path);
    try {
      expect(new AtomRegistry(reopened).getByName(mixed.name)).toMatchObject({ successes: 14, failures: 1, consecutiveSuccesses: 3 });
    } finally { reopened.close(); }
  });
});
