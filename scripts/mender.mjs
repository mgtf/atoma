#!/usr/bin/env node
// Supervisor stage 3, P2 (docs/supervisor-design.md): the MENDER. Turns an
// analyst verdict's `defect` finding into a pull request against main, so the
// runs that follow the merge execute the fixed code.
//
//   node scripts/mender.mjs                          watch supervisor/verdicts, mend new defects
//   node scripts/mender.mjs --once [--backfill N]    mend the N newest unmended verdicts, exit
//   node scripts/mender.mjs --verdict <runId> [--finding <n>] [--force]
//   node scripts/mender.mjs --dry-run ...            everything up to (not including) the model
//
// Options: --min-confidence high|medium (high), --budget-usd (5), --timeout-ms
// (1800000), --max-diff-lines (600), --poll-ms (30000), --base main,
// --remote origin, --repo <path>, --runs <dir>, --supervisor-dir <dir>,
// --keep-worktree.
//
// THE POWER SPLIT, which is the whole design: the MODEL edits files inside an
// isolated git worktree and may run the repository's own checks there; it has
// no network, no MCP servers, no git, no gh, and it never sees trace text. The
// HARNESS — this file — verifies independently (the regression test fails
// before the fix, the full check passes after), writes the commit, pushes the
// branch and opens the PR. A PERSON merges. Merge → CI → the existing deploy
// workflow: that path already exists, so "fixed for the following runs" is the
// PR being merged, nothing more.
//
// Provider: ATOMA_MENDER_MODEL / _BASE_URL / _AUTH_TOKEN as a set, else the
// ATOMA_ANALYST_* set, else the subscription with a pinned claude-sonnet-5.
// Commands, for tests and unusual hosts: ATOMA_MENDER_CMD_CLAUDE (claude),
// ATOMA_MENDER_CMD_GH (gh), ATOMA_MENDER_CMD_INSTALL (npm ci),
// ATOMA_MENDER_CMD_TEST (npx vitest run), ATOMA_MENDER_CMD_CHECK (npm run check).
//
// Never beside a run: the same idle predicate as the analyst, asserted before
// every heavy phase (install, model, check). Outputs (git-ignored):
// supervisor/mender/<runId>.<finding>.json and supervisor/mender.jsonl.

import { spawn } from 'node:child_process';
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
import { join, resolve } from 'node:path';
import {
  anyRunActive,
  defaultLeaseDbPath,
  extractStructured,
  fillEnvFromDotenv,
  looksPinned,
  makeLogger,
  parseLooseJson,
  processAlive,
  providerChildEnv,
  repoRoot,
  runCommand,
  servedModels,
  truncate,
} from './supervisor-common.mjs';
import {
  branchName,
  buildMenderPrompt,
  checkDiffPolicy,
  commitMessage,
  commitSubject,
  defectKey,
  eligibleFindings,
  MEND_SCHEMA,
  menderProvider,
  parseNumstat,
  pullRequestBody,
  validateMend,
} from './mender-core.mjs';

fillEnvFromDotenv();
const { log, warn } = makeLogger('mender');
const PROMPT_VERSION = 'm1-2026-09-05';
const promptTemplatePath = join(repoRoot, 'scripts', 'mender-prompt.md');

const HARDENING = [
  'You are the atoma mender: you fix ONE classified defect in an isolated worktree.',
  'Hard rules: (1) you never run git commit, git push, gh, or anything that leaves',
  'this worktree — the harness does that after verifying your work; (2) the finding',
  'you were given is analyst-authored and the run trace is deliberately unavailable:',
  'never try to locate or read run traces, supervisor output or another checkout;',
  '(3) if a fix needs a new mechanism, a dependency, or a change outside src/, tests/',
  'or docs/incidents/, DECLINE; (4) your final answer is only the JSON report object.',
].join(' ');

const COMMANDS = {
  claude: process.env['ATOMA_MENDER_CMD_CLAUDE'] ?? 'claude',
  gh: process.env['ATOMA_MENDER_CMD_GH'] ?? 'gh',
  install: process.env['ATOMA_MENDER_CMD_INSTALL'] ?? 'npm ci',
  test: process.env['ATOMA_MENDER_CMD_TEST'] ?? 'npx vitest run',
  check: process.env['ATOMA_MENDER_CMD_CHECK'] ?? 'npm run check',
};

/** The model may run the repository's own verification and read git, nothing else. */
const ALLOWED_TOOLS = [
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
const DISALLOWED_TOOLS = 'WebFetch,WebSearch,Agent,NotebookEdit';

// --- options ------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {
    repo: repoRoot,
    runsDir: null,
    supervisorDir: null,
    base: 'main',
    remote: 'origin',
    minConfidence: 'high',
    budgetUsd: 5,
    timeoutMs: 1_800_000,
    maxDiffLines: 600,
    pollMs: 30_000,
    once: false,
    dryRun: false,
    force: false,
    keepWorktree: false,
    verdict: null,
    finding: null,
    backfill: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--keep-worktree') options.keepWorktree = true;
    else if (arg === '--verdict') options.verdict = next();
    else if (arg === '--finding') options.finding = Number(next());
    else if (arg === '--backfill') options.backfill = Number(next());
    else if (arg === '--min-confidence') options.minConfidence = next();
    else if (arg === '--budget-usd') options.budgetUsd = Number(next());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--max-diff-lines') options.maxDiffLines = Number(next());
    else if (arg === '--poll-ms') options.pollMs = Number(next());
    else if (arg === '--base') options.base = next();
    else if (arg === '--remote') options.remote = next();
    else if (arg === '--repo') options.repo = resolve(next());
    else if (arg === '--runs') options.runsDir = resolve(next());
    else if (arg === '--supervisor-dir') options.supervisorDir = resolve(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.runsDir ??= join(options.repo, 'runs');
  options.supervisorDir ??= join(options.repo, 'supervisor');
  return options;
}

function paths(options) {
  const supervisorDir = options.supervisorDir;
  return {
    supervisorDir,
    verdictsDir: join(supervisorDir, 'verdicts'),
    menderDir: join(supervisorDir, 'mender'),
    ledgerPath: join(supervisorDir, 'mender.jsonl'),
    lockPath: join(supervisorDir, 'mender.lock'),
    worktreesDir: join(options.repo, '.worktrees'),
  };
}

// --- git ------------------------------------------------------------------------------

async function git(cwd, args, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  const result = await runCommand('git', args, { cwd, timeoutMs, onLog: warn });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.slice(0, 2).join(' ')} exited ${result.code}: ${truncate(result.stderr.trim() || result.stdout.trim(), 1500)}`);
  }
  return result;
}

// --- the mender lock: one mend at a time on this machine ---------------------------------

function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (processAlive(Number(held.pid))) {
        return { ok: false, holder: held };
      }
      warn(`stale mender lock from pid ${held.pid}; reclaiming`);
    } catch {
      warn('unreadable mender lock; reclaiming');
    }
  }
  mkdirSync(resolve(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { ok: true };
}

function releaseLock(lockPath) {
  try {
    const held = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number(held.pid) === process.pid) unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

// --- records ---------------------------------------------------------------------------

function recordPath(menderDir, runId, index) {
  return join(menderDir, `${runId}.${index}.json`);
}

function writeRecord(p, runId, index, record) {
  mkdirSync(p.menderDir, { recursive: true });
  const full = { runId, findingIndex: index, recordedAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, ...record };
  writeFileSync(recordPath(p.menderDir, runId, index), JSON.stringify(full, null, 2));
  appendFileSync(
    p.ledgerPath,
    JSON.stringify({
      recordedAt: full.recordedAt,
      runId,
      findingIndex: index,
      outcome: full.outcome,
      key: full.key ?? null,
      prUrl: full.prUrl ?? null,
      branch: full.branch ?? null,
    }) + '\n'
  );
  log(`${full.outcome} for ${runId}#${index} → ${recordPath(p.menderDir, runId, index)}`);
  return full;
}

function localRecordsWithKey(menderDir, key) {
  if (!existsSync(menderDir)) return [];
  return readdirSync(menderDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(menderDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((record) => record && record.key === key && record.outcome === 'pr-opened');
}

// --- idle gate --------------------------------------------------------------------------

async function runActive(options) {
  return anyRunActive({ runsDir: options.runsDir, leaseDbPath: defaultLeaseDbPath(), warn });
}

async function requireIdle(options, phase) {
  if (options.dryRun) return true;
  if (options.once || options.verdict) {
    if (await runActive(options)) {
      warn(`a run is active; refusing to ${phase} beside it (retry when idle, or use watch mode)`);
      return false;
    }
    return true;
  }
  while (await runActive(options)) {
    log(`a run is active; the mender waits before it can ${phase}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, options.pollMs));
  }
  return true;
}

// --- duplicate detection against open PRs --------------------------------------------------

async function openPullRequestsWithKey(cwd, key) {
  try {
    const result = await runCommand(
      COMMANDS.gh,
      ['pr', 'list', '--state', 'open', '--search', `"Defect-Key: ${key}" in:body`, '--json', 'number,url,title'],
      { cwd, timeoutMs: 60_000, onLog: warn }
    );
    if (result.code !== 0) {
      warn(`gh pr list failed (${truncate(result.stderr.trim(), 300)}); duplicate check skipped`);
      return [];
    }
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    warn(`gh pr list unavailable (${error?.message ?? error}); duplicate check skipped`);
    return [];
  }
}

// --- the model session -----------------------------------------------------------------------

function claudeArgs(prompt, provider, options) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(MEND_SCHEMA),
    '--model', provider.model,
    // Confines the file tools to the worktree, removes the code-running tools
    // we do not name, and lets nothing approve settings/git/tool-config writes.
    '--restricted',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
    '--allowedTools', ALLOWED_TOOLS,
    '--disallowedTools', DISALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', String(options.budgetUsd),
    '--append-system-prompt', HARDENING,
    prompt,
  ];
}

// --- one mend ----------------------------------------------------------------------------------

async function mendFinding({ runId, index, verdict, finding, options, p }) {
  const existing = recordPath(p.menderDir, runId, index);
  if (existsSync(existing) && !options.force) {
    log(`record already exists for ${runId}#${index} (use --force to redo); skipping`);
    return true;
  }
  const key = defectKey(finding);
  const branch = branchName(runId, index, finding);
  const base = { key, branch, finding: { title: finding.title, confidence: finding.confidence } };

  const priors = localRecordsWithKey(p.menderDir, key);
  if (priors.length > 0 && !options.force) {
    writeRecord(p, runId, index, { ...base, outcome: 'skipped-duplicate', duplicateOf: priors.map((r) => r.prUrl ?? `${r.runId}#${r.findingIndex}`) });
    return true;
  }
  const openPrs = await openPullRequestsWithKey(options.repo, key);
  if (openPrs.length > 0 && !options.force) {
    writeRecord(p, runId, index, { ...base, outcome: 'skipped-duplicate', duplicateOf: openPrs.map((pr) => pr.url) });
    return true;
  }

  const lock = acquireLock(p.lockPath);
  if (!lock.ok) {
    warn(`another mender (pid ${lock.holder?.pid}) holds ${p.lockPath}; not starting`);
    return false;
  }

  const shortRun = String(runId).split('-').pop()?.slice(0, 8) ?? 'run';
  const worktree = join(p.worktreesDir, `mender-${shortRun}-${index}`);
  let keepWorktree = options.keepWorktree;
  const provider = menderProvider(process.env);
  try {
    if (!(await requireIdle(options, 'prepare a worktree'))) return false;

    // A fresh worktree at the tip of the base branch, never the serving checkout.
    await git(options.repo, ['fetch', options.remote, options.base]);
    if (existsSync(worktree)) {
      warn(`stale worktree at ${worktree}; removing`);
      await git(options.repo, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
    }
    mkdirSync(p.worktreesDir, { recursive: true });
    await git(options.repo, ['worktree', 'add', '-B', branch, worktree, `${options.remote}/${options.base}`]);
    const baseSha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    log(`worktree ${worktree} on ${branch} at ${baseSha.slice(0, 10)}`);

    log(`installing (${COMMANDS.install})`);
    const install = await runCommand(COMMANDS.install, [], { cwd: worktree, timeoutMs: options.timeoutMs, onLog: warn });
    if (install.code !== 0) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, outcome: 'harness-failed', baseSha, worktree, reason: 'install failed', output: truncate(install.stderr || install.stdout, 4000) });
      return false;
    }

    const template = readFileSync(promptTemplatePath, 'utf8');
    const prompt = buildMenderPrompt(template, { runId, verdict, findingIndex: index, finding });
    if (options.dryRun) {
      log(`dry-run: provider ${provider.model} via ${provider.source}${provider.baseUrl ? ` (${provider.baseUrl})` : ''}`);
      log(`dry-run: would spawn ${COMMANDS.claude} ${claudeArgs('<prompt>', provider, options).slice(0, -1).join(' ')}`);
      log(`dry-run: prompt is ${prompt.length} chars; worktree ${worktree}`);
      writeRecord(p, runId, index, { ...base, outcome: 'dry-run', baseSha, provider: { model: provider.model, source: provider.source } });
      return true;
    }

    if (!(await requireIdle(options, 'spend model quota'))) {
      keepWorktree = false;
      return false;
    }
    log(`mending ${runId}#${index} "${truncate(finding.title, 80)}" with ${provider.model} (${provider.source} provider)`);
    const startedAt = Date.now();
    const session = await runCommand(COMMANDS.claude, claudeArgs(prompt, provider, options), {
      cwd: worktree,
      env: providerChildEnv(provider),
      timeoutMs: options.timeoutMs,
      onLog: warn,
    });
    if (session.code !== 0) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, outcome: 'model-failed', baseSha, worktree, exitCode: session.code, output: truncate(session.stderr.trim() || session.stdout.trim(), 4000) });
      return false;
    }
    const wrapper = parseLooseJson(session.stdout);
    const report = extractStructured(wrapper);
    const problems = validateMend(report);
    const served = servedModels(wrapper);
    const costUsd = typeof wrapper?.total_cost_usd === 'number' ? wrapper.total_cost_usd : null;
    const modelMeta = {
      provider: { model: provider.model, source: provider.source, baseUrl: provider.baseUrl },
      modelsServed: served,
      mendCostUsd: costUsd,
      mendDurationMs: wrapper?.duration_ms ?? Date.now() - startedAt,
      mendTurns: wrapper?.num_turns ?? null,
    };
    if (looksPinned(provider.model) && served && !served.some((m) => m.model === provider.model)) {
      warn(`requested ${provider.model} but served ${served.map((m) => m.model).join(' + ')}`);
    }
    if (problems.length > 0) {
      keepWorktree = true;
      mkdirSync(p.menderDir, { recursive: true });
      writeFileSync(join(p.menderDir, `${runId}.${index}.raw.txt`), session.stdout);
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'invalid-report', baseSha, worktree, problems });
      return false;
    }

    if (report.outcome === 'declined') {
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'declined', baseSha, report });
      return true;
    }

    // ---- verification, by the harness and not by the model's word ----
    await git(worktree, ['add', '-A']);
    const files = (await git(worktree, ['diff', '--cached', '--name-only'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const numstat = parseNumstat((await git(worktree, ['diff', '--cached', '--numstat'])).stdout);
    const policy = checkDiffPolicy({ files, numstat, maxLines: options.maxDiffLines });
    await git(worktree, ['reset', '-q']);
    if (!policy.ok) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'refused', baseSha, worktree, report, files, problems: policy.problems });
      return false;
    }

    // The regression test must FAIL without the source change. Stash the
    // non-test files (untracked included), run the test files, restore.
    const stashed = await git(worktree, ['stash', 'push', '-u', '--', ...policy.sourceFiles]);
    if (!/Saved working directory/.test(stashed.stdout)) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'harness-failed', baseSha, worktree, reason: 'could not stash source changes', output: truncate(stashed.stdout + stashed.stderr, 2000) });
      return false;
    }
    let before = null;
    let testError = null;
    try {
      before = await runCommand(COMMANDS.test, policy.testFiles, { cwd: worktree, timeoutMs: options.timeoutMs, onLog: warn });
    } catch (error) {
      testError = error;
    }
    const popped = await git(worktree, ['stash', 'pop'], { allowFailure: true });
    if (popped.code !== 0) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'harness-failed', baseSha, worktree, reason: 'stash pop failed — the worktree is kept with the stash', output: truncate(popped.stderr, 2000) });
      return false;
    }
    if (testError) throw testError;
    const testFailedBefore = before.code !== 0;
    if (!testFailedBefore) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'refused', baseSha, worktree, report, files, problems: ['the regression test passes on the unfixed code — the mechanism is not established'], testOutput: truncate(before.stdout + before.stderr, 3000) });
      return false;
    }

    if (!(await requireIdle(options, 'run the full check'))) {
      keepWorktree = true;
      return false;
    }
    log(`verifying (${COMMANDS.check})`);
    const check = await runCommand(COMMANDS.check, [], { cwd: worktree, timeoutMs: options.timeoutMs, onLog: warn });
    const checkPassed = check.code === 0;
    if (!checkPassed) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'refused', baseSha, worktree, report, files, problems: ['the full check is red after the fix'], checkOutput: truncate(check.stdout + check.stderr, 6000) });
      return false;
    }
    const verification = { testFailedBefore, checkPassed, testFiles: policy.testFiles, checkCommand: COMMANDS.check };

    // ---- commit, push, pull request: the harness's hands, not the model's ----
    await git(worktree, ['add', '-A']);
    const messagePath = join(p.menderDir, `${runId}.${index}.commit.txt`);
    mkdirSync(p.menderDir, { recursive: true });
    writeFileSync(messagePath, commitMessage({ report, sourceFiles: policy.sourceFiles, runId, key, verification }));
    await git(worktree, ['commit', '--author=atoma mender <mender@atoma.invalid>', '-F', messagePath], { timeoutMs: options.timeoutMs });
    const sha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(worktree, ['push', '-u', options.remote, branch], { timeoutMs: 300_000 });

    const diffStat = {
      files: files.length,
      added: numstat.reduce((t, r) => t + r.added, 0),
      deleted: numstat.reduce((t, r) => t + r.deleted, 0),
    };
    const bodyPath = join(p.menderDir, `${runId}.${index}.pr.md`);
    writeFileSync(bodyPath, pullRequestBody({ report, finding, runId, key, verification, provider, served, costUsd, diffStat }));
    const pr = await runCommand(
      COMMANDS.gh,
      ['pr', 'create', '--base', options.base, '--head', branch, '--title', commitSubject(report, policy.sourceFiles), '--body-file', bodyPath],
      { cwd: worktree, timeoutMs: 120_000, onLog: warn }
    );
    if (pr.code !== 0) {
      keepWorktree = true;
      writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'pushed-no-pr', baseSha, sha, worktree, report, files, verification, output: truncate(pr.stderr.trim() || pr.stdout.trim(), 2000) });
      return false;
    }
    const prUrl = (pr.stdout.match(/https?:\/\/\S+/) ?? [pr.stdout.trim()])[0];
    writeRecord(p, runId, index, { ...base, ...modelMeta, outcome: 'pr-opened', baseSha, sha, prUrl, report, files, diffStat, verification });
    return true;
  } finally {
    if (!keepWorktree && existsSync(worktree)) {
      await git(options.repo, ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
      // The branch lives on the remote once pushed; locally it is only clutter.
      await git(options.repo, ['branch', '-D', branch], { allowFailure: true });
    } else if (keepWorktree && existsSync(worktree)) {
      log(`worktree kept for inspection: ${worktree} (branch ${branch})`);
    }
    releaseLock(p.lockPath);
  }
}

// --- discovery ----------------------------------------------------------------------------------

function readVerdict(verdictsDir, runId) {
  try {
    return JSON.parse(readFileSync(join(verdictsDir, `${runId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function listVerdicts(verdictsDir) {
  if (!existsSync(verdictsDir)) return [];
  return readdirSync(verdictsDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.raw.json'))
    .map((name) => ({ runId: name.slice(0, -'.json'.length), mtimeMs: statSync(join(verdictsDir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Every (verdict, finding) pair the mender has not yet recorded. */
function pendingWork(p, options, runIds) {
  const work = [];
  for (const runId of runIds) {
    const verdict = readVerdict(p.verdictsDir, runId);
    if (!verdict) continue;
    for (const { index, finding } of eligibleFindings(verdict, { minConfidence: options.minConfidence })) {
      if (existsSync(recordPath(p.menderDir, runId, index)) && !options.force) continue;
      work.push({ runId, index, verdict, finding });
    }
  }
  return work;
}

async function processWork(work, options, p) {
  let failures = 0;
  for (const item of work) {
    try {
      const ok = await mendFinding({ ...item, options, p });
      if (!ok) failures += 1;
    } catch (error) {
      failures += 1;
      warn(`mend of ${item.runId}#${item.index} failed: ${error?.message ?? error}`);
    }
  }
  return failures;
}

function startCaffeinate() {
  if (process.platform !== 'darwin') return;
  try {
    const inhibitor = spawn('caffeinate', ['-i', '-m', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
    inhibitor.unref();
    log('sleep inhibitor started (caffeinate -i -m)');
  } catch {
    warn('could not start caffeinate; the machine may sleep on battery');
  }
}

async function main() {
  const options = parseCliArgs(process.argv);
  const p = paths(options);
  const provider = menderProvider(process.env);
  if (!looksPinned(provider.model)) {
    warn(`"${provider.model}" is an alias, not a pinned model id — records made under it are not comparable over time`);
  }
  if (provider.baseUrl && !provider.authToken) {
    warn(`a base URL is set for the ${provider.source} provider without an auth token — the endpoint will likely refuse`);
  }
  mkdirSync(p.menderDir, { recursive: true });

  if (options.verdict) {
    const verdict = readVerdict(p.verdictsDir, options.verdict);
    if (!verdict) throw new Error(`no verdict for ${options.verdict} under ${p.verdictsDir}`);
    let eligible = eligibleFindings(verdict, { minConfidence: options.minConfidence });
    if (options.finding !== null) eligible = eligible.filter((e) => e.index === options.finding);
    if (eligible.length === 0) {
      warn(`no eligible defect finding in ${options.verdict} (kind=defect, confidence ≥ ${options.minConfidence}, proposedFix cited)`);
      process.exitCode = 1;
      return;
    }
    const work = eligible.map(({ index, finding }) => ({ runId: options.verdict, index, verdict, finding }));
    process.exitCode = (await processWork(work, options, p)) > 0 ? 1 : 0;
    return;
  }

  const verdicts = listVerdicts(p.verdictsDir);
  if (options.once) {
    const ids = options.backfill > 0 ? verdicts.slice(-options.backfill).map((v) => v.runId) : verdicts.map((v) => v.runId);
    const work = pendingWork(p, options, ids);
    log(`once: ${work.length} pending defect finding(s)`);
    process.exitCode = (await processWork(work, options, p)) > 0 ? 1 : 0;
    return;
  }

  // watch mode
  const baseline = new Set(verdicts.map((v) => v.runId));
  if (options.backfill > 0) {
    for (const v of verdicts.slice(-options.backfill)) baseline.delete(v.runId);
    log(`backfill: the ${Math.min(options.backfill, verdicts.length)} newest verdict(s) re-queued`);
  }
  startCaffeinate();
  log(`watching ${p.verdictsDir} (baseline ${baseline.size} verdicts, poll ${options.pollMs}ms, model ${provider.model}${options.dryRun ? ', DRY-RUN' : ''})`);
  let stopping = false;
  const stop = () => {
    stopping = true;
    log('stopping');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    const fresh = listVerdicts(p.verdictsDir).filter((v) => !baseline.has(v.runId));
    if (fresh.length > 0) {
      const work = pendingWork(p, options, fresh.map((v) => v.runId));
      for (const item of work) {
        if (stopping) break;
        try {
          await mendFinding({ ...item, options, p });
        } catch (error) {
          warn(`mend of ${item.runId}#${item.index} failed: ${error?.message ?? error}`);
        }
      }
      for (const v of fresh) baseline.add(v.runId); // one attempt per verdict in watch mode
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, options.pollMs));
  }
}

main().catch((error) => {
  console.error(`[mender] fatal: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
