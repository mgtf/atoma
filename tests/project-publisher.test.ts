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
  const built = buildArtifactManifest({
    workspaceRoot: workspace,
    declaredPaths: ['index.html'],
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
      expect.objectContaining({ token: 'ghs_install-token' })
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
});
