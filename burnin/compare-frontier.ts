/**
 * Paired comparison: frontier --baseline first, then atoma.
 * Reuses spawnRun — do not copy the kill sequence.
 *
 *   env -u OPENAI_API_KEY ZAI_API_KEY="$(< "$HOME/.config/atoma/zai-api-key")" \
 *     npx tsx burnin/compare-frontier.ts
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  looksLikeConfigFailure,
  looksLikeProviderLimitFailure,
  newestTraceDuration,
  newestTraceName,
  parseRunLog,
  spawnRun,
  type RunStats,
} from '../src/cli/burnin.js';
import { skillsDirPath, storeDbPath } from '../src/core/stores.js';
import { snapshotSqliteStore } from '../src/core/sqliteBackup.js';
export { snapshotSqliteStore } from '../src/core/sqliteBackup.js';

export type Arm = 'baseline' | 'atoma';
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
const SCRATCH_ROOT = resolve('benchmark/.scratch-compare');
const HEADER =
  'timestamp,arm,task_id,family,outcome,cost_usd,duration_s,llm_calls,opus_calls,sonnet_calls,haiku_calls,other_calls,deterministic_phases,escalations,learned_skills,trace,provider';

export interface CompareRoundState {
  readonly scratchRoot: string;
  readonly roundDir: string;
  readonly baselineDb: string;
  readonly baselineSkills: string;
  readonly treatmentDb: string;
  readonly treatmentSkills: string;
}

function destinationIsInsideSource(source: string, destination: string): boolean {
  const rel = relative(resolve(source), resolve(destination));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Reserve one paired comparison round.
 *
 * Every task gets a fresh, atomically-created directory. The baseline starts
 * with no DB file and an empty skills directory. The treatment gets detached
 * snapshots of the mature store and skills, so learning may mutate its own
 * round without touching production or influencing the next task pair.
 */
export async function prepareCompareRound(args: {
  readonly scratchRoot: string;
  readonly sourceDb: string;
  readonly sourceSkills: string;
}): Promise<CompareRoundState> {
  const scratchRoot = resolve(args.scratchRoot);
  mkdirSync(scratchRoot, { recursive: true });
  const roundDir = mkdtempSync(join(scratchRoot, 'round-'));
  const baselineDir = join(roundDir, 'baseline');
  const treatmentDir = join(roundDir, 'treatment');
  const state: CompareRoundState = {
    scratchRoot,
    roundDir,
    baselineDb: join(baselineDir, 'store.db'),
    baselineSkills: join(baselineDir, 'skills'),
    treatmentDb: join(treatmentDir, 'store.db'),
    treatmentSkills: join(treatmentDir, 'skills'),
  };

  try {
    // The missing baseline DB is intentional: the runner creates only its
    // schema. No stale rows, WAL, ledger import, or learned recipe can survive
    // from an earlier comparison.
    mkdirSync(state.baselineSkills, { recursive: true });
    await snapshotSqliteStore(args.sourceDb, state.treatmentDb);

    const sourceSkills = resolve(args.sourceSkills);
    if (!existsSync(sourceSkills)) {
      mkdirSync(state.treatmentSkills, { recursive: true });
    } else {
      if (!statSync(sourceSkills).isDirectory()) {
        throw new Error(`compare treatment skills source is not a directory: ${sourceSkills}`);
      }
      if (destinationIsInsideSource(sourceSkills, state.treatmentSkills)) {
        throw new Error('compare scratch directory must not be inside the production skills tree');
      }
      // Dereference links so the copied tree cannot retain a write path back
      // into production when the treatment bumps counters or revises a body.
      cpSync(sourceSkills, state.treatmentSkills, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    }
    return state;
  } catch (err) {
    rmSync(roundDir, { recursive: true, force: true });
    throw err;
  }
}

/** Remove only the exact round directory returned by prepareCompareRound. */
export function cleanupCompareRound(state: CompareRoundState): void {
  const scratchRoot = resolve(state.scratchRoot);
  const roundDir = resolve(state.roundDir);
  if (dirname(roundDir) !== scratchRoot || !basename(roundDir).startsWith('round-')) {
    throw new Error(`refusing to clean an unreserved compare path: ${roundDir}`);
  }
  rmSync(roundDir, { recursive: true, force: true });
}

class CompareAbortError extends Error {
  constructor(
    readonly exitCode: number,
    message: string
  ) {
    super(message);
    this.name = 'CompareAbortError';
  }
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`;
}

export function envFor(
  arm: Arm,
  state: CompareRoundState,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const baseline = arm === 'baseline';
  const dbPath = baseline ? state.baselineDb : state.treatmentDb;
  const skillsPath = baseline ? state.baselineSkills : state.treatmentSkills;
  const stateEnv = {
    ATOMA_DB_PATH: dbPath,
    // Keep the legacy alias pinned too. ATOMA_DB_PATH wins in current code,
    // but an old local checkout or helper must not regain a production path.
    ATOMA_BUILD_DB_PATH: dbPath,
    ATOMA_SKILLS_DIR: skillsPath,
    ATOMA_LEDGER_DB: dbPath,
    // An exported legacy JSONL path would otherwise populate the supposedly
    // empty baseline store on first open.
    ATOMA_LEDGER_PATH: '',
    ATOMA_PREFILTER_CACHE: baseline ? '0' : dbPath,
  };
  if (arm === 'baseline') {
    return {
      ATOMA_LLM: 'anthropic',
      ATOMA_MODEL_L3: 'claude-opus-5',
      ...stateEnv,
    };
  }
  const zai = hostEnv['ZAI_API_KEY'] ?? '';
  return {
    ATOMA_LLM: 'ollama',
    ATOMA_MODEL_L1: 'zai:glm-4.5-air',
    ATOMA_MODEL_L2: 'codex:gpt-5.4-mini',
    ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
    ...(zai ? { ZAI_API_KEY: zai } : {}),
    ...stateEnv,
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

async function runOne(arm: Arm, task: Task, state: CompareRoundState): Promise<void> {
  const ts = new Date().toISOString();
  const since = Date.now();
  const label = `${arm}-${task.id}`;
  process.stdout.write(`▶ ${label} … `);
  const log = await spawnRun({
    goal: task.goal,
    timeoutMs: TIMEOUT_MS,
    logPath: join(LOGS_DIR, `${label}.log`),
    extraArgs: arm === 'baseline' ? ['--baseline'] : [],
    extraEnv: envFor(arm, state),
  });
  if (looksLikeProviderLimitFailure(log)) {
    throw new CompareAbortError(
      1,
      `✖ provider limit on ${label} — aborting before more rows.`
    );
  }
  const stats = parseRunLog(log);
  const durationS = newestTraceDuration(RUNS_DIR, since);
  const trace = newestTraceName(RUNS_DIR, since);
  if (looksLikeConfigFailure(stats, durationS)) {
    throw new CompareAbortError(
      3,
      `✖ ${label} died fast with no spend — configuration failure, aborting.`
    );
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
  mkdirSync(dirname(CSV_PATH), { recursive: true });
  if (!existsSync(CSV_PATH)) {
    writeFileSync(CSV_PATH, HEADER + '\n', 'utf8');
  } else {
    // A row written under a header it does not match is worse than no row
    // (measured 2026-08-14: standard burn-in rows landed under this compare
    // header and the arm column became unrecoverable). Refuse foreign files.
    const firstLine = readFileSync(CSV_PATH, 'utf8').split('\n', 1)[0];
    if (firstLine !== HEADER) {
      throw new CompareAbortError(
        2,
        `refusing to append: ${CSV_PATH} header does not match the compare schema — ` +
          `found "${String(firstLine).slice(0, 80)}…". Pick a fresh output file.`
      );
    }
  }

  const sourceDb = resolve(storeDbPath());
  const sourceSkills = resolve(skillsDirPath());

  console.log('== atoma vs frontier-direct (Opus) ==');
  console.log('control : ATOMA_LLM=anthropic --baseline L3=claude-opus-5 (empty per-round state)');
  console.log('treatment: current hybrid atoma (per-round snapshot of mature state)');
  console.log(`source  : ${sourceDb} + ${sourceSkills}`);
  console.log(`tasks   : ${file.tasks.map((t) => t.id).join(', ')}`);
  console.log(`output  : ${CSV_PATH}\n`);

  for (const task of file.tasks) {
    console.log(`── paired round: ${task.id} ──`);
    const state = await prepareCompareRound({
      scratchRoot: SCRATCH_ROOT,
      sourceDb,
      sourceSkills,
    });
    try {
      await runOne('baseline', task, state);
      await runOne('atoma', task, state);
    } finally {
      cleanupCompareRound(state);
    }
    console.log('');
  }
  console.log('\n== compare batch finished ==');
}

if (process.argv[1] && /compare-frontier\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof CompareAbortError) {
      console.error(err.message);
      process.exitCode = err.exitCode;
      return;
    }
    console.error('FATAL', err);
    process.exitCode = 1;
  });
}
