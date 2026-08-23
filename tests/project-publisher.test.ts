import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { GitHubApiError, type GitHubAppClient, type GitHubRepository } from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { buildArtifactManifest } from '../src/projects/artifacts.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectStore } from '../src/projects/store.js';
import type { RunStats } from '../src/contracts/runStats.js';

let root: string;
let db: Database.Database;
let store: ProjectStore;
let github: GitHubStore;

const deliveredStats: RunStats = {
  outcome: 'delivered',
  costUsd: 0.12,
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-publisher-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  store = new ProjectStore(db);
  github = new GitHubStore(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Actor {
  orgId: string;
  principalId: string;
}

function actor(label: string): Actor {
  const orgId = randomUUID();
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)')
    .run(orgId, `${label} Org`, now);
  db.prepare(
    `INSERT INTO auth_principals (principal_id, kind, display_name, created_at)
     VALUES (?, 'human', ?, ?)`
  ).run(principalId, label, now);
  db.prepare(
    `INSERT INTO auth_memberships (org_id, principal_id, role, created_at)
     VALUES (?, ?, 'org:owner', ?)`
  ).run(orgId, principalId, now);
  return { orgId, principalId };
}

function repository(owner: string, name: string): GitHubRepository {
  return {
    id: '9001',
    owner,
    name,
    fullName: `${owner}/${name}`,
    defaultBranch: 'main',
    private: true,
    htmlUrl: `https://github.com/${owner}/${name}`,
  };
}

function apiError(status: number, path: string): GitHubApiError {
  return new GitHubApiError({ status, method: 'POST', path, code: 'http' });
}

async function deliveredRun(
  owner: Actor,
  targetType: 'User' | 'Organization',
  login: string
) {
  github.linkInstallation({
    installationId: '501',
    orgId: owner.orgId,
    accountId: '701',
    accountLogin: login,
    targetType,
    repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    connectedByPrincipalId: owner.principalId,
  });
  const project = store.createProject({
    orgId: owner.orgId,
    principalId: owner.principalId,
    project: {
      name: 'Weather Lab',
      slug: 'weather-lab',
      initialPrompt: 'Build a weather dashboard.',
      repositoryTarget: {
        installationId: '501',
        owner: login,
        name: 'weather-lab',
        visibility: 'private',
      },
    },
  });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), '<h1>ok</h1>\n');
  writeFileSync(join(workspace, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const built = buildArtifactManifest({
    workspaceRoot: workspace,
    declaredPaths: ['index.html', 'run.sh'],
  });
  const reserved = store.createProjectRun({
    orgId: owner.orgId,
    projectId: project.projectId,
    principalId: owner.principalId,
    request: { idempotencyKey: 'publish-1', goal: 'Build a weather dashboard.' },
    hostPaths: {
      workspacePath: workspace,
      runsPath: join(root, 'runs'),
      logPath: join(root, 'run.log'),
    },
  })!;
  store.transitionProjectRun({
    orgId: owner.orgId,
    projectRunId: reserved.run.projectRunId,
    from: 'queued',
    to: 'running',
  });
  store.transitionProjectRun({
    orgId: owner.orgId,
    projectRunId: reserved.run.projectRunId,
    from: 'running',
    to: 'delivered',
    traceId: 'trace-1',
    stats: deliveredStats,
  });
  const run = store.saveArtifactManifest(owner.orgId, reserved.run.projectRunId, built.manifest)!;
  return { project, run, workspace, hash: built.hash };
}

function mockClient(overrides: Partial<GitHubAppClient> = {}): GitHubAppClient {
  return {
    createInstallationToken: vi.fn(async () => ({
      token: 'ghs_install-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permissions: { administration: 'write', contents: 'write' },
    })),
    createUserRepository: vi.fn(async () => repository('alice', 'weather-lab')),
    createOrganisationRepository: vi.fn(async () => repository('atoma-org', 'weather-lab')),
    getRepository: vi.fn(async () => null),
    publishInitialCommit: vi.fn(async () => ({
      branch: 'main',
      treeSha: 't'.repeat(40),
      commitSha: 'a'.repeat(40),
      ref: 'refs/heads/main',
    })),
    ...overrides,
  } as unknown as GitHubAppClient;
}

describe('GitHubPublisher token split', () => {
  it('creates a personal repository with the user-to-server token and pushes with the installation token', async () => {
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const client = mockClient();
    const resolveUserAccessToken = vi.fn(async () => 'ghu_user-token');
    const publisher = new GitHubPublisher({ client, github, store, resolveUserAccessToken });

    await publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash });

    expect(resolveUserAccessToken).toHaveBeenCalledWith(owner.principalId);
    expect(client.createUserRepository).toHaveBeenCalledWith(
      'ghu_user-token',
      expect.objectContaining({ name: 'weather-lab', private: true })
    );
    expect(client.createOrganisationRepository).not.toHaveBeenCalled();
    expect(client.publishInitialCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'ghs_install-token',
        // The manifest's recorded mode reaches the publish call: an
        // executable script must not land as a plain 100644 file.
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'run.sh', mode: '100755' }),
          expect.objectContaining({ path: 'index.html', mode: '100644' }),
        ]),
      })
    );
  });

  it('creates an organisation repository with the installation token and never asks for a user token', async () => {
    const owner = actor('Org');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'Organization', 'atoma-org');
    const client = mockClient();
    const resolveUserAccessToken = vi.fn(async () => {
      throw new Error('user token must not be used for organisation repositories');
    });
    const publisher = new GitHubPublisher({ client, github, store, resolveUserAccessToken });

    await publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash });

    expect(resolveUserAccessToken).not.toHaveBeenCalled();
    expect(client.createOrganisationRepository).toHaveBeenCalledWith(
      'ghs_install-token',
      'atoma-org',
      expect.objectContaining({ name: 'weather-lab' })
    );
    expect(client.createUserRepository).not.toHaveBeenCalled();
  });

  it('treats HTTP 422 as an existing repository and looks it up with the create token', async () => {
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const existing = repository('alice', 'weather-lab');
    const client = mockClient({
      createUserRepository: vi.fn(async () => {
        throw apiError(422, '/user/repos');
      }),
      getRepository: vi.fn(async () => existing),
    });
    const publisher = new GitHubPublisher({
      client,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });

    const publication = await publisher.publish({
      project,
      run,
      workspaceRoot: workspace,
      manifestHash: hash,
    });

    expect(client.getRepository).toHaveBeenCalledWith('ghu_user-token', 'alice', 'weather-lab');
    expect(publication?.repositoryId).toBe(existing.id);
  });

  it('refuses the 422 idempotent path when the existing repository has the wrong visibility', async () => {
    // The defect this pins: a project targeting a PRIVATE repository landed
    // its artifacts in a pre-existing PUBLIC repository of the same name —
    // the idempotent lookup never compared visibility to the target.
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const client = mockClient({
      createUserRepository: vi.fn(async () => {
        throw apiError(422, '/user/repos');
      }),
      getRepository: vi.fn(async () => ({
        ...repository('alice', 'weather-lab'),
        private: false,
      })),
    });
    const publisher = new GitHubPublisher({
      client,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });

    await expect(
      publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow(/public while the project targets a private repository/);
    expect(client.publishInitialCommit).not.toHaveBeenCalled();
    // The failure is recorded and the publication stays retryable.
    const publication = store.getPublicationForRun(owner.orgId, run.projectRunId)!;
    expect(publication.status).toBe('failed');
  });

  it('records the repository failure on the project row, not only on the publication', async () => {
    // The defect this pins: a repository that could not be created left the
    // project at `creating` with a NULL error — for ever, and
    // indistinguishable from a publish still in flight, sitting above a green
    // `delivered` run. `failed` was reachable only from a test.
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const client = mockClient({
      createUserRepository: vi.fn(async () => {
        throw apiError(403, '/user/repos');
      }),
    });
    const publisher = new GitHubPublisher({
      client,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });

    await expect(
      publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow();

    const after = store.getProject(owner.orgId, project.projectId)!;
    expect(after.repositoryStatus).toBe('failed');
    expect(after.repositoryError).toBeTruthy();
    // And it stays retryable: failed → creating is an allowed transition, so
    // the next publish attempt can still converge.
    expect(store.getPublicationForRun(owner.orgId, run.projectRunId)!.status).toBe('failed');
  });

  it('publishes into a ready repository without asking GitHub to create it again', async () => {
    // The defect this pins: a first attempt that CREATED the repository and
    // then failed its commit left the row at `ready`, which is terminal — so
    // every retry called createUserRepository again and then failed its own
    // compare-and-set. The retry could never succeed, and a tenant who had
    // renamed the repository on GitHub got a second one.
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const failingCommit = mockClient({
      publishInitialCommit: vi.fn(async () => {
        throw apiError(500, '/repos/alice/weather-lab/git/commits');
      }),
    });
    const first = new GitHubPublisher({
      client: failingCommit,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    await expect(
      first.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow();
    // The repository exists, so its row is ready — and stays ready.
    const afterFirst = store.getProject(owner.orgId, project.projectId)!;
    expect(afterFirst.repositoryStatus).toBe('ready');
    expect(failingCommit.createUserRepository).toHaveBeenCalledTimes(1);

    const second = mockClient();
    const retry = new GitHubPublisher({
      client: second,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    const published = await retry.publish({
      project,
      run,
      workspaceRoot: workspace,
      manifestHash: hash,
    });
    expect(published?.status).toBe('published');
    // Not once: the row already held the identity.
    expect(second.createUserRepository).not.toHaveBeenCalled();
    expect(second.publishInitialCommit).toHaveBeenCalledTimes(1);
  });

  it('says what is known when a 422 is not a name collision', async () => {
    // 422 is both "the name is taken" and "this account refuses to create
    // that repository", and GitHubApiError carries no body to tell them
    // apart. Asserting the first would tell an operator something
    // affirmatively false about their own account — on the very path a
    // public/private choice opens.
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const client = mockClient({
      createUserRepository: vi.fn(async () => {
        throw apiError(422, '/user/repos');
      }),
      getRepository: vi.fn(async () => null),
    });
    const publisher = new GitHubPublisher({
      client,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });

    await expect(
      publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow(/refused \(HTTP 422\)/);
    await expect(
      publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow(/may not allow creating a private repository/);
  });
});

describe('coordinator publication retry', () => {
  it('re-drives a failed publication to published without creating a second repository', async () => {
    const owner = actor('Alice');
    const { project, run, workspace } = await deliveredRun(owner, 'User', 'alice');
    const hash = run.artifactManifestHash!;

    // First attempt: GitHub is down. The publication lands in 'failed'.
    const downClient = mockClient({
      createUserRepository: vi.fn(async () => {
        throw apiError(500, '/user/repos');
      }),
    });
    const failing = new GitHubPublisher({
      client: downClient,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    await expect(
      failing.publish({ project, run, workspaceRoot: workspace, manifestHash: hash })
    ).rejects.toThrow();
    expect(store.getPublicationForRun(owner.orgId, run.projectRunId)!.status).toBe('failed');

    // Retry through the coordinator surface: same publication row is
    // re-driven, one repository created, and a second retry is a no-op.
    const upClient = mockClient();
    const publisher = new GitHubPublisher({
      client: upClient,
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    const coordinator = new ProjectRunCoordinator({
      store,
      dbPath: join(root, 'product.db'),
      projectsRoot: join(root, 'projects-root'),
      publisher,
    });
    const retried = await coordinator.retryPublication(owner.orgId, run.projectRunId);
    expect(retried?.projectRunId).toBe(run.projectRunId);
    const published = store.getPublicationForRun(owner.orgId, run.projectRunId)!;
    expect(published.status).toBe('published');
    expect(upClient.createUserRepository).toHaveBeenCalledTimes(1);

    await coordinator.retryPublication(owner.orgId, run.projectRunId);
    expect(upClient.createUserRepository).toHaveBeenCalledTimes(1);
    expect(upClient.publishInitialCommit).toHaveBeenCalledTimes(1);
  });

  it('refuses a retry without a configured publisher or a delivered run', async () => {
    const owner = actor('Alice');
    const { project, run } = await deliveredRun(owner, 'User', 'alice');
    void project;
    const bare = new ProjectRunCoordinator({
      store,
      dbPath: join(root, 'product.db'),
      projectsRoot: join(root, 'projects-root'),
    });
    await expect(bare.retryPublication(owner.orgId, run.projectRunId)).rejects.toThrow(
      /GitHub App is not configured/
    );

    const publisher = new GitHubPublisher({
      client: mockClient(),
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    const coordinator = new ProjectRunCoordinator({
      store,
      dbPath: join(root, 'product.db'),
      projectsRoot: join(root, 'projects-root'),
      publisher,
    });
    // Unknown run → null; a run outside this org is invisible the same way.
    await expect(coordinator.retryPublication(owner.orgId, randomUUID())).resolves.toBeNull();
  });
});
