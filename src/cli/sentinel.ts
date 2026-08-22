#!/usr/bin/env tsx
/**
 * atoma sentinel — the mechanical live watch (stage 1 of
 * `docs/supervisor-design.md`).
 *
 *   npm run sentinel                       # watch until Ctrl-C
 *   npm run sentinel -- --once             # one pass, then exit
 *   npm run sentinel -- --cost-alert 2.50  # arm the cost threshold
 *
 * Costs zero tokens, forever. It reads `runs/index.json`, each live run's
 * trace and the MCP lease, applies the rule table, and writes journal rows.
 * It has NO power over a run: the kill switch is an unsettled decision in the
 * design document, and until it is settled this process cannot cancel
 * anything.
 */
import { existsSync } from 'node:fs';
import { PlatformEventLog } from '../platform/events.js';
import { storeDbPath } from '../core/stores.js';
import { mcpRunLockPath } from '../mcp/runLock.js';
import {
  runSentinelLoop,
  SentinelWatch,
  SENTINEL_DEFAULT_INTERVAL_MS,
} from '../sentinel/watch.js';
import { sentinelRuleIds } from '../sentinel/rules.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma sentinel — mechanical live watch over runs in flight

usage:
  npm run sentinel [-- --once] [--interval <ms>] [--cost-alert <usd>] [--db path]

what it does:
  Reads runs/index.json, each live run's trace and the MCP run lease; applies
  the rule table; writes run.anomaly / security.flagged journal rows. Zero
  tokens, no power over any run — flagging only.

what it does NOT do:
  Cancel a run. Whether the sentinel gets that power is still an open
  decision in docs/supervisor-design.md, so it does not have it.

flags:
  --once                 one pass, then exit (useful in cron or a check)
  --interval <ms>        poll interval (default ${SENTINEL_DEFAULT_INTERVAL_MS})
  --cost-alert <usd>     raise run.anomaly past this cumulative spend
  --runs <dir>           runs directory (default ATOMA_RUNS_DIR or ./runs)
  --db <path>            product store holding the journal
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
    booleanFlags: ['help', 'once'],
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
  const costAlertUsd = positiveNumber(args.flags['cost-alert'], '--cost-alert');
  const runsDir = args.flags['runs'];

  const journal = PlatformEventLog.open(dbPath);
  const watch = new SentinelWatch({
    journal,
    ...(typeof runsDir === 'string' && runsDir.length > 0 ? { runsDir } : {}),
    costAlertUsd,
    leasePath: mcpRunLockPath(),
    logger: (line) => process.stdout.write(`[sentinel] ${line}\n`),
  });

  process.stdout.write(
    `atoma sentinel — ${sentinelRuleIds().length} rules, zero tokens, flagging only\n` +
      `  store    ${dbPath}\n` +
      `  cost     ${costAlertUsd === null ? 'threshold disarmed (--cost-alert to arm)' : `alert past ${costAlertUsd} USD`}\n`
  );

  if (args.flags['once'] === 'true') {
    const report = watch.tick();
    process.stdout.write(
      `one pass: ${report.liveRuns.length} live run(s), ${report.emitted.length} new finding(s)` +
        `${report.skipped.length > 0 ? `, ${report.skipped.length} skipped` : ''}\n`
    );
    for (const skip of report.skipped) {
      process.stdout.write(`  skipped ${skip.runId}: ${skip.reason}\n`);
    }
    return;
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

  await runSentinelLoop({
    watch,
    signal: controller.signal,
    ...(interval !== null ? { intervalMs: interval } : {}),
    logger: (line) => process.stderr.write(`[sentinel] ${line}\n`),
  });
}

await main();
