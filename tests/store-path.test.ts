import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_DB_PATH, skillsDirPath, storeDbPath } from '../src/core/stores.js';

/**
 * ONE STORE, and ONE rule for where it lives.
 *
 * `storeDbPath` replaced four divergent copies of that rule — `cli/registry`,
 * `cli/skills`, `cli/ledger` and `viz/server` had each grown their own probe
 * for a second store file, no two alike, because the runner wrote
 * `ATOMA_BUILD_DB_PATH` while every CLI read `ATOMA_DB_PATH`. Drift between
 * copies of one rule is the bug `usedOrdinals` was extracted to stop.
 *
 * Resolution is a pure function of flag/env/default and touches no disk. The
 * store is gitignored runtime state holding counters earned over months, so
 * picking the wrong file does not error — it presents a working system that
 * has forgotten everything.
 */

const ENV_KEYS = ['ATOMA_DB_PATH', 'ATOMA_BUILD_DB_PATH', 'ATOMA_SKILLS_DIR'] as const;

describe('storeDbPath — one rule for where the store lives', () => {
  let dir: string;
  let cwd: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-storepath-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to ./atoma.db on a clean tree', () => {
    expect(storeDbPath()).toBe(DEFAULT_DB_PATH);
  });

  it('an explicit path wins over everything', () => {
    process.env['ATOMA_DB_PATH'] = './from-env.db';
    expect(storeDbPath('./from-flag.db')).toBe('./from-flag.db');
  });

  it('honours ATOMA_DB_PATH', () => {
    process.env['ATOMA_DB_PATH'] = './from-env.db';
    expect(storeDbPath()).toBe('./from-env.db');
  });

  it('can resolve from an injected snapshot without consulting process state', () => {
    process.env['ATOMA_DB_PATH'] = './ambient.db';
    expect(storeDbPath(undefined, { ATOMA_DB_PATH: './snapshot.db' })).toBe('./snapshot.db');
    expect(storeDbPath('./explicit.db', { ATOMA_DB_PATH: './snapshot.db' })).toBe('./explicit.db');
    expect(storeDbPath(undefined, {})).toBe(DEFAULT_DB_PATH);
  });

  it('resolving a path never CREATES one — resolution must not touch disk', () => {
    storeDbPath();
    storeDbPath();
    // The default is a NAME, not a file: resolving it must not conjure
    // ./atoma.db, nor drop a -wal/-shm beside it by opening it read-write.
    expect(() => new Database('./atoma.db', { fileMustExist: true })).toThrow();
  });

  it('skillsDirPath follows the same shape', () => {
    expect(skillsDirPath()).toBe('./skills');
    process.env['ATOMA_SKILLS_DIR'] = './elsewhere';
    expect(skillsDirPath()).toBe('./elsewhere');
    expect(skillsDirPath('./explicit')).toBe('./explicit');
  });
});
