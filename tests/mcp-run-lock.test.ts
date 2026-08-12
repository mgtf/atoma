import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLease, RunLockBusyError } from '../src/mcp/runLock.js';

describe('MCP cross-process run lease', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-lock-'));
    lockPath = join(dir, 'run.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits exactly one owner until that owner releases', () => {
    const first = acquireRunLease('run-one', lockPath);
    expect(() => acquireRunLease('run-two', lockPath)).toThrow(RunLockBusyError);
    expect(() => acquireRunLease('run-two', lockPath)).toThrow(/run-one/);

    first.release();
    const second = acquireRunLease('run-two', lockPath);
    expect(existsSync(lockPath)).toBe(true);
    second.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('excludes a genuinely separate MCP process', async () => {
    const script = [
      "import { acquireRunLease } from './src/mcp/runLock.ts';",
      "const lease = acquireRunLease('child-run', process.env['LOCK_PATH']);",
      "process.stdout.write('LOCKED\\n');",
      'setTimeout(() => { lease.release(); process.exit(0); }, 1200);',
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
    const exited = new Promise<number | null>((resolveExit) => {
      child.once('exit', resolveExit);
    });

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

      expect(() => acquireRunLease('parent-run', lockPath)).toThrow(/child-run/);
      expect(await exited).toBe(0);
      const after = acquireRunLease('parent-run', lockPath);
      after.release();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('recovers an atomic lease whose owner process is dead', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        token: 'dead-owner',
        runId: 'stale-run',
        ownerPid: 99_999_999,
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8'
    );

    const recovered = acquireRunLease('new-run', lockPath);
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { runId: string };
    expect(owner.runId).toBe('new-run');
    recovered.release();
  });

  it('records the detached child and never deletes a successor lease', () => {
    const lease = acquireRunLease('run-one', lockPath);
    lease.attachChild(4242);
    const attached = JSON.parse(readFileSync(lockPath, 'utf8')) as { childPid?: number };
    expect(attached.childPid).toBe(4242);

    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        token: 'successor',
        runId: 'run-two',
        ownerPid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
      'utf8'
    );
    lease.release();
    expect(existsSync(lockPath)).toBe(true);
  });
});
