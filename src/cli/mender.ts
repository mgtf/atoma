#!/usr/bin/env tsx
/**
 * atoma mender — a cited defect verdict becomes a pull request on main
 * (stage 3 of `docs/supervisor-design.md`).
 *
 *   npm run mender                                   # watch supervisor/verdicts, mend new defects
 *   npm run mender -- --once [--backfill <n>]        # mend pending defects, exit
 *   npm run mender -- --verdict <runId> [--finding <n>] [--force]
 *   npm run mender -- --dry-run ...                  # everything up to (not including) the model
 *
 * The model edits an isolated worktree and may run the repository's checks
 * there; it never commits, pushes or opens anything. The harness proves the
 * regression test fails before the fix and the full check passes after, then
 * commits, pushes and opens the PR. A person merges. Every attempt is one
 * record under supervisor/mender/ and — when it touched the deployment — one
 * journal row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { storeDbPath } from '../core/stores.js';
import { mcpRunLockPath } from '../mcp/runLock.js';
import { PlatformEventLog } from '../platform/events.js';
import { findingConfidenceSchema, type FindingConfidence } from '../contracts/supervisorVerdict.js';
import {
  eligibleForVerdict,
  listVerdicts,
  MENDER_DEFAULT_POLL_MS,
  mendInputFromRequest,
  menderCommandsFromEnv,
  menderPaths,
  pendingMends,
  processMends,
  readVerdict,
  runMenderLoop,
  type MenderOptions,
} from '../supervisor/mender.js';
import { DEFAULT_MAX_DIFF_LINES } from '../supervisor/menderPolicy.js';
import { looksPinned, menderProvider } from '../supervisor/session.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma mender — a cited defect verdict becomes a pull request on main

usage:
  npm run mender [-- --once [--backfill <n>]] [--verdict <runId> [--finding <n>]]
                 [--finding-file <request.json>] [--no-idle-gate] [--dry-run]
                 [--force] [--keep-worktree] [--min-confidence high|medium|low]
                 [--budget-usd <usd>] [--timeout-ms <ms>] [--max-diff-lines <n>]
                 [--poll-ms <ms>] [--base <branch>] [--remote <name>] [--repo <path>]
                 [--runs <dir>] [--supervisor-dir <dir>] [--db <path>]

what it does:
  For each analyst verdict carrying a \`defect\` finding at or above the
  confidence floor with a cited proposedFix: cut a worktree at the tip of the
  base branch, install, run ONE restricted headless claude session that may
  edit src/, tests/ and docs/incidents/ and run the checks, then VERIFY on its
  own — the new test must fail without the source change and \`npm run check\`
  must pass with it — and only then commit, push and open the PR with gh.
  A person merges; merge → CI → the existing production deployment.

what it never does:
  Take a mechanism_candidate (COOLING-OFF), show the model any trace text,
  merge, or run beside a live run. Refusals keep the worktree for inspection.

provider:
  ATOMA_MENDER_MODEL / _BASE_URL / _AUTH_TOKEN as a set, else the ATOMA_ANALYST_*
  set, else pinned claude-sonnet-5 with explicit ANTHROPIC_API_KEY / AUTH_TOKEN.
  Host login files are not exposed to the execution container.
  ATOMA_MENDER_TRANSPORT=codex selects a dedicated ChatGPT subscription login
  from ATOMA_MENDER_CODEX_HOME. Only an auth-only temporary copy is mounted
  during the model phase; refreshes are preserved. No OpenAI API billing.

execution host:
  Linux / WSL2 with Docker; build the disposable image before the first mend:
  docker build -f docker/mender.Dockerfile -t atoma-mender:local .
  ATOMA_MENDER_SANDBOX_IMAGE may select an operator-built image.
  The model and checks have no host HOME, GitHub credentials or engine socket.

commands (env, resolved inside the execution image):
  ATOMA_MENDER_CMD_CLAUDE (claude)   ATOMA_MENDER_CMD_GH (gh)
  ATOMA_MENDER_CMD_INSTALL (npm ci)  ATOMA_MENDER_CMD_TEST (npx vitest run)
  ATOMA_MENDER_CMD_CHECK (npm run check)

flags:
  --finding-file <path>  mend ONE request (atoma.supervisor.mend-request/v1) — what a
                         production analyst dispatches to .github/workflows/mender.yml
  --no-idle-gate         skip the live-run gate; only for a machine with nothing else to do (CI)
  --once                 mend pending findings (all, or the --backfill newest verdicts), exit
  --backfill <n>         limit --once to the n newest verdicts; in watch mode, re-queue them
  --verdict <runId>      mend the eligible findings of one verdict (--finding <n> for one)
  --force                redo a finding that already has a record
  --dry-run              prepare the worktree and print the session line; spend nothing
  --keep-worktree        keep the worktree even after a pull request
  --min-confidence <c>   confidence floor (default high)
  --budget-usd <usd>     Claude spend ceiling per mend (default 5; unsupported by Codex)
  --timeout-ms <ms>      wall clock per phase (default 1800000)
  --max-diff-lines <n>   refuse a larger change (default ${DEFAULT_MAX_DIFF_LINES})
  --poll-ms <ms>         watch poll interval (default ${MENDER_DEFAULT_POLL_MS})
  --base <branch>        base branch (default main)     --remote <name>  (default origin)
  --repo <path>          checkout to cut worktrees from (default cwd)
  --runs <dir>           operator runs directory, for the idle gate (default ATOMA_RUNS_DIR or ./runs)
  --supervisor-dir <dir> where verdicts and records live (default ./supervisor)
  --db <path>            product store holding the journal (default ATOMA_DB_PATH or ./atoma.db)
  --help                 show this help`;

function fail(message: string): never {
  process.stderr.write(`atoma mender: ${message}\n`);
  process.exit(1);
}

function positiveNumber(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

function nonNegativeInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`invalid ${label}="${raw}"`);
  return value;
}

function confidence(raw: string | undefined): FindingConfidence {
  if (raw === undefined) return 'high';
  const parsed = findingConfidenceSchema.safeParse(raw);
  if (!parsed.success) fail(`invalid --min-confidence="${raw}" (high, medium or low)`);
  return parsed.data;
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const args = parseCliArgs(process.argv, {
    booleanFlags: ['help', 'once', 'dry-run', 'force', 'keep-worktree', 'no-idle-gate'],
    valueFlags: [
      'verdict', 'finding', 'finding-file', 'backfill', 'min-confidence', 'budget-usd', 'timeout-ms', 'max-diff-lines',
      'poll-ms', 'base', 'remote', 'repo', 'runs', 'supervisor-dir', 'db',
    ],
    undeclared: 'discard',
  });
  if (args.flags['help'] === 'true') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.undeclaredFlags.length > 0) fail(`unknown flag: ${args.undeclaredFlags[0]!}`);
  if (args.command !== null) fail(`unexpected argument: ${args.command}`);

  const repo = resolve(args.flags['repo'] || process.cwd());
  const dbPath = args.flags['db'] || storeDbPath();
  const provider = menderProvider();
  if (!looksPinned(provider.model)) {
    process.stderr.write(`atoma mender: "${provider.model}" is an alias, not a pinned model id — records made under it are not comparable over time\n`);
  }
  if (provider.baseUrl && !provider.authToken) {
    process.stderr.write(`atoma mender: a base URL is set for the ${provider.source} provider without an auth token — the endpoint will likely refuse\n`);
  }
  // Journal only into a store that EXISTS (see the analyst for why).
  const journal = existsSync(dbPath) ? PlatformEventLog.open(dbPath) : null;
  const log = (line: string): void => void process.stdout.write(`[mender ${new Date().toISOString()}] ${line}\n`);
  const warn = (line: string): void => void process.stderr.write(`[mender ${new Date().toISOString()}] WARN ${line}\n`);
  const once = args.flags['once'] === 'true';
  const verdictId = args.flags['verdict'];
  const findingFile = args.flags['finding-file'];
  const options: MenderOptions = {
    repo,
    runsDir: resolve(args.flags['runs'] || process.env['ATOMA_RUNS_DIR'] || './runs'),
    supervisorDir: resolve(args.flags['supervisor-dir'] || './supervisor'),
    leasePath: mcpRunLockPath(),
    provider,
    commands: menderCommandsFromEnv(),
    base: args.flags['base'] || 'main',
    remote: args.flags['remote'] || 'origin',
    minConfidence: confidence(args.flags['min-confidence']),
    budgetUsd: positiveNumber(args.flags['budget-usd'], '--budget-usd', 5),
    timeoutMs: positiveNumber(args.flags['timeout-ms'], '--timeout-ms', 1_800_000),
    maxDiffLines: positiveNumber(args.flags['max-diff-lines'], '--max-diff-lines', DEFAULT_MAX_DIFF_LINES),
    dryRun: args.flags['dry-run'] === 'true',
    force: args.flags['force'] === 'true',
    keepWorktree: args.flags['keep-worktree'] === 'true',
    idleGate: args.flags['no-idle-gate'] !== 'true',
    waitForIdle: !once && !verdictId && !findingFile,
    pollMs: positiveNumber(args.flags['poll-ms'], '--poll-ms', MENDER_DEFAULT_POLL_MS),
    journal: journal ? (input) => void journal.append(input) : null,
    log,
    warn,
  };
  const paths = menderPaths(options);
  process.stdout.write(
    `atoma mender — a person merges; the model never pushes\n` +
      `  repo       ${repo} (${options.remote}/${options.base})\n` +
      `  verdicts   ${paths.verdictsDir}\n` +
      `  journal    ${journal ? dbPath : 'none (no product store at ' + dbPath + ')'}\n` +
      `  provider   ${provider.model} (${provider.source}${provider.baseUrl ? `, ${provider.baseUrl}` : ''})\n` +
      `  floor      confidence ≥ ${options.minConfidence}, defects only\n`
  );

  const backfill = nonNegativeInteger(args.flags['backfill'], '--backfill');
  if (findingFile) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(findingFile, 'utf8'));
    } catch (error) {
      fail(`cannot read ${findingFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let input: ReturnType<typeof mendInputFromRequest>;
    try {
      input = mendInputFromRequest(raw);
    } catch (error) {
      fail(`${findingFile} is not a mend request: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!options.idleGate) log('idle gate OFF — this machine is expected to have nothing else to do');
    const { failures } = await processMends([input], options);
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }
  if (verdictId) {
    const verdict = readVerdict(paths.verdictsDir, verdictId);
    if (!verdict) fail(`no valid verdict for ${verdictId} under ${paths.verdictsDir}`);
    const only = nonNegativeInteger(args.flags['finding'], '--finding');
    const eligible = eligibleForVerdict(verdict, options, only);
    if (eligible.length === 0) {
      fail(`no eligible defect finding in ${verdictId} (kind=defect, confidence ≥ ${options.minConfidence}, proposedFix cited)`);
    }
    const { failures } = await processMends(
      eligible.map(({ index, finding }) => ({
        runId: verdictId,
        index,
        run: { runStatus: verdict.runStatus, grade: verdict.runAssessment.grade },
        finding,
      })),
      options
    );
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }

  if (once) {
    const verdicts = listVerdicts(paths.verdictsDir);
    const ids = (backfill !== undefined && backfill > 0 ? verdicts.slice(-backfill) : verdicts).map((v) => v.runId);
    const work = pendingMends(options, ids);
    log(`once: ${work.length} pending defect finding(s)`);
    const { failures } = await processMends(work, options);
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
  log(`watching ${paths.verdictsDir} (poll ${options.pollMs}ms${options.dryRun ? ', DRY-RUN' : ''})`);
  await runMenderLoop({ options, signal: controller.signal, ...(backfill !== undefined ? { backfill } : {}) });
}

main().catch((error: unknown) => {
  process.stderr.write(`atoma mender: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
