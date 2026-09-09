import { eventLabel } from '../contracts/platformEvents.js';
import { TRAJECTORY_DRIFT_DEFAULT_MIN_SCORE } from '../contracts/trajectory.js';
import {
  claimSentinelWatch,
  type SentinelWatchIncumbent,
  type SentinelWatchLease,
  type SentinelWatchSource,
} from './lease.js';
import {
  safeTick,
  SENTINEL_DEFAULT_INTERVAL_MS,
  type SentinelTickReport,
  type SentinelWatch,
} from './watch.js';

/**
 * THE RESIDENT SHELL — a watch that lives inside a host process.
 *
 * `runSentinelLoop` (watch.ts) is the CLI's shell: it blocks until a signal.
 * This is the server's: it arms a timer and gets out of the way. One tick
 * definition (`SentinelWatch.tick`), one containment path (`safeTick`), two
 * shells, because "block until told to stop" and "ride an HTTP server's
 * lifetime" are genuinely different shapes.
 *
 * THE TIMER IS UNREF'ED, for the reason the auth sweep timer beside it is: the
 * listening socket is what keeps the server alive, and the watch must never be
 * why a process refuses to exit. There is no signal handler here and the host
 * registers none — `stop()` is a test seam and a lifecycle nicety, not the
 * shutdown path. A SIGKILLed host leaves its lease row behind, which is
 * exactly what staleness reclaim is for.
 *
 * THE LEASE IS A PER-TICK FACT, not a boot decision. A boot-time claim that
 * failed would leave the server blind until someone restarted it — the CLI
 * that held the watch could exit thirty seconds later and nothing would
 * notice. So every tick asserts ownership first: hold it and screen, or record
 * why not and screen nothing. Both directions heal themselves.
 *
 * The tick is fully SYNCHRONOUS — `readBoundedJson` is `readFileSync` plus
 * `JSON.parse`, and the journal is better-sqlite3 — so no two ticks can
 * interleave and there is nothing to guard. Said here so nobody adds a lock
 * for a race that cannot occur.
 */

/** Consecutive failures after which the watch stops claiming to watch. */
export const SENTINEL_FAILURE_LIMIT = 3;

export type SentinelArmedReason =
  /** Watching. */
  | 'armed'
  /** No journal on this path, so nothing to write to. Banner only. */
  | 'ungated'
  /** ATOMA_VIZ_SENTINEL=0. */
  | 'disabled'
  /** Another live watch holds this store. */
  | 'lease-held'
  /** We held it and lost it: something else took over. */
  | 'lease-lost'
  /** Three ticks in a row threw. Not watching, and saying so. */
  | 'failing'
  /** `stop()` was called. */
  | 'stopped';

export interface SentinelHealth {
  readonly armed: boolean;
  readonly reason: SentinelArmedReason;
  readonly source: SentinelWatchSource;
  readonly intervalMs: number;
  readonly startedAt: string;
  readonly armedSince: string | null;
  readonly lastTickAt: string | null;
  readonly lastTickMs: number | null;
  readonly ticks: number;
  readonly runsScreenedLastTick: number;
  readonly skippedLastTick: number;
  readonly emittedSinceBoot: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /** The watch holding this store when we are not it. */
  readonly incumbent: SentinelWatchIncumbent | null;
}

export interface ResidentSentinel {
  /** Test seam and lifecycle nicety. NOT the host's shutdown path. */
  stop(): void;
  health(): SentinelHealth;
  /** One tick, now, for tests that will not wait for a timer. */
  tickNow(): SentinelTickReport | null;
}

export interface ResidentSentinelOptions {
  /**
   * A tick, and nothing more. Asking for the whole class would make every
   * test of this shell construct a journal and a corpus to exercise a timer.
   */
  readonly watch: Pick<SentinelWatch, 'tick'>;
  /** Product store holding the journal — the lease is keyed by it. */
  readonly dbPath: string;
  readonly source: SentinelWatchSource;
  readonly intervalMs?: number;
  readonly label?: string;
  readonly now?: () => Date;
  readonly logger?: (line: string) => void;
}

export function startResidentSentinel(options: ResidentSentinelOptions): ResidentSentinel {
  const intervalMs = Math.max(1_000, options.intervalMs ?? SENTINEL_DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => {});
  const startedAt = now().toISOString();

  let lease: SentinelWatchLease | null = null;
  let reason: SentinelArmedReason = 'lease-held';
  let armedSince: string | null = null;
  let incumbent: SentinelWatchIncumbent | null = null;
  let lastTickAt: string | null = null;
  let lastTickMs: number | null = null;
  let ticks = 0;
  let runsScreenedLastTick = 0;
  let skippedLastTick = 0;
  let emittedSinceBoot = 0;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let stopped = false;

  /** Hold the watch, or say who does. Cheap in the steady state: one UPDATE. */
  const holdLease = (): boolean => {
    if (lease) {
      if (lease.heartbeat(now())) return true;
      // The row is no longer ours. Something took over — a CLI an operator
      // started on purpose, most likely — so stop appending and let the next
      // tick find out whether it is still there.
      lease = null;
      reason = 'lease-lost';
      armedSince = null;
      log('lost the watch lease — another watch took over this store');
    }
    const claim = claimSentinelWatch(options.dbPath, {
      source: options.source,
      intervalMs,
      ...(options.label ? { label: eventLabel(options.label, 60) } : {}),
      now,
    });
    if (!claim.held) {
      incumbent = claim.incumbent;
      if (reason !== 'lease-lost') reason = 'lease-held';
      return false;
    }
    lease = claim.lease;
    incumbent = null;
    reason = 'armed';
    armedSince = now().toISOString();
    if (claim.displaced) {
      log(
        `took over the watch from ${claim.displaced.source} pid ${claim.displaced.ownerPid}`
      );
    }
    return true;
  };

  const tick = (): SentinelTickReport | null => {
    if (stopped) return null;
    if (!holdLease()) {
      runsScreenedLastTick = 0;
      skippedLastTick = 0;
      return null;
    }
    const startedMs = Date.now();
    const report = safeTick(options.watch, (line) => {
      lastError = line;
      log(line);
    });
    lastTickAt = now().toISOString();
    lastTickMs = Date.now() - startedMs;
    ticks += 1;
    if (!report) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= SENTINEL_FAILURE_LIMIT) {
        // Three passes in a row that produced nothing but an error is not a
        // watch. Say so rather than keep a timer that reports health.
        reason = 'failing';
        armedSince = null;
        clearInterval(timer);
        lease?.release();
        lease = null;
        log(`stopping after ${consecutiveFailures} consecutive failed ticks`);
      }
      return null;
    }
    consecutiveFailures = 0;
    runsScreenedLastTick = report.runs.length;
    skippedLastTick = report.skipped.length;
    emittedSinceBoot += report.emitted.length;
    return report;
  };

  // OWNERSHIP IS SETTLED SYNCHRONOUSLY, the first screen is not. The host
  // prints a banner line the moment it starts listening, and "off — lease
  // held" would be a lie there if the claim were deferred to the first tick.
  // One cheap transaction at boot; the reading of traces waits.
  holdLease();

  // A first look sooner than the interval — an operator who opens the screen
  // right after boot should not read "never ticked" for twenty seconds — but
  // not inside the boot path either, where it would delay `listen`.
  const primer = setTimeout(tick, Math.min(2_000, intervalMs));
  primer.unref();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    stop(): void {
      stopped = true;
      clearTimeout(primer);
      clearInterval(timer);
      lease?.release();
      lease = null;
      reason = 'stopped';
      armedSince = null;
    },
    tickNow: tick,
    health(): SentinelHealth {
      return {
        armed: reason === 'armed',
        reason,
        source: options.source,
        intervalMs,
        startedAt,
        armedSince,
        lastTickAt,
        lastTickMs,
        ticks,
        runsScreenedLastTick,
        skippedLastTick,
        emittedSinceBoot,
        consecutiveFailures,
        lastError,
        incumbent,
      };
    },
  };
}

/** Health for a host that is not watching at all, so the shape is never null. */
export function unarmedSentinelHealth(
  reason: SentinelArmedReason,
  source: SentinelWatchSource,
  startedAt: string,
  incumbent: SentinelWatchIncumbent | null = null
): SentinelHealth {
  return {
    armed: false,
    reason,
    source,
    intervalMs: 0,
    startedAt,
    armedSince: null,
    lastTickAt: null,
    lastTickMs: null,
    ticks: 0,
    runsScreenedLastTick: 0,
    skippedLastTick: 0,
    emittedSinceBoot: 0,
    consecutiveFailures: 0,
    lastError: null,
    incumbent,
  };
}

export const VIZ_SENTINEL_ENV = 'ATOMA_VIZ_SENTINEL';
export const SENTINEL_INTERVAL_ENV = 'ATOMA_VIZ_SENTINEL_INTERVAL_MS';
export const SENTINEL_COST_ALERT_ENV = 'ATOMA_SENTINEL_COST_ALERT_USD';
export const SENTINEL_TRAJECTORY_MIN_SCORE_ENV = 'ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE';

/**
 * THE HOST'S OWN WAY to hold a machine awake beside a long run, for the two
 * banners that carry that obligation — this file's server host and
 * `src/cli/sentinel.ts`. Both printed `caffeinate -i -m` unconditionally, so a
 * Linux operator was handed a command their machine does not have and a
 * Windows one was handed macOS advice (observed 2026-09-01 on a win32 host).
 *
 * `null` means SAY NOTHING, and on win32 that is the correct answer rather
 * than a gap: the obligation exists "alongside long runs", and a run cannot
 * start on a platform `runHostSupported` refuses ([src/run](../run/platform.ts)).
 * Inventing a Windows incantation would be advice for a situation that cannot
 * arise. An unlisted POSIX platform is silent for the ordinary reason — nobody
 * has checked what it ships.
 */
export function sleepInhibitorHint(
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === 'darwin') return 'caffeinate -i -m';
  // systemd-inhibit takes the command to hold the lock around; `sleep
  // infinity` is the idiom for "until I stop it".
  if (platform === 'linux') return 'systemd-inhibit --what=idle:sleep sleep infinity';
  return null;
}

/**
 * Armed by default, and a typo must never cost the operator the visualizer.
 *
 * Deliberately NOT `vizAuthEnabled`'s throw-on-garbage shape. That variable
 * decides whether a deployment is authenticated, where refusing to boot is the
 * safe answer; this one decides whether a zero-token reader runs, where
 * refusing to boot would trade a whole product surface for a misspelled word.
 * It warns loudly and arms.
 */
export function vizSentinelEnabled(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): boolean {
  const raw = env[VIZ_SENTINEL_ENV];
  if (raw === undefined) return true;
  const value = raw.trim();
  if (value === '' || value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  warn(`${VIZ_SENTINEL_ENV}="${raw}" is not one of 0, false, 1, true — watching anyway`);
  return true;
}

/** ONE reader for the cost threshold, shared by both hosts. Invalid → off. */
export function sentinelCostAlertFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env[SENTINEL_COST_ALERT_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * ONE reader for the trajectory floor, shared by both hosts. Unlike the cost
 * threshold this rule is ARMED by default — Stage A of the trajectory design
 * exists to collect the rows that calibration needs — so nonsense falls back
 * to the default rather than to silence, and only an explicit `off` (or `0`)
 * disarms it.
 */
export function sentinelTrajectoryMinScoreFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env[SENTINEL_TRAJECTORY_MIN_SCORE_ENV];
  if (raw === undefined || raw.trim() === '') return TRAJECTORY_DRIFT_DEFAULT_MIN_SCORE;
  // `null` is a VALUE here (disarmed), so no `??`: only an unparsable string falls back.
  const parsed = parseTrajectoryMinScore(raw);
  return parsed === undefined ? TRAJECTORY_DRIFT_DEFAULT_MIN_SCORE : parsed;
}

/**
 * `off`, `0`, `false` or `none` → null (disarmed); a number in (0, 1] → that
 * floor; anything else → undefined, so each caller chooses its own fallback.
 */
export function parseTrajectoryMinScore(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === '0' || value === 'false' || value === 'none') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

/** Interval override, for tests and for an operator who wants a slower watch. */
export function sentinelIntervalFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env[SENTINEL_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? Math.trunc(value) : null;
}
