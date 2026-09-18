import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeStoreHandles } from '../src/core/stores.js';

/**
 * ONE FRESH STORE PER TEST for every handle-less writer.
 *
 * `vitest.config.ts` pins `ATOMA_LEDGER_DB` to one file under `node_modules`
 * so that no test appends to the developer's real store. That was enough
 * while the file only received lifecycle events, which nothing counts except
 * in tests that set their own path. Since 2026-09-18 (W4) skill trust is rows
 * in that same store, keyed by fixed-string namespaces the suite reuses
 * everywhere (`Water/s`, `Ammonia/x`, `molecule-a/…`) — and those rows outlive
 * the per-test `mkdtemp` roots, because `rmSync` deletes bodies, not rows.
 * Shared across files running in parallel forks, the one file would make
 * every exact-count assertion order- and worker-dependent.
 *
 * So each test gets its own store, structurally, the way it always got its
 * own skills root. A test that sets `ATOMA_LEDGER_DB` in its own `beforeEach`
 * still wins: file-level hooks run before a describe's. Cached handles are
 * closed BEFORE the path changes, so no registry can hold a connection to a
 * store the next test no longer names; every default handle is re-resolved
 * per call through `openStoreHandle`'s path-keyed cache for exactly this
 * reason. A handle opened in `beforeAll` or at module scope would be closed
 * after the first test — none does today, and one that did would be wrong.
 */
let current: string | undefined;

beforeEach(() => {
  closeStoreHandles();
  current = mkdtempSync(join(tmpdir(), 'atoma-test-store-'));
  process.env['ATOMA_LEDGER_DB'] = join(current, 'store.db');
});

afterEach(() => {
  closeStoreHandles();
  if (current) {
    // Windows keeps a file busy while any non-cached handle is open; the
    // temp directory is disposable either way.
    try { rmSync(current, { recursive: true, force: true }); } catch { /* EBUSY/EPERM */ }
    current = undefined;
  }
});
