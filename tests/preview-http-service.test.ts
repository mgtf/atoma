import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import type { Viewer } from '../src/auth/store.js';
import { ProjectHttpError } from '../src/projects/service.js';
import { ProjectStore } from '../src/projects/store.js';
import { PreviewStore } from '../src/preview/store.js';
import { PREVIEW_GRANT_TTL_MS, PreviewClaimRegistry } from '../src/preview/claims.js';
import { PreviewRouteTable } from '../src/preview/gatewayServer.js';
import { PreviewManager } from '../src/preview/manager.js';
import { PreviewHttpService } from '../src/preview/httpService.js';
import { recordDeliveredPreview } from '../src/preview/service.js';
import type { PreviewConfig } from '../src/preview/config.js';
import type {
  ContainerLauncher,
  LauncherFamily,
  LauncherNetworkHandle,
  LauncherNetworkSpec,
  LauncherOwnerId,
  LauncherUnitHandle,
  LauncherUnitKind,
  LauncherUnitSpec,
  LauncherUnitSummary,
  LauncherWorkspaceHandle,
} from '../src/contracts/launcher.js';

/**
 * WHO MAY ASK, AND WHAT AN ANSWER MEANS.
 *
 * These are the boundary tests for the preview's HTTP semantics: a read that
 * allocates nothing, a write bound to the viewer's active organisation, and a
 * run bound to the project named in the path. The IDOR cases are the point —
 * a preview reachable through another project's path would make the REST
 * hierarchy a lie.
 */

const config: PreviewConfig = {
  domain: 'previews.example.net',
  gatewayHost: '127.0.0.1',
  gatewayPort: 0,
  publicScheme: 'https',
  publicPort: null,
  image: `atoma-preview@sha256:${'a'.repeat(64)}`,
  runtime: 'runsc',
  maxGlobal: 4,
  maxPerOrg: 2,
  idleMs: 900_000,
  hardMs: 7_200_000,
  copyMaxBytes: 536_870_912,
};

class WorkspaceOnlyLauncher implements ContainerLauncher {
  constructor(private readonly rootDir: string) {}
  networkName(spec: LauncherNetworkSpec): string {
    return `net-${spec.kind}-${spec.ownerId}`;
  }
  unitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string {
    return `${kind}-${ownerId}`;
  }
  async purgeOwner(_family: LauncherFamily, _ownerId: LauncherOwnerId): Promise<void> {}
  armHardExitCleanup(): void {}
  disarmHardExitCleanup(): void {}
  async createWorkspace(ownerId: LauncherOwnerId): Promise<LauncherWorkspaceHandle> {
    const hostPath = join(this.rootDir, ownerId.replace(/[^A-Za-z0-9_.-]/g, '-'));
    rmSync(hostPath, { recursive: true, force: true });
    mkdirSync(hostPath, { recursive: true });
    return { ownerId, id: ownerId, hostPath };
  }
  async removeWorkspace(handle: LauncherWorkspaceHandle): Promise<void> {
    rmSync(join(this.rootDir, handle.ownerId.replace(/[^A-Za-z0-9_.-]/g, '-')), {
      recursive: true,
      force: true,
    });
  }
  async createNetwork(spec: LauncherNetworkSpec): Promise<LauncherNetworkHandle> {
    return { ...spec, name: this.networkName(spec) };
  }
  async removeNetwork(): Promise<boolean> {
    return true;
  }
  async startUnit(spec: LauncherUnitSpec): Promise<LauncherUnitHandle> {
    return { kind: spec.kind, ownerId: spec.ownerId, name: this.unitName(spec.kind, spec.ownerId) };
  }
  async awaitUnitReady(): Promise<void> {}
  async stopUnit(): Promise<void> {}
  async listUnits(): Promise<LauncherUnitSummary[]> {
    return [];
  }
  async reconcileOrphans(): Promise<number> {
    return 0;
  }
}

let root: string;
let db: Database.Database;
let projects: ProjectStore;
let previews: PreviewStore;
let service: PreviewHttpService;
// A fake clock, so the grant's five minutes are asserted rather than slept.
let claims: PreviewClaimRegistry;
let claimsNow = 1_000;
let manager: PreviewManager;
const workspaces = new Map<string, string>();

interface Actor {
  readonly orgId: string;
  readonly principalId: string;
}

function actor(label: string): Actor {
  const orgId = randomUUID();
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)').run(
    orgId,
    `Org ${label}`,
    now
  );
  db.prepare(
    `INSERT INTO auth_principals (principal_id, kind, display_name, created_at)
     VALUES (?, 'human', ?, ?)`
  ).run(principalId, `User ${label}`, now);
  db.prepare(
    `INSERT INTO auth_memberships (org_id, principal_id, role, created_at)
     VALUES (?, ?, 'org:owner', ?)`
  ).run(orgId, principalId, now);
  return { orgId, principalId };
}

function viewerFor(a: Actor, role: Viewer['role'] = 'org:owner'): Viewer {
  return {
    principalId: a.principalId,
    displayName: 'Member',
    kind: 'human',
    orgId: a.orgId,
    orgName: 'Org',
    role,
    platformAdmin: false,
    displayNameSource: 'provider',
  };
}

function seedProject(a: Actor, slug: string): string {
  return projects.createProject({
    orgId: a.orgId,
    principalId: a.principalId,
    project: {
      name: slug,
      slug,
      initialPrompt: '',
      family: 'build',
      repositoryTarget: { installationId: '1', owner: 'acme', name: slug, visibility: 'private' },
    },
  }).projectId;
}

function seedDeliveredRun(a: Actor, projectId: string, key: string): string {
  const workspace = join(root, `ws-${key}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), '<h1>artifact</h1>');
  const run = projects.createProjectRun({
    orgId: a.orgId,
    projectId,
    principalId: a.principalId,
    request: { goal: 'build', idempotencyKey: key },
    hostPaths: {
      workspacePath: workspace,
      runsPath: join(root, 'traces'),
      logPath: join(root, 'run.log'),
    },
  })!.run;
  workspaces.set(run.projectRunId, workspace);
  recordDeliveredPreview(previews, {
    orgId: a.orgId,
    projectId,
    projectRunId: run.projectRunId,
    workspaceRoot: workspace,
  });
  return run.projectRunId;
}

/** A run still going: a workspace being written, and NO descriptor. */
function seedRunningRun(a: Actor, projectId: string, key: string): string {
  const workspace = join(root, `ws-${key}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), '<h1>half built</h1>');
  const run = projects.createProjectRun({
    orgId: a.orgId,
    projectId,
    principalId: a.principalId,
    request: { goal: 'build', idempotencyKey: key },
    hostPaths: {
      workspacePath: workspace,
      runsPath: join(root, 'traces'),
      logPath: join(root, 'run.log'),
    },
  })!.run;
  workspaces.set(run.projectRunId, workspace);
  // A run is `queued` when it is created and `running` once the host starts
  // it. Only the second has anything to snapshot.
  projects.transitionProjectRun({
    orgId: a.orgId,
    projectRunId: run.projectRunId,
    from: 'queued',
    to: 'running',
  });
  return run.projectRunId;
}

beforeEach(() => {
  workspaces.clear();
  claimsNow = 1_000;
  claims = new PreviewClaimRegistry(() => claimsNow);
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-http-'));
  db = new Database(join(root, 'product.db'));
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db);
  previews = new PreviewStore(db);
  manager = new PreviewManager({
    store: previews,
    launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
    routes: new PreviewRouteTable(),
    claims,
    config,
    // The host owns this mapping; the test records what it seeded.
    workspaceOf: (_o, _p, runId) => workspaces.get(runId) ?? join(root, 'absent'),
    probe: async () => true,
    log: () => undefined,
  });
  service = new PreviewHttpService({ manager, store: previews, projects });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function status(error: unknown): number {
  return error instanceof ProjectHttpError ? error.status : 0;
}

describe('preview reads allocate nothing', () => {
  it('lets a viewer see the state without starting anything', () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');

    const summary = service.status(viewerFor(alice, 'org:viewer'), projectId, runId);

    expect(summary.availability).toBe('available');
    expect(summary.state).toBe('stopped');
    // The decisive assertion: reading created no instance row.
    expect(previews.getInstance(alice.orgId, runId)).toBeNull();
  });

  it('refuses a viewer that tries to open one', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');

    const error = await service
      .open(viewerFor(alice, 'org:viewer'), projectId, runId)
      .catch((e: unknown) => e);

    expect(status(error)).toBe(403);
    expect(previews.getInstance(alice.orgId, runId)).toBeNull();
  });
});

describe('preview writes are bound to the path and the organisation', () => {
  it('answers 404 for a run of another organisation', async () => {
    const alice = actor('alice');
    const bob = actor('bob');
    const aliceProject = seedProject(alice, 'site');
    const aliceRun = seedDeliveredRun(alice, aliceProject, 'k1');
    const bobProject = seedProject(bob, 'other');

    // Bob asks for Alice's run, through his own project's path.
    const error = await service
      .open(viewerFor(bob), bobProject, aliceRun)
      .catch((e: unknown) => e);
    expect(status(error)).toBe(404);
    expect(() => service.status(viewerFor(bob), bobProject, aliceRun)).toThrow(ProjectHttpError);
  });

  it('answers 404 for a run under a DIFFERENT project of the same organisation', async () => {
    // The REST hierarchy is a claim about containment; a run reachable through
    // another project's path would make it a lie.
    const alice = actor('alice');
    const site = seedProject(alice, 'site');
    const other = seedProject(alice, 'other');
    const runId = seedDeliveredRun(alice, site, 'k1');

    const error = await service.open(viewerFor(alice), other, runId).catch((e: unknown) => e);
    expect(status(error)).toBe(404);
  });
});

describe('preview open semantics', () => {
  it('returns a claim URL once, and a fresh one on every later open', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');

    const first = await service.open(viewerFor(alice), projectId, runId);
    expect(first.status).toBe(200);
    expect(first.body.url).toContain('/#');

    const second = await service.open(viewerFor(alice), projectId, runId);
    expect(second.body.summary.generation).toBe(first.body.summary.generation);
    // "Open in a new tab" must never copy a stale bearer.
    expect(second.body.url).not.toBe(first.body.url);
  });

  it('reports a run with nothing to preview as a conflict, not a failure', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const workspace = join(root, 'ws-cli');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'notes.md'), '# nothing runnable');
    const run = projects.createProjectRun({
      orgId: alice.orgId,
      projectId,
      principalId: alice.principalId,
      request: { goal: 'a CLI', idempotencyKey: 'cli' },
      hostPaths: {
        workspacePath: workspace,
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;
    workspaces.set(run.projectRunId, workspace);
    recordDeliveredPreview(previews, {
      orgId: alice.orgId,
      projectId,
      projectRunId: run.projectRunId,
      workspaceRoot: workspace,
    });

    const error = await service
      .open(viewerFor(alice), projectId, run.projectRunId)
      .catch((e: unknown) => e);
    expect(status(error)).toBe(409);
  });

  it('refuses past capacity with 429 rather than evicting someone else', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runs = ['a', 'b', 'c'].map((k) => seedDeliveredRun(alice, projectId, k));

    await service.open(viewerFor(alice), projectId, runs[0]!);
    await service.open(viewerFor(alice), projectId, runs[1]!);
    const error = await service
      .open(viewerFor(alice), projectId, runs[2]!)
      .catch((e: unknown) => e);

    expect(status(error)).toBe(429);
    expect(previews.countLiveInstances(alice.orgId).org).toBe(2);
  });

  it('mints a new generation on restart', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');

    const first = await service.open(viewerFor(alice), projectId, runId);
    const restarted = await service.restart(viewerFor(alice), projectId, runId);

    expect(restarted.body.summary.generation).toBe(first.body.summary.generation + 1);
  });
});

describe('preview heartbeat', () => {
  it('extends the live generation and tolerates a stale one', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');
    const opened = await service.open(viewerFor(alice), projectId, runId);
    const generation = opened.body.summary.generation;

    expect(service.heartbeat(viewerFor(alice), projectId, runId, generation).state).toBe('ready');
    // A browser one beat behind is not an error; the summary tells it so.
    expect(
      service.heartbeat(viewerFor(alice), projectId, runId, generation + 1).generation
    ).toBe(generation);
  });

  it('renews the grant the browser holds, not only the container clock', async () => {
    // THE DEFECT THIS PINS: the heartbeat extended the instance's activity and
    // nothing else, while the grant on the preview origin expired after five
    // minutes. Every viewing session was therefore capped at five minutes and
    // ended in the gateway's one generic 404 with a healthy container behind
    // it. Crossing service → manager → registry is the point: the renewal is
    // wired at the seam, and a unit test of the registry alone missed it.
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');
    const opened = await service.open(viewerFor(alice), projectId, runId);
    const generation = opened.body.summary.generation;
    const host = new URL(opened.body.url!).hostname;
    const secret = new URL(opened.body.url!).hash.slice(1);
    const redeemed = claims.redeem(secret, host);
    expect(redeemed.ok).toBe(true);
    const token = redeemed.ok ? redeemed.token : '';
    const route = { orgId: viewerFor(alice).orgId, projectRunId: runId, generation, host };

    claimsNow += PREVIEW_GRANT_TTL_MS - 1;
    service.heartbeat(viewerFor(alice), projectId, runId, generation);
    claimsNow += PREVIEW_GRANT_TTL_MS - 1;

    expect(claims.authorise(token, route)).not.toBeNull();
  });

  it('refuses a viewer', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedDeliveredRun(alice, projectId, 'k1');
    await service.open(viewerFor(alice), projectId, runId);

    expect(() => service.heartbeat(viewerFor(alice, 'org:viewer'), projectId, runId, 1)).toThrow(
      ProjectHttpError
    );
  });
});

describe('preview egress approvals', () => {
  it('is readable by a member and writable only by an admin', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');

    expect(service.listEgress(viewerFor(alice, 'org:member'), projectId)).toEqual({
      approvedHosts: [],
    });
    const error = await service
      .replaceEgress(viewerFor(alice, 'org:member'), projectId, ['api.example.com'])
      .catch((e: unknown) => e);
    expect(status(error)).toBe(403);
  });

  it('refuses a host no delivered run ever requested', async () => {
    // A standing permission nobody reviewed is worse than no permission.
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    seedDeliveredRun(alice, projectId, 'k1');

    const error = await service
      .replaceEgress(viewerFor(alice), projectId, ['api.example.com'])
      .catch((e: unknown) => e);
    expect(status(error)).toBe(400);
  });

  it('refuses a malformed host before it can be stored', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');

    for (const host of ['*.example.com', '192.168.1.5', 'localhost', 'UPPER.example.com']) {
      const error = await service
        .replaceEgress(viewerFor(alice), projectId, [host])
        .catch((e: unknown) => e);
      expect(status(error)).toBe(400);
    }
  });

  it('answers 404 for a project of another organisation', async () => {
    const alice = actor('alice');
    const bob = actor('bob');
    const aliceProject = seedProject(alice, 'site');

    expect(() => service.listEgress(viewerFor(bob), aliceProject)).toThrow(ProjectHttpError);
  });
});

describe('a run still in flight', () => {
  it('offers a preview BEFORE one exists, or the control could never appear', () => {
    // THE CHICKEN AND EGG THIS PINS: availability was read from the descriptor
    // and the instance alone, so a run that had never been previewed answered
    // `unavailable`/`legacy-run`. The client hides the control for exactly
    // that answer — so the preview could not be asked for, and therefore never
    // came to exist, and therefore stayed unavailable.
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedRunningRun(alice, projectId, 'k-live');

    const summary = service.status(viewerFor(alice), projectId, runId);

    expect(summary.availability).toBe('available');
    // Not a legacy run: the absence of a descriptor means something else here.
    expect(summary.reason).toBeNull();
    // And reading still allocated nothing.
    expect(summary.state).toBe('stopped');
    expect(summary.generation).toBe(0);
  });

  it('serves a SNAPSHOT for a running run and the DELIVERED preview for a finished one', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const live = seedRunningRun(alice, projectId, 'k-live');
    const done = seedDeliveredRun(alice, projectId, 'k-done');

    // The same request on both. `inFlight` is a willingness to accept a
    // snapshot, never an assertion about the run: the HOST decides which of
    // the two this is, from the run's own status.
    const snapshot = await service.open(viewerFor(alice), projectId, live, { inFlight: true });
    const delivered = await service.open(viewerFor(alice), projectId, done, { inFlight: true });

    expect(snapshot.body.summary.source).toBe('in-flight');
    expect(snapshot.body.summary.snapshotAt).not.toBeNull();
    // A caller asking for a snapshot of a finished run gets the delivered
    // preview instead of one that silently disagrees with the published
    // result.
    expect(delivered.body.summary.source).toBe('delivered');
    expect(delivered.body.summary.snapshotAt).toBeNull();
  });

  it('keeps the control after a stop, because the run is still going', async () => {
    const alice = actor('alice');
    const projectId = seedProject(alice, 'site');
    const runId = seedRunningRun(alice, projectId, 'k-live');
    await service.open(viewerFor(alice), projectId, runId, { inFlight: true });

    const stopped = await service.stop(viewerFor(alice), projectId, runId);

    // The manager answers about the INSTANCE it just removed and knows nothing
    // about the run; taking its word would remove the control mid-run.
    expect(stopped.state).toBe('stopped');
    expect(stopped.availability).toBe('available');
  });
});



describe('failed preview startup cleans its generation', () => {
  it.each(['delivered', 'in-flight'] as const)('removes a partially materialized %s workspace on every retry', async (mode) => {
    const a = actor('cleanup');
    const projectId = seedProject(a, 'cleanup');
    const runId = mode === 'delivered' ? seedDeliveredRun(a, projectId, 'cleanup') : seedRunningRun(a, projectId, 'cleanup');
    const limited = new PreviewManager({
      store: previews, launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes: new PreviewRouteTable(), claims, config: { ...config, copyMaxBytes: 1 },
      workspaceOf: () => workspaces.get(runId)!, probe: async () => true,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = { orgId: a.orgId, projectId, projectRunId: runId,
        opener: { principalId: a.principalId, sessionId: 's' } };
      await expect(mode === 'delivered' ? limited.open(input) : limited.openInFlight(input)).rejects.toThrow();
      expect(previews.getInstance(a.orgId, runId)?.state).toBe('failed');
      expect(existsSync(join(root, 'copies')) ? readdirSync(join(root, 'copies')) : []).toEqual([]);
    }
  });
});
