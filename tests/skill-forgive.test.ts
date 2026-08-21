import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from '../src/skills/registry.js';
import {
  closeLedgerHandles,
  projectCounters,
  readLedger,
  type LedgerEvent,
} from '../src/core/ledger.js';

/**
 * `skills forgive` — surgical retraction of MISATTRIBUTED counter increments.
 *
 * MEASURED 2026-08-21 (burn-in session record): `build-inline-html-widget`
 * stood at 7✓/2✗ where both failures came from a run killed by its
 * wall-clock budget — an environment failure, which AGENTS says is "not
 * evidence against the recipe". With failures > 0 the recipe could never
 * become promotion-eligible again, and the only operator surface was the
 * all-or-nothing `reset`: erasing 2 wrong failures cost 7 right successes.
 *
 * The op mirrors `AtomRegistry.compensateCounters` (negative integer deltas,
 * mandatory reason, floor at zero) and emits `skill-counter-compensation`,
 * which `projectCounters` folds in — so `ledger check` stays exact instead
 * of flagging the store as impossibly below the ledger.
 */
describe('SkillRegistry.compensateCounters (skills forgive)', () => {
  let dir: string;
  let reg: SkillRegistry;

  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-forgive-'));
    // A REAL ledger db for this suite: the op's whole point is the audit row,
    // and the review found the original write-then-append ordering could
    // claim a row that was never written.
    envBefore = process.env['ATOMA_LEDGER_DB'];
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'ledger.db');
    closeLedgerHandles();
    reg = new SkillRegistry(dir);
    reg.save('Water', {
      id: 'widget',
      description: 'd',
      whenToUse: 'w',
      kind: 'llm',
      body: 'b',
    });
    for (let i = 0; i < 7; i++) reg.recordSuccess('Water', 'widget');
    reg.recordFailure('Water', 'widget');
    reg.recordFailure('Water', 'widget');
  });
  afterEach(() => {
    closeLedgerHandles();
    if (envBefore === undefined) delete process.env['ATOMA_LEDGER_DB'];
    else process.env['ATOMA_LEDGER_DB'] = envBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  const counters = (): { s: number; f: number } => {
    const sk = reg.loadFor('Water').find((x) => x.id === 'widget')!;
    return { s: sk.successes, f: sk.failures };
  };

  it('removes the misattributed failures and keeps every earned success', () => {
    const meta = reg.compensateCounters('Water', 'widget', {
      failures: -2,
      reason: 'both failures came from a budget-killed run — environment, not the recipe',
    });
    expect(meta).not.toBeNull();
    expect(meta!.successes).toBe(7);
    expect(meta!.failures).toBe(0);
    expect(counters()).toEqual({ s: 7, f: 0 });
    // The audit row is REAL, not claimed: read it back from the ledger db.
    const row = readLedger().find((e) => e.kind === 'skill-counter-compensation');
    expect(row).toBeDefined();
    expect(row!.entity).toBe('Water/widget');
    expect(row!.detail).toMatchObject({ failures: -2, reason: expect.stringContaining('budget-killed') });
  });

  it('JOURNALS FIRST and fails CLOSED: an unwritable ledger aborts with the store untouched', () => {
    // Point the ledger at a DIRECTORY — sqlite cannot open it, so the strict
    // append throws. The original ordering mutated _meta.json first and then
    // swallowed the append failure (appendLedger is fail-open), leaving the
    // store BELOW the ledger — the exact direction `ledger check` reports as
    // IMPOSSIBLE — while the CLI printed "audited as a … ledger event".
    closeLedgerHandles();
    const dirAsDb = join(dir, 'not-a-db');
    mkdirSync(dirAsDb);
    process.env['ATOMA_LEDGER_DB'] = dirAsDb;
    expect(() =>
      reg.compensateCounters('Water', 'widget', { failures: -2, reason: 'env failure' })
    ).toThrow();
    expect(counters()).toEqual({ s: 7, f: 2 }); // store untouched
  });

  it('requires a reason and at least one negative integer delta', () => {
    expect(() =>
      reg.compensateCounters('Water', 'widget', { failures: -1, reason: '   ' })
    ).toThrow(/reason/);
    expect(() => reg.compensateCounters('Water', 'widget', { reason: 'r' })).toThrow(
      /negative integer delta/
    );
    expect(() =>
      reg.compensateCounters('Water', 'widget', { failures: 2, reason: 'r' })
    ).toThrow(/negative integer delta/);
    expect(() =>
      reg.compensateCounters('Water', 'widget', { failures: -1.5, reason: 'r' })
    ).toThrow(/negative integer delta/);
    // Nothing was written by any refused call.
    expect(counters()).toEqual({ s: 7, f: 2 });
  });

  it('refuses to take a counter below zero, and writes NOTHING when it refuses', () => {
    expect(() =>
      reg.compensateCounters('Water', 'widget', { failures: -3, reason: 'r' })
    ).toThrow(/negative/);
    expect(counters()).toEqual({ s: 7, f: 2 });
  });

  it('returns null for a skill that does not exist (mirrors resetCounters)', () => {
    expect(reg.compensateCounters('Water', 'ghost', { failures: -1, reason: 'r' })).toBeNull();
  });

  it('the ledger projection absorbs the compensation — check stays exact', () => {
    // The invariant that killed the naive design: `ledger check` reports
    // store < ledger as IMPOSSIBLE. The event kind must therefore fold into
    // projectCounters so a forgiven store matches its projection.
    const at = new Date(0).toISOString();
    const ev = (kind: LedgerEvent['kind'], detail?: Record<string, unknown>): LedgerEvent => ({
      at,
      kind,
      entity: 'Water/widget',
      ...(detail ? { detail } : {}),
    });
    const events: LedgerEvent[] = [
      ...Array.from({ length: 7 }, () => ev('skill-success')),
      ev('skill-failure'),
      ev('skill-failure'),
      ev('skill-counter-compensation', { successes: 0, failures: -2, reason: 'env' }),
    ];
    const p = projectCounters(events).get('Water/widget')!;
    expect(p.successes).toBe(7);
    expect(p.failures).toBe(0); // store 7✓/0✗ == ledger 7✓/0✗ — nothing impossible
  });

  it('the projection CLAMPS a compensation at zero — no negative residue', () => {
    // Forgiving increments that PREDATE the ledger (the documented
    // expected-drift population) would otherwise drive the projection to
    // -2✗, and a negative residue silently absorbs that many later phantom
    // failure events on the same axis before check can see them.
    const at = new Date(0).toISOString();
    const ev = (kind: LedgerEvent['kind'], detail?: Record<string, unknown>): LedgerEvent => ({
      at,
      kind,
      entity: 'Water/widget',
      ...(detail ? { detail } : {}),
    });
    const events: LedgerEvent[] = [
      ev('skill-counter-compensation', { successes: 0, failures: -2, reason: 'predates ledger' }),
      ev('skill-failure'), // a phantom the residue must NOT absorb
    ];
    const p = projectCounters(events).get('Water/widget')!;
    expect(p.failures).toBe(1); // clamped 0, then the phantom counts fully
  });
});
