import { runIsolatedMenderCommand } from './menderIsolation.js';
import { runCodexSupervisor } from './codexSession.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import {
  mendRequestSchema,
  SUPERVISOR_MEND_JSON_SCHEMA,
  supervisorMendReportSchema,
  type MendRecordOutcome,
  type MendRequest,
  type SanitisedFinding,
  type SupervisorMendReport,
} from '../contracts/supervisorMend.js';
import {
  supervisorVerdictSchema,
  type FindingConfidence,
  type ServedModelUsage,
  type SupervisorVerdict,
  type VerdictFinding,
} from '../contracts/supervisorVerdict.js';
import { processExists } from '../mcp/runLock.js';
import { readBoundedJson } from '../sentinel/sources.js';
import { anyRunActive } from './activity.js';
import { truncate } from './digest.js';
import { mendEvent, safeSink, type MendJournalFacts } from './journal.js';
import { MENDER_HARDENING, MENDER_PROMPT_VERSION, buildMenderPrompt } from './menderPrompt.js';
import {
  branchName,
  checkDiffPolicy,
  commitMessage,
  commitSubject,
  defectKey,
  eligibleFindings,
  parseNumstat,
  pullRequestBody,
  sanitiseFinding,
  shortRunId,
  type EligibleFinding,
  type MendVerification,
} from './menderPolicy.js';
import { runClaudeSession, runCommand, servedMatchesPin, type SupervisorProvider } from './session.js';

/**
 * STAGE 3 — THE MENDER. A cited `defect` verdict becomes a pull request on
 * the base branch, so the runs that follow the merge execute the fixed code.
 *
 * THE POWER SPLIT IS THE WHOLE DESIGN. The MODEL edits files inside an
 * isolated git worktree at the tip of the base branch and may run the
 * repository's own checks inside a disposable container. It has no publisher
 * credentials, host HOME or engine socket, and it never sees trace text. The HARNESS — this module —
 * verifies on its own: it stashes the source change and runs the new test
 * files expecting a FAILURE, restores them, runs the full check expecting
 * success, and only then commits, pushes and opens the PR. A PERSON merges;
 * merge → CI → the existing deploy workflow is the redeploy, so "fixed for
 * the following runs" is the PR being merged and nothing more.
 *
 * Every attempt ends in exactly one `MendRecordOutcome`, written to
 * `supervisor/mender/<runId>.<finding>.json`, appended to `mender.jsonl`, and
 * — for every outcome that touched the deployment — journaled as a row that
 * carries facts and never model prose.
 */

export interface MenderCommands {
  readonly codex?: string;
  readonly claude: string;
  readonly gh: string;
  readonly install: string;
  readonly test: string;
  readonly check: string;
}

export const DEFAULT_MENDER_COMMANDS: MenderCommands = {
  claude: 'claude',
  gh: 'gh',
  install: 'npm ci',
  test: 'npx vitest run',
  check: 'npm run check',
};

/** The `ATOMA_MENDER_CMD_*` seams, for tests and unusual hosts. */
export function menderCommandsFromEnv(env: NodeJS.ProcessEnv = process.env): MenderCommands {
  return {
    codex: env['ATOMA_MENDER_CMD_CODEX'] ?? 'codex',
    claude: env['ATOMA_MENDER_CMD_CLAUDE'] ?? DEFAULT_MENDER_COMMANDS.claude,
    gh: env['ATOMA_MENDER_CMD_GH'] ?? DEFAULT_MENDER_COMMANDS.gh,
    install: env['ATOMA_MENDER_CMD_INSTALL'] ?? DEFAULT_MENDER_COMMANDS.install,
    test: env['ATOMA_MENDER_CMD_TEST'] ?? DEFAULT_MENDER_COMMANDS.test,
    check: env['ATOMA_MENDER_CMD_CHECK'] ?? DEFAULT_MENDER_COMMANDS.check,
  };
}

/** The model may run the repository's own verification and read git, nothing else. */
export const MENDER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(npm run check:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npm run lint:*)',
  'Bash(npm test:*)',
  'Bash(npx vitest:*)',
  'Bash(npx eslint:*)',
  'Bash(npx tsc:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
].join(',');
export const MENDER_DISALLOWED_TOOLS = 'WebFetch,WebSearch,Agent,NotebookEdit';

export function menderSessionArgs(prompt: string, provider: SupervisorProvider, budgetUsd: number): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SUPERVISOR_MEND_JSON_SCHEMA),
    '--model', provider.model,
    // Confines the file tools to the worktree, removes the code-running tools
    // not named below, and lets nothing approve settings/git/tool-config writes.
    '--restricted',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
    '--allowedTools', MENDER_ALLOWED_TOOLS,
    '--disallowedTools', MENDER_DISALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', String(budgetUsd),
    '--append-system-prompt', MENDER_HARDENING,
    prompt,
  ];
}

export interface MenderOptions {
  /** The checkout whose remote and base branch the worktree is cut from. */
  readonly repo: string;
  readonly runsDir: string;
  readonly supervisorDir: string;
  readonly leasePath: string;
  readonly provider: SupervisorProvider;
  readonly commands: MenderCommands;
  /** Trusted in-process test seam; production always uses the container executor. */
  readonly executeUntrusted?: typeof runCommand;
  readonly base: string;
  readonly remote: string;
  readonly minConfidence: FindingConfidence;
  readonly budgetUsd: number;
  readonly timeoutMs: number;
  readonly maxDiffLines: number;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly keepWorktree: boolean;
  /**
   * Assert the shared idle predicate before every heavy phase. OFF only on a
   * machine that has nothing else to do — the CI runner — where the operator
   * corpus and the run lease do not exist and would read as idle anyway; the
   * flag makes that a decision rather than an accident of the environment.
   */
  readonly idleGate: boolean;
  /** Wait for an idle machine (watch mode) or refuse (once / one verdict). */
  readonly waitForIdle: boolean;
  readonly pollMs: number;
  readonly journal: PlatformEventSink | null;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

export interface MenderPaths {
  readonly verdictsDir: string;
  readonly menderDir: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  readonly worktreesDir: string;
}

export function menderPaths(options: Pick<MenderOptions, 'repo' | 'supervisorDir'>): MenderPaths {
  return {
    verdictsDir: join(options.supervisorDir, 'verdicts'),
    menderDir: join(options.supervisorDir, 'mender'),
    ledgerPath: join(options.supervisorDir, 'mender.jsonl'),
    lockPath: join(options.supervisorDir, 'mender.lock'),
    worktreesDir: join(options.repo, '.worktrees'),
  };
}

export interface MendRecord {
  readonly runId: string;
  readonly findingIndex: number;
  readonly recordedAt: string;
  readonly promptVersion: string;
  readonly outcome: MendRecordOutcome;
  readonly key: string;
  readonly branch: string;
  readonly finding: { title: string; confidence: FindingConfidence };
  readonly baseSha?: string;
  readonly sha?: string;
  readonly prUrl?: string;
  readonly worktree?: string;
  readonly report?: SupervisorMendReport;
  readonly files?: readonly string[];
  readonly problems?: readonly string[];
  readonly verification?: MendVerification;
  readonly diffStat?: { files: number; added: number; deleted: number };
  readonly duplicateOf?: readonly string[];
  readonly provider?: { model: string; source: string; baseUrl: string | null };
  readonly modelsServed?: readonly ServedModelUsage[] | null;
  readonly mendCostUsd?: number | null;
  readonly mendDurationMs?: number | null;
  readonly mendTurns?: number | null;
  readonly reason?: string;
  readonly output?: string;
  readonly exitCode?: number | null;
}

export function mendRecordPath(menderDir: string, runId: string, index: number): string {
  return join(menderDir, `${runId}.${index}.json`);
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

interface GitOptions {
  readonly allowFailure?: boolean;
  readonly timeoutMs?: number;
}

async function git(
  cwd: string,
  args: readonly string[],
  warn: (line: string) => void,
  options: GitOptions = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Proposal files include ignored files too: a generated pre-push hook must
  // never execute with the publisher's credentials.
  const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeoutMs: options.timeoutMs ?? 120_000, onLog: warn });
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `git ${args.slice(0, 2).join(' ')} exited ${result.code}: ${truncate(result.stderr.trim() || result.stdout.trim(), 1500)}`
    );
  }
  return result;
}

interface LockOutcome {
  readonly ok: boolean;
  readonly holderPid?: number;
}

/** One mend at a time on this machine; a dead holder is reclaimed. */
export function acquireMenderLock(lockPath: string, warn: (line: string) => void): LockOutcome {
  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
      const pid = Number(held.pid);
      if (processExists(pid)) return { ok: false, holderPid: pid };
      warn(`stale mender lock from pid ${pid}; reclaiming`);
    } catch {
      warn('unreadable mender lock; reclaiming');
    }
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { ok: true };
}

export function releaseMenderLock(lockPath: string): void {
  try {
    const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (Number(held.pid) === process.pid) unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function priorRecordsWithKey(menderDir: string, key: string): MendRecord[] {
  if (!existsSync(menderDir)) return [];
  return readdirSync(menderDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readBoundedJson<MendRecord>(join(menderDir, name)))
    .filter((record): record is MendRecord => record !== null && record.key === key && record.outcome === 'pr-opened');
}

async function openPullRequestsWithKey(
  commands: MenderCommands,
  cwd: string,
  key: string,
  warn: (line: string) => void
): Promise<{ url: string }[]> {
  try {
    const result = await runCommand(
      commands.gh,
      ['pr', 'list', '--state', 'open', '--search', `"Defect-Key: ${key}" in:body`, '--json', 'number,url,title'],
      { cwd, timeoutMs: 60_000, onLog: warn }
    );
    if (result.code !== 0) {
      warn(`gh pr list failed (${truncate(result.stderr.trim(), 300)}); duplicate check skipped`);
      return [];
    }
    const parsed: unknown = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((row): row is { url: string } => typeof (row as { url?: unknown })?.url === 'string')
      : [];
  } catch (error) {
    warn(`gh pr list unavailable (${String(error)}); duplicate check skipped`);
    return [];
  }
}

async function requireIdle(options: MenderOptions, phase: string): Promise<boolean> {
  if (options.dryRun || !options.idleGate) return true;
  const probe = { runsDir: options.runsDir, leasePath: options.leasePath };
  if (!options.waitForIdle) {
    if (anyRunActive(probe)) {
      options.warn(`a run is active; refusing to ${phase} beside it (retry when idle, or use watch mode)`);
      return false;
    }
    return true;
  }
  while (anyRunActive(probe)) {
    options.log(`a run is active; the mender waits before it can ${phase}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, options.pollMs));
  }
  return true;
}

/* ─────────────────────────────── one mend ─────────────────────────────── */

export interface MendInput {
  readonly runId: string;
  readonly index: number;
  /** The run's own assessment, for the prompt. */
  readonly run: { readonly runStatus: SupervisorVerdict['runStatus']; readonly grade: SupervisorVerdict['runAssessment']['grade'] };
  /** A verdict finding, or one already sanitised by an analyst elsewhere. */
  readonly finding: VerdictFinding | SanitisedFinding;
  /** Which deployment asked, when the request crossed a boundary. */
  readonly instance?: string | null;
}

/** A request file (`--finding-file`), as the CI workflow hands it over. */
export function mendInputFromRequest(raw: unknown): MendInput {
  const request: MendRequest = mendRequestSchema.parse(raw);
  return {
    runId: request.runId,
    index: request.findingIndex,
    run: { runStatus: request.runStatus, grade: request.runGrade },
    finding: request.finding,
    instance: request.instance ?? null,
  };
}

/**
 * One attempt on one finding. Returns the record it wrote, or null when the
 * attempt could not even be recorded (another mender holds the lock, or the
 * idle gate refused before anything was prepared).
 */
export async function mendFinding(input: MendInput, options: MenderOptions): Promise<MendRecord | null> {
  const paths = menderPaths(options);
  const journal = safeSink(options.journal, options.warn);
  const { runId, index, run, finding } = input;
  const recordPath = mendRecordPath(paths.menderDir, runId, index);
  if (existsSync(recordPath) && !options.force) {
    options.log(`record already exists for ${runId}#${index} (use --force to redo); skipping`);
    return readBoundedJson<MendRecord>(recordPath);
  }
  const key = defectKey(finding);
  const branch = branchName(runId, index, finding);
  const base = { key, branch, finding: { title: finding.title, confidence: finding.confidence } };

  const record = (fields: Omit<MendRecord, 'runId' | 'findingIndex' | 'recordedAt' | 'promptVersion' | 'key' | 'branch' | 'finding'>): MendRecord => {
    const full: MendRecord = {
      runId,
      findingIndex: index,
      recordedAt: new Date().toISOString(),
      promptVersion: MENDER_PROMPT_VERSION,
      ...base,
      ...fields,
    };
    mkdirSync(paths.menderDir, { recursive: true });
    writeFileSync(recordPath, JSON.stringify(full, null, 2));
    appendFileSync(
      paths.ledgerPath,
      JSON.stringify({
        recordedAt: full.recordedAt,
        runId,
        findingIndex: index,
        outcome: full.outcome,
        key,
        prUrl: full.prUrl ?? null,
        branch,
      }) + '\n'
    );
    const facts: MendJournalFacts = {
      runId,
      findingIndex: index,
      key,
      branch,
      outcome: full.outcome,
      ...(full.prUrl !== undefined ? { prUrl: full.prUrl } : {}),
      ...(full.sha !== undefined ? { sha: full.sha } : {}),
      ...(full.provider ? { modelRequested: full.provider.model } : {}),
      ...(full.modelsServed ? { modelsServed: full.modelsServed.map((entry) => entry.model) } : {}),
      ...(full.mendCostUsd !== undefined ? { mendCostUsd: full.mendCostUsd } : {}),
      ...(full.diffStat ? { changedFiles: full.diffStat.files, changedLines: full.diffStat.added + full.diffStat.deleted } : {}),
      ...(full.problems ? { problems: full.problems } : {}),
      ...(full.worktree !== undefined ? { worktreeKept: true } : {}),
    };
    const event = mendEvent(facts);
    if (event) journal(event);
    options.log(`${full.outcome} for ${runId}#${index} → ${recordPath}`);
    return full;
  };

  const priors = priorRecordsWithKey(paths.menderDir, key);
  if (priors.length > 0 && !options.force) {
    return record({ outcome: 'skipped-duplicate', duplicateOf: priors.map((r) => r.prUrl ?? `${r.runId}#${r.findingIndex}`) });
  }
  const openPrs = await openPullRequestsWithKey(options.commands, options.repo, key, options.warn);
  if (openPrs.length > 0 && !options.force) {
    return record({ outcome: 'skipped-duplicate', duplicateOf: openPrs.map((pr) => pr.url) });
  }

  const lock = acquireMenderLock(paths.lockPath, options.warn);
  if (!lock.ok) {
    options.warn(`another mender (pid ${lock.holderPid}) holds ${paths.lockPath}; not starting`);
    return null;
  }

  const worktree = join(paths.worktreesDir, `mender-${shortRunId(runId)}-${index}`);
  let keepWorktree = options.keepWorktree;
  const provider = options.provider;
  const executeUntrusted = options.executeUntrusted ?? runIsolatedMenderCommand;
  const providerFacts = { model: provider.model, source: provider.source, baseUrl: provider.baseUrl };
  try {
    if (!(await requireIdle(options, 'prepare a worktree'))) return null;

    // A fresh worktree at the tip of the base branch, never the serving checkout.
    await git(options.repo, ['fetch', options.remote, options.base], options.warn);
    if (existsSync(worktree)) {
      options.warn(`stale worktree at ${worktree}; removing`);
      await git(options.repo, ['worktree', 'remove', '--force', worktree], options.warn, { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
    }
    mkdirSync(paths.worktreesDir, { recursive: true });
    await git(options.repo, ['worktree', 'add', '-B', branch, worktree, `${options.remote}/${options.base}`], options.warn);
    const baseSha = (await git(worktree, ['rev-parse', 'HEAD'], options.warn)).stdout.trim();
    options.log(`worktree ${worktree} on ${branch} at ${baseSha.slice(0, 10)}`);

    options.log(`installing (${options.commands.install})`);
    const install = await executeUntrusted(options.commands.install, [], { cwd: worktree, timeoutMs: options.timeoutMs, onLog: options.warn });
    if (install.code !== 0) {
      keepWorktree = true;
      return record({ outcome: 'harness-failed', baseSha, worktree, reason: 'install failed', output: truncate(install.stderr || install.stdout, 4000) });
    }

    const prompt = buildMenderPrompt({
      runId,
      runStatus: run.runStatus,
      runGrade: run.grade,
      findingIndex: index,
      findingJson: JSON.stringify(sanitiseFinding(finding), null, 2),
    });
    const args = menderSessionArgs(prompt, provider, options.budgetUsd);
    if (options.dryRun) {
      options.log(`dry-run: provider ${provider.model} via ${provider.source}${provider.baseUrl ? ` (${provider.baseUrl})` : ''}`);
      options.log(provider.transport === 'codex' ? 'dry-run: would start a container-isolated Codex ChatGPT session' : `dry-run: would spawn ${options.commands.claude} ${args.slice(0, -1).join(' ')}`);
      options.log(`dry-run: prompt is ${prompt.length} chars; worktree ${worktree}`);
      return record({ outcome: 'dry-run', baseSha, provider: providerFacts });
    }

    if (!(await requireIdle(options, 'spend model quota'))) {
      keepWorktree = false;
      return null;
    }
    journal(mendEvent({ runId, findingIndex: index, key, branch, outcome: 'started', modelRequested: provider.model })!);
    options.log(`mending ${runId}#${index} "${truncate(finding.title, 80)}" with ${provider.model} (${provider.source} provider)`);
    const startedAt = Date.now();
    const session = provider.transport === 'codex' ? await runCodexSupervisor({
      command: options.commands.codex ?? 'codex', provider, cwd: worktree, prompt,
      hardening: MENDER_HARDENING, schema: SUPERVISOR_MEND_JSON_SCHEMA,
      timeoutMs: options.timeoutMs, execute: executeUntrusted, onLog: options.warn,
    }) : await runClaudeSession({
      claudeCommand: options.commands.claude,
      execute: executeUntrusted,
      args,
      cwd: worktree,
      provider,
      timeoutMs: options.timeoutMs,
      onLog: options.warn,
    });
    const modelMeta = {
      provider: providerFacts,
      modelsServed: session.usage.served,
      mendCostUsd: session.usage.costUsd,
      mendDurationMs: session.usage.durationMs ?? Date.now() - startedAt,
      mendTurns: session.usage.turns,
    };
    if (session.code !== 0) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'model-failed', baseSha, worktree, exitCode: session.code, output: truncate(session.stderr.trim() || session.stdout.trim(), 4000) });
    }
    const parsed = supervisorMendReportSchema.safeParse(session.structured);
    if (!servedMatchesPin(provider, session.usage)) {
      options.warn(`requested ${provider.model} but served ${session.usage.served?.map((m) => m.model).join(' + ')}`);
    }
    if (!parsed.success) {
      keepWorktree = true;
      mkdirSync(paths.menderDir, { recursive: true });
      writeFileSync(join(paths.menderDir, `${runId}.${index}.raw.txt`), session.stdout);
      const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      return record({ ...modelMeta, outcome: 'invalid-report', baseSha, worktree, problems });
    }
    const report = parsed.data;
    if (report.outcome === 'declined') {
      return record({ ...modelMeta, outcome: 'declined', baseSha, report });
    }

    // ---- verification, by the harness and never by the model's word ----
    await git(worktree, ['add', '-A'], options.warn);
    const files = (await git(worktree, ['diff', '--cached', '--name-only'], options.warn)).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const numstat = parseNumstat((await git(worktree, ['diff', '--cached', '--numstat'], options.warn)).stdout);
    const policy = checkDiffPolicy({ files, numstat, maxLines: options.maxDiffLines });
    const proposedTree = (await git(worktree, ['write-tree'], options.warn)).stdout.trim();
    await git(worktree, ['reset', '-q'], options.warn);
    if (!policy.ok) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'refused', baseSha, worktree, report, files, problems: policy.problems });
    }

    // The regression test must FAIL without the source change: stash the
    // non-test files (untracked included), run the test files, restore.
    const stashed = await git(worktree, ['stash', 'push', '-u', '--', ...policy.sourceFiles], options.warn);
    if (!/Saved working directory/.test(stashed.stdout)) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'harness-failed', baseSha, worktree, reason: 'could not stash source changes', output: truncate(stashed.stdout + stashed.stderr, 2000) });
    }
    let before: { code: number | null; stdout: string; stderr: string } | null = null;
    let testError: unknown = null;
    try {
      before = await executeUntrusted(options.commands.test, policy.testFiles, { cwd: worktree, timeoutMs: options.timeoutMs, onLog: options.warn });
    } catch (error) {
      testError = error;
    }
    const popped = await git(worktree, ['stash', 'pop'], options.warn, { allowFailure: true });
    if (popped.code !== 0) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'harness-failed', baseSha, worktree, reason: 'stash pop failed — the worktree is kept with the stash', output: truncate(popped.stderr, 2000) });
    }
    if (testError || !before) {
      throw testError instanceof Error ? testError : new Error('test command produced no result');
    }
    const testFailedBefore = before.code !== 0;
    if (!testFailedBefore) {
      keepWorktree = true;
      return record({
        ...modelMeta,
        outcome: 'refused',
        baseSha,
        worktree,
        report,
        files,
        problems: ['the regression test passes on the unfixed code — the mechanism is not established'],
        output: truncate(before.stdout + before.stderr, 3000),
      });
    }

    if (!(await requireIdle(options, 'run the full check'))) {
      keepWorktree = true;
      return null;
    }
    options.log(`verifying (${options.commands.check})`);
    const check = await executeUntrusted(options.commands.check, [], { cwd: worktree, timeoutMs: options.timeoutMs, onLog: options.warn });
    const checkPassed = check.code === 0;
    if (!checkPassed) {
      keepWorktree = true;
      return record({
        ...modelMeta,
        outcome: 'refused',
        baseSha,
        worktree,
        report,
        files,
        problems: ['the full check is red after the fix'],
        output: truncate(check.stdout + check.stderr, 6000),
      });
    }
    const verification: MendVerification = { testFailedBefore, checkPassed, testFiles: policy.testFiles, checkCommand: options.commands.check };

    // ---- commit, push, pull request: the harness's hands, never the model's ----
    await git(worktree, ['add', '-A'], options.warn);
    const finalFiles = (await git(worktree, ['diff', '--cached', '--name-only'], options.warn)).stdout.trim().split('\n').filter(Boolean);
    const finalPolicy = checkDiffPolicy({
      files: finalFiles,
      numstat: parseNumstat((await git(worktree, ['diff', '--cached', '--numstat'], options.warn)).stdout),
      maxLines: options.maxDiffLines,
    });
    const finalTree = (await git(worktree, ['write-tree'], options.warn)).stdout.trim();
    const finalHead = (await git(worktree, ['rev-parse', 'HEAD'], options.warn)).stdout.trim();
    if (!finalPolicy.ok || finalTree !== proposedTree || finalHead !== baseSha) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'refused', baseSha, worktree, report, files: finalFiles,
        problems: [...finalPolicy.problems, 'verification changed the proposed tree or base commit'] });
    }
    mkdirSync(paths.menderDir, { recursive: true });
    const messagePath = join(paths.menderDir, `${runId}.${index}.commit.txt`);
    writeFileSync(messagePath, commitMessage({ report, sourceFiles: policy.sourceFiles, runId, key, verification }));
    await git(worktree, ['commit', '--author=atoma mender <mender@atoma.invalid>', '-F', messagePath], options.warn, { timeoutMs: options.timeoutMs });
    const sha = (await git(worktree, ['rev-parse', 'HEAD'], options.warn)).stdout.trim();
    await git(worktree, ['push', '-u', options.remote, branch], options.warn, { timeoutMs: 300_000 });

    const diffStat = {
      files: files.length,
      added: numstat.reduce((total, row) => total + row.added, 0),
      deleted: numstat.reduce((total, row) => total + row.deleted, 0),
    };
    const bodyPath = join(paths.menderDir, `${runId}.${index}.pr.md`);
    writeFileSync(
      bodyPath,
      pullRequestBody({ report, finding, instance: input.instance ?? null, runId, key, verification, provider, served: session.usage.served, costUsd: session.usage.costUsd, diffStat })
    );
    const pr = await runCommand(
      options.commands.gh,
      ['pr', 'create', '--base', options.base, '--head', branch, '--title', commitSubject(report, policy.sourceFiles), '--body-file', bodyPath],
      { cwd: worktree, timeoutMs: 120_000, onLog: options.warn }
    );
    if (pr.code !== 0) {
      keepWorktree = true;
      return record({ ...modelMeta, outcome: 'pushed-no-pr', baseSha, sha, worktree, report, files, verification, output: truncate(pr.stderr.trim() || pr.stdout.trim(), 2000) });
    }
    const prUrl = /https?:\/\/\S+/.exec(pr.stdout)?.[0] ?? pr.stdout.trim();
    return record({ ...modelMeta, outcome: 'pr-opened', baseSha, sha, prUrl, report, files, diffStat, verification });
  } finally {
    if (!keepWorktree && existsSync(worktree)) {
      await git(options.repo, ['worktree', 'remove', '--force', worktree], options.warn, { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
      // The branch lives on the remote once pushed; locally it is only clutter.
      await git(options.repo, ['branch', '-D', branch], options.warn, { allowFailure: true });
    } else if (keepWorktree && existsSync(worktree)) {
      options.log(`worktree kept for inspection: ${worktree} (branch ${branch})`);
    }
    releaseMenderLock(paths.lockPath);
  }
}

/* ─────────────────────────────── discovery ─────────────────────────────── */

export interface VerdictFile {
  readonly runId: string;
  readonly mtimeMs: number;
}

export function listVerdicts(verdictsDir: string): VerdictFile[] {
  if (!existsSync(verdictsDir)) return [];
  return readdirSync(verdictsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ runId: name.slice(0, -'.json'.length), mtimeMs: statSync(join(verdictsDir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function readVerdict(verdictsDir: string, runId: string): SupervisorVerdict | null {
  const raw = readBoundedJson<unknown>(join(verdictsDir, `${runId}.json`));
  if (!raw || typeof raw !== 'object') return null;
  // A stored verdict carries `_meta` beside the schema's strict shape.
  const { _meta: _ignored, ...bare } = raw as Record<string, unknown>;
  const parsed = supervisorVerdictSchema.safeParse(bare);
  return parsed.success ? parsed.data : null;
}

/** Every (verdict, finding) pair the mender has not yet recorded. */
export function pendingMends(options: MenderOptions, runIds: readonly string[]): MendInput[] {
  const paths = menderPaths(options);
  const work: MendInput[] = [];
  for (const runId of runIds) {
    const verdict = readVerdict(paths.verdictsDir, runId);
    if (!verdict) continue;
    for (const { index, finding } of eligibleFindings(verdict, options.minConfidence)) {
      if (existsSync(mendRecordPath(paths.menderDir, runId, index)) && !options.force) continue;
      work.push({ runId, index, run: { runStatus: verdict.runStatus, grade: verdict.runAssessment.grade }, finding });
    }
  }
  return work;
}

export function eligibleForVerdict(verdict: SupervisorVerdict, options: MenderOptions, only?: number): EligibleFinding[] {
  const eligible = eligibleFindings(verdict, options.minConfidence);
  return only === undefined ? eligible : eligible.filter((entry) => entry.index === only);
}

/** Mend each item in turn; a thrown attempt is contained and counted. */
export async function processMends(work: readonly MendInput[], options: MenderOptions): Promise<{ failures: number; records: MendRecord[] }> {
  let failures = 0;
  const records: MendRecord[] = [];
  for (const item of work) {
    try {
      const outcome = await mendFinding(item, options);
      if (!outcome) failures += 1;
      else records.push(outcome);
      if (outcome && !['pr-opened', 'declined', 'skipped-duplicate', 'dry-run'].includes(outcome.outcome)) failures += 1;
    } catch (error) {
      failures += 1;
      options.warn(`mend of ${item.runId}#${item.index} failed: ${String(error)}`);
    }
  }
  return { failures, records };
}

export const MENDER_DEFAULT_POLL_MS = 30_000;

/**
 * Watch the verdicts directory; mend every new eligible finding once. One
 * attempt per verdict in watch mode; `--verdict` redoes.
 */
export async function runMenderLoop(args: {
  readonly options: MenderOptions;
  readonly signal: AbortSignal;
  readonly backfill?: number;
}): Promise<void> {
  const { options, signal } = args;
  const paths = menderPaths(options);
  const verdicts = listVerdicts(paths.verdictsDir);
  const baseline = new Set(verdicts.map((v) => v.runId));
  if (args.backfill && args.backfill > 0) {
    for (const v of verdicts.slice(-args.backfill)) baseline.delete(v.runId);
  }
  while (!signal.aborted) {
    const fresh = listVerdicts(paths.verdictsDir).filter((v) => !baseline.has(v.runId));
    if (fresh.length > 0) {
      await processMends(pendingMends(options, fresh.map((v) => v.runId)), options);
      for (const v of fresh) baseline.add(v.runId);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, options.pollMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolveSleep(); }, { once: true });
    });
  }
}
