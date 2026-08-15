import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardTimeoutLogEpilogue, parseRunLog, spawnRun, withUnkillableBackstop } from '../src/cli/burnin.js';

/**
 * The hard-timeout reap used to be UNATTRIBUTED: a wedged runner prints none
 * of parseRunLog's markers, so the reaped run read as outcome 'error' with
 * null economics and no hint — indistinguishable from any other failure in the
 * CSV and in the MCP run record (2026-08-14 review, MCP §). spawnRun now
 * appends the runner-owned `TIMEOUT after` marker plus an explicit
 * attribution, mirroring its own `--- spawn failed ---` precedent on the
 * spawn-error path.
 */
describe('spawnRun — hard-timeout reap leaves a parseable marker', () => {
  it('the epilogue classifies as failed, and a delivered banner still wins the race', () => {
    const epilogue = hardTimeoutLogEpilogue(900_000 + 180_000);
    expect(epilogue).toContain('TIMEOUT after 1080s');
    expect(epilogue).toMatch(/reaped a wedged runner/);
    expect(parseRunLog('wedged stdout with no markers at all' + epilogue).outcome).toBe('failed');
    // Race case: if the completion banner arrived while the timer fired,
    // parseRunLog checks `✓ build finished` FIRST, so delivered wins and the
    // marker cannot relabel a healthy run.
    expect(parseRunLog('✓ build finished\n' + epilogue).outcome).toBe('delivered');
  });

  /**
   * The real branch, on a real detached child. The fake-npm-on-PATH seam is
   * the one the env-isolation test already uses; this child prints nothing
   * and never exits — the exact wedged shape. `hardKillMarginMs` is the test
   * seam: nobody waits out the 180s production margin.
   */
  it('reaps a wedged child and lands the marker in the log BEFORE the promise resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-hard-timeout-'));
    const fakeNpm = join(dir, 'npm');
    const previousPath = process.env['PATH'];
    writeFileSync(fakeNpm, '#!/bin/sh\nsleep 300\n', 'utf8');
    chmodSync(fakeNpm, 0o755);
    const logPath = join(dir, 'child.log');
    try {
      process.env['PATH'] = `${dir}:${previousPath ?? ''}`;
      const log = await spawnRun({
        goal: 'wedge forever',
        timeoutMs: 300,
        hardKillMarginMs: 700, // hard reap at 1s instead of timeoutMs + 180s
        logPath,
        cleanWorkspace: false,
      });
      expect(log).toContain('TIMEOUT after 1s');
      expect(log).toMatch(/reaped a wedged runner/);
      expect(parseRunLog(log).outcome).toBe('failed');
      // The log FILE carries the marker too — it must land before the settle,
      // or a caller re-parsing the persisted log disagrees with the promise.
      expect(readFileSync(logPath, 'utf8')).toContain('TIMEOUT after 1s');
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The settle-forever hole (2026-08-15 wedging investigation, layer B):
 * spawnRun fails closed when a process group survives SIGKILL — correct
 * under the MCP server's hard-exit backstop, but `npm run burnin` had no
 * equivalent, so the batch loop awaited forever with no timer left armed.
 */
describe('withUnkillableBackstop — the batch loop cannot await forever', () => {
  it('passes a normal settle through and clears its timer', async () => {
    await expect(
      withUnkillableBackstop(Promise.resolve('log text'), 60_000, 'task-x')
    ).resolves.toBe('log text');
  });

  it('throws attributed when spawnRun never settles', async () => {
    const never = new Promise<string>(() => {});
    await expect(withUnkillableBackstop(never, 20, 'coffee-blend-web-page')).rejects.toThrow(
      /coffee-blend-web-page: the runner's process group survived SIGKILL/
    );
  });
});
