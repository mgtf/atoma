import type { PlatformEvent } from '../contracts/platformEvents.js';
import type { AnalyseResult } from './analyst.js';

/**
 * THE RESIDENT ANALYST — a host-process shell around `analyseTarget`, armed
 * inside the gated viz server the way the sentinel is.
 *
 * WHY THE JOURNAL IS THE TRIGGER. The coordinator journals `run.finished` for
 * every terminal project run, and `PlatformEventLog.subscribe` delivers rows
 * appended by this very process. That row is the ONE fact "a run ended" the
 * platform already records, so the analyst listens to it rather than polling
 * a store or inferring from timestamps. A run finished while the server was
 * down is not missed either: `backfill` re-queues what the store lists as
 * ended and un-analysed at boot.
 *
 * WHAT IT PROMISES. One analysis at a time, never while a run is active, and
 * never before the run has been quiet for `quietMs` — the same quiet period
 * that coalesces a burn-in batch to its end. A queued run that keeps finding
 * the machine busy is retried, not dropped; a run whose analysis throws is
 * recorded as failed and not retried (the CLI's `--run --force` redoes it).
 * The timer is unref'd, like the sentinel's: a host must never refuse to exit
 * because its analyst is waiting.
 *
 * WHY IT IS OPT-IN where the sentinel is opt-out: this spends the operator's
 * quota. `ATOMA_VIZ_ANALYST=1` is a decision, never a default.
 */

export const VIZ_ANALYST_ENV = 'ATOMA_VIZ_ANALYST';
export const ANALYST_QUIET_ENV = 'ATOMA_ANALYST_QUIET_MS';
export const ANALYST_BUDGET_ENV = 'ATOMA_ANALYST_BUDGET_USD';
export const RESIDENT_ANALYST_DEFAULT_QUIET_MS = 120_000;
export const RESIDENT_ANALYST_DEFAULT_POLL_MS = 30_000;

/** Off unless explicitly `1`/`true`; a typo stays off and says so. */
export function vizAnalystEnabled(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): boolean {
  const raw = env[VIZ_ANALYST_ENV];
  if (raw === undefined) return false;
  const value = raw.trim();
  if (value === '1' || value === 'true') return true;
  if (value === '' || value === '0' || value === 'false') return false;
  warn(`${VIZ_ANALYST_ENV}="${raw}" is not one of 0, false, 1, true — the analyst stays OFF`);
  return false;
}

export function analystQuietMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[ANALYST_QUIET_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export function analystBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[ANALYST_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface ResidentAnalystHealth {
  readonly armed: boolean;
  readonly quietMs: number;
  readonly queued: number;
  readonly inFlight: string | null;
  readonly analysed: number;
  readonly failed: number;
  readonly deferred: number;
  readonly lastResult: { runId: string; outcome: string; at: string } | null;
  readonly lastError: string | null;
}

export interface ResidentAnalyst {
  /** Test seam and lifecycle nicety, not the host's shutdown path. */
  stop(): void;
  health(): ResidentAnalystHealth;
  /** Queue a run by hand (boot backfill, tests). */
  enqueue(runId: string, finishedAtMs: number): void;
  /** Drain what is due, now, for tests that will not wait for a timer. */
  drainNow(): Promise<void>;
}

export interface ResidentAnalystOptions {
  /** `PlatformEventLog.subscribe`, or any bus with the same shape. */
  readonly subscribe: (listener: (event: PlatformEvent) => void) => () => void;
  readonly analyse: (runId: string) => Promise<AnalyseResult>;
  /** The shared idle predicate; a queued run waits while it says active. */
  readonly isActive: () => boolean;
  readonly quietMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly logger?: (line: string) => void;
}

export function startResidentAnalyst(options: ResidentAnalystOptions): ResidentAnalyst {
  const quietMs = options.quietMs ?? RESIDENT_ANALYST_DEFAULT_QUIET_MS;
  const pollMs = Math.max(1_000, options.pollMs ?? RESIDENT_ANALYST_DEFAULT_POLL_MS);
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? (() => {});

  const queue = new Map<string, number>(); // runId → finished at (ms)
  let inFlight: string | null = null;
  let analysed = 0;
  let failed = 0;
  let deferred = 0;
  let lastResult: ResidentAnalystHealth['lastResult'] = null;
  let lastError: string | null = null;
  let stopped = false;

  const unsubscribe = options.subscribe((event) => {
    if (event.kind !== 'run.finished' || !event.runId) return;
    if (!queue.has(event.runId)) {
      queue.set(event.runId, Date.parse(event.at) || now());
      log(`queued ${event.runId} (quiet ${Math.round(quietMs / 1000)}s)`);
    }
  });

  async function drain(): Promise<void> {
    if (inFlight || stopped) return;
    const due = [...queue.entries()]
      .filter(([, finishedAt]) => now() - finishedAt >= quietMs)
      .sort((a, b) => a[1] - b[1]);
    const next = due[0];
    if (!next) return;
    if (options.isActive()) {
      deferred += 1;
      log(`a run is active; ${queue.size} analysis(es) wait`);
      return;
    }
    const [runId] = next;
    queue.delete(runId);
    inFlight = runId;
    try {
      const result = await options.analyse(runId);
      lastResult = { runId, outcome: result.outcome, at: new Date(now()).toISOString() };
      if (result.outcome === 'analysed') analysed += 1;
      else if (result.outcome !== 'already-analysed' && result.outcome !== 'dry-run') failed += 1;
      if (result.outcome === 'refused-active') {
        // Not spent: a run started between the gate and the session. Back in line.
        queue.set(runId, now());
      }
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
      log(`analysis of ${runId} threw: ${lastError}`);
    } finally {
      inFlight = null;
    }
  }

  const timer = setInterval(() => {
    void drain();
  }, pollMs);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
    health() {
      return { armed: !stopped, quietMs, queued: queue.size, inFlight, analysed, failed, deferred, lastResult, lastError };
    },
    enqueue(runId, finishedAtMs) {
      if (!queue.has(runId)) queue.set(runId, finishedAtMs);
    },
    async drainNow() {
      // One pass per due run, so a test sees the whole backlog handled.
      let before = -1;
      while (before !== queue.size && !inFlight) {
        before = queue.size;
        await drain();
      }
    },
  };
}
