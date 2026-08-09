import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_DB_PATH, legacyStoreNotice, skillsDirPath, storeDbPath } from '../src/core/stores.js';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';

/**
 * ONE STORE, and the ramp that gets an existing installation there.
 *
 * `storeDbPath` replaced four divergent copies of the rule — `cli/registry`,
 * `cli/skills`, `cli/ledger` and `viz/server` had each grown their own
 * `existsSync('./atoma-build.db')` probe, no two alike, because the runner
 * wrote `ATOMA_BUILD_DB_PATH` while every CLI read `ATOMA_DB_PATH`. Drift
 * between copies of one rule is the bug `usedOrdinals` was extracted to stop.
 *
 * The ramp is the part that can destroy something. The store is gitignored
 * runtime state holding counters earned over months, so picking the wrong
 * file does not error — it presents a working system that has forgotten
 * everything.
 */

const ENV_KEYS = ['ATOMA_DB_PATH', 'ATOMA_BUILD_DB_PATH', 'ATOMA_SKILLS_DIR'] as const;

function populate(path: string): void {
  const db = openDb(path);
  new AtomRegistry(db).create(1, {
    description: 'x', systemPrompt: 'p', tools: [], params: {}, createdBy: 'test',
  });
  db.close();
}

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
    expect(legacyStoreNotice(storeDbPath())).toBeNull();
  });

  it('an explicit path wins over everything', () => {
    process.env['ATOMA_DB_PATH'] = './from-env.db';
    expect(storeDbPath('./from-flag.db')).toBe('./from-flag.db');
  });

  it('honours ATOMA_DB_PATH, and the pre-consolidation env var too', () => {
    process.env['ATOMA_DB_PATH'] = './from-env.db';
    expect(storeDbPath()).toBe('./from-env.db');
    delete process.env['ATOMA_DB_PATH'];
    // An operator with the old var exported in their shell keeps working.
    process.env['ATOMA_BUILD_DB_PATH'] = './legacy-env.db';
    expect(storeDbPath()).toBe('./legacy-env.db');
  });

  it('ramps onto a populated legacy store when the new one is ABSENT', () => {
    populate('./atoma-build.db');
    expect(storeDbPath()).toBe('./atoma-build.db');
    expect(legacyStoreNotice(storeDbPath())).toContain('mv atoma-build.db atoma.db');
  });

  it('ramps when the new store EXISTS BUT IS EMPTY — the state that actually occurs', () => {
    // THE BUG THE FIRST VERSION HAD. `./atoma.db` already existed on the
    // developer's machine holding zero rows, created by any bare
    // `npm run registry -- list` (whose default was already ./atoma.db while
    // every run wrote ./atoma-build.db). An absence test never fired, so the
    // resolver picked the empty store and `tests/run-profile-build.test.ts`
    // failed with "no Neuron in the build store" — the silent-loss scenario,
    // caught only because one test still names the subject.
    populate('./atoma-build.db');
    openDb('./atoma.db').close(); // schema, zero rows — exactly what the CLI leaves
    expect(storeDbPath()).toBe('./atoma-build.db');
  });

  it('STOPS ramping once the new store has content — the migration is over', () => {
    populate('./atoma-build.db');
    populate('./atoma.db');
    expect(storeDbPath()).toBe(DEFAULT_DB_PATH);
    expect(legacyStoreNotice(storeDbPath())).toBeNull();
  });

  it('never ramps onto an empty legacy store', () => {
    openDb('./atoma-build.db').close();
    expect(storeDbPath()).toBe(DEFAULT_DB_PATH);
  });

  it('treats an unreadable or non-SQLite legacy file as absent rather than throwing', () => {
    // A path resolver that throws takes down every CLI over a corrupt
    // sibling nobody asked to open.
    writeFileSync('./atoma-build.db', 'this is not a database');
    expect(() => storeDbPath()).not.toThrow();
    expect(storeDbPath()).toBe(DEFAULT_DB_PATH);
  });

  it('resolving a path never CREATES one — probing must not have side effects', () => {
    populate('./atoma-build.db');
    storeDbPath();
    storeDbPath();
    // No ./atoma.db conjured by the probe, and no -wal/-shm dropped beside
    // the legacy store by opening it read-write.
    expect(() => new Database('./atoma.db', { fileMustExist: true })).toThrow();
  });

  it('skillsDirPath follows the same shape', () => {
    expect(skillsDirPath()).toBe('./skills');
    process.env['ATOMA_SKILLS_DIR'] = './elsewhere';
    expect(skillsDirPath()).toBe('./elsewhere');
    expect(skillsDirPath('./explicit')).toBe('./explicit');
  });
});
