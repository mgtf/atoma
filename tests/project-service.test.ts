import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_TABLES_DDL, type Viewer } from '../src/auth/store.js';
import { GitHubStore } from '../src/github/store.js';
import type { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { ProjectHttpError, ProjectService } from '../src/projects/service.js';
import { ProjectRunConfigurationError } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';

let db: Database.Database;
let projects: ProjectStore;
let github: GitHubStore;
let alice: Viewer;
let bob: Viewer;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db);
  github = new GitHubStore(db);
  alice = principal('Alice', 'org:owner');
  bob = principal('Bob', 'org:owner');
});

afterEach(() => {
  db.close();
});

function principal(label: string, role: Viewer['role']): Viewer {
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
     VALUES (?, ?, ?, ?)`
  ).run(orgId, principalId, role, now);
  return {
    principalId,
    displayName: label,
    kind: 'human',
    orgId,
    orgName: `${label} Org`,
    role,
    platformAdmin: false,
    displayNameSource: 'provider',
  };
}

function jsonReq(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  stream.headers = { 'content-type': 'application/json' };
  stream.method = 'POST';
  return stream;
}

function linkInstallation(owner: Viewer, installationId: string, login: string) {
  github.linkInstallation({
    installationId,
    orgId: owner.orgId,
    accountId: installationId,
    accountLogin: login,
    targetType: 'Organization',
    repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    connectedByPrincipalId: owner.principalId,
  });
}

function payload(installationId: string, slug = 'weather-lab') {
  return {
    name: 'Weather Lab',
    slug,
    initialPrompt: 'Build a small weather dashboard in index.html.',
    repositoryTarget: {
      installationId,
      owner: 'atoma-org',
      name: slug,
      visibility: 'private' as const,
    },
  };
}

function service(): {
  svc: ProjectService;
  start: ReturnType<typeof vi.fn>;
  retryPublication: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async (input: {
    orgId: string;
    projectId: string;
    principalId: string;
    request: { idempotencyKey: string };
  }) => {
    if (!projects.getProject(input.orgId, input.projectId)) {
      throw new Error('project not found');
    }
    throw new Error('unexpected launch');
  });
  const retryPublication = vi.fn();
  const svc = new ProjectService({
    store: projects,
    github,
    coordinator: { start, cancel: vi.fn(), retryPublication } as unknown as ProjectRunCoordinator,
  });
  return { svc, start, retryPublication };
}

describe('ProjectService — roles, IDOR and slug identity', () => {
  it('lets org:member create a project against an installation in their org', async () => {
    const member = principal('Member', 'org:member');
    linkInstallation(member, '501', 'member-org');
    const { svc } = service();
    const created = await svc.createProject(jsonReq(payload('501')), member) as {
      projectId: string;
      slug: string;
    };
    expect(created.slug).toBe('weather-lab');
    expect(projects.getProject(member.orgId, created.projectId)?.slug).toBe('weather-lab');
  });

  it('refuses org:viewer writes while still listing the org corpus', async () => {
    const viewer = principal('Viewer', 'org:viewer');
    linkInstallation(viewer, '501', 'viewer-org');
    const { svc } = service();
    await expect(svc.createProject(jsonReq(payload('501')), viewer)).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<ProjectHttpError>);
    await expect(
      svc.startProjectRun(jsonReq({ idempotencyKey: 'run-1', goal: 'Build a dashboard.' }), viewer, randomUUID())
    ).rejects.toMatchObject({ status: 403 } satisfies Partial<ProjectHttpError>);
    expect(svc.listProjects(viewer)).toEqual([]);
  });

  it('refuses a repository target whose installation belongs to another org', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc } = service();
    await expect(svc.createProject(jsonReq(payload('501')), bob)).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<ProjectHttpError>);
  });

  it('conflicts on a duplicate slug inside one org and isolates the other org', async () => {
    linkInstallation(alice, '501', 'alice-org');
    linkInstallation(bob, '502', 'bob-org');
    const { svc } = service();
    await svc.createProject(jsonReq(payload('501')), alice);
    await expect(svc.createProject(jsonReq(payload('501')), alice)).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<ProjectHttpError>);
    await expect(svc.createProject(jsonReq(payload('502', 'weather-lab')), bob)).resolves.toMatchObject({
      slug: 'weather-lab',
    });
    expect(svc.listProjects(bob)).toHaveLength(1);
    expect(svc.listProjects(alice)).toHaveLength(1);
  });

  it('lists only the active organisation\'s installations', () => {
    linkInstallation(alice, '501', 'alice-org');
    linkInstallation(bob, '502', 'bob-org');
    const { svc } = service();
    expect(svc.listInstallations(alice)).toEqual([
      expect.objectContaining({ installationId: '501', accountLogin: 'alice-org' }),
    ]);
    expect(svc.listInstallations(bob)).toEqual([
      expect.objectContaining({ installationId: '502', accountLogin: 'bob-org' }),
    ]);
  });

  it('hides another organisation\'s project as 404 on run reads and starts', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    expect(() => svc.listProjectRuns(bob, created.projectId)).toThrow(ProjectHttpError);
    try {
      svc.listProjectRuns(bob, created.projectId);
    } catch (error) {
      expect(error).toMatchObject({ status: 404 });
    }
    await expect(
      svc.startProjectRun(jsonReq({ idempotencyKey: 'run-1', goal: 'Build a dashboard.' }), bob, created.projectId)
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ProjectHttpError>);
  });

  it('projects a started run without host filesystem paths', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc, start } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    const reserved = projects.createProjectRun({
      orgId: alice.orgId,
      projectId: created.projectId,
      principalId: alice.principalId,
      request: { idempotencyKey: 'run-1', goal: 'Build a dashboard.' },
      projectRunId: randomUUID(),
      hostPaths: {
        workspacePath: '/secret/workspaces/run',
        runsPath: '/secret/runs/run',
        logPath: '/secret/logs/run.log',
      },
    });
    expect(reserved?.run.hostPaths.workspacePath).toBe('/secret/workspaces/run');
    start.mockResolvedValue(reserved!.run);
    const result = await svc.startProjectRun(
      jsonReq({ idempotencyKey: 'run-1', goal: 'Build a dashboard.' }),
      alice,
      created.projectId
    );
    expect(result).not.toHaveProperty('hostPaths');
    expect(JSON.stringify(result)).not.toContain('/secret/');
    expect(result).toMatchObject({
      projectRunId: reserved!.run.projectRunId,
      goal: 'Build a dashboard.',
      status: 'queued',
      costUsd: null,
      publication: null,
    });
    const listed = svc.listProjectRuns(alice, created.projectId) as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('hostPaths');
    expect(listed[0]?.['projectRunId']).toBe(reserved!.run.projectRunId);
    expect(listed[0]?.['traceId']).toBeNull();
    expect(svc.listProjects(alice)).toEqual([
      expect.objectContaining({
        projectId: created.projectId,
        runCount: 1,
        lastRunAt: reserved!.run.createdAt,
      }),
    ]);
  });

  it('projects the per-tier models a run was resolved to, from its payer ledger', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    const reserved = projects.createProjectRun({
      orgId: alice.orgId,
      projectId: created.projectId,
      principalId: alice.principalId,
      request: { idempotencyKey: 'run-models', goal: 'Build a dashboard.' },
      projectRunId: randomUUID(),
      hostPaths: { workspacePath: '/w', runsPath: '/r', logPath: '/l.log' },
    })!;
    const runId = reserved.run.projectRunId;
    // Queued: nothing resolved yet, and a run from before the ledger reads the same.
    expect(svc.projectRunStatus(alice, created.projectId, runId)).toMatchObject({ models: null });
    const payers = {
      l1: { selection: 'api:zai:glm-4.5-air', provider: 'zai-api', payer: 'org-key', source: 'org' },
      l2: { selection: 'sub:anthropic:sonnet', provider: 'claude-cli', payer: 'host-subscription', source: 'account' },
      l3: { selection: 'api:anthropic:claude-opus-5', provider: 'anthropic-api', payer: 'host-key', source: 'host' },
    } as const;
    projects.startProjectRun({ orgId: alice.orgId, projectRunId: runId, payers });
    expect(svc.projectRunStatus(alice, created.projectId, runId)).toMatchObject({ models: payers });
    const listed = svc.listProjectRuns(alice, created.projectId) as Record<string, unknown>[];
    expect(listed[0]?.['models']).toEqual(payers);
  });

  it.each([
    ['delivered', '2026-09-12T10:35:14.096Z', '2026-09-12T11:00:43.190Z', 1529.094],
    ['failed', '2026-09-12T09:36:42.766Z', '2026-09-12T10:05:17.691Z', 1714.925],
    ['cancelled', '2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.000Z', 0],
    ['failed', null, '2026-09-12T10:00:00.000Z', null],
    ['queued', null, null, null],
    ['running', '2026-09-12T10:00:00.000Z', null, null],
    ['failed', '2026-09-12T10:00:01.000Z', '2026-09-12T10:00:00.000Z', null],
  ])('reports persisted elapsed time for %s runs (%s → %s)', async (status, startedAt, endedAt, durationS) => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    const runId = randomUUID();
    projects.createProjectRun({
      orgId: alice.orgId,
      projectId: created.projectId,
      principalId: alice.principalId,
      projectRunId: runId,
      request: { idempotencyKey: 'duration', goal: 'Read persisted duration' },
      hostPaths: { workspacePath: '/absent/workspace', runsPath: '/absent/traces', logPath: '/absent/run.log' },
    });
    // Historical rows, including failures before launch, must work without traces.
    db.prepare('UPDATE project_runs SET status = ?, started_at = ?, ended_at = ? WHERE project_run_id = ?')
      .run(status, startedAt, endedAt, runId);
    expect(svc.listProjectRuns(alice, created.projectId)).toEqual([
      expect.objectContaining({ projectRunId: runId, status, durationS }),
    ]);
    expect(svc.projectRunStatus(alice, created.projectId, runId)).toMatchObject({
      projectRunId: runId, status, durationS,
    });
  });

  it.each(['direct', 'pull-request', 'legacy', 'failed', 'publishing'] as const)(
    'exposes an honest %s publication receipt through both run readers', async kind => {
      linkInstallation(alice, '501', 'alice-org');
      const { svc } = service();
      const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
      const runId = randomUUID();
      projects.createProjectRun({ orgId: alice.orgId, projectId: created.projectId,
        principalId: alice.principalId, projectRunId: runId,
        request: { idempotencyKey: 'receipt', goal: 'Read publication receipt' },
        hostPaths: { workspacePath: '/absent/workspace', runsPath: '/absent/traces', logPath: '/absent/log' } });
      const published = !['failed', 'publishing'].includes(kind);
      const git = kind === 'direct' || kind === 'pull-request' ? {
        branch: kind === 'direct' ? 'release' : 'atoma/run-example',
        baseBranch: 'release', defaultBranch: 'release', mode: kind, publishKind: 'extended',
      } : null;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO project_publications
        (publication_id, project_run_id, org_id, idempotency_key, manifest_hash, status,
         repository_id, repository_full_name, repository_url, commit_sha, base_sha, git_json,
         pull_request_url, error, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), runId, alice.orgId, 'receipt', 'a'.repeat(64), published ? 'published' : kind,
          '777', 'owner/app', 'https://github.com/owner/app', published ? 'b'.repeat(40) : null,
          null, git ? JSON.stringify(git) : null,
          kind === 'pull-request' ? 'https://github.com/owner/app/pull/1' : null,
          kind === 'failed' ? 'Branch diverged' : null, now, now, published ? now : null);
      const expected = { status: published ? 'published' : kind, repositoryFullName: 'owner/app',
        git, remoteState: 'not-checked', mergeStatus: kind === 'direct' ? 'not-applicable' : 'unknown',
        error: kind === 'failed' ? 'Branch diverged' : null, publishedAt: published ? now : null, updatedAt: now };
      expect(svc.projectRunStatus(alice, created.projectId, runId)).toMatchObject({ publication: expected });
      expect(svc.listProjectRuns(alice, created.projectId)).toEqual([expect.objectContaining({ publication: expect.objectContaining(expected) })]);
      expect(() => svc.projectRunStatus(bob, created.projectId, runId)).toThrow(ProjectHttpError);
    });

  it('exposes the project-run id as traceId once the trace file exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-project-service-trace-'));
    try {
      linkInstallation(alice, '501', 'alice-org');
      const { svc } = service();
      const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
      const runsPath = join(root, 'runs');
      mkdirSync(runsPath, { recursive: true });
      const reserved = projects.createProjectRun({
        orgId: alice.orgId,
        projectId: created.projectId,
        principalId: alice.principalId,
        request: { idempotencyKey: 'run-trace', goal: 'Build a dashboard.' },
        projectRunId: randomUUID(),
        hostPaths: {
          workspacePath: join(root, 'workspace'),
          runsPath,
          logPath: join(root, 'run.log'),
        },
      });
      writeFileSync(
        join(runsPath, `${reserved!.run.projectRunId}.json`),
        JSON.stringify({
          id: reserved!.run.projectRunId,
          label: 'project run',
          startedAt: '2026-08-20T00:00:00.000Z',
        })
      );
      const listed = svc.listProjectRuns(alice, created.projectId) as Record<string, unknown>[];
      expect(listed[0]?.['traceId']).toBe(reserved!.run.projectRunId);
      expect(JSON.stringify(listed[0])).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards an approved acceptance list and refuses a malformed one with 400 before the coordinator', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc, start } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    start.mockResolvedValue({ projectRunId: randomUUID(), status: 'queued' });
    const acceptanceChecklist = [{ behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } }];
    await svc.startProjectRun(jsonReq({ idempotencyKey: 'run-1', goal: 'Build a notes API.', acceptanceChecklist }), alice, created.projectId)
      .catch(() => undefined);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ request: { acceptanceChecklist } });
    start.mockClear();
    await expect(svc.startProjectRun(jsonReq({ idempotencyKey: 'run-2', goal: 'Build a notes API.',
      acceptanceChecklist: [{ behaviour: 'lists notes', check: { kind: 'http', method: 'FETCH', path: '/api/notes' } }] }),
    alice, created.projectId)).rejects.toMatchObject({ status: 400 } satisfies Partial<ProjectHttpError>);
    expect(start).not.toHaveBeenCalled();
  });

  it('maps a project-run configuration error to 400', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc, start } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    start.mockRejectedValue(
      new ProjectRunConfigurationError(
        'project runs require an anthropic credential: ANTHROPIC_API_KEY on the host, or this ' +
          "organisation's own anthropic provider key"
      )
    );
    await expect(
      svc.startProjectRun(
        jsonReq({ idempotencyKey: 'run-1', goal: 'Build a dashboard.' }),
        alice,
        created.projectId
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/ANTHROPIC_API_KEY/),
    } satisfies Partial<ProjectHttpError>);
  });

  it('binds publication retry to the project in the path and to org:member or above', async () => {
    linkInstallation(alice, '501', 'alice-org');
    const { svc, retryPublication } = service();
    const created = await svc.createProject(jsonReq(payload('501')), alice) as { projectId: string };
    const other = await svc.createProject(jsonReq(payload('501', 'other-lab')), alice) as {
      projectId: string;
    };
    const reserved = projects.createProjectRun({
      orgId: alice.orgId,
      projectId: created.projectId,
      principalId: alice.principalId,
      request: { idempotencyKey: 'run-retry', goal: 'Build a dashboard.' },
      projectRunId: randomUUID(),
      hostPaths: {
        workspacePath: '/secret/workspaces/run',
        runsPath: '/secret/runs/run',
        logPath: '/secret/logs/run.log',
      },
    })!;

    const viewer = { ...alice, role: 'org:viewer' as const };
    await expect(
      svc.retryPublication(viewer, created.projectId, reserved.run.projectRunId)
    ).rejects.toMatchObject({ status: 403 });

    // The run exists in the org, but under ANOTHER project: the REST
    // hierarchy must not lie (unlike the cancel route's looser lookup).
    await expect(
      svc.retryPublication(alice, other.projectId, reserved.run.projectRunId)
    ).rejects.toMatchObject({ status: 404 });
    expect(retryPublication).not.toHaveBeenCalled();

    retryPublication.mockResolvedValue(reserved.run);
    const result = await svc.retryPublication(
      alice,
      created.projectId,
      reserved.run.projectRunId
    );
    expect(retryPublication).toHaveBeenCalledWith(alice.orgId, reserved.run.projectRunId);
    expect(result).not.toHaveProperty('hostPaths');
    expect(JSON.stringify(result)).not.toContain('/secret/');

    // Cancel binds the same way: the run under ANOTHER project of the same
    // org is a 404 through that project's path.
    await expect(
      svc.cancelProjectRun(alice, other.projectId, reserved.run.projectRunId)
    ).rejects.toMatchObject({ status: 404 });
  });
});
