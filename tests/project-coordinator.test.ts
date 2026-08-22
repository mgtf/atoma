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
  type ProjectRunDriver,
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
  uncoveredObligations: 0,
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

  it('opens the subscription transport for a platform admin ONLY, and forwards no credential', () => {
    // The door: a machine-bound transport spends the HOST login session and
    // cannot honour a per-run credential, so it stays refused for a tenant
    // and is allowed for the one identity whose subscription it actually is.
    // The authority is the platform-admin flag because it is never derived
    // from an OAuth claim — only the operator CLI can mint it.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    };
    for (const spelling of ['claude-cli', 'claude', 'CLAUDE-CLI']) {
      // Both spellings `resolveBaseProviderKind` accepts, or the door has a
      // hole in it.
      expect(() => projectRunEnvironment({ ...base, hostEnv: { ATOMA_LLM: spelling } })).toThrow(
        /platform admin/
      );
      const env = projectRunEnvironment({
        ...base,
        hostEnv: { ATOMA_LLM: spelling, ANTHROPIC_API_KEY: 'stale-host-key' },
        subscriptionTransport: { principalId: 'admin-1' },
      });
      // Canonical spelling regardless of the alias the host wrote.
      expect(env['ATOMA_LLM']).toBe('claude-cli');
      // No credential crosses: the transport cannot honour one, and a stale
      // exported key would only confuse the provider's own precedence.
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
      // Isolation is NOT relaxed by the door.
      expect(env['ATOMA_CONTAINER']).toBe('1');
      expect(env['ATOMA_REQUIRE_ISOLATION']).toBe('1');
    }
    // A subscription run has no per-run credential by definition, so the
    // exactly-one-credential rule must not fire on it.
    expect(() =>
      projectRunEnvironment({
        ...base,
        hostEnv: { ATOMA_LLM: 'claude-cli' },
        subscriptionTransport: { principalId: 'admin-1' },
      })
    ).not.toThrow();
    // A grant does not turn every provider into a subscription transport.
    expect(() =>
      projectRunEnvironment({
        ...base,
        hostEnv: { ATOMA_LLM: 'ollama' },
        subscriptionTransport: { principalId: 'admin-1' },
      })
    ).toThrow(/do not support/);
  });

  it('lets an account pin override the operator per tier, and inherit where it does not', () => {
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      hostEnv: {
        ANTHROPIC_API_KEY: 'key',
        ATOMA_MODEL_L1: 'claude-haiku-4-5-20251001',
        ATOMA_MODEL_L2: 'claude-sonnet-5',
      },
    };
    // No account pins: the operator's host pins stand, unchanged behaviour.
    const operatorOnly = projectRunEnvironment(base);
    expect(operatorOnly['ATOMA_MODEL_L1']).toBe('claude-haiku-4-5-20251001');
    expect(operatorOnly['ATOMA_MODEL_L2']).toBe('claude-sonnet-5');
    expect(operatorOnly['ATOMA_MODEL_L3']).toBeUndefined();

    const withPins = projectRunEnvironment({
      ...base,
      tierModels: { l1: 'claude-sonnet-5', l2: null, l3: 'claude-opus-5' },
    });
    // L1 overridden, L2 inherited from the host, L3 set where the host had none.
    expect(withPins['ATOMA_MODEL_L1']).toBe('claude-sonnet-5');
    expect(withPins['ATOMA_MODEL_L2']).toBe('claude-sonnet-5');
    expect(withPins['ATOMA_MODEL_L3']).toBe('claude-opus-5');

    // The cross-provider refusal still guards the account path, not only the
    // host one — the closed choice list cannot produce this, and that is
    // exactly why the check stays.
    expect(() => projectRunEnvironment({
      ...base,
      tierModels: { l1: 'ollama:llama3' as 'claude-sonnet-5', l2: null, l3: null },
    })).toThrow(/another provider/);
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

describe('the subscription-transport door, at the coordinator', () => {
  /**
   * The VERIFICATION lives here, not at the caller: `platformAdmins` is a
   * question the coordinator asks, so no route and no CLI can hand in a
   * pre-decided "yes". Every case below is about who is allowed to spend the
   * host's login session.
   */
  function deliveringDriver(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_options: SpawnRunOptions): Promise<string> => {
      return `${formatRunStatsEpilogue(DELIVERED_STATS)}\n✓ build finished\n`;
    });
  }

  /** A host with NO credential: only the door can make this run startable. */
  function subscriptionHost(): NodeJS.ProcessEnv {
    return { PATH: process.env['PATH'], ATOMA_LLM: 'claude-cli' };
  }

  async function expectRefused(
    f: ReturnType<typeof fixture>,
    coordinator: ProjectRunCoordinator,
    driver: ReturnType<typeof vi.fn>,
    key: string,
    matcher: RegExp | typeof ProjectRunConfigurationError
  ): Promise<void> {
    const promise = coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: key, goal: 'Build a clock.' },
    });
    await (matcher instanceof RegExp
      ? expect(promise).rejects.toThrow(matcher)
      : expect(promise).rejects.toThrow(matcher));
    expect(driver).not.toHaveBeenCalled();
  }

  it('refuses when NO authority is wired (fail-closed, unlike tier pins)', async () => {
    const f = fixture();
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
    });
    await expectRefused(f, coordinator, driver, 'no-authority', ProjectRunConfigurationError);
  });

  it('refuses a requester who is not a platform admin', async () => {
    const f = fixture();
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => false,
    });
    await expectRefused(f, coordinator, driver, 'not-admin', /platform admin/);
  });

  it('refuses when the authority lookup THROWS', async () => {
    // The opposite of `tierModelsFor`, deliberately: a preferences lookup
    // that throws must not block a run, an authority lookup that throws must
    // never be read as permission to spend.
    const f = fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => {
        throw new Error('store unavailable');
      },
    });
    await expectRefused(f, coordinator, driver, 'authority-down', ProjectRunConfigurationError);
  });

  it('lets a platform admin through, and announces the spend exactly once', async () => {
    const f = fixture();
    const seen: Array<{ principalId: string; transport: string }> = [];
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: (principalId) => principalId === f.viewer.principalId,
      onSubscriptionTransport: (info) =>
        seen.push({ principalId: info.principalId, transport: info.transport }),
    });
    const run = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'admin-run', goal: 'Build a clock.' },
    });
    await coordinator.waitForIdle();
    expect(driver).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { principalId: f.viewer.principalId, transport: 'claude-cli' },
    ]);
    // The env the driver received carries the transport and no credential.
    const passed = driver.mock.calls[0]![0] as SpawnRunOptions;
    expect(passed.env?.['ATOMA_LLM']).toBe('claude-cli');
    expect(passed.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(run.projectRunId).toBeTruthy();
  });

  it('says nothing when the host is NOT on a subscription transport', async () => {
    const f = fixture();
    const seen: unknown[] = [];
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => true,
      onSubscriptionTransport: (info) => seen.push(info),
    });
    await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'credentialled', goal: 'Build a clock.' },
    });
    await coordinator.waitForIdle();
    // An admin on a credentialled transport is an ordinary run: the audit row
    // means "billed to the host subscription", and this one was not.
    expect(seen).toEqual([]);
  });
});
