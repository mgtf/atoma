import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubAppClient } from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ProjectService } from '../src/projects/service.js';
import { parseGitHubRepository, type Project } from '../src/contracts/projects.js';
import { HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../src/run/runner.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { FakeGitHub } from './github-api-fake.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); closeStoreHandles(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

async function fixture(mode: 'pull-request' | 'fork', transform?: (fake: FakeGitHub) => typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-import-')); roots.push(root);
  const f = projectRetrievalFixture(root);
  const fake = new FakeGitHub({ existing: ['upstream/app'] });
  fake.commitOutside('upstream', 'app', 'main', 'index.html', '<h1>Original</h1>');
  fake.commitOutside('upstream', 'app', 'main', 'keep.txt', 'Unchanged');
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '501', orgId: f.viewer.orgId, accountId: '701',
    accountLogin: mode === 'fork' ? 'alice' : 'upstream', targetType: 'User', repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write', pull_requests: 'write' }, connectedByPrincipalId: f.viewer.principalId });
  const client = new GitHubAppClient({ appId: '123', appSlug: 'test',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, apiBaseUrl: 'https://api.github.test' },
  { fetch: transform?.(fake) ?? fake.fetch, now: () => Date.UTC(2026, 7, 23, 12) });
  const publisher = new GitHubPublisher({ client, github, store: f.projects, resolveUserAccessToken: async () => 'user-token' });
  const seeds: string[] = [];
  let nextContent = '<h1>Changed</h1>';
  const driver = vi.fn<ProjectRunDriver>(async options => {
    const seedIndex = options.extraArgs!.indexOf('--seed');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    const seed = options.extraArgs![seedIndex + 1]!;
    seeds.push(readFileSync(join(seed, 'index.html'), 'utf8'));
    const env = options.env!;
    expect(Object.values(env)).not.toContain('user-token');
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    cpSync(seed, workspace, { recursive: true });
    writeFileSync(join(workspace, 'index.html'), nextContent);
    const manifest = env[ARTIFACT_MANIFEST_PATH_ENV]!;
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 1, runId: env['ATOMA_RUN_ID'], generatedAt: new Date().toISOString(), outputs: ['index.html'] }));
    const traces = env['ATOMA_RUNS_DIR']!; mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${env['ATOMA_RUN_ID']}.json`), JSON.stringify({ id: env['ATOMA_RUN_ID'], endedAt: new Date().toISOString(), result: { summary: 'Verified' } }));
    return '✓ build finished';
  });
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
    hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:test',
      ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
    publisher, driver, acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release: vi.fn() }) });
  const service = new ProjectService({ store: f.projects, github, coordinator, publisher });
  const created = await service.createProjectFromInput(f.viewer, { name: 'Imported', slug: 'imported', repositoryTarget: {
    installationId: '501', owner: mode === 'fork' ? 'alice' : 'upstream', name: 'app',
    source: { owner: 'upstream', name: 'app', mode },
  } }) as { projectId: string };
  const project = f.projects.getProject(f.viewer.orgId, created.projectId)!;
  const start = async (content = '<h1>Changed</h1>') => {
    nextContent = content;
    const run = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: project.projectId,
      request: { idempotencyKey: randomUUID(), goal: 'Change the heading.' } });
    await coordinator.waitForIdle();
    return f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)!;
  };
  return { ...f, project, fake, client, publisher, service, coordinator, driver, start, seeds };
}

describe('existing GitHub projects through service, coordinator and publication', () => {
  it.each(['fork', 'pull-request'] as const)('includes child-created assets omitted from the root plan in %s mode', async mode => {
    const f = await fixture(mode);
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const log = await driver(options);
      const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
      mkdirSync(join(workspace, 'assets'));
      writeFileSync(join(workspace, 'assets', 'app.js'), 'document.title="Complete";');
      return log;
    });
    const run = await f.start('<script src="assets/app.js"></script>');
    expect(run.status).toBe('delivered');
    expect(run.artifactManifest?.source).toBe('workspace');
    const owner = mode === 'fork' ? 'alice' : 'upstream';
    const branch = mode === 'fork' ? 'main' : `atoma/run-${run.projectRunId}`;
    expect(f.fake.filesOn(owner, 'app', branch).get('assets/app.js')?.text).toBe('document.title="Complete";');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
  });

  it('seeds current main, creates one PR per delivered change and leaves main intact', async () => {
    const f = await fixture('pull-request');
    const original = f.fake.refSha('upstream', 'app', 'main');
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(run.repositoryBase?.commitSha).toBe(original);
    expect(f.seeds).toEqual(['<h1>Original</h1>']);
    expect(f.fake.refSha('upstream', 'app', 'main')).toBe(original);
    expect(f.fake.filesOn('upstream', 'app', `atoma/run-${run.projectRunId}`).get('keep.txt')?.text).toBe('Unchanged');
    const publication = f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)!;
    expect(publication).toMatchObject({ status: 'published', pullRequestUrl: 'https://github.com/upstream/app/pull/1' });
    await f.coordinator.retryPublication(f.viewer.orgId, run.projectRunId);
    expect(f.fake.pullRequests).toHaveLength(1);
    f.fake.commitOutside('upstream', 'app', 'main', 'index.html', '<h1>Merged externally</h1>');
    const second = await f.start('<h1>Second</h1>');
    expect(second.status).toBe('delivered');
    expect(f.seeds[1]).toBe('<h1>Merged externally</h1>');
    expect(f.fake.pullRequests).toHaveLength(2);
    expect(f.fake.forcedUpdates).toBe(0);
  });

  it('forks once, publishes directly there and seeds the next run from the fork', async () => {
    const f = await fixture('fork');
    const original = f.fake.refSha('upstream', 'app', 'main');
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.filesOn('alice', 'app', 'main').get('index.html')?.text).toBe('<h1>Changed</h1>');
    expect(f.fake.refSha('upstream', 'app', 'main')).toBe(original);
    await f.start('<h1>Second</h1>');
    expect(f.seeds).toEqual(['<h1>Original</h1>', '<h1>Changed</h1>']);
    expect(f.fake.calls.filter(call => call.endsWith('/forks'))).toHaveLength(1);
    expect(f.fake.pullRequests).toHaveLength(0);
  });

  it('retries a failed PR creation without a second branch or commit', async () => {
    let fail = true;
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/pulls') && init?.method === 'POST' && fail) {
        fail = false; return new Response('{}', { status: 503 });
      }
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('failed');
    const head = f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`);
    await f.coordinator.retryPublication(f.viewer.orgId, run.projectRunId);
    expect(f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`)).toBe(head);
    expect(f.fake.pullRequests).toHaveLength(1);
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
  });

  it('does not open an empty PR', async () => {
    const f = await fixture('pull-request');
    const run = await f.start('<h1>Original</h1>');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.pullRequests).toHaveLength(0);
    expect(f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`)).toBeNull();
  });

  it('refuses an unrelated fork destination before any model work', async () => {
    const f = await fixture('fork');
    f.fake.createRepository('alice', 'app');
    f.fake.commitOutside('alice', 'app', 'main', 'other.txt', 'Other project');
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('fork parent');
    expect(f.driver).not.toHaveBeenCalled();
    expect(f.fake.filesOn('alice', 'app', 'main').has('index.html')).toBe(false);
  });

  it('refuses direct publication when the fork changes during a run', async () => {
    const f = await fixture('fork');
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const log = await driver(options);
      f.fake.commitOutside('alice', 'app', 'main', 'index.html', '<h1>Human edit</h1>');
      return log;
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('failed');
    expect(f.fake.filesOn('alice', 'app', 'main').get('index.html')?.text).toBe('<h1>Human edit</h1>');
  });

  it.each(['../escape', '.git/config', 'safe/../../escape'])('refuses unsafe repository path %s before running', async unsafePath => {
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('?recursive=1')) return new Response(JSON.stringify({ truncated: false,
        tree: [{ path: unsafePath, type: 'blob', mode: '100644', sha: 'a'.repeat(40) }] }));
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it('refuses a truncated source tree before invoking the driver', async () => {
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('?recursive=1')) return new Response(JSON.stringify({ truncated: true, tree: [] }));
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.error).toContain('incomplete');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it('refuses a foreign organisation installation before downloading files or invoking the driver', async () => {
    const f = await fixture('pull-request');
    const foreign = { ...f.project, orgId: randomUUID() } satisfies Project;
    await expect(f.publisher.prepareRun(foreign, {} as never, new AbortController().signal)).rejects.toThrow('not linked');
    expect(f.driver).not.toHaveBeenCalled();
  });
});

describe('GitHub source entry', () => {
  it.each(['owner/repo', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git'])('parses %s', value => {
    expect(parseGitHubRepository(value)).toEqual({ owner: 'owner', name: 'repo' });
  });
  it.each(['https://evil.test/owner/repo', 'https://github.com/owner/repo/tree/main', 'https://u:p@github.com/owner/repo', '../repo', 'git@github.com:owner/repo'])('refuses %s', value => {
    expect(() => parseGitHubRepository(value)).toThrow();
  });
});
