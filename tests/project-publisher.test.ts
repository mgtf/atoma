import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import {
  GitHubApiError,
  GitHubAppClient,
  type GitHubRepository,
} from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { buildArtifactManifest } from '../src/projects/artifacts.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { GitHubPublisher, PublicationSupersededError } from '../src/projects/publisher.js';
import { ProjectStore } from '../src/projects/store.js';
import { FakeGitHub } from './github-api-fake.js';
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
    // A CALL-SHAPE STUB, and nothing more. It is stateless, so it cannot
    // observe a second commit, a branch that already exists, or a
    // non-fast-forward — which is exactly how both measured publication
    // defects shipped green (`src/github/AGENTS.md`). NO BEHAVIOURAL CLAIM
    // ABOUT PUBLICATION MAY REST ON IT: the tests below use it only for the
    // repository lifecycle and the token split, and every claim about what
    // reaches a branch lives in `tests/github-incremental-publish.test.ts`
    // and in the two-run case at the end of this file, both of which drive the
    // REAL client over a stateful fake GitHub.
    publishManifestCommit: vi.fn(async () => ({
      branch: 'main',
      treeSha: 't'.repeat(40),
      commitSha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      baseSha: null,
      publishKind: 'created' as const,
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
    expect(client.publishManifestCommit).toHaveBeenCalledWith(
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
    expect(client.publishManifestCommit).not.toHaveBeenCalled();
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
      publishManifestCommit: vi.fn(async () => {
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
    expect(second.publishManifestCommit).toHaveBeenCalledTimes(1);
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
    expect(upClient.publishManifestCommit).toHaveBeenCalledTimes(1);
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

/**
 * PUBLICATION IS A SEQUENCE — proven at the production boundary.
 *
 * Everything above this point drives a stateless whole-client stub, which is
 * why `src/github/AGENTS.md` records that a defect of exactly this class
 * "survived because every publisher test mocks this client". These cases drive
 * the REAL `GitHubAppClient` over a stateful fake GitHub, through the real
 * `ProjectStore` on real SQLite, so a second delivered run of one project is
 * observable at all.
 *
 * The state they invert is live: `mgtf/atoma-e2e-stopwatch-2` holds a stopwatch
 * with no lap button, because run `a06b09ff` — delivered — was refused with
 * `GitHub repository branch already exists; initial publish refused`.
 */
describe('two delivered runs of one project both reach the repository', () => {
  function realClient(fake: FakeGitHub): GitHubAppClient {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return new GitHubAppClient(
      { appId: '123456', appSlug: 'atoma-test', privateKey, apiBaseUrl: 'https://api.github.test' },
      { fetch: fake.fetch, now: () => Date.UTC(2026, 7, 23, 12, 0, 0) }
    );
  }

  /** Another delivered run of the SAME project, with its own workspace. */
  async function nextDeliveredRun(
    owner: Actor,
    projectId: string,
    key: string,
    files: Record<string, string>
  ) {
    const workspace = join(root, `workspace-${key}`);
    mkdirSync(workspace, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(workspace, name), contents);
    }
    const built = buildArtifactManifest({
      workspaceRoot: workspace,
      declaredPaths: Object.keys(files),
    });
    const reserved = store.createProjectRun({
      orgId: owner.orgId,
      projectId,
      principalId: owner.principalId,
      request: { idempotencyKey: key, goal: 'Add a lap button.' },
      hostPaths: {
        workspacePath: workspace,
        runsPath: join(root, `runs-${key}`),
        logPath: join(root, `run-${key}.log`),
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
      traceId: `trace-${key}`,
      stats: deliveredStats,
    });
    const run = store.saveArtifactManifest(owner.orgId, reserved.run.projectRunId, built.manifest)!;
    return { run, workspace, hash: built.hash };
  }

  it('commits the second run on top of the first, keeping what it did not declare', async () => {
    const owner = actor('Alice');
    const first = await deliveredRun(owner, 'User', 'alice');
    const fake = new FakeGitHub();
    const publisher = new GitHubPublisher({
      client: realClient(fake),
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });

    const one = await publisher.publish({
      project: first.project,
      run: first.run,
      workspaceRoot: first.workspace,
      manifestHash: first.hash,
    });
    expect(one?.status).toBe('published');
    expect(one?.baseSha).toBeNull();

    // Run 2 declares ONLY the file it changed, which is what a manifest is:
    // `plan.subtasks.flatMap(s => s.outputs)`, declared at plan time.
    const second = await nextDeliveredRun(owner, first.project.projectId, 'publish-2', {
      'index.html': '<h1>ok with laps</h1>\n',
    });
    const project = store.getProject(owner.orgId, first.project.projectId)!;
    const two = await publisher.publish({
      project,
      run: second.run,
      workspaceRoot: second.workspace,
      manifestHash: second.hash,
    });

    // THE INVERSION. Today this row is `failed` with the divergence sentence.
    expect(two?.status).toBe('published');
    expect(two?.commitSha).not.toBe(one?.commitSha);
    expect(two?.baseSha).toBe(one?.commitSha);

    const history = fake.historyOf('alice', 'weather-lab', 'main');
    expect(history[0]!.sha).toBe(two!.commitSha);
    expect(history[0]!.parents).toEqual([one!.commitSha]);
    const files = fake.filesOn('alice', 'weather-lab', 'main');
    expect(files.get('index.html')?.text).toBe('<h1>ok with laps</h1>\n');
    // MERGE, NOT REPLACE: run 1's executable script is untouched, at its mode.
    expect(files.get('run.sh')?.text).toBe('#!/bin/sh\necho ok\n');
    expect(files.get('run.sh')?.mode).toBe('100755');
    // And no repository was created twice.
    expect(fake.calls.filter((call) => call === 'POST /user/repos')).toHaveLength(1);
  });

  it('refuses to publish a run older than the one already published', async () => {
    const owner = actor('Alice');
    const first = await deliveredRun(owner, 'User', 'alice');
    const fake = new FakeGitHub();
    const publisher = new GitHubPublisher({
      client: realClient(fake),
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    await publisher.publish({
      project: first.project,
      run: first.run,
      workspaceRoot: first.workspace,
      manifestHash: first.hash,
    });
    const second = await nextDeliveredRun(owner, first.project.projectId, 'publish-2', {
      'index.html': '<h1>newer</h1>\n',
    });
    const project = store.getProject(owner.orgId, first.project.projectId)!;
    await publisher.publish({
      project,
      run: second.run,
      workspaceRoot: second.workspace,
      manifestHash: second.hash,
    });
    const tip = fake.refSha('alice', 'weather-lab', 'main');

    // Now retry the OLDER run. Every entry point accepts any delivered run
    // whose publication is pending or failed, so without the order gate this
    // would move the branch back to older artifacts.
    const older = await nextDeliveredRun(owner, first.project.projectId, 'publish-0', {
      'index.html': '<h1>older</h1>\n',
    });
    // `publish-0` was created last but names artifacts older in intent; the
    // gate reads run creation order, so force the comparison the other way by
    // publishing it against a project whose newest published run is later.
    await expect(
      publisher.publish({
        project,
        run: { ...older.run, createdAt: '2020-01-01T00:00:00.000Z' },
        workspaceRoot: older.workspace,
        manifestHash: older.hash,
      })
    ).rejects.toThrow(PublicationSupersededError);
    expect(fake.refSha('alice', 'weather-lab', 'main')).toBe(tip);
    expect(fake.filesOn('alice', 'weather-lab', 'main').get('index.html')?.text).toBe(
      '<h1>newer</h1>\n'
    );
  });

  it('records a re-published run with no changes as a no-op, adding no commit', async () => {
    const owner = actor('Alice');
    const first = await deliveredRun(owner, 'User', 'alice');
    const fake = new FakeGitHub();
    const publisher = new GitHubPublisher({
      client: realClient(fake),
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    });
    await publisher.publish({
      project: first.project,
      run: first.run,
      workspaceRoot: first.workspace,
      manifestHash: first.hash,
    });
    // A LATER run whose manifest is byte-identical to what is already there.
    const same = await nextDeliveredRun(owner, first.project.projectId, 'publish-same', {
      'index.html': '<h1>ok</h1>\n',
    });
    const project = store.getProject(owner.orgId, first.project.projectId)!;
    const published = await publisher.publish({
      project,
      run: same.run,
      workspaceRoot: same.workspace,
      manifestHash: same.hash,
    });
    expect(published?.status).toBe('published');
    // The commit that really holds these bytes, and no new one. Run 1 declared
    // two files, so its own publication is a seed plus one git-data commit —
    // the point is that this attempt added NEITHER.
    expect(published?.commitSha).toBe(published?.baseSha);
    const tip = fake.refSha('alice', 'weather-lab', 'main');
    expect(published?.commitSha).toBe(tip);
    expect(fake.historyOf('alice', 'weather-lab', 'main')).toHaveLength(2);
  });

  it('migrates a store created before base_sha existed', async () => {
    const owner = actor('Alice');
    const { project, run, workspace, hash } = await deliveredRun(owner, 'User', 'alice');
    const fake = new FakeGitHub();
    await new GitHubPublisher({
      client: realClient(fake),
      github,
      store,
      resolveUserAccessToken: async () => 'ghu_user-token',
    }).publish({ project, run, workspaceRoot: workspace, manifestHash: hash });

    // Simulate the pre-change schema by dropping the column from a store that
    // already holds a published row, then re-opening.
    db.exec('ALTER TABLE project_publications DROP COLUMN base_sha');
    const columnsBefore = (
      db.prepare('PRAGMA table_info(project_publications)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columnsBefore).not.toContain('base_sha');

    const reopened = new ProjectStore(db);
    const columnsAfter = (
      db.prepare('PRAGMA table_info(project_publications)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columnsAfter).toContain('base_sha');
    // NULL is factually true for a pre-existing row: every publication that
    // ever succeeded in this product created the branch.
    expect(reopened.getPublicationForRun(owner.orgId, run.projectRunId)?.baseSha).toBeNull();
    // Idempotent: opening again is a no-op, not a duplicate-column error.
    expect(() => new ProjectStore(db)).not.toThrow();
  });
});
