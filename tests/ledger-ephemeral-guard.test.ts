import { describe, it, expect, afterEach } from 'vitest';
import { ledgerWritesAllowed } from '../src/core/ledger.js';

/**
 * An in-memory registry must not write to somebody else's ledger.
 *
 * The ledger's one hard rule is ONE ledger ↔ ONE authoritative store: events
 * carry no store identity, so `ledger check` projects them against whichever
 * store you point it at. A `:memory:` registry is by construction not that
 * store.
 *
 * MEASURED: two throwaway `tsx` scripts on 2026-08-09 opened `:memory:`
 * registries, called `recordSuccess('Helium')`, and appended four phantom
 * successes to the real file. `ledger check` then read
 * `IMPOSSIBLE  Helium: store 2 < ledger 6` — permanently, on the one tool
 * whose job is to be believed. vitest was never the problem (it pins
 * ATOMA_LEDGER_PATH); ad-hoc scripts are, and they are exactly what nobody
 * remembers to configure.
 */

const saved = process.env['ATOMA_LEDGER_PATH'];
afterEach(() => {
  if (saved === undefined) delete process.env['ATOMA_LEDGER_PATH'];
  else process.env['ATOMA_LEDGER_PATH'] = saved;
});

describe('ledgerWritesAllowed', () => {
  it('refuses an in-memory store when no ledger was named', () => {
    delete process.env['ATOMA_LEDGER_PATH'];
    expect(ledgerWritesAllowed(':memory:')).toBe(false);
    expect(ledgerWritesAllowed('file::memory:?cache=shared')).toBe(false);
  });

  it('allows a real file-backed store', () => {
    delete process.env['ATOMA_LEDGER_PATH'];
    expect(ledgerWritesAllowed('./atoma-build.db')).toBe(true);
    expect(ledgerWritesAllowed('/var/data/atoma.db')).toBe(true);
  });

  it('an EXPLICIT ledger path always wins — the caller took responsibility', () => {
    // This is what the test suite and viz:demo do, and why they keep working.
    process.env['ATOMA_LEDGER_PATH'] = '/tmp/some-test-ledger.jsonl';
    expect(ledgerWritesAllowed(':memory:')).toBe(true);
  });

  it('refuses an unknown path rather than guessing', () => {
    delete process.env['ATOMA_LEDGER_PATH'];
    expect(ledgerWritesAllowed(undefined)).toBe(false);
  });
});
