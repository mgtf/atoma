import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrievalCampaignSpecSchema, retrievalRegistrationSchema } from '../src/contracts/retrievalCampaign.js';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS } from '../src/contracts/projectRetrieval.js';
import { HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { retrievalIndexConfig } from '../src/projects/retrievalCorpus.js';
import { retrievalCampaignPolicy, retrievalSchedule, validateRetrievalRegistration } from '../src/cli/retrievalRegistration.js';
import { loadRetrievalDataset, retrievalSha256, prepareRetrievalWorkspace } from '../src/cli/retrievalDataset.js';
import { prepareRetrievalProjectAttempt } from '../src/cli/retrievalProjectAttempt.js';
import { retrievalChildEnvironment } from '../src/cli/retrievalCampaign.js';
import { openProjectRunHaystack } from '../src/projects/retrievalHaystackLaunch.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { existsSync } from 'node:fs';
import { pairedRetrievalDecision } from '../src/cli/retrievalComparison.js';
import { parseRunLog } from '../src/cli/burnin.js';

const repo = resolve(import.meta.dirname, '..');
const dataset = loadRetrievalDataset(join(repo, 'benchmark/retrieval'));
const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-haystack-campaign-')); roots.push(root);
  const launch = haystackTestRuntime(root);
  const spec = retrievalCampaignSpecSchema.parse({ version: 1, id: 'haystack-test', purpose: 'Evaluate local hybrid retrieval through the existing shared runner.',
    kind: 'haystack-development', questionIds: ['northstar-05', 'northstar-13'], repetitions: 1, firstArm: 'atoma',
    models: { l1: 'sub:anthropic:haiku', l2: 'sub:anthropic:sonnet', l3: 'sub:anthropic:opus', frontier: 'sub:anthropic:opus' },
    workerImage: 'sha256:' + '1'.repeat(64), timeoutMs: 30_000, maxWallMs: 300_000,
    stopAfterConsecutiveInfrastructureFailures: 1, thresholds: { trust: 3, promote: 3, demote: 2 },
    treatment: { backend: 'haystack', index: retrievalIndexConfig(), queryLimits: DEFAULT_PROJECT_RETRIEVAL_LIMITS, launch },
    decision: { objective: 'paired-full-pass', minimumGain: 0.5, maxElapsedRatio: 1.25, maxPriceEquivalentRatio: 1.25 } });
  const registration = retrievalRegistrationSchema.parse({ version: 1, registeredAt: new Date().toISOString(), spec,
    source: { revision: '1'.repeat(40), sha256: '2'.repeat(64) }, instrumentsSha256: retrievalSha256(readFileSync(join(dataset.root, 'instruments.lock.json'))),
    runtime: { node: process.version, platform: process.platform, arch: process.arch }, policy: retrievalCampaignPolicy(spec), schedule: retrievalSchedule(spec) });
  return { root, registration, launch };
}
describe('registered Haystack agent treatment', () => {
  it('keeps historical arms distinct, enforces backend settings and compares the Haystack arm', () => {
    const { registration: r } = setup();
    expect(validateRetrievalRegistration(r, dataset)).toEqual(r);
    expect(r.schedule.map(e => e.arm)).toEqual(['atoma', 'atoma-haystack', 'frontier-direct', 'frontier-direct', 'atoma-haystack', 'atoma']);
    expect(retrievalCampaignSpecSchema.safeParse({ ...r.spec, kind: 'bm25-development' }).success).toBe(false);
    expect(retrievalCampaignSpecSchema.safeParse({ ...r.spec, firstArm: 'atoma-bm25' }).success).toBe(false);
    const rows = r.schedule.map(entry => ({ entry, runId: 'trial', startedAt: new Date().toISOString(), elapsedMs: 1000,
      runner: { ...parseRunLog('✓ build finished'), costUsd: 0.1 }, infrastructureFailure: false,
      score: { questionId: entry.questionId, full: true, checks: [] }, full: entry.arm !== 'atoma', tracePath: 'trace.json' }));
    expect(pairedRetrievalDecision(r, rows)).toMatchObject({ bFull: 2, pairedFullPassDifference: 1, decision: 'advance-to-new-confirmation' });
  });
  it('cancels and reaps a warmup that never answers, with no provider involved', async () => {
    const { root } = setup(); const launch = haystackTestRuntime(root, 'hang');
    const f = projectRetrievalFixture(root); const source = f.makeRun({ 'docs.md': 'Refund window is 14 days.\n' }); const run = f.makeRun();
    await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(run.run.projectRunId, source.run.projectRunId, retrievalContext());
    const prepared = openProjectRunHaystack({ dbPath: f.dbPath, runId: run.run.projectRunId, workspacePath: run.layout.workspacePath,
      skillsPath: run.layout.skillsPath, runsPath: run.layout.runsPath }, launch);
    const pending = prepared.prepare(retrievalContext());
    const rejected = expect(pending).rejects.toThrow('unavailable or denied');
    let pid: number;
    try {
      await vi.waitFor(() => expect(existsSync(join(root, 'haystack.pid'))).toBe(true), { timeout: 3000 });
      pid = Number(readFileSync(join(root, 'haystack.pid'), 'utf8'));
    } finally { await prepared.binding.service.dispose(); await rejected; }
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('prepares the same tenant authority and activates the framework only for treatment B', async () => {
    const { root, registration, launch } = setup();
    for (const entry of registration.schedule.slice(0, 3)) {
      const attempt = join(root, String(entry.ordinal)); mkdirSync(attempt); mkdirSync(join(attempt, 'state'));
      const prepared = prepareRetrievalWorkspace(dataset, entry.questionId, join(attempt, 'seed'));
      const runId = randomUUID();
      const env = retrievalChildEnvironment(registration, entry, attempt, runId, { [HAYSTACK_LAUNCH_ENV]: 'ambient forbidden' });
      expect(env[HAYSTACK_LAUNCH_ENV]).toBeUndefined();
      const project = await prepareRetrievalProjectAttempt({ registration, entry, dataset, attempt, seed: prepared.workspace, runId, env: { ...env, [HAYSTACK_LAUNCH_ENV]: 'must not leak into controls' }, ...retrievalContext() });
      try {
        expect(project.env['ATOMA_PROJECT_RETRIEVAL_RECEIPT']).toBe(entry.arm === 'atoma-haystack' ? '1' : undefined);
        if (entry.arm !== 'atoma-haystack') expect(project.env[HAYSTACK_LAUNCH_ENV]).toBeUndefined();
        if (entry.arm === 'atoma-haystack') {
          expect(JSON.parse(project.env[HAYSTACK_LAUNCH_ENV]!)).toEqual(launch);
          const bound = openProjectRunHaystack({ dbPath: project.env['ATOMA_DB_PATH']!, runId,
            workspacePath: project.env['ATOMA_BUILD_WORKSPACE']!, skillsPath: project.env['ATOMA_SKILLS_DIR']!, runsPath: project.env['ATOMA_RUNS_DIR']! }, launch);
          const tool = createProjectRetrievalTool(bound.binding, retrievalContext());
          try {
            await bound.prepare(retrievalContext());
            expect(await tool.execute({ query: 'refund' })).toMatchObject({ ok: true });
          } finally { await tool.close(); }
        } else expect(project.env[HAYSTACK_LAUNCH_ENV]).toBeUndefined();
        await project.finish(parseRunLog('--- spawn failed ---'));
      } finally { project.close(); }
    }
  });
});
