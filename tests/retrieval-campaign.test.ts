import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  retrievalCampaignSpecSchema, retrievalRegistrationSchema, type RetrievalRegistration,
} from '../src/contracts/retrievalCampaign.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';
import { loadRetrievalDataset, retrievalSha256 } from '../src/cli/retrievalDataset.js';
import {
  archiveRetrievalSource, assertRetrievalExecutionIdentity, createRetrievalRegistration, RETRIEVAL_CAMPAIGN_POLICY, retrievalSchedule, retrievalSourceIdentity,
  validateRetrievalRegistration, writeRetrievalRegistration,
} from '../src/cli/retrievalRegistration.js';
import { retrievalChildEnvironment, runRetrievalCampaign } from '../src/cli/retrievalCampaign.js';
import { parseRunLog, spawnRun } from '../src/cli/burnin.js';
import { acquireRunLeaseWithoutRecovery, peekRunLease as peekRunLock } from '../src/mcp/runLock.js';

const repo = resolve(import.meta.dirname, '..');
const dataset = loadRetrievalDataset(join(repo, 'benchmark/retrieval'));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-retrieval-campaign-'));
  roots.push(dir);
  return dir;
};
const spec = retrievalCampaignSpecSchema.parse({
  version: 1, id: 'test-campaign', purpose: 'Characterize agentic search before implementing an index.',
  kind: 'agentic-characterization', questionIds: ['northstar-11', 'northstar-12'], repetitions: 1,
  firstArm: 'atoma',
  models: { l1: 'sub:openai:test', l2: 'sub:openai:test', l3: 'sub:openai:test', frontier: 'sub:openai:test' },
  workerImage: 'sha256:' + '1'.repeat(64), timeoutMs: 1000, maxWallMs: 60_000,
  stopAfterConsecutiveInfrastructureFailures: 1,
  thresholds: { trust: 3, promote: 3, demote: 2 },
});

function registration(): RetrievalRegistration {
  return retrievalRegistrationSchema.parse({
    version: 1, registeredAt: new Date().toISOString(), spec: structuredClone(spec),
    source: { revision: '1'.repeat(40), sha256: '2'.repeat(64) },
    instrumentsSha256: retrievalSha256(readFileSync(join(dataset.root, 'instruments.lock.json'))),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    policy: RETRIEVAL_CAMPAIGN_POLICY, schedule: retrievalSchedule(spec),
  });
}

function sourceRepo(): string {
  const dir = temp();
  mkdirSync(join(dir, 'src/cli'), { recursive: true });
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src/cli/retrievalCampaign.ts'), 'export {};\n');
  writeFileSync(join(dir, '.nvmrc'), process.version.slice(1) + '\n');
  writeFileSync(join(dir, 'docs/notes.md'), 'unrelated\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
  return dir;
}

describe('retrieval campaign registration', () => {
  it('keeps the published campaign example valid without treating its dummy image as installed', () => {
    expect(retrievalCampaignSpecSchema.safeParse(JSON.parse(
      readFileSync(join(dataset.root, 'campaign.example.json'), 'utf8')
    )).success).toBe(true);
  });
  it('registers committed source, freezes a balanced schedule and refuses overwrite', () => {
    const dir = sourceRepo();
    writeFileSync(join(dir, 'docs/notes.md'), 'other task edits');
    const reg = createRetrievalRegistration(spec, dataset, dir);
    expect(reg.schedule.map(e => e.arm)).toEqual(['atoma', 'frontier-direct', 'frontier-direct', 'atoma']);
    expect(reg.source).toEqual(retrievalSourceIdentity(dir));
    const path = join(temp(), 'registration.json');
    writeRetrievalRegistration(path, reg);
    expect(() => writeRetrievalRegistration(path, reg)).toThrow();
    expect(validateRetrievalRegistration(JSON.parse(readFileSync(path, 'utf8')), dataset)).toEqual(reg);
  });

  it('refuses dirty or untracked executable source and detects committed changes', () => {
    const dir = sourceRepo();
    const before = retrievalSourceIdentity(dir);
    const reg = createRetrievalRegistration(spec, dataset, dir);
    const file = join(dir, 'src/extra.ts');
    writeFileSync(file, 'export const extra = true;');
    expect(() => retrievalSourceIdentity(dir)).toThrow(/commit runtime/);
    rmSync(file);
    writeFileSync(join(dir, 'src/cli/retrievalCampaign.ts'), 'export const changed = true;');
    expect(() => retrievalSourceIdentity(dir)).toThrow(/commit runtime/);
    execFileSync('git', ['add', 'src'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'changed'], { cwd: dir, stdio: 'pipe' });
    expect(retrievalSourceIdentity(dir).sha256).not.toBe(before.sha256);
    reg.source.sha256 = retrievalSourceIdentity(dir).sha256;
    expect(() => assertRetrievalExecutionIdentity(reg, dir)).toThrow(/registered revision/);
  });

  it('archives the registered Git tree when watched paths are absent, excluding later edits and unrelated files', () => {
    const dir = sourceRepo();
    const reg = createRetrievalRegistration(spec, dataset, dir);
    expect(existsSync(join(dir, '.dockerignore'))).toBe(false);
    writeFileSync(join(dir, 'src/cli/retrievalCampaign.ts'), 'later working tree edit');
    writeFileSync(join(dir, '.env'), 'PRIVATE_FIXTURE=never-archive\n');
    const out = temp();
    archiveRetrievalSource(dir, reg, out);
    const extracted = temp();
    execFileSync('tar', ['-xf', join(out, 'source.tar'), '-C', extracted]);
    expect(readFileSync(join(extracted, 'src/cli/retrievalCampaign.ts'), 'utf8')).toBe('export {};\n');
    expect(readFileSync(join(extracted, '.nvmrc'), 'utf8')).toBe(process.version.slice(1) + '\n');
    expect(readdirSync(extracted).sort()).toEqual(['.nvmrc', 'src']);
    expect(() => archiveRetrievalSource(dir, reg, out)).toThrow();
  });

  it('rejects changed schedules, instruments and reserved held-out questions', () => {
    const reordered = registration();
    reordered.schedule.reverse();
    expect(() => validateRetrievalRegistration(reordered, dataset)).toThrow(/schedule/);
    const drift = registration();
    drift.instrumentsSha256 = '0'.repeat(64);
    expect(() => validateRetrievalRegistration(drift, dataset)).toThrow(/instruments/);
    const heldOut = registration();
    heldOut.spec.questionIds = ['orchard-01'];
    heldOut.schedule = retrievalSchedule(heldOut.spec);
    expect(() => validateRetrievalRegistration(heldOut, dataset)).toThrow(/development questions/);
  });

  it.each(['api:openai:test', 'own:openai:test', 'invalid'])('refuses an unsupported payer/selector: %s', selector => {
    expect(retrievalCampaignSpecSchema.safeParse({ ...spec, models: { ...spec.models, l1: selector } }).success).toBe(false);
  });

  it('rejects a frontier transport the runner did not construct, duplicate tasks and mutable images', () => {
    expect(retrievalCampaignSpecSchema.safeParse({ ...spec, models: { ...spec.models, frontier: 'sub:anthropic:opus' } }).success).toBe(false);
    expect(retrievalCampaignSpecSchema.safeParse({ ...spec, questionIds: ['northstar-11', 'northstar-11'] }).success).toBe(false);
    expect(retrievalCampaignSpecSchema.safeParse({ ...spec, workerImage: 'atoma-worker:latest' }).success).toBe(false);
  });
});

const delivered = { ...parseRunLog('--- spawn failed ---'), outcome: 'delivered' as const, costUsd: 0.1, llmCalls: 1 };

function candidate(opts: Parameters<typeof spawnRun>[0]): string {
  const env = opts.env!;
  const args = opts.extraArgs!;
  const seed = args[args.indexOf('--seed') + 1]!;
  const workspace = env['ATOMA_BUILD_WORKSPACE']!;
  cpSync(seed, workspace, { recursive: true });
  const inventory = JSON.parse(readFileSync(join(workspace, 'CORPUS.json'), 'utf8')) as Record<string, string>;
  const questionId = /questionId: "([^"]+)"/.exec(opts.goal)![1]!;
  writeFileSync(join(workspace, 'retrieval-answer.json'), JSON.stringify({
    questionId, snapshotId: inventory['snapshotId'], snapshotSha256: inventory['snapshotSha256'],
    status: 'not_found', facts: [],
  }));
  writeFileSync(join(env['ATOMA_RUNS_DIR']!, `${env['ATOMA_RUN_ID']}.json`), JSON.stringify({
    id: env['ATOMA_RUN_ID'], endedAt: new Date().toISOString(),
  }));
  return formatRunStatsEpilogue(delivered);
}

function harness(spawn: typeof spawnRun = async opts => candidate(opts)) {
  const dir = temp();
  const lock = join(dir, 'lease.db');
  const run = vi.fn(spawn);
  const verify = vi.fn();
  return {
    dir, lock, out: join(dir, 'archive'), run, verify,
    deps: { spawn: run, verify, archiveSource: vi.fn(),
      preflight: () => ({ workerImage: spec.workerImage, codex: 'test-version' }),
      acquire: (id: string) => acquireRunLeaseWithoutRecovery(id, lock),
    },
  };
}

describe('retrieval campaign execution through the shared launcher seam', () => {
  it('isolates every attempt, scores stopped workspaces, archives failures and preserves the global lease', async () => {
    const h = harness(async opts => {
      expect(existsSync(opts.env!['ATOMA_DB_PATH']!)).toBe(false);
      expect(readdirSync(opts.env!['ATOMA_SKILLS_DIR']!)).toEqual([]);
      expect(peekRunLock(h.lock)?.runId).toBe('retrieval:test-campaign');
      const log = candidate(opts);
      writeFileSync(opts.env!['ATOMA_DB_PATH']!, 'this attempt state');
      return log;
    });
    const report = await runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps);
    expect(report).toMatchObject({ reason: 'completed', planned: 4, attempted: 4, apiSpendUsd: 0 });
    expect(report.arms.map(a => a.full)).toEqual([2, 2]);
    const calls = h.run.mock.calls.map(([o]) => o);
    expect(new Set(calls.map(o => o.env!['ATOMA_DB_PATH'])).size).toBe(4);
    expect(calls[0]!.goal).toBe(calls[1]!.goal);
    expect(calls.map(o => o.extraArgs![0])).toEqual(['--no-baseline', '--baseline', '--baseline', '--no-baseline']);
    for (const o of calls) {
      expect(o.extraArgs).toContain('--container');
      expect(o.extraArgs).toContain('--no-egress');
      expect(o.extraArgs![o.extraArgs!.indexOf('--worker-image') + 1]).toBe(spec.workerImage);
      expect(readdirSync(o.env!['ATOMA_BUILD_WORKSPACE']!)).not.toContain('questions.json');
    }
    expect(peekRunLock(h.lock)).toBeNull();
    expect(loadRetrievalDataset(join(h.out, 'dataset')).questions).toHaveLength(26);
    expect(readFileSync(join(h.out, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('strips ambient experiment state and model/debug overrides from child environments', () => {
    const r = registration();
    const host = { PATH: '/test-bin', HOME: '/host-home', ATOMA_DB_PATH: '/live/store',
      ATOMA_MODEL_L1: 'api:openai:wrong', ATOMA_CODEX_MODEL: 'override', ATOMA_SKILL_LEARN: '1',
      ATOMA_RUN_ID: 'stale', NODE_OPTIONS: '--import unwanted', OPENAI_API_KEY: 'secret' };
    const env = retrievalChildEnvironment(r, r.schedule[0]!, '/attempt', 'fresh', host);
    expect(env['HOME']).toBe('/host-home');
    expect(env['ATOMA_MODEL_L1']).toBe(spec.models.l1);
    expect(env['ATOMA_DB_PATH']).toBe('/attempt/state/store.db');
    expect(env['ATOMA_CODEX_MODEL']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['ATOMA_SKILL_LEARN']).toBe('0');
    expect(host.ATOMA_DB_PATH).toBe('/live/store');
  });

  it('does not credit a delivery banner or completed runner when the executable scorer fails', async () => {
    const h = harness(async opts => {
      const log = candidate(opts);
      writeFileSync(join(opts.env!['ATOMA_BUILD_WORKSPACE']!, 'retrieval-answer.json'), '{}');
      return log + '\n✓ build finished\n';
    });
    const report = await runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps);
    expect(report.arms.map(a => a.full)).toEqual([0, 0]);
    expect(report.reason).toBe('completed');
  });

  it('keeps missing epilogues/traces as infrastructure failures and stops at the registered count', async () => {
    const h = harness(async opts => { candidate(opts); return '✓ build finished'; });
    const report = await runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps);
    expect(report).toMatchObject({ reason: 'infrastructure-stop', attempted: 1, subscriptionPriceEquivalentUsd: null });
    expect(report.arms[0]).toMatchObject({ full: 0, infrastructureFailures: 1 });
    expect(peekRunLock(h.lock)).toBeNull();
  });

  it('refuses a busy lease before creating an archive or spawning', async () => {
    const h = harness();
    const held = acquireRunLeaseWithoutRecovery('existing-live-run', h.lock);
    try {
      await expect(runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps)).rejects.toThrow(/slot is occupied/);
      expect(h.run).not.toHaveBeenCalled();
      expect(existsSync(h.out)).toBe(false);
    } finally { held.release(); }
  });

  it('refuses existing output directories without replacing evidence', async () => {
    const h = harness();
    mkdirSync(h.out);
    writeFileSync(join(h.out, 'keep'), 'evidence');
    await expect(runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps)).rejects.toThrow();
    expect(h.run).not.toHaveBeenCalled();
    expect(readFileSync(join(h.out, 'keep'), 'utf8')).toBe('evidence');
    expect(peekRunLock(h.lock)).toBeNull();
  });

  it('aborts on source drift after a run, keeps that result and releases only after settlement', async () => {
    const h = harness();
    h.verify.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('source changed'); });
    await expect(runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps)).rejects.toThrow(/source changed/);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(h.out, 'aborted.json'))).toBe(true);
    expect(readFileSync(join(h.out, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(peekRunLock(h.lock)).toBeNull();
  });

  it('cancels the active attempt before another starts', async () => {
    const abort = new AbortController();
    const h = harness(async opts => {
      const log = candidate(opts);
      abort.abort();
      expect(opts.signal?.aborted).toBe(true);
      return log;
    });
    const report = await runRetrievalCampaign(registration(), dataset, { repo, out: h.out, signal: abort.signal }, h.deps);
    expect(report).toMatchObject({ reason: 'cancelled', attempted: 1 });
    expect(peekRunLock(h.lock)).toBeNull();
  });

  it('retains the lease when the shared launch backstop finds an unsettled child', async () => {
    vi.useFakeTimers();
    let settle: ((value: string) => void) | undefined;
    const h = harness(() => new Promise<string>(resolveRun => { settle = resolveRun; }));
    const acquire = h.deps.acquire;
    let held: ReturnType<typeof acquire> | undefined;
    h.deps.acquire = id => { held = acquire(id); return held; };
    const work = runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps);
    const rejected = expect(work).rejects.toThrow(/survived SIGKILL/);
    try {
      await vi.advanceTimersByTimeAsync(242_000);
      await rejected;
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(peekRunLock(h.lock)?.runId).toBe('retrieval:test-campaign');
      expect(existsSync(join(h.out, 'aborted.json'))).toBe(true);
    } finally {
      settle?.('test child settled');
      await Promise.resolve();
      held?.release();
    }
  });

  it('the real CLI exits on execution refusal before touching an output or a provider', () => {
    const dir = temp();
    const path = join(dir, 'registration.json');
    writeRetrievalRegistration(path, registration());
    const out = join(dir, 'archive');
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/benchmark.ts',
      'retrieval', 'run', '--registration', path, '--out', out], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain('FATAL');
    expect(existsSync(out)).toBe(false);
  });

  it('crosses a real npm child process through spawnRun and attaches its PGID to the lease', async () => {
    const fixture = temp();
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { stub: 'node child.mjs' } }));
    writeFileSync(join(fixture, 'child.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const goal = args.at(-1);
const seed = args[args.indexOf('--seed') + 1];
const workspace = process.env.ATOMA_BUILD_WORKSPACE;
fs.cpSync(seed, workspace, { recursive: true });
const inventory = JSON.parse(fs.readFileSync(path.join(workspace, 'CORPUS.json')));
const questionId = /questionId: "([^"]+)"/.exec(goal)[1];
fs.writeFileSync(path.join(workspace, 'retrieval-answer.json'), JSON.stringify({
  questionId, snapshotId: inventory.snapshotId, snapshotSha256: inventory.snapshotSha256, status: 'not_found', facts: []
}));
fs.writeFileSync(path.join(process.env.ATOMA_RUNS_DIR, process.env.ATOMA_RUN_ID + '.json'), JSON.stringify({ id: process.env.ATOMA_RUN_ID, endedAt: new Date().toISOString() }));
console.log(${JSON.stringify(formatRunStatsEpilogue(delivered))});
`);
    const h = harness(opts => spawnRun({ ...opts, cwd: fixture, npmScript: 'stub' }));
    const attach = vi.fn();
    const acquire = h.deps.acquire;
    h.deps.acquire = id => {
      const lease = acquire(id);
      return { ...lease, attachChild: pgid => { attach(pgid); lease.attachChild(pgid); } };
    };
    const report = await runRetrievalCampaign(registration(), dataset, { repo, out: h.out }, h.deps);
    expect(report.arms.map(a => a.full)).toEqual([2, 2]);
    expect(attach).toHaveBeenCalledTimes(4);
    expect(peekRunLock(h.lock)).toBeNull();
  }, 30_000);
});
