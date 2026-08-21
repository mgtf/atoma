import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendLedger,
  closeLedgerHandles,
  ledgerDbPath,
  projectCounters,
  readLedger,
  readLedgerTail,
} from '../src/core/ledger.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

/**
 * P2 stage 1 — the lifecycle ledger, now a `lifecycle_events` table inside
 * the store. The mutable counters stay authoritative; the ledger records
 * every mutation from the storage choke points so `ledger check` can flag the
 * IMPOSSIBLE direction (store counter below the ledger's projection = a write
 * path bypassed the choke points).
 */
describe('lifecycle ledger', () => {
  let dir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-ledger-'));
    envBefore = process.env['ATOMA_LEDGER_DB'];
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'store.db');
    closeLedgerHandles();
  });
  afterEach(() => {
    closeLedgerHandles();
    if (envBefore === undefined) delete process.env['ATOMA_LEDGER_DB'];
    else process.env['ATOMA_LEDGER_DB'] = envBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a bounded newest-first tail without materialising the table', () => {
    // The admin journal and `ledger tail` only DISPLAY recent activity; they
    // must not pay for the full-history load `projectCounters` needs.
    for (let index = 0; index < 12; index++) {
      appendLedger({ kind: 'type-success', entity: `Atom${index}` });
    }
    expect(readLedgerTail(3).map((event) => event.entity)).toEqual([
      'Atom11',
      'Atom10',
      'Atom9',
    ]);
    // Out-of-range limits clamp rather than throwing or reading everything.
    expect(readLedgerTail(0)).toHaveLength(1);
    expect(readLedgerTail(-5)).toHaveLength(1);
    expect(readLedgerTail(50_000)).toHaveLength(12);
    // Fail-open: a store with no ledger table reads empty, never throws.
    closeLedgerHandles();
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'absent-dir', 'store.db');
    expect(readLedgerTail(5)).toEqual([]);
  });

  it('append + read round-trips in append order', () => {
    appendLedger({ kind: 'type-success', entity: 'Water' });
    appendLedger({ kind: 'type-failure', entity: 'Water' });
    const events = readLedger();
    expect(events.map((e) => e.kind)).toEqual(['type-success', 'type-failure']);
    expect(events[0]!.at).toBeTruthy();
  });

  it('preserves order for events sharing a millisecond', () => {
    // `at` has millisecond resolution and bursts are normal, so ordering by
    // timestamp is ambiguous exactly where `projectCounters` is
    // order-sensitive: a `counters-reset` replayed one position early or late
    // changes the result. The autoincrement rowid is what carries append
    // order now that file order is gone.
    appendLedger({ kind: 'type-success', entity: 'X' });
    appendLedger({ kind: 'counters-reset', entity: 'X', detail: { reason: 'patch' } });
    appendLedger({ kind: 'type-success', entity: 'X' });
    const evs = readLedger();
    expect(new Set(evs.map((e) => e.at)).size).toBeLessThanOrEqual(evs.length);
    expect(evs.map((e) => e.kind)).toEqual(['type-success', 'counters-reset', 'type-success']);
    expect(projectCounters(evs).get('X')!.successes).toBe(1);
  });

  it('SkillRegistry mutations flow through: bump, promote (reset), demote', () => {
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.save('Water', { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    skills.recordSuccess('Water', 's');
    skills.recordSuccess('Water', 's');
    skills.promoteToScript({
      l1Name: 'Water', skillId: 's', language: 'node',
      scriptBody: 'x', compiledGeneration: 'g1',
    });
    skills.recordSuccess('Water', 's');
    const projected = projectCounters(readLedger()).get('Water/s')!;
    const live = skills.loadFor('Water')[0]!;
    // Projection matches the store exactly: 2✓ erased by promotion, then 1✓.
    expect(projected.successes).toBe(live.successes);
    expect(projected.successes).toBe(1);
    const kinds = readLedger().map((e) => e.kind);
    expect(kinds).toContain('skill-save');
    expect(kinds).toContain('promote');
  });

  it('a bump that does NOT move a counter writes no event', () => {
    // The ledger-before-store window: `bump` no-ops when there is no
    // SKILL.md, so appending first produced store < ledger — the direction
    // `check` reports as IMPOSSIBLE, i.e. as proof of a bypassed choke point.
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.recordSuccess('Water', 'never-existed');
    skills.recordFailure('Water', 'never-existed');
    expect(readLedger()).toHaveLength(0);
  });

  it('AtomRegistry counter bumps and patch-resets are recorded and project correctly', () => {
    const db = openDb(':memory:');
    const reg = new AtomRegistry(db);
    const t = reg.create(1, {
      description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
    });
    reg.recordSuccess(t.name);
    reg.recordSuccess(t.name);
    reg.recordFailure(t.name);
    reg.patch(t.name, { systemPromptAppend: 'more' }, 'test', 'why');
    reg.recordSuccess(t.name);
    const projected = projectCounters(readLedger(db)).get(t.name)!;
    const live = reg.getByName(t.name)!;
    expect(projected.successes).toBe(live.successes);
    expect(projected.failures).toBe(live.failures);
    expect(projected.successes).toBe(1);
    expect(projected.failures).toBe(0);
  });

  it('counter compensation removes false trust and stays ledger-exact', () => {
    const db = openDb(':memory:');
    const reg = new AtomRegistry(db);
    const t = reg.create(1, {
      description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
    });
    reg.recordSuccess(t.name);
    reg.recordSuccess(t.name);
    const corrected = reg.compensateCounters(t.name, {
      successes: -1,
      reason: 'provider experiment approved narrative with zero tool actions',
    });

    expect(corrected.successes).toBe(1);
    expect(projectCounters(readLedger(db)).get(t.name)).toEqual({
      successes: 1,
      failures: 0,
    });
    expect(readLedger(db).at(-1)).toMatchObject({
      kind: 'type-counter-compensation',
      entity: t.name,
      detail: { successes: -1 },
    });
    expect(() =>
      reg.compensateCounters(t.name, { successes: 1, reason: 'inflate' })
    ).toThrow(/negative integer delta/);
  });

  it('an in-memory registry cannot reach the configured store — the incident, structurally closed', () => {
    // Two throwaway `tsx` scripts once opened `:memory:` registries, bumped
    // `Methane`, and left `ledger check` reporting `IMPOSSIBLE  Methane:
    // store 2 < ledger 6` permanently. It was a guard (`ledgerWritesAllowed`);
    // now the registry writes through its OWN handle, so there is nothing to
    // guard — the events have nowhere else to go.
    const db = openDb(':memory:');
    const reg = new AtomRegistry(db);
    const t = reg.create(1, {
      description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
    });
    reg.recordSuccess(t.name);
    expect(readLedger(db)).toHaveLength(1);
    expect(readLedger()).toHaveLength(0); // the configured store is untouched
  });

  it('mergeInto records the counters it moves — the projection stays exact', () => {
    // `mergeInto` adds the losers' totals to the winner and deletes their
    // rows. Before it emitted an event the winner simply grew, which `check`
    // classifies as benign `store > ledger` drift: a counter mutation the
    // integrity checker was structurally blind to.
    const db = openDb(':memory:');
    const reg = new AtomRegistry(db);
    const keep = reg.create(1, {
      description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
    });
    const gone = reg.create(1, {
      description: 'y', systemPrompt: 'q', tools: [], params: {}, createdBy: 'test',
    });
    reg.recordSuccess(keep.name);
    reg.recordSuccess(gone.name);
    reg.recordSuccess(gone.name);
    reg.recordFailure(gone.name);
    reg.mergeInto(keep.name, [gone.name]);
    const live = reg.getByName(keep.name)!;
    const projected = projectCounters(readLedger(db)).get(keep.name)!;
    expect(live.successes).toBe(3);
    expect(projected.successes).toBe(live.successes);
    expect(projected.failures).toBe(live.failures);
  });

  it('an event written on the store handle ROLLS BACK with its transaction', () => {
    // The guarantee that makes `recordSuccess` honest: the counter and its
    // event are one write. Appending to a separate file meant a failed
    // `patch` left a phantom `counters-reset` (ledger > store) and a crash
    // between the append and the UPDATE left store < ledger — the direction
    // `check` reports as proof that a write path bypassed the choke points.
    // This is what a future "helpful" move of the append back out of the
    // handle would break, silently.
    const db = openDb(':memory:');
    expect(() =>
      db.transaction(() => {
        appendLedger({ kind: 'type-success', entity: 'Doomed' }, db);
        throw new Error('the write failed after the event was recorded');
      })()
    ).toThrow(/the write failed/);
    expect(readLedger(db)).toHaveLength(0);
  });

  it('a broken ledger target never takes down the caller (fail-open)', () => {
    closeLedgerHandles();
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'nope', '\0bad', 'x.db');
    expect(() => appendLedger({ kind: 'type-success', entity: 'H' })).not.toThrow();
    expect(ledgerDbPath()).toContain('nope');
  });
});
