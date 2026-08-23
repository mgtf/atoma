#!/usr/bin/env tsx
/**
 * atoma sentinel — the mechanical live watch (stage 1 of
 * `docs/supervisor-design.md`).
 *
 *   npm run sentinel                       # watch until Ctrl-C
 *   npm run sentinel -- --once             # one pass, then exit
 *   npm run sentinel -- --cost-alert 2.50  # arm the cost threshold
 *
 * Costs zero tokens, forever. It reads both run corpora — the operator's
 * `runs/` directory and, when this store holds a tenant control plane, every
 * project run the control plane says is executing — applies the rule table,
 * and writes journal rows. It has NO power over a run: the kill switch is an
 * unsettled decision in the design document, and until it is settled this
 * process cannot cancel anything.
 *
 * IT IS NOT THE ONLY HOST ANY MORE. A gated viz server arms the same watch
 * in-process, so `npm run viz` covers the case where somebody is looking at
 * the screen. This command is for the cases the server cannot serve: an
 * ungated checkout, another machine, another store, a burn-in batch that owns
 * the machine and must not also run a browser, and `--once` in cron. Started
 * resident, it TAKES OVER the store's watch from a viz server — typing this
 * command is the deliberate act, and a forgotten browser tab must not refuse
 * it — and yields only to another live CLI, where the tie is ambiguous.
 */
import { existsSync } from 'node:fs';
import { PlatformEventLog } from '../platform/events.js';
import { storeDbPath } from '../core/stores.js';
import { mcpRunLockPath } from '../mcp/runLock.js';
import { hasProjectTables, ProjectStore } from '../projects/store.js';
import { claimSentinelWatch, type SentinelWatchLease } from '../sentinel/lease.js';
import { sentinelCostAlertFromEnv } from '../sentinel/resident.js';
import {
  runSentinelLoop,
  SentinelWatch,
  SENTINEL_DEFAULT_INTERVAL_MS,
} from '../sentinel/watch.js';
import {
  operatorRunSource,
  projectRunSource,
  type SentinelRunSource,
} from '../sentinel/sources.js';
import { sentinelRuleIds } from '../sentinel/rules.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma sentinel — mechanical live watch over runs in flight

usage:
  npm run sentinel [-- --once] [--interval <ms>] [--cost-alert <usd>] [--db path]

what it does:
  Watches BOTH run corpora — operator runs under runs/, and project runs the
  tenant control plane reports as running (each in its own directory) — reads
  each live trace and the MCP run lease, applies the rule table, and writes
  run.anomaly / security.flagged journal rows. Zero tokens, no power over any
  run — flagging only.

what it does NOT do:
  Cancel a run. Whether the sentinel gets that power is still an open
  decision in docs/supervisor-design.md, so it does not have it.

one watch per store:
  A gated viz server hosts the same watch in-process, so this command is for
  what the server cannot cover: an ungated checkout, another machine, another
  store, a burn-in batch that must not also run a browser, or --once in cron.
  Resident, it takes the store's watch over from a viz server and yields only
  to another live sentinel. --once takes no lease and always journals.

flags:
  --once                 one pass, then exit (useful in cron or a check)
  --interval <ms>        poll interval (default ${SENTINEL_DEFAULT_INTERVAL_MS})
  --cost-alert <usd>     raise run.anomaly past this cumulative spend
                         (default: ATOMA_SENTINEL_COST_ALERT_USD)
  --runs <dir>           operator runs directory (default ATOMA_RUNS_DIR or ./runs)
  --operator-only        do not watch project runs even if this store has them
  --db <path>            product store holding the journal and the projects
  --help                 show this help`;

function fail(message: string): never {
  process.stderr.write(`atoma sentinel: ${message}\n`);
  process.exit(1);
}

function positiveNumber(raw: string | undefined, label: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const args = parseCliArgs(process.argv, {
    booleanFlags: ['help', 'once', 'operator-only'],
    valueFlags: ['interval', 'cost-alert', 'runs', 'db'],
    undeclared: 'discard',
  });
  if (args.flags['help'] === 'true') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.undeclaredFlags.length > 0) fail(`unknown flag: ${args.undeclaredFlags[0]!}`);

  const dbFlag = args.flags['db'];
  const dbPath = typeof dbFlag === 'string' && dbFlag.length > 0 ? dbFlag : storeDbPath();
  if (!existsSync(dbPath)) {
    fail(`no product store at ${dbPath} — nothing to journal into yet`);
  }
  const interval = positiveNumber(args.flags['interval'], '--interval');
  // The flag wins; the environment is the default, read through the ONE helper
  // both hosts share so the two cannot disagree about what arms the rule.
  const costAlertUsd =
    positiveNumber(args.flags['cost-alert'], '--cost-alert') ?? sentinelCostAlertFromEnv();
  const runsDir = args.flags['runs'];

  const journal = PlatformEventLog.open(dbPath);

  // TWO CORPORA, one watch. Operator runs share `runs/`; a project run writes
  // into its own directory, so an index-only watch would see every burn-in
  // and not one customer run. The tenant source is added only when this store
  // already HOLDS project tables: `ProjectStore.open` applies its DDL, and a
  // watcher must not bring a tenant control plane into being by looking at it.
  const sources: SentinelRunSource[] = [
    operatorRunSource({
      runsDir:
        typeof runsDir === 'string' && runsDir.length > 0
          ? runsDir
          : (process.env['ATOMA_RUNS_DIR'] ?? './runs'),
    }),
  ];
  let projectsLine = 'off (--operator-only)';
  if (args.flags['operator-only'] !== 'true') {
    if (hasProjectTables(dbPath)) {
      sources.push(projectRunSource({ reader: ProjectStore.open(dbPath) }));
      projectsLine = 'on (project_runs where status = running)';
    } else {
      projectsLine = 'off (no project control plane in this store)';
    }
  }

  const watch = new SentinelWatch({
    journal,
    sources,
    costAlertUsd,
    leasePath: mcpRunLockPath(),
    source: 'cli',
    logger: (line) => process.stdout.write(`[sentinel] ${line}\n`),
  });

  process.stdout.write(
    `atoma sentinel — ${sentinelRuleIds().length} rules, zero tokens, flagging only\n` +
      `  store    ${dbPath}\n` +
      `  projects ${projectsLine}\n` +
      `  cost     ${costAlertUsd === null ? 'threshold disarmed (--cost-alert to arm)' : `alert past ${costAlertUsd} USD`}\n`
  );

  if (args.flags['once'] === 'true') {
    // NO LEASE for one pass, and it still journals. `--once` is a shipped cron
    // contract, its worst case beside a resident watch is one duplicated row,
    // and a bounded pass that appends nothing would be a dry run wearing a
    // safety feature's name.
    const report = watch.tick();
    const operator = report.runs.filter((run) => run.corpus === 'operator').length;
    const project = report.runs.length - operator;
    process.stdout.write(
      `one pass: ${report.runs.length} live run(s) (${operator} operator, ${project} project), ` +
        `${report.emitted.length} new finding(s)` +
        `${report.skipped.length > 0 ? `, ${report.skipped.length} skipped` : ''}\n`
    );
    for (const skip of report.skipped) {
      process.stdout.write(`  skipped ${skip.runId ?? '(source)'}: ${skip.reason}\n`);
    }
    return;
  }

  // ONE APPENDING RESIDENT WATCH PER STORE. Resident mode takes the watch
  // over from a viz server hosting it in-process — this command is the
  // deliberate act and must not be refused by a browser tab somebody left
  // open — and yields to another live sentinel, where the tie is genuinely
  // ambiguous. Refusing is not a failure of the watch; it is the watch that
  // already exists.
  const claim = claimSentinelWatch(dbPath, {
    source: 'cli',
    intervalMs: interval ?? SENTINEL_DEFAULT_INTERVAL_MS,
    label: 'npm run sentinel',
  });
  if (!claim.held) {
    const incumbent = claim.incumbent;
    process.stderr.write(
      `atoma sentinel: ${incumbent.source} pid ${incumbent.ownerPid} has held the watch on\n` +
        `  ${dbPath}\n` +
        `  since ${incumbent.startedAt} (last beat ${incumbent.heartbeatAt}).\n` +
        `  Two appending watches on one store can duplicate a finding, so this one stops.\n` +
        `  Run one bounded pass instead: npm run sentinel -- --once\n` +
        `  Or watch a corpus that one does not cover: --runs <dir>\n`
    );
    process.exit(1);
  }
  const lease: SentinelWatchLease = claim.lease;
  if (claim.displaced) {
    process.stdout.write(
      `  took the watch over from ${claim.displaced.source} pid ${claim.displaced.ownerPid}\n`
    );
  }

  // A long-lived watcher on a laptop needs the machine awake, and this one is
  // meant to run BESIDE runs — a sleeping host stops watching exactly when
  // the run it was watching is still spending.
  process.stdout.write(
    '  hold the machine awake alongside this process: caffeinate -i -m\n\n'
  );

  const controller = new AbortController();
  const stop = (signal: string): void => {
    process.stdout.write(`\n[sentinel] ${signal} — stopping\n`);
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // RETENTION. The journal's age cut and row cap ride the viz server's
  // 5-minute sweep timer, which only exists behind the auth gate — so a CLI
  // watch on an ungated checkout was the one journal writer in the repository
  // with no retention at all. It sweeps on its own cadence here, and the
  // ownership check rides the same tick: losing the lease means another watch
  // took over, and continuing to append would be the double-writer the lease
  // exists to prevent.
  let lastSweep = 0;
  const SWEEP_EVERY_MS = 5 * 60 * 1000;

  await runSentinelLoop({
    watch,
    signal: controller.signal,
    ...(interval !== null ? { intervalMs: interval } : {}),
    logger: (line) => process.stderr.write(`[sentinel] ${line}\n`),
    onTick: () => {
      if (!lease.heartbeat()) {
        process.stderr.write(
          '[sentinel] another watch took over this store — stopping to avoid duplicate rows\n'
        );
        controller.abort();
        return;
      }
      const nowMs = Date.now();
      if (nowMs - lastSweep < SWEEP_EVERY_MS) return;
      lastSweep = nowMs;
      journal.sweep();
    },
  });
  lease.release();
}

await main();
