import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORE_BUSY_TIMEOUT_MS, openStoreHandle, closeStoreHandles } from '../src/core/stores.js';
import { openDb } from '../src/registry/db.js';

/**
 * THE STORE HAS MORE THAN ONE WRITER, AND HAS HAD FOR A WHILE.
 *
 * The viz server holds write handles for auth, projects, github, preview,
 * push and platform events; the coordinator injects `ATOMA_DB_PATH` into the
 * run child, which opens the same file read/write for the whole run; the
 * mender runs as its own host service; operator CLIs and the platform-tier
 * MCP write tools reach it too. Yet every registry write transaction was
 * DEFERRED, and `create` reads `usedOrdinals` and `takenNames` before it
 * INSERTs — a read-then-write across which another connection may commit.
 *
 * Deferred, that window is not merely slow. MEASURED: reverting only the
 * eleven `.immediate()` calls — leaving the explicit `busy_timeout` in place
 * — turns this test red, with a writer dying on `SQLITE_BUSY`. An ordinary
 * lock contention would have been waited out; a stale-snapshot upgrade under
 * WAL does not invoke the busy handler at all, so no timeout can rescue it,
 * and the allocation it computed no longer describes the table anyway.
 * `BEGIN IMMEDIATE` takes the write lock before the read, which is what
 * makes the allocation atomic.
 *
 * This test crosses REAL PROCESSES, and starts them on a barrier. One process
 * cannot interleave two synchronous better-sqlite3 transactions against
 * itself, so an in-process test would pass either way; and children that
 * merely start together still finish their `tsx` boot at different moments,
 * so without the barrier the contended window is left to chance.
 */
describe('concurrent writers on one product store', () => {
  let root: string;
  let dbPath: string;
  let startPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-concurrent-'));
    dbPath = join(root, 'atoma.db');
    startPath = join(root, 'start');
    // Create the schema once up front so the subject under test is the
    // ALLOCATION race, not the separate question of concurrent first-open.
    // The children still call `openDb`, which re-runs its migrations, so that
    // path is exercised anyway — just not asserted here.
    openDb(dbPath).close();
  });

  afterEach(() => {
    closeStoreHandles();
    rmSync(root, { recursive: true, force: true });
  });

  const CHILD = [
    "import { existsSync } from 'node:fs';",
    "import { openDb } from './src/registry/db.ts';",
    "import { AtomRegistry } from './src/registry/atomRegistry.ts';",
    "const reg = new AtomRegistry(openDb(process.env['DB']));",
    "process.stderr.write('READY\\n');",
    // Spin, synchronously, until the parent opens the gate. A bounded
    // deadline so a dead parent ends the child instead of a busy core.
    'const deadline = Date.now() + 30000;',
    "while (!existsSync(process.env['START'])) { if (Date.now() > deadline) { process.exit(3); } }",
    'const made = [];',
    "for (let i = 0; i < Number(process.env['N']); i++) {",
    "  made.push(reg.create(1, { description: 'concurrent', systemPrompt: 'sys',",
    "    tools: [], params: {}, createdBy: process.env['WHO'] }).name);",
    '}',
    'process.stdout.write(JSON.stringify(made));',
  ].join(' ');

  interface ChildResult {
    readonly code: number | null;
    readonly names: string[];
    readonly stderr: string;
  }

  function allocateInChild(who: string, n: number, ready: () => void): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', CHILD], {
        cwd: process.cwd(),
        env: { ...process.env, DB: dbPath, START: startPath, N: String(n), WHO: who },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let stderr = '';
      let announced = false;
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (!announced && stderr.includes('READY')) {
          announced = true;
          ready();
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        // A child that died before announcing must not leave the parent
        // waiting on a barrier that can no longer be reached.
        if (!announced) {
          announced = true;
          ready();
        }
        let names: string[] = [];
        try {
          names = JSON.parse(out || '[]') as string[];
        } catch {
          names = [];
        }
        resolve({ code, names, stderr });
      });
    });
  }

  it(
    'allocates distinct ordinals and names when four processes create at once',
    async () => {
      const WRITERS = 4;
      const PER_WRITER = 15;
      let booted = 0;
      let readyHook: () => void = () => {};
      const allBooted = new Promise<void>((resolve) => {
        readyHook = (): void => {
          booted += 1;
          if (booted === WRITERS) resolve();
        };
      });
      const running = Array.from({ length: WRITERS }, (_, i) =>
        allocateInChild(`writer-${i}`, PER_WRITER, () => readyHook())
      );
      await allBooted;
      writeFileSync(startPath, 'go', 'utf8');
      const results = await Promise.all(running);

      // A child that died is the failure this test exists to catch: deferred,
      // the loser of the race throws instead of waiting.
      for (const [i, res] of results.entries()) {
        expect(res.code, `writer-${i} stderr: ${res.stderr}`).toBe(0);
        expect(res.names, `writer-${i} stderr: ${res.stderr}`).toHaveLength(PER_WRITER);
      }

      const claimed = results.flatMap((r) => r.names);
      expect(new Set(claimed).size, `duplicate names across writers`).toBe(WRITERS * PER_WRITER);

      // And the store agrees — the assertion a duplicate ordinal would break
      // even if two children happened to report different names.
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS rows,
                    COUNT(DISTINCT ordinal) AS ordinals,
                    COUNT(DISTINCT name) AS names,
                    COUNT(DISTINCT atom_id) AS ids
             FROM atom_types WHERE tier = 1`
          )
          .get() as { rows: number; ordinals: number; names: number; ids: number };
        expect(row).toEqual({
          rows: WRITERS * PER_WRITER,
          ordinals: WRITERS * PER_WRITER,
          names: WRITERS * PER_WRITER,
          ids: WRITERS * PER_WRITER,
        });
      } finally {
        db.close();
      }
    },
    90_000
  );

  it('pins the contention window on both product-store open paths', () => {
    // better-sqlite3 applies a default of the same value that is invisible at
    // the call sites, so without this a driver upgrade would silently change
    // how long a writer waits. The registry's connection and the shared
    // handle are two different connections on one file; both must wait.
    const registryDb = openDb(dbPath);
    try {
      expect(registryDb.pragma('busy_timeout', { simple: true })).toBe(STORE_BUSY_TIMEOUT_MS);
    } finally {
      registryDb.close();
    }

    const shared = openStoreHandle(dbPath, 'CREATE TABLE IF NOT EXISTS probe (x INTEGER)');
    expect(shared.pragma('busy_timeout', { simple: true })).toBe(STORE_BUSY_TIMEOUT_MS);
  });
});
