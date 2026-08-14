/**
 * Paired comparison: frontier --baseline first, then atoma.
 * Reuses spawnRun — do not copy the kill sequence.
 *
 *   env -u OPENAI_API_KEY ZAI_API_KEY="$(< "$HOME/.config/atoma/zai-api-key")" \
 *     npx tsx burnin/compare-frontier.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  looksLikeConfigFailure,
  looksLikeProviderLimitFailure,
  newestTraceDuration,
  newestTraceName,
  parseRunLog,
  spawnRun,
  type RunStats,
} from '../src/cli/burnin.js';

type Arm = 'baseline' | 'atoma';
interface Task {
  readonly id: string;
  readonly family: string;
  readonly goal: string;
}

const TIMEOUT_MS = 900_000;
const TASKS_PATH = resolve('burnin/tasks-compare-frontier.json');
const CSV_PATH = resolve('burnin/results-compare-opus.csv');
const LOGS_DIR = resolve('burnin/logs');
const RUNS_DIR = resolve(process.env['ATOMA_RUNS_DIR'] ?? 'runs');
const SCRATCH = resolve('benchmark/.scratch-compare');
const HEADER =
  'timestamp,arm,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,other_calls,deterministic_phases,escalations,learned_skills,trace,provider';

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`;
}

function envFor(arm: Arm): Record<string, string> {
  if (arm === 'baseline') {
    return {
      ATOMA_LLM: 'anthropic',
      ATOMA_MODEL_L3: 'claude-opus-5',
      ATOMA_DB_PATH: join(SCRATCH, 'baseline-store.db'),
      ATOMA_SKILLS_DIR: join(SCRATCH, 'baseline-skills'),
      ATOMA_LEDGER_DB: join(SCRATCH, 'baseline-store.db'),
      ATOMA_PREFILTER_CACHE: '0',
    };
  }
  const zai = process.env['ZAI_API_KEY'] ?? '';
  return {
    ATOMA_LLM: 'ollama',
    ATOMA_MODEL_L1: 'zai:glm-4.5-air',
    ATOMA_MODEL_L2: 'codex:gpt-5.4-mini',
    ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
    ...(zai ? { ZAI_API_KEY: zai } : {}),
  };
}

function toRow(args: {
  ts: string;
  arm: Arm;
  task: Task;
  stats: RunStats;
  durationS: number | null;
  trace: string;
  provider: string;
}): string {
  const s = args.stats;
  return [
    args.ts,
    args.arm,
    args.task.id,
    args.task.family,
    s.outcome,
    s.costUsd ?? '',
    args.durationS ?? '',
    s.llmCalls ?? '',
    s.opusCalls,
    s.sonnetCalls,
    s.haikuCalls,
    s.otherCalls,
    s.deterministicPhases,
    s.escalations,
    s.learnedSkills,
    args.trace,
    args.provider,
  ]
    .map((c) => String(c))
    .join(',');
}

async function runOne(arm: Arm, task: Task): Promise<void> {
  const ts = new Date().toISOString();
  const since = Date.now();
  const label = `${arm}-${task.id}`;
  process.stdout.write(`▶ ${label} … `);
  const log = await spawnRun({
    goal: task.goal,
    timeoutMs: TIMEOUT_MS,
    logPath: join(LOGS_DIR, `${label}.log`),
    extraArgs: arm === 'baseline' ? ['--baseline'] : [],
    extraEnv: envFor(arm),
  });
  if (looksLikeProviderLimitFailure(log)) {
    console.error(`\n✖ provider limit on ${label} — aborting before more rows.`);
    process.exit(1);
  }
  const stats = parseRunLog(log);
  const durationS = newestTraceDuration(RUNS_DIR, since);
  const trace = newestTraceName(RUNS_DIR, since);
  if (looksLikeConfigFailure(stats, durationS)) {
    console.error(`\n✖ ${label} died fast with no spend — configuration failure, aborting.`);
    process.exit(3);
  }
  const provider = arm === 'baseline' ? 'anthropic-opus-baseline' : 'ollama+zai+codex';
  appendFileSync(
    CSV_PATH,
    toRow({ ts, arm, task, stats, durationS, trace, provider }) + '\n',
    'utf8'
  );
  console.log(
    `${stats.outcome === 'delivered' ? '✓' : '✗'} ${stats.outcome}  ${usd(stats.costUsd)}  ` +
      `${durationS === null ? '—' : `${Math.round(durationS)}s`}  llm=${stats.llmCalls ?? '?'}`
  );
}

async function main(): Promise<void> {
  const file = JSON.parse(readFileSync(TASKS_PATH, 'utf8')) as { tasks: Task[] };
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(dirname(CSV_PATH), { recursive: true });
  if (!existsSync(CSV_PATH)) {
    writeFileSync(CSV_PATH, HEADER + '\n', 'utf8');
  } else {
    // A row written under a header it does not match is worse than no row
    // (measured 2026-08-14: standard burn-in rows landed under this compare
    // header and the arm column became unrecoverable). Refuse foreign files.
    const firstLine = readFileSync(CSV_PATH, 'utf8').split('\n', 1)[0];
    if (firstLine !== HEADER) {
      console.error(
        `refusing to append: ${CSV_PATH} header does not match the compare schema — ` +
          `found "${String(firstLine).slice(0, 80)}…". Pick a fresh output file.`
      );
      process.exit(2);
    }
  }

  console.log('== atoma vs frontier-direct (Opus) ==');
  console.log('control : ATOMA_LLM=anthropic --baseline L3=claude-opus-5 (throwaway store)');
  console.log('treatment: current hybrid atoma (mature store)');
  console.log(`tasks   : ${file.tasks.map((t) => t.id).join(', ')}`);
  console.log(`output  : ${CSV_PATH}\n`);

  console.log('── A. control — frontier direct ──');
  for (const task of file.tasks) await runOne('baseline', task);
  console.log('\n── B. treatment — atoma ──');
  for (const task of file.tasks) await runOne('atoma', task);
  console.log('\n== compare batch finished ==');
}

if (process.argv[1] && /compare-frontier\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
