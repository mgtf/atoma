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
 *   - Metrics come from the run's own stdout (the `TOTAL` row of
 *     `formatSummary`) — the same numbers a human reads — plus counts of
 *     the load-bearing log markers (deterministic dispatch, escalations,
 *     learned skills). Duration comes from the newest trace in ./runs when
 *     available, wall time otherwise.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export interface BurninTask {
  readonly id: string;
  readonly family: string;
  readonly goal: string;
}

export interface RunStats {
  readonly outcome: 'delivered' | 'failed' | 'error';
  readonly costUsd: number | null;
  readonly llmCalls: number | null;
  readonly opusCalls: number;
  readonly sonnetCalls: number;
  readonly haikuCalls: number;
  readonly deterministicPhases: number;
  readonly escalations: number;
  readonly learnedSkills: number;
  /** llm→script compilations that succeeded in this run. */
  readonly promotions: number;
  /** compile attempts the compiler REFUSED as irreducible. */
  readonly refusals: number;
  /** script→llm demotions (the safety net firing). */
  readonly demotions: number;
  /** dispatches that hit a contract failure and fell back to the LLM loop. */
  readonly dispatchFallbacks: number;
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
  const outcome: RunStats['outcome'] = /✓ build finished/.test(log)
    ? 'delivered'
    : /--- run failed ---|TIMEOUT after/.test(log)
      ? 'failed'
      : 'error';

  let costUsd: number | null = null;
  let llmCalls: number | null = null;
  // Last TOTAL row wins (a failed run prints one table only; delivered runs too).
  for (const line of log.split('\n')) {
    if (!/^TOTAL\s/.test(line.trim())) continue;
    const cols = line.trim().split(/\s{2,}/);
    const calls = Number(cols[1]);
    const cost = Number(cols[cols.length - 1]);
    if (Number.isFinite(calls)) llmCalls = calls;
    if (Number.isFinite(cost)) costUsd = cost;
  }

  return {
    outcome,
    costUsd,
    llmCalls,
    opusCalls: modelCalls(log, /claude-opus/),
    sonnetCalls: modelCalls(log, /claude-sonnet/),
    haikuCalls: modelCalls(log, /claude-haiku/),
    deterministicPhases: (log.match(/ran via deterministic dispatch/g) ?? []).length,
    escalations: (log.match(/escalat/gi) ?? []).length,
    learnedSkills: (log.match(/learned new skill/g) ?? []).length,
    promotions: (log.match(/promoted to kind:script/g) ?? []).length,
    refusals: (log.match(/not promotable:/g) ?? []).length,
    demotions: (log.match(/demoted to llm after/g) ?? []).length,
    dispatchFallbacks: (log.match(/falling back to the LLM loop/g) ?? []).length,
  };
}

export function toCsvRow(args: {
  readonly ts: string;
  readonly taskId: string;
  readonly family: string;
  readonly stats: RunStats;
  readonly durationS: number | null;
  readonly trace: string;
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
  ];
  return cells.map((c) => String(c)).join(',');
}

export const CSV_HEADER =
  'timestamp,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,deterministic_phases,escalations,learned_skills,promotions,refusals,demotions,dispatch_fallbacks,trace';

/**
 * Signature of a MISCONFIGURED launch, not a task failure: the run died
 * almost instantly and spent nothing (dead API key → 401 on the first
 * call, wrong provider env, missing login…). Observed live: `npm run
 * burnin` without ATOMA_LLM=claude-cli marched through the task list at
 * two phantom failed rows per minute against a revoked key. One config
 * failure should abort the batch, not pollute the curve N times.
 */
export function looksLikeConfigFailure(stats: RunStats, durationS: number | null): boolean {
  if (stats.outcome === 'delivered') return false;
  const fast = durationS !== null && durationS <= 15;
  const spentNothing = stats.costUsd === null || stats.costUsd === 0;
  return fast && spentNothing;
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
 *     family launches. Burn-in defaults to run:build exactly as before.
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

export function runProcessGroupExists(pid: number): boolean {
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

export function spawnRun(opts: {
  readonly goal: string;
  readonly timeoutMs: number;
  readonly logPath: string;
  readonly extraArgs?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** npm script to execute. Defaults to run:build. */
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
}): Promise<string> {
  const { goal, timeoutMs, logPath } = opts;
  return new Promise((resolveRun, rejectRun) => {
    // Ahead of the spawn: the write below happens on the settle path, and a
    // throw there is what used to strand the promise.
    try {
      mkdirSync(dirname(resolve(logPath)), { recursive: true });
    } catch {
      /* the write is guarded too — a log we cannot keep must not lose the run */
    }
    const child = spawn(
      'npm',
      [
        'run',
        opts.npmScript ?? 'run:build',
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
          ...process.env,
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
    const hardTimer = setTimeout(() => void requestTermination(), timeoutMs + 180_000);
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
    const settle = (finalLog: string, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', abortHandler);
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
  if (!existsSync(resolve(outPath))) {
    writeFileSync(resolve(outPath), CSV_HEADER + '\n', 'utf8');
  } else {
    // HEADER MIGRATION (#10): the lifecycle columns (promotions, refusals,
    // demotions, dispatch_fallbacks) were appended to the row format while
    // an existing CSV kept its old header — silent mismatch that every new
    // consumer had to rediscover. Rewrite the header line in place when it
    // is outdated; data rows are untouched (the viz parser is
    // position-tolerant for legacy 14-col rows by design).
    const cur = readFileSync(resolve(outPath), 'utf8');
    const nl = cur.indexOf('\n');
    const curHeader = nl === -1 ? cur : cur.slice(0, nl);
    if (curHeader !== CSV_HEADER && curHeader.startsWith('timestamp,task_id')) {
      writeFileSync(resolve(outPath), CSV_HEADER + (nl === -1 ? '\n' : cur.slice(nl)), 'utf8');
      console.log('ℹ results.csv header migrated to the current column set');
    }
  }

  const runsDir = resolve(process.env['ATOMA_RUNS_DIR'] ?? 'runs');
  console.log(`burn-in: ${tasks.length} task(s), timeout ${timeoutMs}ms each, provider ${process.env['ATOMA_LLM'] ?? 'anthropic'}`);
  const summaryRows: { family: string; outcome: string; costUsd: number | null }[] = [];
  let consecutiveConfigFailures = 0;

  for (const task of tasks) {
    const ts = new Date().toISOString();
    const started = Date.now();
    console.log(`\n▶ ${task.id} (${task.family}) …`);
    const log = await spawnRun({
      goal: task.goal,
      timeoutMs,
      logPath: join(logsDir, `${task.id}-${ts.replace(/[:.]/g, '-')}.log`),
    });
    const stats = parseRunLog(log);
    const durationS = newestTraceDuration(runsDir, started) ?? Math.round((Date.now() - started) / 1000);
    const trace = newestTraceName(runsDir, started);
    appendFileSync(resolve(outPath), toCsvRow({ ts, taskId: task.id, family: task.family, stats, durationS, trace }) + '\n', 'utf8');
    summaryRows.push({ family: task.family, outcome: stats.outcome, costUsd: stats.costUsd });
    console.log(
      `  ${stats.outcome === 'delivered' ? '✓' : '✗'} ${stats.outcome}  $${stats.costUsd ?? '?'}  ${durationS}s  ` +
        `llm=${stats.llmCalls ?? '?'} (O${stats.opusCalls}/S${stats.sonnetCalls}/H${stats.haikuCalls})  ` +
        `deterministic=${stats.deterministicPhases}  learned=${stats.learnedSkills}` +
        (stats.promotions ? `  ⚡promoted=${stats.promotions}` : '') +
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
          `  misconfigured or expired provider (dead ANTHROPIC_API_KEY? missing ATOMA_LLM=claude-cli?\n` +
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
