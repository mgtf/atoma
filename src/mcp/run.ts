/**
 * The MUTATING half of the MCP surface: starting a task run, watching it, and
 * cancelling it.
 *
 * WHY A CHILD PROCESS AND NOT `runTask` IN-PROCESS — four independent blockers,
 * any one of which is fatal, all verified in the source rather than assumed:
 *   1. `runTask` NEVER SETTLES. `src/run/runner.ts` ends its success path on
 *      `await new Promise(() => {})` so a delivered run's server stays
 *      reachable. Awaiting it inside a tool handler means the tool call never
 *      returns.
 *   2. IT EXITS THE PROCESS on every other path — the failure branch, the
 *      watchdog, a bad `--seed`, a bad timeout, and `makeAnthropicClient` with
 *      no credential all call `process.exit`. In-process, any of those kills
 *      the MCP server mid-session.
 *   3. IT FLOODS STDOUT, and in MCP stdio STDOUT IS THE PROTOCOL. The runner's
 *      logger is hardcoded to `console.log`/`console.debug`, wired into both
 *      `ctx.logger` and the tool backend with no seam to substitute it, and it
 *      prints the whole `--- result ---` block including unbounded
 *      model-authored output. The peer's frame reader THROWS on a non-JSON
 *      line — stricter than atoma's own container protocol, which drops them.
 *   4. IT MUTATES PROCESS GLOBALS: it writes the three skill-lifecycle env
 *      vars, deletes `ANTHROPIC_API_KEY`, and registers SIGINT/SIGTERM
 *      handlers on every call without ever removing them.
 *
 * WHY START+POLL AND NOT ONE BLOCKING CALL: a run takes minutes, and a host's
 * tool-call tolerance is not ours to assume. Polling also gives cancellation
 * somewhere to live, which a blocking call cannot have — and a cancelled run
 * still closes its trace (`cancelled: true`) because the abort routes through
 * the same graceful group-kill.
 *
 * The process discipline itself is NOT reimplemented here: `spawnRun` from the
 * burn-in harness is the one sanctioned run driver, and its kill sequence was
 * measured (a naive re-implementation leaks nine browser processes per web
 * run). This module assembles argv, validates it, serialises runs and maps the
 * captured log through `parseRunLog` — the same parser that produces the
 * committed cost curve.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeConfigFailure,
  newestTraceDuration,
  newestTraceName,
  parseRunLog,
  signalRunProcessGroup,
  spawnRun,
  type RunStats,
} from '../cli/burnin.js';
import { findLaunchable } from '../run/profiles/index.js';
import { runsDirPath } from './readers.js';
import {
  acquireRunLease,
  RunLockBusyError,
  type RunLease,
  type RunLeaseAcquirer,
} from './runLock.js';

/** Matches the runner's own claude-cli default (15 min). */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** Bound on how many finished runs stay queryable in memory. */
const MAX_RECORDS = 20;
/** Bound on the live progress tail kept per run. */
const PROGRESS_TAIL_CHARS = 2000;

export interface RunRecordPublic {
  readonly runId: string;
  readonly status: 'running' | 'cancelling' | 'finished' | 'cancelled' | 'spawn-failed';
  readonly goal: string;
  readonly family: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly logPath: string;
  readonly elapsedS: number;
  readonly progress: { chunks: number; tail: string };
  readonly stats?: RunStats;
  readonly durationS?: number | null;
  readonly trace?: string;
  readonly configFailureSuspected?: boolean;
  readonly hint?: string;
}

interface RunRecord {
  readonly runId: string;
  status: RunRecordPublic['status'];
  readonly goal: string;
  readonly family: string;
  readonly startedAtMs: number;
  readonly startedAt: string;
  endedAt?: string;
  readonly logPath: string;
  readonly abort: AbortController;
  readonly lease: RunLease;
  childPid?: number;
  chunks: number;
  tail: string;
  stats?: RunStats;
  durationS?: number | null;
  trace?: string;
  configFailureSuspected?: boolean;
  hint?: string;
}

const records = new Map<string, RunRecord>();
let inFlight: RunRecord | null = null;
let seq = 0;
const idleWaiters = new Set<() => void>();

/**
 * The atoma repo root, derived from this module's own location so the server
 * works from ANY cwd a host launches it in — `src/mcp/run.ts` and
 * `dist/mcp/run.js` are both two levels down. Verified by the presence of
 * package.json rather than assumed, because a wrong root surfaces as
 * `npm run run:build` failing with a missing-script error that reads as an
 * ordinary run failure.
 */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..');
  return existsSync(join(candidate, 'package.json')) ? candidate : process.cwd();
}

export interface StartRunInput {
  goal: string;
  family?: string;
  timeoutMs?: number;
  learnSkills?: boolean;
  promoteSkills?: boolean;
  directSkills?: boolean;
  container?: boolean;
  egress?: boolean;
  keepWorkspace?: boolean;
}

export class RunRejected extends Error {}

/**
 * The subset of `spawnRun` this module needs, as an injectable parameter.
 *
 * It exists so the serialisation and bookkeeping can be tested WITHOUT
 * spawning `npm run run:build` — a test that really starts a run would spend
 * quota, take minutes and mutate the store. The default IS `spawnRun`, so
 * production has no seam to get wrong and nothing test-only lives in module
 * state.
 */
export type RunDriver = (opts: Parameters<typeof spawnRun>[0]) => Promise<string>;

/**
 * Assemble the child's argv from a CLOSED set of flags.
 *
 * No raw argv and no free-form flag string is accepted, and the goal always
 * goes LAST: `parseRunnerArgs` warns-and-DISCARDS any token it does not
 * recognise that starts with `--`, then falls back to the profile's DEFAULT
 * goal — so a goal like `--clean-workspace something` would archive the
 * caller's workspace and silently run the Minesweeper build instead of the
 * task they asked for. Only `--seed` consumes a following token, and `--seed`
 * is deliberately not exposed (it copies an arbitrary host directory into the
 * workspace).
 */
export function buildRunArgs(input: StartRunInput): string[] {
  const args: string[] = [];
  if (input.learnSkills === false) args.push('--no-learn-skills');
  if (input.promoteSkills === false) args.push('--no-promote-skills');
  if (input.directSkills === false) args.push('--no-direct-skills');
  if (input.container) args.push('--container');
  if (input.egress) args.push('--egress');
  return args;
}

/** Every flag `buildRunArgs` can emit, for the surface test to compare. */
export const RUN_FLAGS: readonly string[] = [
  '--no-learn-skills',
  '--no-promote-skills',
  '--no-direct-skills',
  '--container',
  '--egress',
];

export function validateStartInput(input: StartRunInput): { family: string; timeoutMs: number } {
  const goal = (input.goal ?? '').trim();
  if (goal.length === 0) throw new RunRejected('goal is empty');
  if (goal.startsWith('--')) {
    throw new RunRejected(
      `goal must not start with "--" (it would be parsed as a flag, discarded, and the family's DEFAULT goal would run instead): ${goal.slice(0, 60)}`
    );
  }
  const familyId = input.family ?? 'build';
  // `findLaunchable` is the ONLY family resolver, and it already refuses
  // traversal-shaped ids.
  if (!findLaunchable(familyId)) {
    throw new RunRejected(
      `unknown family "${familyId}" — known: ${['build'].join(', ')} (call atoma_families)`
    );
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || Math.floor(timeoutMs) !== timeoutMs) {
    throw new RunRejected(`timeoutMs must be a positive integer in ms (got ${String(input.timeoutMs)})`);
  }
  return { family: familyId, timeoutMs };
}

function publish(r: RunRecord): RunRecordPublic {
  return {
    runId: r.runId,
    status: r.status,
    goal: r.goal,
    family: r.family,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    logPath: r.logPath,
    elapsedS: Math.round(((r.endedAt ? Date.parse(r.endedAt) : Date.now()) - r.startedAtMs) / 1000),
    progress: { chunks: r.chunks, tail: r.tail },
    stats: r.stats,
    durationS: r.durationS,
    trace: r.trace,
    configFailureSuspected: r.configFailureSuspected,
    hint: r.hint,
  };
}

function remember(r: RunRecord): void {
  records.set(r.runId, r);
  if (records.size > MAX_RECORDS) {
    // Oldest first; never evict the one still running.
    for (const [id, rec] of records) {
      if (records.size <= MAX_RECORDS) break;
      if (rec.status !== 'running' && rec.status !== 'cancelling') records.delete(id);
    }
  }
}

function finishRun(record: RunRecord): void {
  record.lease.release();
  if (inFlight === record) inFlight = null;
  if (!inFlight) {
    for (const resolveIdle of idleWaiters) resolveIdle();
    idleWaiters.clear();
  }
}

export function waitForRunIdle(): Promise<void> {
  if (!inFlight) return Promise.resolve();
  return new Promise<void>((resolveIdle) => idleWaiters.add(resolveIdle));
}

function requestCancellation(record: RunRecord, reason: string): void {
  if (record.status !== 'running') return;
  record.status = 'cancelling';
  record.hint = `Cancellation requested: ${reason}. Waiting for the child process group to exit.`;
  record.abort.abort(new Error(reason));
}

/**
 * Start a run and return immediately.
 *
 * SERIALISED BY DESIGN, and the refusal is the feature. Three independent
 * single-tenancy facts make a parallel run produce plausible-looking WRONG
 * results rather than an error: the build workspace is ONE shared directory
 * that `--clean-workspace` archives wholesale, trace attribution is
 * newest-mtime-since (so two runs cross-attribute), and AGENTS.md requires the
 * machine to itself for comparable economics. The burn-in harness gets this
 * free from its sequential loop; a server has to enforce it.
 */
export function startRun(
  input: StartRunInput,
  driver: RunDriver = spawnRun,
  acquireLease: RunLeaseAcquirer = acquireRunLease
): RunRecordPublic {
  if (inFlight) {
    throw new RunRejected(
      `a run is already in flight (${inFlight.runId}, started ${inFlight.startedAt}). atoma serialises runs: the build workspace is shared, trace attribution is newest-file-wins, and concurrent runs make the cost numbers incomparable. Wait for it or call atoma_run_cancel.`
    );
  }
  const { family, timeoutMs } = validateStartInput(input);
  const goal = input.goal.trim();
  const root = repoRoot();
  const startedAtMs = Date.now();
  const stamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
  const runId = `mcp-${stamp}-${++seq}`;
  const logPath = join(root, 'burnin', 'logs', 'mcp', `${runId}.log`);
  let lease: RunLease;
  try {
    lease = acquireLease(runId);
  } catch (err) {
    if (err instanceof RunLockBusyError) throw new RunRejected(err.message);
    throw err;
  }

  const record: RunRecord = {
    runId,
    status: 'running',
    goal,
    family,
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    logPath,
    abort: new AbortController(),
    lease,
    chunks: 0,
    tail: '',
  };
  remember(record);
  inFlight = record;

  const runsDir = runsDirPath();
  // Fire and forget: the promise is the record's own completion handler. It
  // ALWAYS settles now — `spawnRun` gained an 'error' listener and a guarded
  // log write precisely because a server cannot survive a promise that never
  // resolves.
  let driven: Promise<string>;
  try {
    driven = driver({
      goal,
      timeoutMs,
      logPath,
      cwd: root,
      signal: record.abort.signal,
      cleanWorkspace: input.keepWorkspace !== true,
      extraArgs: buildRunArgs(input),
      extraEnv: {
        // The provider must be DECIDED, never inherited. The Claude Code
        // environment carries an ANTHROPIC_API_KEY that `makeAnthropicClient`
        // prefers FIRST (documented as the #1 auth trap), and in this project it
        // is dead — a run reaching the direct-API path dies in ~15s and reads as
        // a config failure. claude-cli on the local subscription is the path
        // that works, verified from a Claude-Code-spawned child. An explicit
        // host setting still wins.
        ATOMA_LLM: process.env['ATOMA_LLM'] ?? 'claude-cli',
      },
      onChunk: (chunk) => {
        record.chunks++;
        record.tail = (record.tail + chunk).slice(-PROGRESS_TAIL_CHARS);
      },
      onSpawn: (pid) => {
        record.childPid = pid;
        record.lease.attachChild(pid);
      },
    });
  } catch (err) {
    driven = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  void driven.then(
    (log) => {
      try {
        const stats = parseRunLog(log);
        const durationS = newestTraceDuration(runsDir, startedAtMs);
        record.stats = stats;
        record.durationS = durationS;
        record.trace = newestTraceName(runsDir, startedAtMs) || undefined;
        record.endedAt = new Date().toISOString();
        const wasCancelled = record.status === 'cancelling';
        record.status = wasCancelled ? 'cancelled' : 'finished';
        if (wasCancelled) {
          // A cancelled run prints neither completion banner nor failure
          // banner, so `parseRunLog` — correctly, per its own contract —
          // reports outcome 'error' with null economics.
          record.hint =
            'Cancelled on request. `stats.outcome` reads "error" and the economics are null because the run was terminated before printing its summary — that is the cancellation, not a failure. The trace is closed and marked cancelled.';
        } else if (looksLikeConfigFailure(stats, durationS)) {
          record.configFailureSuspected = true;
          record.hint =
            'The run died almost instantly having spent nothing — that is the signature of a MISCONFIGURED launch (dead API key, wrong provider, missing `claude /login`), not of a hard task. Check the log.';
        }
      } catch (err) {
        record.status = record.status === 'cancelling' ? 'cancelled' : 'spawn-failed';
        record.endedAt = new Date().toISOString();
        record.hint = `run post-processing failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        finishRun(record);
      }
    },
    (err: unknown) => {
      const wasCancelled = record.status === 'cancelling';
      record.status = wasCancelled ? 'cancelled' : 'spawn-failed';
      record.endedAt = new Date().toISOString();
      record.hint = wasCancelled
        ? 'Cancelled on request before the run produced a summary.'
        : `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      finishRun(record);
    }
  );

  return publish(record);
}

export function runStatus(opts: { runId?: string } = {}): unknown {
  if (opts.runId) {
    const r = records.get(opts.runId);
    return r ? publish(r) : { note: `no run with id "${opts.runId}"` };
  }
  return {
    inFlight: inFlight?.runId ?? null,
    runs: [...records.values()].map(publish).reverse(),
  };
}

/**
 * Cancel by aborting, which routes into the SAME graceful group-kill every
 * other stop uses: SIGTERM, a 5s grace window, then SIGKILL. That ordering is
 * what lets the run close its trace and let Chrome reap its own helper fleet —
 * a bare group SIGKILL is uncatchable and was measured leaking nine puppeteer
 * processes per web run.
 */
export function cancelRun(opts: { runId?: string } = {}): unknown {
  const target = opts.runId ? records.get(opts.runId) : inFlight;
  if (!target) return { note: opts.runId ? `no run with id "${opts.runId}"` : 'no run in flight' };
  if (target.status !== 'running') return { note: `run ${target.runId} is already ${target.status}`, run: publish(target) };
  requestCancellation(target, 'requested through atoma_run_cancel');
  return {
    cancelled: target.runId,
    note: 'SIGTERM sent to the run’s process group; SIGKILL follows after a 5s grace window. The slot remains occupied until the child exits and the trace is closed. Poll atoma_run_status for final status.',
    run: publish(target),
  };
}

/** Graceful server shutdown: abort the active group and wait for its exit. */
export async function shutdownRuns(reason = 'MCP server shutting down'): Promise<void> {
  if (!inFlight) return;
  requestCancellation(inFlight, reason);
  await waitForRunIdle();
}

/** Synchronous hard-exit backstop; graceful shutdown should have run first. */
export function forceStopActiveRunOnExit(): void {
  if (!inFlight) return;
  if (inFlight.childPid !== undefined) {
    signalRunProcessGroup(inFlight.childPid, 'SIGKILL');
  }
  inFlight.lease.release();
}

/** Test seam: forget every record so a suite can assert on a clean slate. */
export function resetRunsForTest(): void {
  if (inFlight) {
    inFlight.abort.abort(new Error('test reset'));
    inFlight.lease.release();
  }
  records.clear();
  inFlight = null;
  for (const resolveIdle of idleWaiters) resolveIdle();
  idleWaiters.clear();
  seq = 0;
}
