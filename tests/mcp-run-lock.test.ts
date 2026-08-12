import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { acquireRunLease, RunLockBusyError } from '../src/mcp/runLock.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL
  )
`;

describe('MCP cross-process run lease', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-lock-'));
    lockPath = join(dir, 'run-lock.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function inspect(): Database.Database {
    const db = new Database(lockPath);
    db.exec(SCHEMA);
    return db;
  }

  function seedStale(runId = 'stale-run'): void {
    const db = inspect();
    db.prepare(
      `INSERT OR REPLACE INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead-owner', ?, 99999999, NULL, '2026-01-01T00:00:00.000Z')`
    ).run(runId);
    db.close();
  }

  it('admits exactly one owner until that owner releases', async () => {
    const first = await acquireRunLease('run-one', lockPath);
    await expect(acquireRunLease('run-two', lockPath)).rejects.toThrow(RunLockBusyError);
    await expect(acquireRunLease('run-two', lockPath)).rejects.toThrow(/run-one/);

    first.release();
    const second = await acquireRunLease('run-two', lockPath);
    second.release();
    const db = inspect();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM mcp_run_lease').get() as { n: number }).n
    ).toBe(0);
    db.close();
  });

  it('excludes a genuinely separate MCP process', async () => {
    const script = [
      "import { acquireRunLease } from './src/mcp/runLock.ts';",
      '(async () => {',
      "const lease = await acquireRunLease('child-run', process.env['LOCK_PATH']);",
      "process.stdout.write('LOCKED\\n');",
      'setTimeout(() => { lease.release(); process.exit(0); }, 1200);',
      '})().catch((e) => { console.error(e); process.exit(1); });',
    ].join(' ');
    const child = spawn('npx', ['tsx', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));

    try {
      await new Promise<void>((resolveLocked, rejectLocked) => {
        const timer = setTimeout(() => rejectLocked(new Error(`child did not lock: ${stderr}`)), 5000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('LOCKED')) return;
          clearTimeout(timer);
          resolveLocked();
        });
        child.once('error', rejectLocked);
      });

      await expect(acquireRunLease('parent-run', lockPath)).rejects.toThrow(/child-run/);
      expect(await exited).toBe(0);
      const after = await acquireRunLease('parent-run', lockPath);
      after.release();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('recovers a lease whose owner process is dead', async () => {
    seedStale();
    const recovered = await acquireRunLease('new-run', lockPath);
    const db = inspect();
    const owner = db.prepare('SELECT run_id FROM mcp_run_lease').get() as { run_id: string };
    expect(owner.run_id).toBe('new-run');
    db.close();
    recovered.release();
  });

  it('records the detached child and never deletes a successor lease', async () => {
    const lease = await acquireRunLease('run-one', lockPath);
    lease.attachChild(4242);
    const db = inspect();
    const attached = db.prepare('SELECT child_pgid FROM mcp_run_lease').get() as {
      child_pgid: number | null;
    };
    expect(attached.child_pgid).toBe(4242);
    db.prepare(
      `UPDATE mcp_run_lease
       SET token = 'successor', run_id = 'run-two', owner_pid = ?, child_pgid = NULL`
    ).run(process.pid);
    db.close();

    lease.release();
    const after = inspect();
    expect((after.prepare('SELECT run_id FROM mcp_run_lease').get() as { run_id: string }).run_id).toBe(
      'run-two'
    );
    after.close();
  });

  it('lets exactly one of two processes recover the same stale token', async () => {
    seedStale('dead-run');
    const go = join(dir, 'go');
    const launch = (id: string): {
      child: ChildProcessWithoutNullStreams;
      ready: string;
      output: Promise<string>;
    } => {
      const ready = join(dir, `ready-${id}`);
      const script = [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { acquireRunLease } from './src/mcp/runLock.ts';",
        '(async () => {',
        "writeFileSync(process.env['READY'], '1');",
        "while (!existsSync(process.env['GO'])) await new Promise(r => setTimeout(r, 10));",
        'try {',
        "const lease = await acquireRunLease(process.env['ID'], process.env['LOCK_PATH']);",
        "process.stdout.write('ACQUIRED:' + process.env['ID']);",
        'setTimeout(() => { lease.release(); process.exit(0); }, 500);',
        '} catch {',
        "process.stdout.write('BUSY:' + process.env['ID']); process.exit(0);",
        '}',
        '})().catch(() => process.exit(1));',
      ].join(' ');
      const child = spawn('npx', ['tsx', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, ID: id, READY: ready, GO: go, LOCK_PATH: lockPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output = new Promise<string>((resolveOutput) => {
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.once('exit', () => resolveOutput(stdout));
      });
      return { child, ready, output };
    };

    const a = launch('A');
    const b = launch('B');
    try {
      const deadline = Date.now() + 5000;
      while ((!existsSync(a.ready) || !existsSync(b.ready)) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(existsSync(a.ready) && existsSync(b.ready)).toBe(true);
      writeFileSync(go, 'go');
      const outputs = await Promise.all([a.output, b.output]);
      expect(outputs.filter((value) => value.startsWith('ACQUIRED:'))).toHaveLength(1);
      expect(outputs.filter((value) => value.startsWith('BUSY:'))).toHaveLength(1);
    } finally {
      if (a.child.exitCode === null) a.child.kill('SIGKILL');
      if (b.child.exitCode === null) b.child.kill('SIGKILL');
    }
  }, 15_000);
});
