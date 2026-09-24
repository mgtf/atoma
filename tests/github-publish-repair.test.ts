import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubAppClient } from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { buildArtifactManifest } from '../src/projects/artifacts.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectStore } from '../src/projects/store.js';
import type { RunStats } from '../src/contracts/runStats.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';
import { FakeGitHub } from './github-api-fake.js';

/**
 * Two publication blockers measured on 2026-09-24
 * (docs/incidents/run-fix-loop-2026-09-24.md), both GitHub configuration and
 * neither reachable from the product before this:
 *
 * - an installation whose repository selection was NARROWED still minted
 *   tokens and read the repository, then refused the first write with a bare
 *   `HTTP 403`;
 * - seven projects were bound to an installation that no longer existed after
 *   the App was reinstalled, and nothing could move them.
 *
 * The REAL client runs against the stateful fake, which refuses writes outside
 * a selection with 403 and answers a deleted installation's token request with
 * 404, as GitHub does.
 */

let root: string;
let db: Database.Database;
let store: ProjectStore;
let github: GitHubStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-publish-repair-'));
  db = new Database(join(root, 'product.db'));
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  store = new ProjectStore(db);
  github = new GitHubStore(db);
});

afterEach(() => {
  closeStoreHandles();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const stats: RunStats = {
  outcome: 'delivered', costUsd: 0.12, llmCalls: 1, opusCalls: 1, sonnetCalls: 0, haikuCalls: 0,
  otherCalls: 0, deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingReasons: [],
  escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0, refusals: 0,
  compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0,
};

function realClient(fake: FakeGitHub): GitHubAppClient {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new GitHubAppClient(
    { appId: '123456', appSlug: 'atoma-test', privateKey, apiBaseUrl: 'https://api.github.test' },
    { fetch: fake.fetch, now: () => Date.UTC(2026, 7, 23, 12, 0, 0) }
  );
}

function organisation(): { orgId: string; principalId: string } {
  const orgId = randomUUID();
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)').run(orgId, 'Org', now);
  db.prepare(`INSERT INTO auth_principals (principal_id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
    .run(principalId, 'Alice', now);
  db.prepare(`INSERT INTO auth_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'org:owner', ?)`)
    .run(orgId, principalId, now);
  return { orgId, principalId };
}

function link(owner: { orgId: string; principalId: string }, installationId: string, accountLogin = 'alice') {
  github.linkInstallation({
    installationId, orgId: owner.orgId, accountId: `70${installationId}`, accountLogin,
    targetType: 'User', repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    connectedByPrincipalId: owner.principalId,
  });
}

function deliveredRun(owner: { orgId: string; principalId: string }, installationId: string) {
  const project = store.createProject({
    orgId: owner.orgId, principalId: owner.principalId,
    project: {
      name: 'Weather Lab', slug: 'weather-lab', initialPrompt: 'Build a weather dashboard.',
      repositoryTarget: { installationId, owner: 'alice', name: 'weather-lab', visibility: 'private' },
    },
  });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), '<h1>ok</h1>\n');
  const built = buildArtifactManifest({ workspaceRoot: workspace, declaredPaths: ['index.html'] });
  const reserved = store.createProjectRun({
    orgId: owner.orgId, projectId: project.projectId, principalId: owner.principalId,
    request: { idempotencyKey: 'publish-1', goal: 'Build a weather dashboard.' },
    hostPaths: { workspacePath: workspace, runsPath: join(root, 'runs'), logPath: join(root, 'run.log') },
  })!;
  store.transitionProjectRun({ orgId: owner.orgId, projectRunId: reserved.run.projectRunId, from: 'queued', to: 'running' });
  store.transitionProjectRun({ orgId: owner.orgId, projectRunId: reserved.run.projectRunId, from: 'running',
    to: 'delivered', traceId: 'trace-1', stats });
  const run = store.saveArtifactManifest(owner.orgId, reserved.run.projectRunId, built.manifest)!;
  return { project, run, workspace, hash: built.hash };
}

function publisherFor(fake: FakeGitHub, events: PlatformEventInput[] = []) {
  return new GitHubPublisher({
    client: realClient(fake), github, store,
    resolveUserAccessToken: async () => 'ghu_user-token',
    events: (event) => { events.push(event); },
  });
}

describe('publication pre-flight: a narrowed installation', () => {
  it('refuses before the first write with a sentence the tenant can act on, then publishes once access is granted', async () => {
    const owner = organisation();
    link(owner, '501');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });
    fake.repositorySelection = 'selected';
    const publisher = publisherFor(fake);

    await expect(publisher.publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))
      .rejects.toThrow('the GitHub App installation no longer includes alice/weather-lab: add it under Repository access at https://github.com/settings/installations/501, then retry the publication');
    // Nothing was written INTO the repository: the refusal came from a READ.
    // (Resolving a new project's repository is a creation attempt, answered
    // 422 here because it exists; the pre-flight needs the id it resolves.)
    expect(fake.calls.filter((call) => call.includes(' /repos/') && !call.startsWith('GET '))).toEqual([]);
    expect(fake.calls).toContain('GET /installation/repositories');
    expect(store.getPublicationForRun(owner.orgId, run.projectRunId)?.status).toBe('failed');

    fake.selectedRepositories.add('alice/weather-lab');
    const retried = await publisher.publish({
      project: store.getProject(owner.orgId, project.projectId)!, run, workspaceRoot: workspace, manifestHash: hash,
    });
    expect(retried?.status).toBe('published');
    expect(fake.filesOn('alice', 'weather-lab', 'main').get('index.html')?.text).toBe('<h1>ok</h1>\n');
  });

  it('asks nothing of an installation that covers all its repositories', async () => {
    const owner = organisation();
    link(owner, '501');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });
    expect((await publisherFor(fake).publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))?.status)
      .toBe('published');
    expect(fake.calls).not.toContain('GET /installation/repositories');
  });
});

describe('a project bound to an installation GitHub no longer knows', () => {
  it('records the installation deleted and moves the project to its one replacement for the same account', async () => {
    const owner = organisation();
    link(owner, '501');
    link(owner, '502');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });
    fake.deletedInstallations.add('501');
    const events: PlatformEventInput[] = [];

    const publication = await publisherFor(fake, events).publish({ project, run, workspaceRoot: workspace, manifestHash: hash });

    expect(publication?.status).toBe('published');
    expect(store.getProject(owner.orgId, project.projectId)!.repositoryTarget.installationId).toBe('502');
    expect(github.getInstallation('501')!.status).toBe('deleted');
    expect(fake.calls.filter((call) => call.includes('/access_tokens'))).toEqual([
      'POST /app/installations/501/access_tokens',
      'POST /app/installations/502/access_tokens',
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'github.installation_status', 'github.installation_linked', 'publication.published',
    ]);
    expect(events[1]!.detail).toEqual({ project: 'weather-lab', from: '501', to: '502' });
  });

  it('moves a project whose installation a webhook already marked deleted, without asking GitHub for the dead one', async () => {
    const owner = organisation();
    link(owner, '501');
    link(owner, '502');
    github.transitionInstallation('501', 'deleted');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });

    expect((await publisherFor(fake).publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))?.status)
      .toBe('published');
    expect(fake.calls.filter((call) => call.includes('/access_tokens'))).toEqual(['POST /app/installations/502/access_tokens']);
  });

  it.each([
    ['no replacement', () => {}, /reconnect GitHub for this organisation/],
    ['a replacement for another account', (owner: { orgId: string; principalId: string }) => link(owner, '502', 'bob'), /reconnect GitHub/],
    ['a suspended replacement', (owner: { orgId: string; principalId: string }) => {
      link(owner, '502'); github.transitionInstallation('502', 'suspended');
    }, /reconnect GitHub/],
    ['two replacements', (owner: { orgId: string; principalId: string }) => { link(owner, '502'); link(owner, '503'); },
      /has 2 installations for alice: the project cannot be moved automatically/],
  ] as const)('never moves a project with %s', async (_label, arrange, message) => {
    const owner = organisation();
    link(owner, '501');
    arrange(owner);
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });
    fake.deletedInstallations.add('501');

    await expect(publisherFor(fake).publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))
      .rejects.toThrow(message);
    expect(store.getProject(owner.orgId, project.projectId)!.repositoryTarget.installationId).toBe('501');
    expect(github.getInstallation('501')!.status).toBe('deleted');
  });

  it('never replaces a suspended installation', async () => {
    const owner = organisation();
    link(owner, '501');
    link(owner, '502');
    github.transitionInstallation('501', 'suspended');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });

    await expect(publisherFor(fake).publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))
      .rejects.toThrow('GitHub installation is not linked to this organisation or is inactive');
    expect(store.getProject(owner.orgId, project.projectId)!.repositoryTarget.installationId).toBe('501');
  });

  it('never borrows another organisation\'s installation of the same account', async () => {
    const owner = organisation();
    const stranger = organisation();
    link(owner, '501');
    link(stranger, '502');
    const { project, run, workspace, hash } = deliveredRun(owner, '501');
    const fake = new FakeGitHub({ existing: ['alice/weather-lab'] });
    fake.deletedInstallations.add('501');

    await expect(publisherFor(fake).publish({ project, run, workspaceRoot: workspace, manifestHash: hash }))
      .rejects.toThrow(/reconnect GitHub/);
    expect(store.getProject(owner.orgId, project.projectId)!.repositoryTarget.installationId).toBe('501');
  });
});
