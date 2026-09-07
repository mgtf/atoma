/**
 * atoma burn-in harness — run a batch of tasks through the REAL build
 * pipeline (`npm run run:build`, one clean workspace per task), extract
 * per-run economics, and append them to a CSV so the cost-decay curve is a
 * regenerable measurement instead of a session anecdote.
 *
 *   npm run burnin                                  # burnin/tasks-default.json
 *   npm run burnin -- my-tasks.json --out out.csv --timeout 900000
 *   npm run burnin -- --family cli                  # filter by family
 *
 * Task file shape:
 *   { "tasks": [ { "id": "cli-slug", "family": "cli", "goal": "…" }, … ] }
 *
 * Each run also matures the skill/trust counters as a side effect — the
 * harness IS usage. Every batch appended to the same CSV extends the curve.
 *
 * Implementation notes:
 *   - The child is spawned in its own process group and group-killed
 *     (#7c pattern): a delivered run that started a server stays alive on
 *     purpose ("Press Ctrl+C when you are done testing"), so the harness
 *     terminates it once "✓ build finished" and the metrics table have been
 *     printed. Failed runs exit on their own.
 *   - Metrics and lifecycle counts come from the runner's final
 *     `ATOMA_RUN_STATS` JSON epilogue. Interrupted runs fall back to the
 *     human `TOTAL` table and exact log markers. Duration comes from the
 *     newest trace in ./runs when available, wall time otherwise.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tierSelectors } from '../run/providers.js';
import { referencedTransports } from '../contracts/modelSelector.js';
import { runHostSupported, unsupportedRunHostMessage } from '../run/platform.js';
import {
  parseRunStatsEpilogue,
  type RunStats,
} from '../contracts/runStats.js';

export type { RunStats } from '../contracts/runStats.js';

export interface BurninTask {
  readonly id: string;
  readonly family: string;
  readonly goal: string;
}

export function burninProviderInfo(
  env: NodeJS.ProcessEnv = process.env
): { transports: string[]; label: string; estimatedCost: boolean } {
  const transports = referencedTransports(tierSelectors(env));
  return {
    transports,
    label: transports.join('+'),
    // Direct Anthropic-only is the one configuration whose estimated API
    // pricing roughly matches the billing path. Subscription/local/routed
    // transports need the explicit equivalence caveat.
    estimatedCost: transports.length !== 1 || transports[0] !== 'anthropic-api',
  };
}

/** Parse one model row of `formatSummary` (e.g. `claude-opus-5  1  2  1552  0  0.0672`). */
function modelCalls(log: string, marker: RegExp): number {
  let calls = 0;
  for (const line of log.split('\n')) {
    if (!marker.test(line)) continue;
    const cols = line.trim().split(/\s{2,}/);
    const n = Number(cols[1]);
    if (Number.isFinite(n)) calls += n;
  }
  return calls;
}

/**
 * Extract the economics of one run from its captured stdout. Exported for
 * tests — pure text in, stats out. Tolerant by design: a missing TOTAL row
 * yields nulls rather than a crash (the CSV keeps the row with its outcome
 * so a hung/killed run still shows up in the curve).
 */
export function parseRunLog(log: string): RunStats {
  const machine = parseRunStatsEpilogue(log);
  if (machine) return machine;

  // THREE MARKERS, AND THEY DO NOT RANK THE WAY A FLAT LIST WOULD.
  //
  // The RUNNER'S OWN verdict outranks the completion banner. A run takes one
  // path, so both appearing means one of them was not printed by the runner —
  // and the reachable way that happens is that a TENANT'S GOAL contains the
  // string, because the goal is echoed verbatim at second zero (`runner.ts`,
  // `task: ${task.description}`) and `projectGoalSchema` permits newlines.
  // Reproduced 2026-08-23 against these parsers: a goal carrying
  // `✓ build finished` read as `delivered` out of a log whose own verdict was
  // `✖ build failed`. Refusing to grant delivery credit on ambiguity does not
  // make the banner unforgeable — nothing in a text stream can be — it makes
  // forging it useless.
  //
  // THE HARNESS'S REAP MARKER RANKS BELOW THE BANNER, and must: a delivered run
  // keeps a server alive on purpose, so the harness terminates it, and the
  // marker it appends would otherwise relabel a healthy run. Its own text says
  // the runner "printed no completion or failure marker of its own" — so a
  // banner falsifies its premise, and the banner wins.
  //
  // Which is why the runner's timeout is matched WITH its `⏱`, not by the bare
  // `TIMEOUT after` these two share. Conflating them is what made the first
  // version of this fix break the reap race.
  const runnerFailed = /--- run failed ---|⏱ TIMEOUT after/.test(log);
  const completed = /✓ build finished/.test(log);
  const harnessReaped = /--- hard timeout ---/.test(log);

  let costUsd: number | null = null;
  let llmCalls: number | null = null;
  // Last TOTAL row wins (a failed run prints one table only; delivered runs too).
  // READ BEFORE the outcome is decided, because it is evidence about it.
  for (const line of log.split('\n')) {
    if (!/^TOTAL\s/.test(line.trim())) continue;
    const cols = line.trim().split(/\s{2,}/);
    const calls = Number(cols[1]);
    const cost = Number(cols[cols.length - 1]);
    if (Number.isFinite(calls)) llmCalls = calls;
    if (Number.isFinite(cost)) costUsd = cost;
  }

  // A BANNER THAT OUTLIVED A REAP MUST BRING ITS ACCOUNTING. Ranking the reap
  // marker below the banner is right for the case it was written for: a
  // delivered run keeps a server alive on purpose and the harness terminates
  // it, so the marker would otherwise relabel a healthy run. But it made the
  // OTHER case free (2026-08-27, 2.9): a goal echoing `✓ build finished` at
  // second zero, in a run that then hung and was hard-reaped, read as
  // `delivered` with no cost at all — a forged row in the very CSVs the
  // benchmark measures from.
  //
  // The two are told apart by evidence rather than by rank: a run that really
  // finished printed its cost table, and a hung one never got there. So when
  // both markers are present and NO accounting is, the banner is unsupported
  // and the reap stands. Not a new mechanism — the same text, read for what it
  // implies. The receipt designed 2026-08-23 stays unbuilt (COOLING-OFF).
  const bannerUnsupported = completed && harnessReaped && costUsd === null && llmCalls === null;
  const outcome: RunStats['outcome'] = runnerFailed
    ? 'failed'
    : completed && !bannerUnsupported
      ? 'delivered'
      : harnessReaped
        ? 'failed'
        : 'error';

  const opusCalls = modelCalls(log, /claude-opus/);
  const sonnetCalls = modelCalls(log, /claude-sonnet/);
  const haikuCalls = modelCalls(log, /claude-haiku/);
  return {
    outcome,
    costUsd,
    llmCalls,
    opusCalls,
    sonnetCalls,
    haikuCalls,
    otherCalls:
      llmCalls === null ? 0 : Math.max(0, llmCalls - opusCalls - sonnetCalls - haikuCalls),
    deterministicPhases: (log.match(/ran via deterministic dispatch/g) ?? []).length,
    // Prose fallback only: count the runner-owned escalation marker, never
    // arbitrary model prose or routine prefilter decisions containing the
    // same word.
    escalations: (log.match(/\bescalation — branched\b/g) ?? []).length,
    learnedSkills: (log.match(/learned new skill/g) ?? []).length,
    learnedEventSkills: (log.match(/learned event skill/g) ?? []).length,
    promotions: (log.match(/promoted to kind:script/g) ?? []).length,
    refusals: (log.match(/not promotable:/g) ?? []).length,
    compileErrors: (log.match(/skill compile errored:/g) ?? []).length,
    demotions: (log.match(/demoted to llm after/g) ?? []).length,
    dispatchFallbacks: (log.match(/falling back to the LLM loop/g) ?? []).length,
    // Prose fallback, runner-owned marker only — same discipline as the
    // escalation counter above.
    uncoveredObligations: (log.match(/proof obligation is UNCOVERED/g) ?? []).length,
  };
}

export function toCsvRow(args: {
  readonly ts: string;
  readonly taskId: string;
  readonly family: string;
  readonly stats: RunStats;
  readonly durationS: number | null;
  readonly trace: string;
  readonly provider?: string;
}): string {
  const s = args.stats;
  const cells = [
    args.ts,
    args.taskId,
    args.family,
    s.outcome,
    s.costUsd ?? '',
    args.durationS ?? '',
    s.llmCalls ?? '',
    s.opusCalls,
    s.sonnetCalls,
    s.haikuCalls,
    s.deterministicPhases,
    s.escalations,
    s.learnedSkills,
    s.promotions,
    s.refusals,
    s.demotions,
    s.dispatchFallbacks,
    args.trace,
    args.provider ?? '',
    s.otherCalls,
    s.learnedEventSkills,
    s.compileErrors,
  ];
  return cells.map((c) => String(c)).join(',');
}

export const CSV_HEADER =
  'timestamp,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,deterministic_phases,escalations,learned_skills,promotions,refusals,demotions,dispatch_fallbacks,trace,provider,other_calls,learned_event_skills,compile_errors';

/**
 * Create or reconcile the output CSV's header before ANY row is appended.
 *
 * Two cases:
 *   - absent file → written with the current header;
 *   - any header that is not this exact one → refused with an error.
 *     Measured 2026-08-14: `--out` pointed at compare-frontier's CSV
 *     (header `timestamp,arm,…`) and the batch appended 22-field rows under a
 *     17-column header — every header-driven consumer then read shifted
 *     columns and the arm distinction was unrecoverable. A row written under a
 *     header it does not match is worse than no row: refuse before the first
 *     append.
 */
export function ensureBurninCsvHeader(outAbsPath: string): void {
  if (!existsSync(outAbsPath)) {
    writeFileSync(outAbsPath, CSV_HEADER + '\n', 'utf8');
    return;
  }
  const cur = readFileSync(outAbsPath, 'utf8');
  const nl = cur.indexOf('\n');
  const curHeader = nl === -1 ? cur : cur.slice(0, nl);
  if (curHeader === CSV_HEADER) return;
  throw new Error(
    `refusing to append burn-in rows to ${outAbsPath}: its header does not match the burn-in schema ` +
      `(found "${curHeader.slice(0, 80)}…", expected "${CSV_HEADER.slice(0, 80)}…"). ` +
      `That file belongs to another writer — pick a different --out path.`
  );
}

/**
 * Signature of a MISCONFIGURED launch, not a task failure: the run died
 * almost instantly and spent nothing (dead API key → 401 on the first
 * call, wrong provider env, missing login…). Observed live: `npm run
 * burnin` against a dead key marched through the task list at
 * two phantom failed rows per minute against a revoked key. One config
 * failure should abort the batch, not pollute the curve N times.
 */
export function looksLikeConfigFailure(stats: RunStats, durationS: number | null): boolean {
  if (stats.outcome === 'delivered') return false;
  // A deliberate kill is not a misconfigured launch, however fast and cheap.
  if (stats.outcome === 'cancelled') return false;
  const fast = durationS !== null && durationS <= 15;
  const spentNothing = stats.costUsd === null || stats.costUsd === 0;
  return fast && spentNothing;
}

/**
 * Definitive provider entitlement/quota failures named in the child log.
 *
 * Unlike the fast+zero-spend heuristic above, a limit can arrive AFTER useful
 * calls already spent tokens — observed live when Claude's weekly limit hit
 * during task 1 of 4. That first row cost $0.1513/96s; later tasks each made a
 * prefilter/plan call before receiving the same denial, so neither "zero cost"
 * nor "two consecutive identical shapes" fired and all four environmental
 * failures polluted results.csv. An explicit provider denial is conclusive on
 * the first occurrence and must abort before appending any row.
 *
 * Deliberately excludes transient 429/rate-limit text: backoff/retry belongs
 * to transports, while weekly/credit/quota exhaustion cannot recover inside
 * this batch.
 */
export function looksLikeProviderLimitFailure(log: string): boolean {
  // Model-authored artefacts can print arbitrary text, including "upgrade for
  // access". A delivered marker is authoritative and must win over content.
  if (/✓ build finished/.test(log)) return false;
  return [
    /you(?:'|’)ve hit your (?:weekly|monthly|usage) limit\b/i,
    /\b(?:weekly|monthly|usage) limit\b[^\n]{0,120}\bresets?\b/i,
    /\b(?:insufficient|exceeded|exhausted)[ _-]?quota\b/i,
    /\bquota (?:has been )?(?:exceeded|exhausted)\b/i,
    /\bcredit balance is too low\b/i,
    /\bmodel requires a subscription\b/i,
    /\bupgrade for access\b/i,
  ].some((pattern) => pattern.test(log));
}

export function summarize(
  rows: { family: string; outcome: string; costUsd: number | null }[]
): string {
  const byFamily = new Map<string, { n: number; delivered: number; cost: number; costN: number }>();
  for (const r of rows) {
    const f = byFamily.get(r.family) ?? { n: 0, delivered: 0, cost: 0, costN: 0 };
    f.n++;
    if (r.outcome === 'delivered') f.delivered++;
    if (r.costUsd !== null) {
      f.cost += r.costUsd;
      f.costN++;
    }
    byFamily.set(r.family, f);
  }
  const lines = ['family    runs  delivered  mean_cost_usd', '--------  ----  ---------  -------------'];
  for (const [fam, f] of [...byFamily.entries()].sort()) {
    const mean = f.costN > 0 ? (f.cost / f.costN).toFixed(4) : '—';
    lines.push(
      `${fam.padEnd(8)}  ${String(f.n).padStart(4)}  ${String(f.delivered).padStart(9)}  ${mean.padStart(13)}`
    );
  }
  return lines.join('\n');
}

export function newestTraceDuration(runsDir: string, since: number): number | null {
  try {
    const files = readdirSync(runsDir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => join(runsDir, f))
      .filter((p) => statSync(p).mtimeMs >= since);
    if (files.length === 0) return null;
    const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
    const run = JSON.parse(readFileSync(newest, 'utf8')) as { startedAt?: string; endedAt?: string };
    if (!run.startedAt || !run.endedAt) return null;
    return Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
  } catch {
    return null;
  }
}

export function newestTraceName(runsDir: string, since: number): string {
  try {
    const files = readdirSync(runsDir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => join(runsDir, f))
      .filter((p) => statSync(p).mtimeMs >= since);
    if (files.length === 0) return '';
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

/**
 * Run one goal through `npm run run:build` in its own process group;
 * group-killed once it reports completion (a delivered run parks alive by
 * design so a started server stays reachable).
 *
 * EXPORTED so the benchmark driver reuses this exact process discipline
 * rather than growing a second copy of it. The kill sequence below is not
 * incidental — it was measured, and a naive re-implementation leaks nine
 * browser processes per web run.
 *
 * `extraArgs` are appended AFTER the flags and BEFORE the goal, because
 * `parseRunnerArgs` takes the first non-flag argument as the goal.
 *
 * THE LAST SIX OPTIONS WERE ADDED FOR THE MCP SERVER, and each closes a real
 * gap rather than adding a knob — every default reproduces the previous
 * behaviour exactly, so burnin and the benchmark are byte-for-byte unaffected.
 *   - `cwd`: was hardcoded to `process.cwd()`. An MCP host launches its server
 *     with an arbitrary working directory, where `npm run run:build` fails with
 *     a missing-script error that reads as outcome 'error'.
 *   - `npmScript`: lets the profile registry remain the authority on how a
 *     family launches. Burn-in defaults to run:build:dev so each batch child
 *     compiles the source as it stands at that task's start.
 *   - `signal`: the ONLY way to cancel from outside. The promise resolves on
 *     the child's exit and the child was otherwise unreachable, so a caller
 *     that owns a run's lifecycle (the MCP server does) had no handle to stop
 *     it with. Aborting group-kills through the SAME graceful sequence, so a
 *     cancelled run still closes its trace and reaps its browser.
 *   - `onChunk`: progress for a caller that cannot show the child's stdout.
 *     Deliberately a callback and not a stream: the accumulated `log` is
 *     unbounded, and a consumer that wants to bound it must see the pieces.
 *   - `onSpawn`: exposes only the detached process-group id, so the MCP owner
 *     can reap it on its own hard-exit path without growing a second spawn or
 *     kill implementation.
 *   - `cleanWorkspace`: `--clean-workspace` was unconditional, which is right
 *     for measurement (every batch row starts from the same state) and
 *     surprising in an interactive host, where it ARCHIVES the deliverable the
 *     caller may have just asked about. Default stays true.
 * Two settle bugs were fixed here at the same time, both of which presented as
 * a promise that never resolves — tolerable in a batch script that a human
 * watches, a hung tool call in a server:
 *   - `writeFileSync(logPath, …)` runs INSIDE the exit handler BEFORE
 *     `resolveRun`, so a missing log directory threw there and killed the
 *     settle. It is now mkdir'd up front and the write cannot block the
 *     resolve.
 *   - there was no `'error'` listener at all, so a spawn that fails outright
 *     (npm not on PATH, bad cwd) resolved never. It now settles with a
 *     synthetic log, which `parseRunLog` reads as outcome 'error'.
 */
export const RUN_KILL_GRACE_MS = 5000;
export const RUN_KILL_CONFIRM_MS = 2000;

/**
 * Group signals only ever target a REAL child process group. `process.kill`
 * gives magic meanings to small values — `-1` signals every process the
 * user owns, `0`/`-0` the caller's own group — so a pgid of 0 or 1 reaching
 * these helpers is never a run: it is DB corruption, a hostile write to the
 * lease store (the MCP run lock feeds `child_pgid` straight from
 * ~/.atoma/mcp-run-lock.db, a file the run itself can reach by absolute
 * path), or a recycled value. The owner-pid path already guarded `pid <= 0`
 * (`processExists` in runLock.ts); the group helpers must too, or stale
 * lease recovery becomes a user-wide SIGKILL primitive.
 */
function isValidRunPgid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

export function runProcessGroupExists(pid: number): boolean {
  if (!isValidRunPgid(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'EPERM'
    );
  }
}

/** Signal a detached run's whole process group, then its leader as fallback. */
export function signalRunProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!isValidRunPgid(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* not a group leader, or already gone */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function waitForRunProcessGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (runProcessGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return true;
}

export const DEFAULT_HARD_KILL_MARGIN_MS = 180_000;
export const UNKILLABLE_BACKSTOP_EXTRA_MS = 60_000;

/**
 * Last-resort settle guard for the batch loop's per-task await.
 *
 * `spawnRun` FAILS CLOSED when a run's process group survives SIGKILL: the
 * promise stays pending, which is correct under the MCP server (its own
 * hard-exit backstop takes over) but left `npm run burnin` awaiting forever
 * with no timer still armed — a silent batch wedge (2026-08-15 wedging
 * investigation, layer B). An unkillable group is a machine fault, so this
 * THROWS with attribution and the batch aborts instead of stacking more work
 * on a poisoned host. The timer is always cleared on settle.
 */
export async function withUnkillableBackstop<T>(
  work: Promise<T>,
  totalMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label}: the runner's process group survived SIGKILL — spawnRun still unsettled ` +
                `${Math.round(totalMs / 1000)}s after launch. The machine needs manual cleanup; ` +
                'batch aborted (fail closed).'
            )
          );
        }, totalMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The one graceful termination primitive for detached run groups.
 *
 * A leader exiting is not enough: grandchildren keep the process group alive.
 * Confirm ESRCH after SIGTERM, escalate to SIGKILL, then confirm again.
 */
export async function terminateRunProcessGroup(
  pid: number,
  graceMs = RUN_KILL_GRACE_MS,
  confirmMs = RUN_KILL_CONFIRM_MS
): Promise<boolean> {
  if (!runProcessGroupExists(pid)) return true;
  signalRunProcessGroup(pid, 'SIGTERM');
  if (await waitForRunProcessGroupGone(pid, graceMs)) return true;
  signalRunProcessGroup(pid, 'SIGKILL');
  return waitForRunProcessGroupGone(pid, confirmMs);
}

/**
 * Synthetic log epilogue for a run the HARD timer reaped.
 *
 * A wedged runner prints NONE of `parseRunLog`'s markers, so before this the
 * reaped run read as outcome 'error' with null economics and no hint —
 * indistinguishable from any other failure in the CSV and in the MCP run
 * record (2026-08-14 review, MCP §). The runner already owns the
 * `TIMEOUT after` marker (`parseRunLog` maps it to outcome 'failed'), so the
 * harness appends the same marker plus an explicit attribution, mirroring the
 * `--- spawn failed ---` precedent on the spawn-error path. Exported for the
 * focused unit test: the hard timer itself sits behind a 180s margin no test
 * should wait out.
 */
export function hardTimeoutLogEpilogue(hardDeadlineMs: number): string {
  return (
    `\n--- hard timeout --- TIMEOUT after ${Math.round(hardDeadlineMs / 1000)}s: ` +
    'the harness reaped a wedged runner past its deadline (it printed no completion or failure marker of its own).\n'
  );
}

export function spawnRun(opts: {
  readonly goal: string;
  readonly timeoutMs: number;
  readonly logPath: string;
  readonly extraArgs?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * Complete child environment. Omitted by operator/burn-in callers so their
   * historical host snapshot is preserved; the authenticated project control
   * plane supplies an allowlisted snapshot so unrelated host secrets cannot
   * cross into a tenant worker.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** npm script to execute. Defaults to the source-level run:build:dev. */
  readonly npmScript?: string;
  /** Working directory for `npm run`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Abort to group-kill the run through the graceful sequence. */
  readonly signal?: AbortSignal;
  /** Called with each stdout/stderr chunk as it arrives. */
  readonly onChunk?: (chunk: string) => void;
  /** Called once with the detached PGID; a throw terminates the group and rejects. */
  readonly onSpawn?: (pid: number) => void;
  /** Pass `--clean-workspace`. Defaults to true (the measurement default). */
  readonly cleanWorkspace?: boolean;
  /**
   * Margin past `timeoutMs` before the hard reap. The 180s default leaves the
   * runner's own watchdog (timeoutMs + 60s) room to exit cleanly first. A
   * test seam: no test should wait three minutes to see the branch fire.
   */
  readonly hardKillMarginMs?: number;
  /** Run host, for the platform refusal below. A test seam; defaults to this one. */
  readonly platform?: NodeJS.Platform;
}): Promise<string> {
  const { goal, timeoutMs, logPath } = opts;
  const hardKillMarginMs = opts.hardKillMarginMs ?? DEFAULT_HARD_KILL_MARGIN_MS;
  const platform = opts.platform ?? process.platform;
  return new Promise((resolveRun, rejectRun) => {
    // Ahead of the spawn: the write below happens on the settle path, and a
    // throw there is what used to strand the promise.
    try {
      mkdirSync(dirname(resolve(logPath)), { recursive: true });
    } catch {
      /* the write is guarded too — a log we cannot keep must not lose the run */
    }
    // THE RUN HOST CONTRACT, enforced where runs start (see run/platform.ts).
    // Everything below this line assumes POSIX: `npm` as an executable, a
    // detached process GROUP, and `process.kill(-pid)`. On a host without
    // them a run died with a bare `spawn npm ENOENT` several processes deep
    // — or worse, reported a successful cancellation over orphans that kept
    // running. Refuse through the SAME shape as any other spawn that never
    // happened, so every caller (burn-in CSV, project coordinator, MCP run
    // record) reads outcome 'error' with the reason in the log instead of
    // learning a new failure mode.
    if (!runHostSupported(platform)) {
      const refusal = `\n--- spawn failed --- ${unsupportedRunHostMessage(platform)}\n`;
      try {
        writeFileSync(logPath, refusal, 'utf8');
      } catch {
        /* an unwritable log must not strand the caller — see the docstring */
      }
      resolveRun(refusal);
      return;
    }
    const child = spawn(
      'npm',
      [
        'run',
        opts.npmScript ?? 'run:build:dev',
        '--',
        ...(opts.cleanWorkspace === false ? [] : ['--clean-workspace']),
        ...(opts.extraArgs ?? []),
        goal,
      ],
      {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...(opts.env ?? process.env),
          // Batch children must not inherit experiment-only runner modes from
          // the operator's shell. A stale `export ATOMA_BASELINE=1` used to
          // turn an entire burn-in into the control arm without any CSV field
          // revealing it; ATOMA_SEED similarly made supposedly clean tasks
          // inherit an unrelated fixture. Explicit caller overrides still win
          // below (benchmarks pass their intent as CLI flags).
          ATOMA_BASELINE: undefined,
          ATOMA_SEED: undefined,
          ATOMA_BUILD_TIMEOUT_MS: String(timeoutMs),
          ...(opts.extraEnv ?? {}),
        },
      }
    );
    let log = '';
    let killTimer: NodeJS.Timeout | null = null;
    let termination: Promise<boolean> | null = null;
    const requestTermination = (): Promise<boolean> => {
      if (termination) return termination;
      if (child.pid !== undefined) {
        termination = terminateRunProcessGroup(child.pid);
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          /* spawn error path will settle */
        }
        termination = Promise.resolve(false);
      }
      return termination;
    };
    const onChunk = (c: Buffer): void => {
      const text = c.toString();
      log += text;
      opts.onChunk?.(text);
      // A delivered run that started a server idles forever by design —
      // terminate once the completion banner is in (metrics print before it).
      if (/✓ build finished/.test(log) && !killTimer) {
        killTimer = setTimeout(() => void requestTermination(), 1500);
      }
    };
    // Hard stop: task budget + generous teardown margin.
    let hardReaped = false;
    const hardTimer = setTimeout(() => {
      // Attribute the reap ONLY when nothing else asked for termination first:
      // a cancellation or delivered-banner kill that merely races this timer
      // is not a wedged runner, and stamping TIMEOUT onto it would relabel a
      // cancelled/delivered run as failed.
      if (!termination) hardReaped = true;
      void requestTermination();
    }, timeoutMs + hardKillMarginMs);
    // Cancellation rides the SAME graceful sequence as every other stop: an
    // abort must not become the bare group SIGKILL the sequence exists to
    // avoid (uncatchable ⇒ the run's teardown never runs ⇒ leaked browsers).
    const abortHandler = (): void => void requestTermination();
    if (opts.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener('abort', abortHandler, { once: true });
    }
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    // 'error' and 'exit' can BOTH fire (a spawn error still emits close/exit
    // in some failure modes), and resolving twice would silently drop the
    // second settle's log. First one wins.
    let settled = false;
    const settle = (logSoFar: string, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', abortHandler);
      // A hard-reaped runner printed none of parseRunLog's markers, so append
      // the runner-owned TIMEOUT marker HERE — before both the file write and
      // the resolve — so the log on disk and the resolved string agree, and
      // the caller's parseRunLog reads outcome 'failed' with an attribution
      // instead of a bare 'error' with null economics.
      const finalLog =
        hardReaped && !error ? logSoFar + hardTimeoutLogEpilogue(timeoutMs + hardKillMarginMs) : logSoFar;
      try {
        writeFileSync(logPath, finalLog, 'utf8');
      } catch {
        /* an unwritable log must not strand the caller — see the docstring */
      }
      if (error) rejectRun(error);
      else resolveRun(finalLog);
    };
    child.once('error', (err: Error) => {
      // No process ever ran, so there is nothing to parse: hand back a log
      // whose shape `parseRunLog` classifies as 'error'.
      settle(`${log}\n--- spawn failed --- ${err.message}\n`);
    });
    let spawnHookError: Error | undefined;
    child.once('exit', () => {
      void (async () => {
        const gone =
          child.pid === undefined
            ? true
            : await (termination ?? terminateRunProcessGroup(child.pid));
        // Fail closed: a surviving group keeps the promise (and MCP lease)
        // pending until the server's own hard-exit backstop takes over.
        if (!gone) return;
        settle(log, spawnHookError);
      })();
    });
    if (child.pid !== undefined) {
      try {
        opts.onSpawn?.(child.pid);
      } catch (err) {
        spawnHookError = err instanceof Error ? err : new Error(String(err));
        void requestTermination();
      }
    }
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let tasksPath = 'burnin/tasks-default.json';
  let outPath = 'burnin/results.csv';
  let timeoutMs = 900_000;
  let familyFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out') outPath = argv[++i] ?? outPath;
    else if (a === '--timeout') timeoutMs = Number(argv[++i] ?? timeoutMs);
    else if (a === '--family') familyFilter = argv[++i] ?? null;
    else if (!a.startsWith('--')) tasksPath = a;
  }

  const file = JSON.parse(readFileSync(resolve(tasksPath), 'utf8')) as { tasks: BurninTask[] };
  const tasks = file.tasks.filter((t) => !familyFilter || t.family === familyFilter);
  if (tasks.length === 0) {
    console.error(`no tasks to run (file: ${tasksPath}${familyFilter ? `, family: ${familyFilter}` : ''})`);
    process.exit(2);
  }

  const logsDir = resolve('burnin/logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  try {
    ensureBurninCsvHeader(resolve(outPath));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }

  const runsDir = resolve(process.env['ATOMA_RUNS_DIR'] ?? 'runs');
  const provider = burninProviderInfo();
  console.log(
    `burn-in: ${tasks.length} task(s), timeout ${timeoutMs}ms each, provider ${provider.label}`
  );
  if (provider.estimatedCost) {
    console.log(
      'cost basis: estimated API-price equivalent from recorded model tiers — not local/subscription billing'
    );
  }
  const summaryRows: { family: string; outcome: string; costUsd: number | null }[] = [];
  let consecutiveConfigFailures = 0;

  for (const task of tasks) {
    const ts = new Date().toISOString();
    const started = Date.now();
    console.log(`\n▶ ${task.id} (${task.family}) …`);
    const log = await withUnkillableBackstop(
      spawnRun({
        goal: task.goal,
        timeoutMs,
        logPath: join(logsDir, `${task.id}-${ts.replace(/[:.]/g, '-')}.log`),
      }),
      timeoutMs + DEFAULT_HARD_KILL_MARGIN_MS + UNKILLABLE_BACKSTOP_EXTRA_MS,
      task.id
    );
    const stats = parseRunLog(log);
    const durationS = newestTraceDuration(runsDir, started) ?? Math.round((Date.now() - started) / 1000);
    const trace = newestTraceName(runsDir, started);
    if (looksLikeProviderLimitFailure(log) && !argv.includes('--force')) {
      console.error(
        `\n✗ provider quota/entitlement denial detected after ${task.id}; batch ABORTED before appending\n` +
          `  this environmental failure to ${outPath}. The trace and task log remain available for diagnosis.\n` +
          `  Restore provider access or select another provider, then re-run (--force to retain denial rows).`
      );
      process.exit(1);
    }
    appendFileSync(
      resolve(outPath),
      toCsvRow({
        ts,
        taskId: task.id,
        family: task.family,
        stats,
        durationS,
        trace,
        provider: provider.label,
      }) + '\n',
      'utf8'
    );
    summaryRows.push({ family: task.family, outcome: stats.outcome, costUsd: stats.costUsd });
    console.log(
      `  ${stats.outcome === 'delivered' ? '✓' : '✗'} ${stats.outcome}  $${stats.costUsd ?? '?'}  ${durationS}s  ` +
        `llm=${stats.llmCalls ?? '?'} (O${stats.opusCalls}/S${stats.sonnetCalls}/H${stats.haikuCalls}` +
        `${stats.otherCalls > 0 ? `/+${stats.otherCalls}` : ''})  ` +
        `deterministic=${stats.deterministicPhases}  learned=${stats.learnedSkills}` +
        (stats.learnedEventSkills ? `  recovery-learned=${stats.learnedEventSkills}` : '') +
        (stats.promotions ? `  ⚡promoted=${stats.promotions}` : '') +
        (stats.compileErrors ? `  ⚠compile-error=${stats.compileErrors}` : '') +
        (stats.demotions ? `  🛡️demoted=${stats.demotions}` : '') +
        (stats.dispatchFallbacks ? `  ↩fallback=${stats.dispatchFallbacks}` : '')
    );
    // Abort on the CONFIG-FAILURE signature — at any position, not just the
    // first task. A credential that dies mid-batch (expired token, exhausted
    // quota, revoked key) produces the same instant zero-spend rows, and
    // burning the remaining tasks against it only pollutes the curve. Two in
    // a row is the trigger: one isolated fast failure can legitimately be a
    // task that bounced off a guard.
    if (looksLikeConfigFailure(stats, durationS)) consecutiveConfigFailures++;
    else consecutiveConfigFailures = 0;
    const abortThreshold = summaryRows.length === 1 ? 1 : 2;
    if (consecutiveConfigFailures >= abortThreshold && !argv.includes('--force')) {
      console.error(
        `\n✗ ${consecutiveConfigFailures} task(s) failed almost instantly with zero spend — the signature of a\n` +
          `  misconfigured or expired provider (dead ANTHROPIC_API_KEY? a sub: tier without its login?\n` +
          `  exhausted quota mid-batch?), not of a hard task. Batch ABORTED after ${summaryRows.length}/${tasks.length}\n` +
          `  task(s) to avoid filling the curve with phantom rows.\n` +
          `  Check the last log under burnin/logs/, fix the env, and re-run (--force to override).`
      );
      process.exit(1);
    }
  }

  console.log('\n== batch summary ==');
  console.log(summarize(summaryRows));
  console.log(`\nCSV appended: ${outPath} — the curve grows with every batch.`);
}

// Only run as a CLI, never on import (tests import the pure helpers).
if (process.argv[1] && /burnin\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
