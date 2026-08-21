import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  ProjectRunBusy,
  ProjectRunConfigurationError,
  ProjectRunCoordinator,
  projectRunEnvironment,
  projectRunHostLayout,
  runnerFailureDetail,
} from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { RunLockBusyError, type RunLease } from '../src/mcp/runLock.js';

type SpawnRunOptions = Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0];

const roots: string[] = [];
const DELIVERED_STATS: RunStats = {
  outcome: 'delivered',
  costUsd: 0.01,
  llmCalls: 1,
  opusCalls: 1,
  sonnetCalls: 0,
  haikuCalls: 0,
  otherCalls: 0,
  deterministicPhases: 0,
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 0,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-project-coordinator-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({
    provider: 'github',
    subject: 'owner',
    displayName: 'Owner',
    email: null,
    emailVerified: false,
  }, null);
  if (!login) throw new Error('owner bootstrap failed');
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId,
    principalId: login.viewer.principalId,
    project: {
      name: 'Clock',
      slug: 'clock',
      initialPrompt: 'Build a clock in one index.html.',
      repositoryTarget: {
        installationId: '123',
        owner: 'owner',
        name: 'clock',
        visibility: 'private',
      },
    },
  });
  return { root, dbPath, store, viewer: login.viewer, project };
}

function lease(): RunLease {
  return {
    path: '/test/lease',
    attachChild: vi.fn(),
    release: vi.fn(),
  };
}

describe('project run environment', () => {
  it('lays a run out under orgs/<org>/projects/<project>/runs/<run>', () => {
    const layout = projectRunHostLayout('/control', 'org-a', 'proj-b', 'run-c');
    expect(layout.runRoot).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c');
    expect(layout.runsPath).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c/traces');
    expect(layout.workspacePath).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c/workspace');
    expect(layout.skillsPath).toBe('/control/orgs/org-a/projects/proj-b/skills');
  });
  it('forwards only the direct model credential and host runtime allowlist', () => {
    const env = projectRunEnvironment({
      hostEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'model-key',
        ATOMA_GITHUB_APP_PRIVATE_KEY: 'must-not-cross',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'must-not-cross-either',
      },
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    });
    expect(env['ANTHROPIC_API_KEY']).toBe('model-key');
    expect(env['ATOMA_REQUIRE_ISOLATION']).toBe('1');
    expect(env['ATOMA_CONTAINER']).toBe('1');
    expect(env['ATOMA_GITHUB_APP_PRIVATE_KEY']).toBeUndefined();
    expect(env['ATOMA_AUTH_GITHUB_CLIENT_SECRET']).toBeUndefined();
  });

  it('refuses subscription transports, cross-provider pins and ambiguous credentials', () => {
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    };
    expect(() => projectRunEnvironment({ ...base, hostEnv: { ATOMA_LLM: 'claude-cli' } }))
      .toThrow(ProjectRunConfigurationError);
    expect(() => projectRunEnvironment({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: 'key', ATOMA_MODEL_L2: 'codex:gpt-5' },
    })).toThrow(/another provider/);
    expect(() => projectRunEnvironment({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'token' },
    })).toThrow(/exactly one/);
  });
});

describe('ProjectRunCoordinator', () => {
  it('isolates, verifies and publishes a delivered project run', async () => {
    const f = fixture();
    const runLease = lease();
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      mkdirSync(join(declarations, '..'), { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      options.onSpawn?.(4242);
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => runLease,
      publisher,
    });

    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-1', goal: 'Build a clock in one index.html.' },
    });
    expect(started.status).toBe('running');
    await coordinator.waitForIdle();

    const finished = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(finished.status).toBe('delivered');
    expect(finished.traceId).toBe(started.projectRunId);
    expect(finished.artifactManifest?.files.map((file) => file.path)).toEqual(['index.html']);
    expect(driver.mock.calls[0]?.[0].extraArgs).toContain('--container');
    expect(runLease.attachChild).toHaveBeenCalledWith(4242);
    expect(runLease.release).toHaveBeenCalledOnce();
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(driver.mock.calls[0]?.[0].extraArgs).not.toContain('--seed');
    expect(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']).toBe(
      join(
        f.root,
        'orgs',
        f.viewer.orgId,
        'projects',
        f.project.projectId,
        'runs',
        started.projectRunId,
        'traces'
      )
    );
    expect(started.hostPaths.runsPath).toBe(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']);
  });

  it('emits one terminal onRunFinished event with the requesting principal', async () => {
    const f = fixture();
    const finished = vi.fn();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
      onRunFinished: finished,
    });

    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(finished).toHaveBeenCalledExactlyOnceWith({
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      projectRunId: started.projectRunId,
      principalId: f.viewer.principalId,
      goal: 'Build a clock in one index.html.',
      status: 'delivered',
    });
  });

  it('a failed run still emits onRunFinished and a throwing listener stays contained', async () => {
    const f = fixture();
    const finished = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: vi.fn(async () => {
        throw new Error('driver died');
      }),
      acquireLease: async () => lease(),
      onRunFinished: finished,
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.status).toBe('failed');
    expect(finished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'failed', projectRunId: started.projectRunId })
    );
  });

  it('seeds a later run from the last delivered workspace', async () => {
    const f = fixture();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });

    const first = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(f.store.getProjectRun(f.viewer.orgId, first.projectRunId)?.status).toBe('delivered');

    const second = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-2', goal: 'Add a timezone selector to the clock.' },
    });
    expect(second.goal).toBe('Add a timezone selector to the clock.');
    const extraArgs = driver.mock.calls[1]?.[0].extraArgs ?? [];
    const seedAt = extraArgs.indexOf('--seed');
    expect(seedAt).toBeGreaterThanOrEqual(0);
    expect(extraArgs[seedAt + 1]).toBe(first.hostPaths.workspacePath);
    await coordinator.waitForIdle();
  });

  it('fails closed when a delivered run declares an excluded secret', async () => {
    const f = fixture();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, '.env'), 'TOKEN=secret', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['.env'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS);
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-secret', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    const failed = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/excluded/);
  });

  it('keeps failed traces under the owning project run directory', async () => {
    const f = fixture();
    const failedStats: RunStats = { ...DELIVERED_STATS, outcome: 'failed' };
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        error: '401',
        result: { summary: 'auth failed' },
      }), 'utf8');
      return `${formatRunStatsEpilogue(failedStats)}\n✖ 401 API key is invalid.\n`;
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-auth', goal: 'Build a clock in one index.html.' },
    });
    const tracesDir = join(
      f.root,
      'orgs',
      f.viewer.orgId,
      'projects',
      f.project.projectId,
      'runs',
      started.projectRunId,
      'traces'
    );
    expect(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']).toBe(tracesDir);
    await coordinator.waitForIdle();
    const failed = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/API key is invalid/);
    expect(failed.traceId).toBe(started.projectRunId);
    expect(existsSync(join(tracesDir, `${started.projectRunId}.json`))).toBe(true);
  });

  it('does not leave a queued row when the instance lease is busy', async () => {
    const f = fixture();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: vi.fn(),
      acquireLease: async () => {
        throw new RunLockBusyError('another run is in progress');
      },
    });
    await expect(coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-busy', goal: 'Build a clock in one index.html.' },
    })).rejects.toBeInstanceOf(ProjectRunBusy);
    expect(f.store.listProjectRuns(f.viewer.orgId, f.project.projectId)).toEqual([]);
  });
});

describe('runnerFailureDetail', () => {
  it('prefers the runner bang line over a generic outcome', () => {
    expect(runnerFailureDetail('hello\n✖ 401 API key is invalid.\n', 'failed'))
      .toBe('401 API key is invalid.');
    expect(runnerFailureDetail('no bang', 'failed')).toBe('runner finished with outcome failed');
  });
});
