#!/usr/bin/env tsx
/**
 * atoma analyst — post-mortem verdicts on finished runs (stage 2 of
 * `docs/supervisor-design.md`).
 *
 *   npm run analyst                          # watch runs/, analyse each run as it finishes
 *   npm run analyst -- --once --backfill 2   # analyse the 2 newest un-analysed runs, exit
 *   npm run analyst -- --run <id> [--force]  # analyse one run now
 *   npm run analyst -- --dry-run ...         # everything except the model call
 *
 * Spends the operator's model quota and therefore NEVER runs beside a run:
 * activity is a live entry in the operator index or a held MCP run lease, the
 * same predicate the mender gates on. Read-only by construction — the child
 * session has Read, Glob and Grep and nothing else. Verdicts land under
 * `supervisor/verdicts/`, mechanism candidates in `supervisor/backlog.jsonl`
 * (cooling-off: never same-day), security incidents in `supervisor/ALERTS.jsonl`,
 * and every verdict is one `supervisor.verdict` row in the journal when this
 * checkout has a product store.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { storeDbPath } from '../core/stores.js';
import { mcpRunLockPath } from '../mcp/runLock.js';
import { PlatformEventLog } from '../platform/events.js';
import { hasProjectTables, ProjectStore } from '../projects/store.js';
import { dispatchConfigFromEnv, type DispatchConfig } from '../supervisor/dispatch.js';
import {
  ANALYST_DEFAULT_POLL_MS,
  ANALYST_DEFAULT_QUIET_MS,
  analyseRun,
  analyseTarget,
  pendingTargets,
  runAnalystLoop,
  type AnalystOptions,
} from '../supervisor/analyst.js';
import { analystProvider, looksPinned } from '../supervisor/session.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma analyst — post-mortem verdicts on finished runs

usage:
  npm run analyst [-- --once --backfill <n>] [--run <id>] [--dry-run] [--force]
                  [--quiet-ms <ms>] [--poll-ms <ms>] [--budget-usd <usd>]
                  [--timeout-ms <ms>] [--runs <dir>] [--supervisor-dir <dir>] [--db <path>]

what it does:
  Watches BOTH run corpora — the operator index and, when this store holds a
  tenant control plane, every finished project run — and once a run has been
  quiet for --quiet-ms and no run is active, drives ONE read-only headless claude session
  over a mechanical digest of its trace. The structured verdict is validated
  against src/contracts/supervisorVerdict.ts, written to supervisor/verdicts/,
  routed (mechanism candidates → backlog.jsonl, security → ALERTS.jsonl) and
  journaled as supervisor.verdict when this checkout has a product store.
  With ATOMA_MENDER_DISPATCH_REPO and _TOKEN set, every cited high-confidence
  defect is also sent to that repository's mender workflow (repository_dispatch)
  and journaled as mender.dispatched.

what it does NOT do:
  Run beside a run, write anything but its own outputs, or follow trace text.

provider:
  ATOMA_ANALYST_MODEL / ATOMA_ANALYST_BASE_URL / ATOMA_ANALYST_AUTH_TOKEN, read
  as a set and forwarded to the child session only. Default: the login
  subscription with a pinned claude-sonnet-5.

flags:
  --once                 analyse pending runs (see --backfill), then exit
  --backfill <n>         re-queue the n newest un-analysed finished runs
  --run <id>             analyse one run now (--force to redo an existing verdict)
  --dry-run              build the digest and print the session line; spend nothing
  --quiet-ms <ms>        quiet period before a finished run is analysed (default ${ANALYST_DEFAULT_QUIET_MS})
  --poll-ms <ms>         poll interval (default ${ANALYST_DEFAULT_POLL_MS})
  --budget-usd <usd>     spend ceiling per analysis (default 2)
  --timeout-ms <ms>      wall clock per analysis (default 900000)
  --runs <dir>           operator runs directory (default ATOMA_RUNS_DIR or ./runs)
  --supervisor-dir <dir> where verdicts live (default ./supervisor)
  --operator-only        do not read project runs even if this store has them
  --db <path>            product store holding the journal (default ATOMA_DB_PATH or ./atoma.db)
  --help                 show this help`;

function fail(message: string): never {
  process.stderr.write(`atoma analyst: ${message}\n`);
  process.exit(1);
}

function positiveNumber(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

function nonNegativeInteger(raw: string | undefined, label: string): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const args = parseCliArgs(process.argv, {
    booleanFlags: ['help', 'once', 'dry-run', 'force', 'operator-only'],
    valueFlags: ['run', 'backfill', 'quiet-ms', 'poll-ms', 'budget-usd', 'timeout-ms', 'runs', 'supervisor-dir', 'db'],
    undeclared: 'discard',
  });
  if (args.flags['help'] === 'true') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.undeclaredFlags.length > 0) fail(`unknown flag: ${args.undeclaredFlags[0]!}`);
  if (args.command !== null) fail(`unexpected argument: ${args.command}`);

  const repoRoot = process.cwd();
  const runsDir = resolve(args.flags['runs'] || process.env['ATOMA_RUNS_DIR'] || './runs');
  const supervisorDir = resolve(args.flags['supervisor-dir'] || './supervisor');
  const dbPath = args.flags['db'] || storeDbPath();
  const provider = analystProvider();
  if (!looksPinned(provider.model)) {
    process.stderr.write(
      `atoma analyst: "${provider.model}" is an alias, not a pinned model id — verdicts recorded under it are not comparable over time\n`
    );
  }
  if (provider.baseUrl && !provider.authToken) {
    process.stderr.write('atoma analyst: a base URL is set without an auth token — the endpoint will likely refuse\n');
  }

  // Journal only into a store that EXISTS: `PlatformEventLog.open` applies its
  // DDL, and an analyst must not bring a control plane into being by writing
  // to it. An ungated checkout keeps its file outputs and journals nothing.
  const journal = existsSync(dbPath) ? PlatformEventLog.open(dbPath) : null;
  // The tenant corpus is read only where the store ALREADY holds it, like the
  // sentinel: `ProjectStore.open` applies DDL, and a reader must not bring a
  // control plane into being by looking at it.
  const projectReader =
    args.flags['operator-only'] !== 'true' && existsSync(dbPath) && hasProjectTables(dbPath)
      ? ProjectStore.open(dbPath)
      : null;
  let dispatch: DispatchConfig | null = null;
  try {
    dispatch = dispatchConfigFromEnv();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const log = (line: string): void => void process.stdout.write(`[analyst ${new Date().toISOString()}] ${line}\n`);
  const warn = (line: string): void => void process.stderr.write(`[analyst ${new Date().toISOString()}] WARN ${line}\n`);
  const analyst: AnalystOptions = {
    repoRoot,
    runsDir,
    projectReader,
    dispatch,
    supervisorDir,
    leasePath: mcpRunLockPath(),
    provider,
    claudeCommand: process.env['ATOMA_SUPERVISOR_CMD_CLAUDE'] ?? 'claude',
    budgetUsd: positiveNumber(args.flags['budget-usd'], '--budget-usd', 2),
    timeoutMs: positiveNumber(args.flags['timeout-ms'], '--timeout-ms', 900_000),
    dryRun: args.flags['dry-run'] === 'true',
    force: args.flags['force'] === 'true',
    journal: journal ? (input) => void journal.append(input) : null,
    log,
    warn,
  };
  process.stdout.write(
    `atoma analyst — read-only post-mortem, never beside a run\n` +
      `  runs       ${runsDir}\n` +
      `  verdicts   ${supervisorDir}/verdicts\n` +
      `  projects   ${projectReader ? 'on (finished project_runs)' : args.flags['operator-only'] === 'true' ? 'off (--operator-only)' : 'off (no project control plane in this store)'}\n` +
      `  journal    ${journal ? dbPath : 'none (no product store at ' + dbPath + ')'}\n` +
      `  provider   ${provider.model} (${provider.source}${provider.baseUrl ? `, ${provider.baseUrl}` : ''})\n` +
      `  dispatch   ${dispatch ? `${dispatch.repo} (${dispatch.eventType}, confidence ≥ ${dispatch.minConfidence})` : 'off (ATOMA_MENDER_DISPATCH_REPO / _TOKEN unset)'}\n`
  );

  const runId = args.flags['run'];
  if (runId) {
    const result = await analyseRun(runId, analyst);
    process.exitCode = result.outcome === 'analysed' || result.outcome === 'dry-run' || result.outcome === 'already-analysed' ? 0 : 1;
    if (result.detail) warn(result.detail);
    return;
  }

  const backfill = nonNegativeInteger(args.flags['backfill'], '--backfill');
  if (args.flags['once'] === 'true') {
    if (backfill <= 0) {
      warn('--once without --backfill or --run has nothing to do (watch mode baselines instead)');
      return;
    }
    const queue = pendingTargets(analyst, backfill);
    log(`once: analysing ${queue.length} run(s): ${queue.map((target) => `${target.runId} (${target.corpus})`).join(', ') || 'none'}`);
    let failures = 0;
    for (const target of queue) {
      const result = await analyseTarget(target, analyst);
      if (result.outcome !== 'analysed' && result.outcome !== 'dry-run') failures += 1;
    }
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }

  const controller = new AbortController();
  const stop = (): void => {
    log('stopping');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log(`watching ${runsDir} (quiet ${positiveNumber(args.flags['quiet-ms'], '--quiet-ms', ANALYST_DEFAULT_QUIET_MS)}ms${analyst.dryRun ? ', DRY-RUN' : ''})`);
  await runAnalystLoop({
    analyst,
    signal: controller.signal,
    quietMs: positiveNumber(args.flags['quiet-ms'], '--quiet-ms', ANALYST_DEFAULT_QUIET_MS),
    pollMs: positiveNumber(args.flags['poll-ms'], '--poll-ms', ANALYST_DEFAULT_POLL_MS),
    backfill,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`atoma analyst: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
