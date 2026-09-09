import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { claimSentinelWatch } from '../src/sentinel/lease.js';
import {
  SENTINEL_FAILURE_LIMIT,
  sentinelCostAlertFromEnv,
  sentinelIntervalFromEnv,
  sentinelTrajectoryMinScoreFromEnv,
  sleepInhibitorHint,
  startResidentSentinel,
  vizSentinelEnabled,
} from '../src/sentinel/resident.js';
import { runHostSupported } from '../src/run/platform.js';
import type { SentinelTickReport } from '../src/sentinel/watch.js';

/**
 * THE RESIDENT SHELL — the watch inside a host process. What these hold:
 *   - a throwing tick is CONTAINED, because in a server an escaping throw from
 *     an interval callback is an uncaught exception and the process dies;
 *   - the timer is unref'd, so the watch can never be why a host refuses to
 *     exit;
 *   - the lease is a PER-TICK fact, so a server that yielded arms itself once
 *     the incumbent is gone, with no restart;
 *   - three failed passes in a row stop claiming to be a watch.
 */

const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-sentinel-resident-'));
  roots.push(root);
  return join(root, 'atoma.db');
}

function emptyReport(): SentinelTickReport {
  return { runs: [], emitted: [], skipped: [] };
}

/** A tick that counts its calls, and can be told to throw. */
function stubWatch(behaviour: { throws?: boolean } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    tick(): SentinelTickReport {
      calls += 1;
      if (behaviour.throws) throw new Error('statSync: ENOENT');
      return emptyReport();
    },
  };
}

describe('the resident watch', () => {
  it('settles ownership at construction and screens on a timer', () => {
    const watch = stubWatch();
    const resident = startResidentSentinel({
      watch,
      dbPath: storePath(),
      source: 'viz-server',
      intervalMs: 10_000,
    });
    // Armed BEFORE the first tick: the host prints a banner line the moment it
    // starts listening, and "off" would be a lie there.
    expect(resident.health().armed).toBe(true);
    expect(resident.health().ticks).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(watch.calls).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(watch.calls).toBe(2);
    expect(resident.health().ticks).toBe(2);
    expect(resident.health().lastTickAt).not.toBeNull();
    resident.stop();

    vi.advanceTimersByTime(60_000);
    expect(watch.calls).toBe(2);
    expect(resident.health().reason).toBe('stopped');
  });

  it('contains a throwing tick instead of taking the host down with it', () => {
    // In the CLI this cost one pass. In a server an escaping throw from an
    // interval callback is an uncaught exception, and the viz server registers
    // no handler — so the process would exit and the launcher would take Vite
    // with it.
    const watch = stubWatch({ throws: true });
    const lines: string[] = [];
    const resident = startResidentSentinel({
      watch,
      dbPath: storePath(),
      source: 'viz-server',
      intervalMs: 10_000,
      logger: (line) => lines.push(line),
    });
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(lines.some((line) => line.includes('ENOENT'))).toBe(true);
    expect(resident.health().consecutiveFailures).toBe(1);
    resident.stop();
  });

  it('stops calling itself a watch after three failed passes', () => {
    const watch = stubWatch({ throws: true });
    const resident = startResidentSentinel({
      watch,
      dbPath: storePath(),
      source: 'viz-server',
      intervalMs: 10_000,
    });
    vi.advanceTimersByTime(2_000 + 10_000 * SENTINEL_FAILURE_LIMIT);
    const health = resident.health();
    expect(health.armed).toBe(false);
    expect(health.reason).toBe('failing');
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(SENTINEL_FAILURE_LIMIT);
    // And it stopped ticking rather than reporting failure forever.
    const calls = watch.calls;
    vi.advanceTimersByTime(60_000);
    expect(watch.calls).toBe(calls);
  });

  it('yields to a live incumbent and arms itself once that watch is gone', () => {
    // The reason the lease is a per-tick fact: a boot-time refusal would leave
    // the server blind until somebody restarted it.
    const dbPath = storePath();
    const cli = claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 });
    if (!cli.held) throw new Error('unreachable');

    const watch = stubWatch();
    const resident = startResidentSentinel({
      watch,
      dbPath,
      source: 'viz-server',
      intervalMs: 10_000,
    });
    expect(resident.health().armed).toBe(false);
    expect(resident.health().reason).toBe('lease-held');
    expect(resident.health().incumbent?.source).toBe('cli');

    // A refused tick screens nothing: no duplicate rows.
    vi.advanceTimersByTime(2_000);
    expect(watch.calls).toBe(0);

    cli.lease.release();
    vi.advanceTimersByTime(10_000);
    expect(resident.health().armed).toBe(true);
    expect(watch.calls).toBe(1);
    resident.stop();
  });

  it('stops appending the moment the lease is taken from under it', () => {
    const dbPath = storePath();
    const watch = stubWatch();
    const resident = startResidentSentinel({
      watch,
      dbPath,
      source: 'viz-server',
      intervalMs: 10_000,
    });
    vi.advanceTimersByTime(2_000);
    expect(watch.calls).toBe(1);

    // An operator starts the CLI: it takes over.
    const cli = claimSentinelWatch(dbPath, { source: 'cli', intervalMs: 20_000 });
    expect(cli.held).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(watch.calls).toBe(1);
    expect(resident.health().armed).toBe(false);
    expect(['lease-lost', 'lease-held']).toContain(resident.health().reason);
    resident.stop();
  });
});

describe('the timer never holds a host open', () => {
  it('lets a process that holds only the watch exit by itself', () => {
    // THE PROCESS BOUNDARY, because that is where the claim lives: an unref'd
    // handle is invisible to fake timers, and the failure it prevents is a viz
    // server that will not die. A ref'd interval here hangs until the timeout
    // and fails; unref'd, node runs out of work and exits 0.
    vi.useRealTimers();
    const dbPath = storePath();
    const script = [
      "import { startResidentSentinel } from './src/sentinel/resident.ts';",
      'startResidentSentinel({',
      '  watch: { tick: () => ({ runs: [], emitted: [], skipped: [] }) },',
      `  dbPath: ${JSON.stringify(dbPath)},`,
      "  source: 'cli',",
      '  intervalMs: 600000,',
      '});',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      timeout: 20_000,
      encoding: 'utf8',
    });
    expect(result.error?.message ?? '').not.toMatch(/ETIMEDOUT/);
    expect(result.signal, `stderr: ${result.stderr}`).toBeNull();
    expect(result.status).toBe(0);
  });
});

describe('the environment surface', () => {
  it('arms by default and never refuses to boot over a typo', () => {
    // Deliberately not `vizAuthEnabled`'s throw: that variable decides whether
    // a deployment is authenticated. This one decides whether a zero-token
    // reader runs, and refusing to boot would trade the whole visualizer for a
    // misspelled word.
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    expect(vizSentinelEnabled({}, warn)).toBe(true);
    expect(vizSentinelEnabled({ ATOMA_VIZ_SENTINEL: '1' }, warn)).toBe(true);
    expect(vizSentinelEnabled({ ATOMA_VIZ_SENTINEL: 'true' }, warn)).toBe(true);
    expect(vizSentinelEnabled({ ATOMA_VIZ_SENTINEL: '0' }, warn)).toBe(false);
    expect(vizSentinelEnabled({ ATOMA_VIZ_SENTINEL: 'false' }, warn)).toBe(false);
    expect(warnings).toEqual([]);
    expect(vizSentinelEnabled({ ATOMA_VIZ_SENTINEL: 'yes' }, warn)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('watching anyway');
  });

  it('reads the cost threshold through one helper, and refuses nonsense quietly', () => {
    expect(sentinelCostAlertFromEnv({})).toBeNull();
    expect(sentinelCostAlertFromEnv({ ATOMA_SENTINEL_COST_ALERT_USD: '2.50' })).toBe(2.5);
    expect(sentinelCostAlertFromEnv({ ATOMA_SENTINEL_COST_ALERT_USD: '0' })).toBeNull();
    expect(sentinelCostAlertFromEnv({ ATOMA_SENTINEL_COST_ALERT_USD: 'lots' })).toBeNull();
    expect(sentinelIntervalFromEnv({ ATOMA_VIZ_SENTINEL_INTERVAL_MS: '5000' })).toBe(5000);
    // Under a second is not an interval, it is a busy loop on the HTTP thread.
    expect(sentinelIntervalFromEnv({ ATOMA_VIZ_SENTINEL_INTERVAL_MS: '10' })).toBeNull();
  });

  it('reads the trajectory floor through one helper: armed by default, off on request, default on nonsense', () => {
    expect(sentinelTrajectoryMinScoreFromEnv({})).toBe(0.5);
    expect(sentinelTrajectoryMinScoreFromEnv({ ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE: '0.35' })).toBe(0.35);
    expect(sentinelTrajectoryMinScoreFromEnv({ ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE: 'off' })).toBeNull();
    expect(sentinelTrajectoryMinScoreFromEnv({ ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE: '0' })).toBeNull();
    // Unlike the cost threshold, nonsense must not silently DISARM the one rule
    // that is on by default: the default floor stands and only `off` disarms.
    expect(sentinelTrajectoryMinScoreFromEnv({ ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE: 'lots' })).toBe(0.5);
    expect(sentinelTrajectoryMinScoreFromEnv({ ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE: '1.5' })).toBe(0.5);
  });

  /**
   * The platform is INJECTED, so this suite exercises every regime from
   * whichever host it runs on — the ubuntu CI included. Both banners printed
   * `caffeinate -i -m` unconditionally, which is a command a Linux machine
   * does not have and advice a Windows machine cannot use (observed
   * 2026-09-01 on a win32 host).
   */
  it('names the host own sleep inhibitor, and says nothing where there is nothing to say', () => {
    expect(sleepInhibitorHint('darwin')).toBe('caffeinate -i -m');
    expect(sleepInhibitorHint('linux')).toMatch(/^systemd-inhibit /);
    // Silence on win32 is the ANSWER, not a gap: the obligation is "alongside
    // long runs", and `runHostSupported` refuses to start one there at all.
    expect(sleepInhibitorHint('win32')).toBeNull();
    expect(runHostSupported('win32')).toBe(false);
    // An unlisted POSIX platform is silent for the ordinary reason: unchecked.
    expect(sleepInhibitorHint('freebsd')).toBeNull();
    // Whatever a host returns, it is a command a banner can print verbatim.
    for (const platform of ['darwin', 'linux'] as const) {
      const hint = sleepInhibitorHint(platform)!;
      expect(hint.trim()).toBe(hint);
      expect(hint).not.toContain('\n');
    }
  });
});
