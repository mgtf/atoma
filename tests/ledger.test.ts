import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLedger, readLedger, projectCounters, ledgerPath } from '../src/core/ledger.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';

/**
 * P2 stage 1 — the append-only lifecycle ledger. The mutable stores stay
 * authoritative; the ledger records every mutation from the storage choke
 * points so `ledger check` can flag the IMPOSSIBLE direction (store counter
 * below the ledger's projection = a write path bypassed the choke points).
 */
describe('lifecycle ledger', () => {
  let dir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-ledger-'));
    envBefore = process.env['ATOMA_LEDGER_PATH'];
    process.env['ATOMA_LEDGER_PATH'] = join(dir, 'ledger.jsonl');
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env['ATOMA_LEDGER_PATH'];
    else process.env['ATOMA_LEDGER_PATH'] = envBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  it('append + read round-trips, and torn lines never blind the reader', () => {
    appendLedger({ kind: 'type-success', entity: 'Hydrogen' });
    appendFileSync(ledgerPath(), '{"kind":"type-suc', 'utf8'); // torn write
    appendFileSync(ledgerPath(), '\n', 'utf8');
    appendLedger({ kind: 'type-failure', entity: 'Hydrogen' });
    const events = readLedger();
    expect(events).toHaveLength(2);
    expect(events[0]!.at).toBeTruthy();
  });

  it('SkillRegistry mutations flow through: bump, promote (reset), demote', () => {
    const skills = new SkillRegistry(join(dir, 'skills'));
    skills.save('Hydrogen', { id: 's', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    skills.recordSuccess('Hydrogen', 's');
    skills.recordSuccess('Hydrogen', 's');
    skills.promoteToScript({
      l1Name: 'Hydrogen', skillId: 's', language: 'node',
      scriptBody: 'x', compiledGeneration: 'g1',
    });
    skills.recordSuccess('Hydrogen', 's');
    const projected = projectCounters(readLedger()).get('Hydrogen/s')!;
    const live = skills.loadFor('Hydrogen')[0]!;
    // Projection matches the store exactly: 2✓ erased by promotion, then 1✓.
    expect(projected.successes).toBe(live.successes);
    expect(projected.successes).toBe(1);
    const kinds = readLedger().map((e) => e.kind);
    expect(kinds).toContain('skill-save');
    expect(kinds).toContain('promote');
  });

  it('AtomRegistry counter bumps and patch-resets are recorded and project correctly', () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const t = reg.create(1, {
      description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
    });
    reg.recordSuccess(t.name);
    reg.recordSuccess(t.name);
    reg.recordFailure(t.name);
    reg.patch(t.name, { systemPromptAppend: 'more' }, 'test', 'why');
    reg.recordSuccess(t.name);
    const projected = projectCounters(readLedger()).get(t.name)!;
    const live = reg.getByName(t.name)!;
    expect(projected.successes).toBe(live.successes);
    expect(projected.failures).toBe(live.failures);
    expect(projected.successes).toBe(1);
    expect(projected.failures).toBe(0);
  });

  it('a broken ledger path never takes down the caller (fail-open)', () => {
    process.env['ATOMA_LEDGER_PATH'] = join(dir, 'nope', '\0bad', 'x.jsonl');
    expect(() => appendLedger({ kind: 'type-success', entity: 'H' })).not.toThrow();
  });
});
