import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE MENDER, ACROSS EVERY BOUNDARY IT SHIPS WITH (supervisor stage 3,
 * docs/supervisor-design.md): a real git repository with a real bare remote,
 * a real worktree, real stash/commit/push — and stubs in place of the three
 * external programs (claude, gh, npm), substituted through the
 * ATOMA_MENDER_CMD_* seams so no shell shim is needed on any platform.
 *
 * What these hold:
 *   - the happy path ends in a pushed branch, a PR request and a record, with
 *     the worktree gone and the model's own argv restricted as designed;
 *   - the harness refuses what the model may not ship — a forbidden path, a
 *     test that already passes on the unfixed code, a red check — and then
 *     nothing reaches the remote;
 *   - a decline, a duplicate and an active run all stop before any quota or
 *     any push is spent.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MENDER = join(REPO_ROOT, 'scripts', 'mender.mjs');
const RUN_ID = '2026-09-05T10-00-00-000-deadbeef';
const TIMEOUT_MS = 90_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

interface Fixture {
  root: string;
  bare: string;
  repo: string;
  supervisor: string;
  runs: string;
  stubs: string;
  ghLog: string;
  claudeArgs: string;
}

/** A repository with one source file, one bare remote and one analyst verdict. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mender-'));
  dirs.push(root);
  const bare = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const supervisor = join(root, 'supervisor');
  const runs = join(root, 'runs');
  const stubs = join(root, 'stubs');
  mkdirSync(runs);
  mkdirSync(stubs);
  git(root, ['init', '--bare', '-b', 'main', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.hooksPath', join(root, 'no-hooks')]);
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'adder.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(repo, 'tests', '.keep'), '');
  writeFileSync(join(repo, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);

  mkdirSync(join(supervisor, 'verdicts'), { recursive: true });
  writeFileSync(
    join(supervisor, 'verdicts', `${RUN_ID}.json`),
    JSON.stringify({
      schema: 'atoma.supervisor.verdict/v1',
      runId: RUN_ID,
      runStatus: 'failed',
      runAssessment: { grade: 'deficient', summary: 'The adder subtracts.' },
      findings: [
        {
          kind: 'mechanism_candidate',
          title: 'Add an arithmetic sanity gate',
          detail: 'never mended',
          evidence: [],
          confidence: 'high',
          proposedFix: { where: 'src/', what: 'gate', checkedIntentionalChoices: 'AGENTS.md' },
        },
        {
          kind: 'defect',
          title: 'add() subtracts its operands',
          detail: 'The adder returns a - b.',
          evidence: [
            { ref: 'src/adder.mjs:1', quote: 'a - b' },
            { ref: 'supervisor/work/x/events.ndjson:9', quote: 'UNTRUSTED TRACE TEXT' },
          ],
          proposedFix: {
            where: 'src/adder.mjs',
            what: 'Return a + b.',
            checkedIntentionalChoices: 'src/AGENTS.md — no recorded shortcut.',
          },
          confidence: 'high',
        },
      ],
    })
  );

  const ghLog = join(root, 'gh.log');
  const claudeArgs = join(root, 'claude-args.json');

  // The model stand-in. STUB_MODE picks what it "does" to the worktree; the
  // structured report is what a real `claude -p --json-schema` wrapper carries.
  writeFileSync(
    join(stubs, 'claude.mjs'),
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.STUB_MODE ?? 'fix';
writeFileSync(process.env.STUB_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
const cwd = process.cwd();
const failingTest = "import { add } from '../src/adder.mjs';\\nif (add(1, 2) !== 3) { console.error('add(1,2) !== 3'); process.exit(1); }\\n";
const passingTest = "process.exit(0);\\n";
let report = { schema: 'atoma.supervisor.mend/v1', outcome: 'fixed', title: 'make add() add', summary: 'add() returned a - b; it now returns a + b, and the test proves it.', checkedIntentionalChoices: 'src/AGENTS.md read; not a recorded shortcut.', regressionTests: ['tests/adder.test.mjs'] };
if (mode === 'fix' || mode === 'forbidden' || mode === 'notest') {
  writeFileSync(join(cwd, 'src', 'adder.mjs'), 'export const add = (a, b) => a + b;\\n');
}
if (mode === 'fix' || mode === 'forbidden') writeFileSync(join(cwd, 'tests', 'adder.test.mjs'), failingTest);
if (mode === 'forbidden') writeFileSync(join(cwd, 'package.json'), '{ "name": "tampered" }\\n');
if (mode === 'no-mechanism') {
  writeFileSync(join(cwd, 'src', 'adder.mjs'), 'export const add = (a, b) => a + b;\\n');
  writeFileSync(join(cwd, 'tests', 'adder.test.mjs'), passingTest);
}
if (mode === 'declined') report = { ...report, outcome: 'declined', declineReason: 'the remedy is a new gate — cooling-off' };
process.stdout.write(JSON.stringify({ type: 'result', structured_output: report, total_cost_usd: 0.42, duration_ms: 1234, num_turns: 3, modelUsage: { 'claude-sonnet-5': { costUSD: 0.4, inputTokens: 10, outputTokens: 5 } } }));
`
  );
  // The test runner stand-in: run each test file as a node script.
  writeFileSync(
    join(stubs, 'test.mjs'),
    `
import { spawnSync } from 'node:child_process';
let failed = false;
for (const file of process.argv.slice(2)) {
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
`
  );
  writeFileSync(join(stubs, 'check.mjs'), `process.exit(process.env.STUB_CHECK_FAIL === '1' ? 1 : 0);\n`);
  writeFileSync(join(stubs, 'noop.mjs'), `process.exit(0);\n`);
  writeFileSync(
    join(stubs, 'gh.mjs'),
    `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write(process.env.STUB_GH_LIST ?? '[]'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'create') { process.stdout.write('https://github.com/example/atoma/pull/42\\n'); process.exit(0); }
process.exit(2);
`
  );
  return { root, bare, repo, supervisor, runs, stubs, ghLog, claudeArgs };
}

function runMender(f: Fixture, extraArgs: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [MENDER, '--once', '--repo', f.repo, '--supervisor-dir', f.supervisor, '--runs', f.runs, ...extraArgs],
    {
      cwd: f.repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATOMA_MENDER_CMD_CLAUDE: join(f.stubs, 'claude.mjs'),
        ATOMA_MENDER_CMD_GH: join(f.stubs, 'gh.mjs'),
        ATOMA_MENDER_CMD_INSTALL: join(f.stubs, 'noop.mjs'),
        ATOMA_MENDER_CMD_TEST: join(f.stubs, 'test.mjs'),
        ATOMA_MENDER_CMD_CHECK: join(f.stubs, 'check.mjs'),
        ATOMA_MCP_RUN_LOCK: join(f.root, 'no-such-lease.db'),
        STUB_GH_LOG: f.ghLog,
        STUB_CLAUDE_ARGS: f.claudeArgs,
        ATOMA_MENDER_MODEL: 'claude-sonnet-5',
        ...env,
      },
      timeout: TIMEOUT_MS,
    }
  );
  return { ...result, log: `${result.stdout}\n${result.stderr}` };
}

function record(f: Fixture): Record<string, unknown> | null {
  const path = join(f.supervisor, 'mender', `${RUN_ID}.1.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
}

function remoteBranches(f: Fixture): string[] {
  return git(f.bare, ['branch', '--list', 'mender/*'])
    .split('\n')
    .map((line) => line.replace('*', '').trim())
    .filter(Boolean);
}

function worktrees(f: Fixture): string[] {
  const dir = join(f.repo, '.worktrees');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('the mender, end to end against a real repository', () => {
  it('turns a cited defect into a pushed branch and a pull request, then cleans up', () => {
    const f = fixture();
    const result = runMender(f, []);
    expect(result.status, result.log).toBe(0);

    const rec = record(f);
    expect(rec).toMatchObject({ outcome: 'pr-opened', prUrl: 'https://github.com/example/atoma/pull/42', mendCostUsd: 0.42 });
    expect(rec!['verification']).toMatchObject({ testFailedBefore: true, checkPassed: true, testFiles: ['tests/adder.test.mjs'] });
    // The mechanism candidate at index 0 was never touched.
    expect(existsSync(join(f.supervisor, 'mender', `${RUN_ID}.0.json`))).toBe(false);

    const [branch] = remoteBranches(f);
    expect(branch).toBe('mender/deadbeef-1-add-subtracts-its-operands');
    const message = git(f.bare, ['log', '-1', '--format=%B%n--author:%an', branch!]);
    expect(message).toMatch(/^fix\(adder\): make add\(\) add/);
    expect(message).toContain('Regression test fails before the fix: yes');
    expect(message).toMatch(/Defect-Key: [0-9a-f]{12}/);
    expect(message).toContain('--author:atoma mender');
    expect(git(f.bare, ['show', `${branch!}:src/adder.mjs`])).toContain('a + b');
    // main itself was never written.
    expect(git(f.bare, ['show', 'main:src/adder.mjs'])).toContain('a - b');

    const ghCalls = readFileSync(f.ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(ghCalls[0]!.slice(0, 2)).toEqual(['pr', 'list']);
    const create = ghCalls.find((call) => call[1] === 'create')!;
    expect(create).toContain('--base');
    expect(create[create.indexOf('--base') + 1]).toBe('main');
    expect(create[create.indexOf('--head') + 1]).toBe(branch);
    const body = readFileSync(create[create.indexOf('--body-file') + 1]!, 'utf8');
    expect(body).toContain('Defect-Key:');
    expect(body).not.toContain('UNTRUSTED TRACE TEXT');
    expect(body).toContain('withheld from the mender by design');
    expect(body).toContain('`src/adder.mjs:1` — a - b');

    // The model's own leash, as passed on its command line.
    const args = JSON.parse(readFileSync(f.claudeArgs, 'utf8')) as string[];
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    expect(allowed).not.toMatch(/git (push|commit)|gh/);
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(args.at(-1)).toContain('add() subtracts its operands');
    expect(args.at(-1)).not.toContain('UNTRUSTED TRACE TEXT');

    expect(worktrees(f)).toEqual([]);
    expect(existsSync(join(f.supervisor, 'mender.lock'))).toBe(false);
    expect(readFileSync(join(f.supervisor, 'mender.jsonl'), 'utf8')).toContain('"outcome":"pr-opened"');
  }, TIMEOUT_MS);

  it('refuses a change outside the allowlist and pushes nothing', () => {
    const f = fixture();
    const result = runMender(f, [], { STUB_MODE: 'forbidden' });
    expect(result.status).toBe(1);
    const rec = record(f);
    expect(rec).toMatchObject({ outcome: 'refused' });
    expect(String(rec!['problems'])).toContain('package.json');
    expect(remoteBranches(f)).toEqual([]);
    // Kept for a person to look at, and said so.
    expect(worktrees(f)).toHaveLength(1);
    expect(result.log).toContain('worktree kept for inspection');
    expect(readFileSync(f.ghLog, 'utf8')).not.toContain('"create"');
  }, TIMEOUT_MS);

  it('refuses a fix whose test already passes on the unfixed code', () => {
    const f = fixture();
    const result = runMender(f, [], { STUB_MODE: 'no-mechanism' });
    expect(result.status).toBe(1);
    const rec = record(f);
    expect(rec).toMatchObject({ outcome: 'refused' });
    expect(String(rec!['problems'])).toMatch(/passes on the unfixed code/);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses a fix with no regression test', () => {
    const f = fixture();
    const result = runMender(f, [], { STUB_MODE: 'notest' });
    expect(result.status).toBe(1);
    expect(String(record(f)!['problems'])).toMatch(/no regression test/);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses when the full check is red after the fix', () => {
    const f = fixture();
    const result = runMender(f, [], { STUB_CHECK_FAIL: '1' });
    expect(result.status).toBe(1);
    const rec = record(f);
    expect(rec).toMatchObject({ outcome: 'refused' });
    expect(String(rec!['problems'])).toMatch(/full check is red/);
    // The failing-before proof had already been established and is recorded.
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('records a decline without touching the remote', () => {
    const f = fixture();
    const result = runMender(f, [], { STUB_MODE: 'declined' });
    expect(result.status).toBe(0);
    const rec = record(f);
    expect(rec).toMatchObject({ outcome: 'declined' });
    expect((rec!['report'] as Record<string, unknown>)['declineReason']).toMatch(/cooling-off/);
    expect(remoteBranches(f)).toEqual([]);
    expect(worktrees(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('skips a defect that already has an open pull request, spending nothing', () => {
    const f = fixture();
    const result = runMender(f, [], {
      STUB_GH_LIST: JSON.stringify([{ number: 7, url: 'https://github.com/example/atoma/pull/7', title: 'earlier' }]),
    });
    expect(result.status).toBe(0);
    expect(record(f)).toMatchObject({ outcome: 'skipped-duplicate', duplicateOf: ['https://github.com/example/atoma/pull/7'] });
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(remoteBranches(f)).toEqual([]);
  }, TIMEOUT_MS);

  it('refuses to start beside a live run', () => {
    const f = fixture();
    writeFileSync(
      join(f.runs, 'index.json'),
      JSON.stringify([{ id: 'live-1', startedAt: new Date().toISOString(), lastEventAt: Date.now(), inFlight: true }])
    );
    const result = runMender(f, []);
    expect(result.status).toBe(1);
    expect(result.log).toContain('a run is active');
    expect(record(f)).toBeNull();
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(worktrees(f)).toEqual([]);
    expect(existsSync(join(f.supervisor, 'mender.lock'))).toBe(false);
  }, TIMEOUT_MS);

  it('does not run the same finding twice unless forced', () => {
    const f = fixture();
    expect(runMender(f, [], { STUB_MODE: 'declined' }).status).toBe(0);
    rmSync(f.claudeArgs);
    const again = runMender(f, [], { STUB_MODE: 'declined' });
    expect(again.status).toBe(0);
    expect(again.log).toContain('0 pending defect finding(s)');
    expect(existsSync(f.claudeArgs)).toBe(false);
  }, TIMEOUT_MS);

  it('dry-run prepares the worktree, prints the leash and spends nothing', () => {
    const f = fixture();
    const result = runMender(f, ['--dry-run']);
    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain('dry-run: would spawn');
    expect(result.log).toContain('--restricted');
    expect(record(f)).toMatchObject({ outcome: 'dry-run' });
    expect(existsSync(f.claudeArgs)).toBe(false);
    expect(worktrees(f)).toEqual([]);
  }, TIMEOUT_MS);
});
