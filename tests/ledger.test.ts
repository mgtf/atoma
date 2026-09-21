import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  LEDGER_SCOPE_COLUMNS,
  appendLedger,
  closeLedgerHandles,
  ledgerDbPath,
  ledgerScope,
  openLedgerHandle,
  projectCounters,
  readLedger,
  readLedgerTail,
  setLedgerScope,
  withLedgerScope,
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

  it('AtomRegistry patches reset trust while historical totals project correctly', () => {
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
    const projected = projectCounters(readLedger(db)).get(t.atomId)!;
    const live = reg.getByName(t.name)!;
    expect(projected.successes).toBe(live.successes);
    expect(projected.failures).toBe(live.failures);
    expect(projected.successes).toBe(3);
    expect(projected.failures).toBe(1);
    expect(live.consecutiveSuccesses).toBe(1);
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
    expect(projectCounters(readLedger(db)).get(t.atomId)).toEqual({
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
    const projected = projectCounters(readLedger(db)).get(keep.atomId)!;
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

/**
 * T7 — every lifecycle event is attributable. The scope columns are additive
 * on a table that stores created before 2026-09-18 carry without them, and
 * the ledger has TWO writable open paths (`openDb` for the registry, the
 * cached `openStoreHandle` for the skill choke points). `appendLedger`
 * swallows its own failure, so a column present on one path and absent on
 * the other is not an error anywhere: it is every event on the other path
 * silently lost. These tests hold both paths to one schema.
 */
describe('scoped lifecycle attribution (T7)', () => {
  let dir: string;
  let envBefore: string | undefined;

  /** A store whose ledger table predates the scope columns, with one row in it. */
  function legacyStore(path: string): void {
    const db = new Database(path);
    db.exec(`CREATE TABLE lifecycle_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL, detail TEXT);
      INSERT INTO lifecycle_events (at, kind, entity, detail) VALUES ('2026-01-01T00:00:00.000Z', 'type-success', 'Ancient', NULL);`);
    db.close();
  }

  function columnsOf(path: string): string[] {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare('PRAGMA table_info(lifecycle_events)').all() as { name: string }[]).map((c) => c.name);
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-ledger-scope-'));
    envBefore = process.env['ATOMA_LEDGER_DB'];
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'store.db');
    closeLedgerHandles();
    setLedgerScope(null);
  });
  afterEach(() => {
    setLedgerScope(null);
    closeLedgerHandles();
    if (envBefore === undefined) delete process.env['ATOMA_LEDGER_DB'];
    else process.env['ATOMA_LEDGER_DB'] = envBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  it('the registry open path migrates a legacy table, and the cached path then appends with scope', () => {
    const path = join(dir, 'store.db');
    legacyStore(path);
    expect(columnsOf(path)).not.toContain('org_id');

    // Path 1: the registry's handle. Its transaction writes the event with
    // the counter, on the migrated table.
    const db = openDb(path);
    expect(columnsOf(path)).toEqual(expect.arrayContaining([...LEDGER_SCOPE_COLUMNS]));
    const reg = new AtomRegistry(db);
    const t = reg.create(1, { description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test' });
    setLedgerScope({ orgId: 'org-a', projectId: 'proj-1', runId: 'run-1', actorType: 'principal', actorId: 'pr-1' });
    reg.recordSuccess(t.name);

    // Path 2: the cached handle the skill choke points use, on the SAME file.
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.save('Water', { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    skills.recordSuccess('Water', 's');

    const events = readLedger(db);
    expect(events.map((e) => e.kind)).toEqual(['type-success', 'type-success', 'skill-save', 'skill-success']);
    // The legacy row reads back as it was written: no scope, not a fabricated one.
    expect(events[0]).toEqual({ at: '2026-01-01T00:00:00.000Z', kind: 'type-success', entity: 'Ancient' });
    // Both paths carried the process scope.
    for (const scoped of events.slice(1)) {
      expect(scoped.scope).toEqual({ orgId: 'org-a', projectId: 'proj-1', runId: 'run-1', actorType: 'principal', actorId: 'pr-1' });
    }
    db.close();
  });

  it('the cached open path migrates a legacy table, and the registry path then appends with scope', () => {
    // The mirror image: the FIRST writable open is the skills side. If only
    // `openDb` migrated, this order would leave the registry's insert
    // naming columns the table has — and the skills side's insert failing
    // silently until the next `openDb` on the file.
    const path = join(dir, 'store.db');
    legacyStore(path);
    setLedgerScope({ actorType: 'cli' });
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.save('Water', { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    expect(columnsOf(path)).toEqual(expect.arrayContaining([...LEDGER_SCOPE_COLUMNS]));

    const db = openDb(path);
    const reg = new AtomRegistry(db);
    const t = reg.create(1, { description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test' });
    reg.recordFailure(t.name);
    const events = readLedger(db);
    expect(events.map((e) => e.kind)).toEqual(['type-success', 'skill-save', 'type-failure']);
    expect(events[1]!.scope).toEqual({ actorType: 'cli' });
    expect(events[2]!.scope).toEqual({ actorType: 'cli' });
    db.close();
  });

  it('a read-only reader on an unmigrated store still reads it, without scope', () => {
    // `ledger tail --db <backup snapshot>` and the viz's read-only handles
    // never migrate. Selecting the scope columns there would throw, and the
    // fail-open readers would report an EMPTY ledger — a lie about a store
    // that has 949 rows in it.
    const path = join(dir, 'legacy.db');
    legacyStore(path);
    const ro = new Database(path, { readonly: true });
    try {
      expect(readLedger(ro)).toEqual([{ at: '2026-01-01T00:00:00.000Z', kind: 'type-success', entity: 'Ancient' }]);
      expect(readLedgerTail(5, ro)).toHaveLength(1);
      expect(columnsOf(path)).not.toContain('org_id');
    } finally {
      ro.close();
    }
  });

  it('an event with no scope in a process with no scope writes NULLs, not an invented actor', () => {
    appendLedger({ kind: 'type-success', entity: 'Platform' });
    const [event] = readLedger();
    expect(event).not.toHaveProperty('scope');
    const row = openLedgerHandle(join(dir, 'store.db'))
      .prepare('SELECT org_id, project_id, run_id, actor_type, actor_id FROM lifecycle_events')
      .get() as Record<string, unknown>;
    expect(Object.values(row)).toEqual([null, null, null, null, null]);
  });

  it('withLedgerScope applies to the operation alone, merges over the process scope, and refuses a promise', () => {
    setLedgerScope({ runId: 'run-9', actorType: 'cli' });
    const result = withLedgerScope({ actorType: 'principal', actorId: 'pr-2', orgId: 'org-b' }, () => {
      appendLedger({ kind: 'skill-drop', entity: 'a/b' });
      return 'done';
    });
    expect(result).toBe('done');
    appendLedger({ kind: 'skill-drop', entity: 'a/c' });
    const [inside, after] = readLedger();
    // Inside: the request's actor over the process fields it did not name.
    expect(inside!.scope).toEqual({ runId: 'run-9', actorType: 'principal', actorId: 'pr-2', orgId: 'org-b' });
    // After: the process scope exactly as it was.
    expect(after!.scope).toEqual({ runId: 'run-9', actorType: 'cli' });
    expect(ledgerScope()).toEqual({ runId: 'run-9', actorType: 'cli' });

    // A promise would resolve after the scope was restored: every append in
    // it would carry the wrong actor, silently. Refused, and the scope is
    // still restored.
    expect(() => withLedgerScope({ actorType: 'system' }, () => Promise.resolve(1))).toThrow(/synchronous/);
    expect(ledgerScope()).toEqual({ runId: 'run-9', actorType: 'cli' });
    // An exception inside restores too.
    expect(() => withLedgerScope({ actorType: 'system' }, () => { throw new Error('boom'); })).toThrow(/boom/);
    expect(ledgerScope()).toEqual({ runId: 'run-9', actorType: 'cli' });
  });

  it('type events carry the atom id beside the name, and the projection groups by it (T4)', () => {
    const db = openDb(join(dir, 'store.db'));
    const reg = new AtomRegistry(db);
    const t = reg.create(1, { description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test' });
    reg.recordSuccess(t.name);
    reg.recordFailure(t.name);
    const events = readLedger(db);
    expect(events.map((e) => [e.entity, e.entityId])).toEqual([[t.name, t.atomId], [t.name, t.atomId]]);
    const projected = projectCounters(events);
    expect(projected.get(t.atomId)).toEqual({ successes: 1, failures: 1 });
    expect(projected.has(t.name)).toBe(false);
    // Skill rows: the label already is the stable key.
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.save(t.atomId, { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    expect(readLedger(db).at(-1)).toMatchObject({ entity: `${t.atomId}/s`, entityId: `${t.atomId}/s` });
    db.close();
  });

  it('backfills stable ids from the store as it is now, and leaves unresolvable labels NULL', () => {
    // A store from before the column: type rows keyed by name, skill rows
    // keyed by id (T4) or by name (pre-T4), and one label whose type is gone.
    const path = join(dir, 'store.db');
    const seed = openDb(path);
    const reg = new AtomRegistry(seed);
    const water = reg.create(1, { description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test' });
    seed.exec(`DROP INDEX IF EXISTS idx_lifecycle_entity_id; ALTER TABLE lifecycle_events DROP COLUMN entity_id;
      INSERT INTO lifecycle_events (at, kind, entity) VALUES
        ('2026-01-01T00:00:00.000Z', 'type-success', '${water.name}'),
        ('2026-01-01T00:00:01.000Z', 'type-success', 'Gone'),
        ('2026-01-01T00:00:02.000Z', 'skill-success', '${water.atomId}/s'),
        ('2026-01-01T00:00:03.000Z', 'skill-failure', '${water.name}/legacy')`);
    seed.close();

    const db = openDb(path);
    const events = readLedger(db);
    expect(events.map((e) => e.entityId ?? null)).toEqual([
      water.atomId, null, `${water.atomId}/s`, `${water.atomId}/legacy`,
    ]);
    // Labels are bytes of history: untouched.
    expect(events.map((e) => e.entity)).toEqual([water.name, 'Gone', `${water.atomId}/s`, `${water.name}/legacy`]);
    // The projection now meets the store on the id, and the orphan keeps its own key.
    const projected = projectCounters(events);
    expect(projected.get(water.atomId)).toEqual({ successes: 1, failures: 0 });
    expect(projected.get('Gone')).toEqual({ successes: 1, failures: 0 });
    // Idempotent: a second open changes nothing.
    db.close();
    const again = openDb(path);
    expect(readLedger(again)).toEqual(events);
    again.close();
  });

  it('an event that names its own scope overrides the process scope field by field', () => {
    setLedgerScope({ orgId: 'org-a', runId: 'run-1', actorType: 'principal', actorId: 'pr-1' });
    appendLedger({ kind: 'type-trust-reset', entity: 'Water', scope: { runId: 'run-2' } });
    const [event] = readLedger();
    expect(event!.scope).toEqual({ orgId: 'org-a', runId: 'run-2', actorType: 'principal', actorId: 'pr-1' });
  });
});
