import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLlmClient } from '../src/core/llm.js';
import { resetHostLifecycleSnapshotForTests, startTask } from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { containerToolBackend, localToolBackend } from '../src/run/toolBackend.js';
import { buildTierClients } from '../src/run/providers.js';
import { PROJECT_RETRIEVAL_TOOL_NAME as SEARCH } from '../src/contracts/projectRetrieval.js';
import { retrievalTestBinding } from './helpers/projectRetrieval.js';
import { silentLogger } from './helpers.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { closeStoreHandles } from '../src/core/stores.js';

vi.mock('../src/run/toolBackend.js', async original => ({
  ...await original<typeof import('../src/run/toolBackend.js')>(), containerToolBackend: vi.fn(),
}));
vi.mock('../src/run/providers.js', async original => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); resetHostLifecycleSnapshotForTests();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-runner-'));
  roots.push(root);
  for (const [key, value] of Object.entries({
    ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
    ATOMA_BASELINE_MODEL: 'api:ollama:test', ATOMA_BUILD_WORKSPACE: join(root, 'workspace'),
    ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
    ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'traces'),
    ATOMA_BUILD_TIMEOUT_MS: '10000', ATOMA_EGRESS: '0', ATOMA_TENANT_RUN: '', ATOMA_RUN_ID: 'test-run',
  })) vi.stubEnv(key, value);
  resetHostLifecycleSnapshotForTests();
  return root;
}

describe('trusted retrieval injection through startTask', () => {
  it('resolves the coordinator receipt through the real startTask path without a library injection', async () => {
    const root = environment();
    const f = projectRetrievalFixture(root);
    const source = f.makeRun({ 'docs.md': 'Private price is 190 euros.\n' });
    const current = f.makeRun();
    await ProjectRetrievalLaunchStore.open(f.dbPath).prepare(current.run.projectRunId, source.run.projectRunId, retrievalContext());
    for (const [key, value] of Object.entries({ ATOMA_PROJECT_RETRIEVAL: '1', ATOMA_TENANT_RUN: '1', ATOMA_RUN_ID: current.run.projectRunId,
      ATOMA_DB_PATH: f.dbPath, ATOMA_BUILD_WORKSPACE: current.layout.workspacePath, ATOMA_RUNS_DIR: current.layout.runsPath,
      ATOMA_SKILLS_DIR: current.layout.skillsPath, ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0', ATOMA_PREFILTER_CACHE: '0' })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    const llm = new MockLlmClient();
    let observed: unknown;
    llm.enqueue(async req => {
      observed = await req.executor!.execute(SEARCH, { query: 'price' });
      return { text: 'Source consulted.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    vi.mocked(buildTierClients).mockReturnValue({ ollama: llm });
    vi.mocked(containerToolBackend).mockImplementation(async opts => localToolBackend({ workspaceRoot: opts.workspaceRoot, logger: silentLogger() }));
    const handle = await startTask(buildProfile, ['--container', '--baseline', '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', 'Consult the source.']);
    try {
      expect((await handle.settled).outcome).toBe('delivered');
      expect(observed).toMatchObject({ ok: true, passages: [expect.objectContaining({ excerpt: 'Private price is 190 euros.\n' })] });
    } finally { await handle.shutdown(); }
  });

  it('refuses a marked child without a stored receipt before workspace or provider construction', async () => {
    const root = environment();
    vi.stubEnv('ATOMA_PROJECT_RETRIEVAL', '1'); vi.stubEnv('ATOMA_TENANT_RUN', '1');
    vi.stubEnv('ATOMA_SKILL_PROMOTE', '0'); vi.stubEnv('ATOMA_SKILL_DIRECT', '0');
    vi.stubEnv('ATOMA_PREFILTER_CACHE', '0'); resetHostLifecycleSnapshotForTests();
    vi.mocked(buildTierClients).mockClear(); vi.mocked(containerToolBackend).mockClear();
    await expect(startTask(buildProfile, ['--container', '--no-promote-skills', '--no-direct-skills', 'Consult source.'])).rejects.toThrow('unavailable or denied');
    expect(buildTierClients).not.toHaveBeenCalled(); expect(containerToolBackend).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'workspace'))).toBe(false);
  });
  it.each([false, true])('uses the same host service with container mode=%s and disposes it on shutdown', async container => {
    environment();
    const binding = retrievalTestBinding();
    const llm = new MockLlmClient();
    llm.enqueue(async req => {
      expect(req.tools?.map(t => t.name)).toContain(SEARCH);
      expect(await req.executor!.execute(SEARCH, { query: 'annual price' })).toMatchObject({ ok: true });
      return { text: 'Source consulted.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    vi.mocked(buildTierClients).mockReturnValue({ ollama: llm });
    vi.mocked(containerToolBackend).mockImplementation(async opts => localToolBackend({
      workspaceRoot: opts.workspaceRoot, logger: silentLogger(),
    }));
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(buildProfile, ['--baseline', container ? '--container' : '--no-container',
        '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', 'Consult the project source.'],
      { projectRetrieval: binding });
      expect((await handle.settled).outcome).toBe('delivered');
      expect(binding.service.search).toHaveBeenCalledTimes(1);
      expect(binding.service.search.mock.calls[0]![0].runId).toBe('test-run');
    } finally { await handle?.shutdown(); await handle?.shutdown(); }
    expect(binding.service.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['missing-run', 'wrong-run', 'tenant-as-operator', 'provider-snapshot-omits-tenant', 'missing-authority'])('refuses %s before setup or providers', async kind => {
    const root = environment();
    const binding = retrievalTestBinding();
    if (kind === 'missing-run') vi.stubEnv('ATOMA_RUN_ID', undefined);
    if (kind === 'wrong-run') vi.stubEnv('ATOMA_RUN_ID', 'another-run');
    if (kind === 'tenant-as-operator' || kind === 'provider-snapshot-omits-tenant') vi.stubEnv('ATOMA_TENANT_RUN', '1');
    if (kind === 'missing-authority') binding.service.authorize = undefined as never;
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(root, 'workspace/keep.txt'), 'prior deliverable');
    vi.mocked(buildTierClients).mockClear();
    vi.mocked(containerToolBackend).mockClear();
    await expect(startTask(buildProfile, ['--container', 'Consult the project source.'], {
      projectRetrieval: binding,
      ...(kind === 'provider-snapshot-omits-tenant' ? { providerEnv: {
        ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
      } } : {}),
    }))
      .rejects.toThrow(/project retrieval|operator retrieval/);
    expect(readFileSync(join(root, 'workspace/keep.txt'), 'utf8')).toBe('prior deliverable');
    expect(existsSync(join(root, 'store.db'))).toBe(false);
    expect(buildTierClients).not.toHaveBeenCalled();
    expect(containerToolBackend).not.toHaveBeenCalled();
    expect(binding.service.dispose).not.toHaveBeenCalled(); // not owned until backend assembly
  });
});
