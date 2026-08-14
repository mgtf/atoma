import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runProcessGroupExists,
  signalRunProcessGroup,
  terminateRunProcessGroup,
} from '../src/cli/burnin.js';

/**
 * `process.kill(-1, sig)` signals EVERY process the user owns and
 * `process.kill(0/-0, sig)` the caller's own group — so a pgid of 0 or 1
 * reaching the group helpers is never a run, it is corruption of the MCP
 * lease store (~/.atoma/mcp-run-lock.db, writable by the run itself via an
 * absolute path) or a recycled value. The helpers must refuse those values
 * BEFORE any kill syscall: stale-lease recovery feeds `child_pgid` from the
 * DB straight into terminateRunProcessGroup, and without the bound that
 * path was a user-wide SIGTERM/SIGKILL primitive.
 */
describe('group-signal helpers — pgid bounds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the magic and malformed pgids without any kill syscall', async () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pgid of [1, 0, -1, -5, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(runProcessGroupExists(pgid)).toBe(false);
      signalRunProcessGroup(pgid, 'SIGTERM');
      // An invalid recorded pgid means "no live group": recovery must treat
      // the stale row as replaceable, not throw or signal.
      await expect(terminateRunProcessGroup(pgid)).resolves.toBe(true);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it('still probes a legitimate pgid (> 1) through the group syscall', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(runProcessGroupExists(54321)).toBe(false);
    expect(kill).toHaveBeenCalledWith(-54321, 0);
  });
});
