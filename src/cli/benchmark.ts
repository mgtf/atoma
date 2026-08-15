/**
 * atoma cost-amortisation benchmark — the controlled experiment behind the
 * project's central claim.
 *
 *   npm run benchmark -- --dry-run     # print the protocol, spend nothing
 *   npm run benchmark -- --out benchmark/results-round9.csv \
 *     --result benchmark/ROUND9.md      # every round gets fresh artefacts
 *
 * THE QUESTION. Running the same task repeatedly, does atoma's cumulative
 * cost fall below a single frontier agent's, and after how many runs?
 *
 * THE DESIGN. Two arms, one code path. `--baseline` swaps exactly one line of
 * `runTask` (see `src/run/baseline.ts`), so the sandbox, the nine tools, the
 * run budget, the prompt-cache behaviour, the token accounting and the price
 * table are not "matched" between arms — they are the same code. Every run of
 * either arm gets a freshly archived workspace, so no run inherits its
 * predecessor's deliverable; without that the second atoma run would find the
 * artefact already on disk and "solve" the task for free, which would be a
 * measurement of the harness rather than the system.
 *
 * PRE-REGISTERED, and this file is the registration. The hypothesis, the
 * primary metric and the falsification condition are fixed in
 * `benchmark/PROTOCOL.md` BEFORE any run, because the audit that motivated
 * this experiment found the previous benchmark's numbers unreproducible and
 * its framing chosen after the fact. `analyse()` below is pure and computes
 * the pre-registered metric only; a negative result is a result.
 *
 * WHAT IT CANNOT SHOW. One task family, on a subscription transport where
 * every LLM call pays a 2-5s subprocess spawn — so wall-clock is biased
 * AGAINST the arm that makes more calls (atoma: ~14; baseline: 1). Call
 * counts are recorded alongside durations so a reader can see the bias
 * rather than take the timing at face value.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { modelForTier } from '../core/models.js';
import { baselineModel } from '../run/baseline.js';
import {
  looksLikeConfigFailure,
  newestTraceDuration,
  newestTraceName,
  parseRunLog,
  spawnRun,
  type RunStats,
} from './burnin.js';

export type Arm = 'baseline' | 'atoma';

export interface BenchmarkTask {
  readonly id: string;
  readonly goal: string;
  /**
   * Directory copied into the workspace after it is cleaned. A MAINTENANCE
   * task needs an artefact to maintain; without this the task degrades into
   * the build shape rounds 1-4 already measured.
   */
  readonly seed?: string;
}

export interface BenchmarkConfig {
  readonly primary: BenchmarkTask;
  readonly heldOut: BenchmarkTask;
  readonly baselineRuns: number;
  readonly atomaRuns: number;
  readonly heldOutBaselineRuns: number;
  readonly heldOutAtomaRuns: number;
  readonly timeoutMs: number;
}

export interface BenchmarkRow {
  readonly ts: string;
  readonly arm: Arm;
  readonly taskId: string;
  readonly runIndex: number;
  readonly stats: RunStats;
  readonly durationS: number | null;
  readonly trace: string;
}

export const BENCHMARK_CSV_HEADER =
  'timestamp,arm,task_id,run_index,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,deterministic_phases,escalations,learned_skills,promotions,refusals,demotions,dispatch_fallbacks,trace';

function immutableBenchmarkError(kind: 'CSV' | 'report', path: string): Error {
  return new Error(
    `refusing to overwrite immutable benchmark ${kind} ${path}; ` +
      'choose fresh paths with both --out <csv> and --result <report>'
  );
}

/** Fail before the first paid run when a round's report path is already taken. */
export function ensureBenchmarkResultAvailable(path: string): void {
  if (existsSync(path)) throw immutableBenchmarkError('report', path);
}

/** Reserve a new round CSV atomically, including its immutable schema header. */
export function createBenchmarkCsv(path: string): void {
  try {
    writeFileSync(path, BENCHMARK_CSV_HEADER + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw immutableBenchmarkError('CSV', path);
    }
    throw err;
  }
}

/** Race-safe final write: another process cannot replace a pre-registered report. */
export function writeBenchmarkResult(path: string, report: string): void {
  try {
    writeFileSync(path, `# Benchmark result\n\n\`\`\`\n${report}\n\`\`\`\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw immutableBenchmarkError('report', path);
    }
    throw err;
  }
}

export function benchmarkOutputPaths(
  argv: readonly string[],
  outDir: string,
  requireExplicit: boolean
): { csvPath: string; resultPath: string } {
  const outIdx = argv.indexOf('--out');
  const resultIdx = argv.indexOf('--result');
  const outValue = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const resultValue = resultIdx >= 0 ? argv[resultIdx + 1] : undefined;
  if ((outIdx >= 0 && (!outValue || outValue.startsWith('--'))) ||
      (resultIdx >= 0 && (!resultValue || resultValue.startsWith('--')))) {
    throw new Error('--out and --result each require a path');
  }
  if ((outIdx >= 0) !== (resultIdx >= 0) || (requireExplicit && outIdx < 0)) {
    throw new Error(
      'a real benchmark requires both --out <fresh.csv> and --result <fresh.md>'
    );
  }
  return {
    csvPath: outValue ? resolve(outValue) : join(outDir, 'results.csv'),
    resultPath: resultValue ? resolve(resultValue) : join(outDir, 'RESULT.md'),
  };
}

export function toBenchmarkCsvRow(r: BenchmarkRow): string {
  const s = r.stats;
  return [
    r.ts,
    r.arm,
    r.taskId,
    r.runIndex,
    s.outcome,
    s.costUsd ?? '',
    r.durationS ?? '',
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
    r.trace,
  ]
    .map((c) => String(c))
    .join(',');
}

// ── analysis (pure) ─────────────────────────────────────────────────────────

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Analysis {
  readonly baselineCosts: readonly number[];
  readonly atomaCosts: readonly number[];
  /**
   * Smallest N for which the cumulative cost of the first N atoma runs is
   * below N x the mean baseline cost — the PRE-REGISTERED primary metric.
   * null when no such N exists within the runs performed.
   */
  readonly breakEvenRun: number | null;
  readonly baselineMean: number | null;
  readonly baselineMedian: number | null;
  readonly atomaMean: number | null;
  /** Mean of the atoma runs AFTER the first, i.e. excluding cold-start tuition. */
  readonly atomaWarmMean: number | null;
  /** Mean of the first half vs the second half of the atoma series. */
  readonly trendFirstHalf: number | null;
  readonly trendSecondHalf: number | null;
  /** Cumulative saving (negative = atoma still behind) at the last atoma run. */
  readonly cumulativeDeltaUsd: number | null;
}

/**
 * Compute the pre-registered metrics. Deliberately narrow: it answers the
 * registered question and nothing else, so the conclusion cannot drift toward
 * whichever slice of the data happens to look best.
 */
export function analyse(baselineCosts: readonly number[], atomaCosts: readonly number[]): Analysis {
  const bMean = mean(baselineCosts);
  let breakEven: number | null = null;
  let cumulativeDelta: number | null = null;
  if (bMean !== null && atomaCosts.length > 0) {
    let cum = 0;
    for (let i = 0; i < atomaCosts.length; i++) {
      cum += atomaCosts[i]!;
      const baselineCum = bMean * (i + 1);
      if (breakEven === null && cum < baselineCum) breakEven = i + 1;
    }
    cumulativeDelta = bMean * atomaCosts.length - cum;
  }
  const half = Math.floor(atomaCosts.length / 2);
  return {
    baselineCosts,
    atomaCosts,
    breakEvenRun: breakEven,
    baselineMean: bMean,
    baselineMedian: median(baselineCosts),
    atomaMean: mean(atomaCosts),
    atomaWarmMean: mean(atomaCosts.slice(1)),
    trendFirstHalf: mean(atomaCosts.slice(0, half)),
    trendSecondHalf: mean(atomaCosts.slice(half)),
    cumulativeDeltaUsd: cumulativeDelta,
  };
}

const usd = (n: number | null): string => (n === null ? '—' : `$${n.toFixed(4)}`);

/**
 * What the control arm actually WAS, carried into the report.
 *
 * From round 9 the control model is a variable of the experiment
 * (`ATOMA_BASELINE_MODEL`), so a report that only says "baseline" no longer
 * identifies its own arm. Recorded here rather than in the CSV for the same
 * reason `PROMOTE`/`TRUST` are: one round is one configuration, the CSV
 * schema is immutable evidence, and a call-time input belongs beside the
 * result it produced.
 */
export interface ArmsContext {
  readonly controlModel: string;
  readonly provider: string;
  /** `L1=… L2=… L3=…`, the treatment arm's gradient. */
  readonly treatmentTiers: string;
}

export function formatAnalysis(
  a: Analysis,
  heldOut?: { baseline: number[]; atoma: number[] },
  arms?: ArmsContext
): string {
  const L: string[] = [];
  L.push('== PRE-REGISTERED RESULT ==');
  L.push('');
  if (arms) {
    L.push(`provider : ${arms.provider}`);
    L.push(`control  : one ${arms.controlModel} agent, plain tool loop, self-certifying`);
    L.push(`treatment: atoma, ${arms.treatmentTiers}`);
    L.push('');
  }
  L.push(`baseline (frontier direct) n=${a.baselineCosts.length}: mean ${usd(a.baselineMean)}, median ${usd(a.baselineMedian)}`);
  if (a.baselineCosts.length > 0) {
    L.push(`  runs: ${a.baselineCosts.map((c) => c.toFixed(3)).join(', ')}`);
  }
  L.push(`atoma n=${a.atomaCosts.length}: mean ${usd(a.atomaMean)}, mean excluding run 1 ${usd(a.atomaWarmMean)}`);
  if (a.atomaCosts.length > 0) {
    L.push(`  runs: ${a.atomaCosts.map((c) => c.toFixed(3)).join(', ')}`);
  }
  L.push('');
  L.push(
    a.breakEvenRun === null
      ? 'H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.'
      : `H1 SUPPORTED: cumulative break-even at run N* = ${a.breakEvenRun}.`
  );
  L.push(`cumulative delta after ${a.atomaCosts.length} runs: ${usd(a.cumulativeDeltaUsd)} (positive = atoma cheaper in total)`);
  L.push(`trend across the atoma series: first half ${usd(a.trendFirstHalf)} → second half ${usd(a.trendSecondHalf)}`);
  if (heldOut && (heldOut.baseline.length > 0 || heldOut.atoma.length > 0)) {
    L.push('');
    L.push('-- held-out task (novel, same family): memorisation control --');
    L.push(`  baseline n=${heldOut.baseline.length}: mean ${usd(mean(heldOut.baseline))}`);
    L.push(`  atoma    n=${heldOut.atoma.length}: mean ${usd(mean(heldOut.atoma))}`);
    L.push('  If atoma is cheap here too, the learning generalised to the family.');
    L.push('  If it is back at baseline cost, it had memorised the primary task.');
  }
  return L.join('\n');
}

// ── driver ──────────────────────────────────────────────────────────────────

function fmtDur(s: number | null): string {
  return s === null ? '—' : `${Math.round(s)}s`;
}

async function runOne(
  arm: Arm,
  task: BenchmarkTask,
  runIndex: number,
  cfg: BenchmarkConfig,
  logsDir: string,
  runsDir: string,
  scratchDir: string
): Promise<BenchmarkRow> {
  const ts = new Date().toISOString();
  const since = Date.now();
  const label = `${arm}-${task.id}-${String(runIndex).padStart(2, '0')}`;
  process.stdout.write(`▶ ${label} … `);

  // The control arm is pointed at a THROWAWAY store. `--baseline` already
  // skips seeding, so nothing should be written — this makes it impossible
  // rather than merely intended, because a control that mutated the
  // treatment's registry would invalidate every run after it.
  const extraEnv: Record<string, string> =
    arm === 'baseline'
      ? {
          ATOMA_DB_PATH: join(scratchDir, 'baseline-store.db'),
          ATOMA_SKILLS_DIR: join(scratchDir, 'baseline-skills'),
          ATOMA_LEDGER_DB: join(scratchDir, 'baseline-store.db'),
          ATOMA_PREFILTER_CACHE: '0',
        }
      : {};

  const log = await spawnRun({
    goal: task.goal,
    timeoutMs: cfg.timeoutMs,
    logPath: join(logsDir, `${label}.log`),
    extraArgs: [
      ...(arm === 'baseline' ? ['--baseline'] : []),
      ...(task.seed ? ['--seed', task.seed] : []),
    ],
    extraEnv,
  });

  const stats = parseRunLog(log);
  const durationS = newestTraceDuration(runsDir, since);
  const trace = newestTraceName(runsDir, since);
  console.log(
    `${stats.outcome === 'delivered' ? '✓' : '✗'} ${stats.outcome}  ${usd(stats.costUsd)}  ${fmtDur(
      durationS
    )}  llm=${stats.llmCalls ?? '—'}  det=${stats.deterministicPhases}  learned=${stats.learnedSkills}`
  );
  return { ts, arm, taskId: task.id, runIndex, stats, durationS, trace };
}

function costsOf(rows: readonly BenchmarkRow[], arm: Arm, taskId: string): number[] {
  return rows
    .filter((r) => r.arm === arm && r.taskId === taskId && r.stats.outcome === 'delivered' && r.stats.costUsd !== null)
    .map((r) => r.stats.costUsd!);
}

/** Resolve both arms exactly as the runner will, at driver start. */
function armsContext(): ArmsContext {
  return {
    controlModel: baselineModel(),
    provider: process.env['ATOMA_LLM'] ?? 'anthropic (default)',
    treatmentTiers: ([1, 2, 3] as const).map((t) => `L${t}=${modelForTier(t)}`).join(' '),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const cfgIdx = argv.indexOf('--config');
  const cfgPath = resolve(cfgIdx >= 0 ? argv[cfgIdx + 1]! : 'benchmark/experiment.json');
  if (!existsSync(cfgPath)) {
    console.error(`missing config: ${cfgPath}`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as BenchmarkConfig;

  const outDir = resolve('benchmark');
  const logsDir = join(outDir, 'logs');
  const scratchDir = join(outDir, '.scratch');
  const runsDir = resolve(process.env['ATOMA_RUNS_DIR'] ?? './runs');
  // A second round must not append into the first round's file: the two are
  // compared against each other, and RESULT.md cites results.csv by name.
  let csvPath: string;
  let resultPath: string;
  try {
    ({ csvPath, resultPath } = benchmarkOutputPaths(argv, outDir, !dryRun));
  } catch (err) {
    console.error(`invalid benchmark outputs: ${(err as Error).message}`);
    process.exit(2);
  }

  const total =
    cfg.baselineRuns + cfg.atomaRuns + cfg.heldOutBaselineRuns + cfg.heldOutAtomaRuns;
  const arms = armsContext();
  console.log('== atoma cost-amortisation benchmark ==\n');
  console.log(`provider     : ${arms.provider}`);
  // Printed on the dry run too: a mis-set ATOMA_BASELINE_MODEL must be
  // visible BEFORE the round spends, not inferred from the report after it.
  console.log(`control arm  : ${arms.controlModel}`);
  console.log(`treatment arm: ${arms.treatmentTiers}`);
  console.log(`primary task : ${cfg.primary.id}`);
  console.log(`held-out task: ${cfg.heldOut.id}`);
  if (cfg.primary.seed) console.log(`workspace seed : ${cfg.primary.seed}`);
  console.log(
    `plan         : ${cfg.baselineRuns} baseline + ${cfg.atomaRuns} atoma on the primary, ` +
      `then ${cfg.heldOutBaselineRuns} + ${cfg.heldOutAtomaRuns} on the held-out = ${total} runs`
  );
  console.log(`budget/run   : ${Math.round(cfg.timeoutMs / 1000)}s`);
  console.log(`output       : ${csvPath}\n`);
  console.log(`report       : ${resultPath}\n`);

  if (dryRun) {
    console.log('--dry-run: nothing executed.');
    console.log('\nPRIMARY GOAL:\n' + cfg.primary.goal);
    console.log('\nHELD-OUT GOAL:\n' + cfg.heldOut.goal);
    return;
  }

  if ((process.env['ATOMA_LLM'] ?? '') === '') {
    console.error('✖ ATOMA_LLM is unset and the API key in .env is dead — every run would 401.');
    console.error(
      '  Launch with fresh artefacts: ATOMA_LLM=claude-cli npm run benchmark -- ' +
        '--out benchmark/results-round<N>.csv --result benchmark/ROUND<N>.md'
    );
    process.exit(2);
  }

  // Refuse BEFORE spending on the first run. RESULT.md and ROUND<n>.md are
  // immutable evidence for their registered CSV; silently replacing one was
  // observed twice and required repository-history recovery both times.
  ensureBenchmarkResultAvailable(resultPath);

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(dirname(csvPath), { recursive: true });
  mkdirSync(dirname(resultPath), { recursive: true });
  createBenchmarkCsv(csvPath);

  const rows: BenchmarkRow[] = [];
  const phases: { arm: Arm; task: BenchmarkTask; n: number; title: string }[] = [
    { arm: 'baseline', task: cfg.primary, n: cfg.baselineRuns, title: 'A. control arm — frontier direct, primary task' },
    { arm: 'atoma', task: cfg.primary, n: cfg.atomaRuns, title: 'B. treatment arm — atoma, primary task (state accumulates)' },
    { arm: 'baseline', task: cfg.heldOut, n: cfg.heldOutBaselineRuns, title: 'C. control arm — held-out task' },
    { arm: 'atoma', task: cfg.heldOut, n: cfg.heldOutAtomaRuns, title: 'D. treatment arm — held-out task (memorisation control)' },
  ];

  let configFailures = 0;
  for (const phase of phases) {
    if (phase.n <= 0) continue;
    console.log(`\n── ${phase.title} ──`);
    for (let i = 1; i <= phase.n; i++) {
      const row = await runOne(phase.arm, phase.task, i, cfg, logsDir, runsDir, scratchDir);
      rows.push(row);
      appendFileSync(csvPath, toBenchmarkCsvRow(row) + '\n', 'utf8');

      // One dead credential should abort the experiment, not silently fill it
      // with phantom rows — the exact failure burn-in already learned to catch.
      if (looksLikeConfigFailure(row.stats, row.durationS)) {
        configFailures++;
        if (configFailures >= 2) {
          console.error('\n✖ two runs died instantly having spent nothing — this is a configuration');
          console.error('  failure, not a task failure. Aborting so the rest of the protocol is not wasted.');
          process.exit(3);
        }
      } else {
        configFailures = 0;
      }
    }
  }

  const analysis = analyse(
    costsOf(rows, 'baseline', cfg.primary.id),
    costsOf(rows, 'atoma', cfg.primary.id)
  );
  const report = formatAnalysis(
    analysis,
    {
      baseline: costsOf(rows, 'baseline', cfg.heldOut.id),
      atoma: costsOf(rows, 'atoma', cfg.heldOut.id),
    },
    armsContext()
  );
  console.log('\n' + report + '\n');
  writeBenchmarkResult(resultPath, report);
  console.log(`rows written to ${csvPath}`);
}

// Only run as a CLI, never on import (tests import the pure helpers).
if (process.argv[1] && /benchmark\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
