import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { ProjectRunCoordinator, ProjectRunConfigurationError, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { openProjectRunHaystack } from '../src/projects/retrievalHaystackLaunch.js';
import { readHaystackLaunch, HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import type { ProjectRetrievalResponse } from '../src/contracts/projectRetrieval.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); closeStoreHandles(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('coordinator retrieval admission before spawn', () => {
  it.each([{}, { [HAYSTACK_LAUNCH_ENV]: 'invalid' }])('refuses new runs without valid Haystack configuration before reservation: %j', async hostEnv => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-config-')); roots.push(root);
    const f = projectRetrievalFixture(root);
    const driver = vi.fn<ProjectRunDriver>();
    const acquireLease = vi.fn();
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath,
      hostEnv, driver, acquireLease });
    // Construction and read-only operations do not need a search runtime.
    expect(coordinator.reconcileInterrupted()).toEqual({ runs: 0, publications: 0 });
    const input = { orgId: f.viewer.orgId, principalId: f.viewer.principalId,
      projectId: f.project.projectId, request: { idempotencyKey: 'missing-runtime', goal: 'Consult project docs.' } };
    await expect(coordinator.start(input)).rejects.toThrow(ProjectRunConfigurationError);
    await expect(coordinator.start(input)).rejects.toThrow('ATOMA_HAYSTACK_CONFIG');
    expect(f.projects.findProjectRunForRequest(input.orgId, input.projectId, input.principalId, input.request)).toBeNull();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(driver).not.toHaveBeenCalled();
  });
  it('always prepares search and archives the delivered seed without an activation switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-coordinator-')); roots.push(root);
    const f = projectRetrievalFixture(root);
    const source = f.makeRun({ 'docs.md': 'Private annual price: 190 euros.\n' });
    let result: ProjectRetrievalResponse | undefined;
    let forwarded: Parameters<ProjectRunDriver>[0] | undefined;
    const driver: ProjectRunDriver = vi.fn(async options => {
      forwarded = options;
      const env = options.env!;
      const prepared = openProjectRunHaystack({ dbPath: env['ATOMA_DB_PATH']!, runId: env['ATOMA_RUN_ID']!,
        workspacePath: env['ATOMA_BUILD_WORKSPACE']!, skillsPath: env['ATOMA_SKILLS_DIR']!, runsPath: env['ATOMA_RUNS_DIR']! }, readHaystackLaunch(env));
      await prepared.prepare(retrievalContext());
      const binding = prepared.binding;
      const tool = createProjectRetrievalTool(binding, retrievalContext());
      try { result = await tool.execute({ query: 'annual price' }); }
      finally { await tool.close(); }
      return '--- run failed --- boundary test ends before delivery';
    });
    const release = vi.fn();
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
      hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
        OLLAMA_BASE_URL: 'http://127.0.0.1:1' }, driver,
      acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release }) });
    const run = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId,
      projectId: f.project.projectId, request: { idempotencyKey: 'with-retrieval', goal: 'Consult the private project docs.' } });
    await coordinator.waitForIdle();
    expect(result).toMatchObject({ ok: true, passages: [expect.objectContaining({ excerpt: 'Private annual price: 190 euros.\n' })] });
    expect(readHaystackLaunch(forwarded!.env!)).toEqual(haystackTestRuntime(root));
    expect(forwarded?.env?.['ATOMA_TENANT_RUN']).toBe('1');
    expect(forwarded?.extraArgs).toContain(source.layout.workspacePath);
    expect(Object.values(forwarded?.env ?? {}).some(value => value?.includes('Private annual'))).toBe(false);
    expect(ProjectRetrievalLaunchStore.open(f.dbPath).resolve(run.projectRunId)).toBe(null); // run is now terminal
    expect(release).toHaveBeenCalledOnce();
  });

  it('prepares search for an empty first corpus within the original deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-empty-')); roots.push(root);
    const f = projectRetrievalFixture(root);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const originalPrepare = ProjectRetrievalLaunchStore.prototype.prepare;
    vi.spyOn(ProjectRetrievalLaunchStore.prototype, 'prepare').mockImplementation(async function (this: ProjectRetrievalLaunchStore, ...args) {
      const receipt = await originalPrepare.apply(this, args);
      clock.mockReturnValue(now + 250);
      return receipt;
    });
    let result: ProjectRetrievalResponse | undefined;
    const driver = vi.fn<ProjectRunDriver>(async options => {
      const env = options.env!;
      const receipt = ProjectRetrievalLaunchStore.open(f.dbPath).resolve(env['ATOMA_RUN_ID']!);
      expect(receipt).toMatchObject({ sourceRunId: null, manifest: { documents: [] } });
      const prepared = openProjectRunHaystack({ dbPath: f.dbPath, runId: env['ATOMA_RUN_ID']!,
        workspacePath: env['ATOMA_BUILD_WORKSPACE']!, skillsPath: env['ATOMA_SKILLS_DIR']!, runsPath: env['ATOMA_RUNS_DIR']! }, readHaystackLaunch(env));
      const tool = createProjectRetrievalTool(prepared.binding, retrievalContext());
      try { await prepared.prepare(retrievalContext()); result = await tool.execute({ query: 'project docs' }); }
      finally { await tool.close(); }
      return '--- run failed --- boundary test ends before delivery';
    });
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root, timeoutMs: 60_000,
      hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)),
        ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
      driver, acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release: vi.fn() }) });
    const input = { orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { idempotencyKey: 'empty-corpus', goal: 'Start the project.' } };
    const run = await coordinator.start(input);
    await coordinator.waitForIdle();
    expect(result).toMatchObject({ ok: true, passages: [] });
    expect(driver.mock.calls[0]?.[0].timeoutMs).toBe(59_750);
    // Retrying an existing request is a read, even from a host without a runtime.
    const reader = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, hostEnv: {} });
    expect((await reader.start(input)).projectRunId).toBe(run.projectRunId);
    expect(driver).toHaveBeenCalledOnce();
  });

  it('does not spawn on cancelled preparation and preserves the original source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-retrieval-cancel-')); roots.push(root);
    const f = projectRetrievalFixture(root);
    const source = f.makeRun({ 'docs.md': 'Original source\n' });
    const driver = vi.fn<ProjectRunDriver>(async () => 'not reached');
    const release = vi.fn();
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
      hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
        OLLAMA_BASE_URL: 'http://127.0.0.1:1' }, driver,
      acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release }) });
    const run = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId,
      projectId: f.project.projectId, request: { idempotencyKey: 'cancelled-retrieval', goal: 'Consult project docs.' } });
    coordinator.cancel(f.viewer.orgId, run.projectRunId);
    await coordinator.waitForIdle();
    expect(driver).not.toHaveBeenCalled();
    expect(f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)?.status).toBe('cancelled');
    expect(readFileSync(join(source.layout.workspacePath, 'docs.md'), 'utf8')).toBe('Original source\n');
    expect(release).toHaveBeenCalledOnce();
  });
});
