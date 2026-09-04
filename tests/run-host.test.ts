import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRunLog, spawnRun } from '../src/cli/burnin.js';
import {
  runHostSupported,
  SUPPORTED_RUN_PLATFORMS,
  UNSUPPORTED_RUN_HOST_REMEDY,
  unsupportedRunHostMessage,
  unsupportedRunHostReason,
} from '../src/run/platform.js';

/**
 * WHERE A RUN MAY EXECUTE, and what happens when it may not.
 *
 * Measured on a Windows host 2026-08-30: the run path assumes `npm` is an
 * executable and that `process.kill(-pid)` signals a process group. Neither
 * holds there, so a run died with a bare `spawn npm ENOENT` several processes
 * deep, and cancellation reported success over orphans that kept running. The
 * defect was never the platform's limits — it was the SILENCE: every doctor
 * check passed and nothing named the host as the reason.
 *
 * The refusal is asserted at the LAUNCHER, the boundary that failed, and with
 * the platform injected so this suite proves the win32 branch from Linux CI
 * (which is the only place it would otherwise never run). The allowed
 * direction is covered by the neighbouring `spawnRun` tests in
 * tests/burnin.test.ts: they drive a real fake `npm` through the real spawn,
 * so a guard that refused a POSIX host would turn them red.
 */
describe('the run host contract', () => {
  it('admits the POSIX hosts and nothing else', () => {
    expect([...SUPPORTED_RUN_PLATFORMS].sort()).toEqual(['darwin', 'linux']);
    expect(runHostSupported('linux')).toBe(true);
    expect(runHostSupported('darwin')).toBe(true);
    expect(runHostSupported('win32')).toBe(false);
    // Not an allowlist by accident: an unlisted POSIX-ish platform is out too,
    // because nothing has measured the reap sequence there.
    expect(runHostSupported('aix')).toBe(false);
    expect(runHostSupported('freebsd')).toBe(false);
  });

  it('names the platform, the way out, and where the procedure is', () => {
    const message = unsupportedRunHostMessage('win32');
    expect(message).toContain('win32');
    expect(message).toContain(UNSUPPORTED_RUN_HOST_REMEDY);
    expect(message).toMatch(/WSL2/);
    // A remedy that only names a platform leaves the reader to guess the
    // procedure; it must point at the document that carries it.
    expect(message).toMatch(/development-setup\.md/);
    // The refusal must not read as "atoma does not work here": the
    // development path is unaffected and the message says so.
    expect(message).toMatch(/typecheck/);
    // A surface with its own remedy field takes the reason alone, so the two
    // halves must not overlap — doctor printed the way out twice otherwise.
    const reason = unsupportedRunHostReason('win32');
    expect(reason).toContain('win32');
    expect(reason).not.toContain('WSL2');
    expect(message).toBe(`${reason} ${UNSUPPORTED_RUN_HOST_REMEDY}`);
  });

  it('refuses at the launcher, before the spawn, in the shape callers read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-run-host-'));
    const logPath = join(dir, 'refused.log');
    try {
      const log = await spawnRun({
        goal: 'anything at all',
        timeoutMs: 1_000,
        logPath,
        cleanWorkspace: false,
        platform: 'win32',
        // A PATH with nothing on it: had the guard let this reach the spawn,
        // the log would carry an ENOENT instead of the refusal below — so
        // this asserts the refusal happened FIRST, not merely that it exists.
        env: { PATH: dir },
      });

      expect(log).toContain('--- spawn failed ---');
      expect(log).toContain('not supported on win32');
      expect(log).toMatch(/WSL2/);
      expect(log).not.toContain('ENOENT');
      // The log on disk and the resolved string agree, so a burn-in CSV row,
      // a project run record and an MCP run status all carry the reason.
      expect(readFileSync(logPath, 'utf8')).toBe(log);
      // And it reads as a plain error — not delivered, not timed out — so no
      // caller has to learn a new failure mode.
      expect(parseRunLog(log).outcome).toBe('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
