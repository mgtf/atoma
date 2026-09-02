import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { PreviewStore } from '../src/preview/store.js';
import { PreviewClaimRegistry } from '../src/preview/claims.js';
import { previewGenerationHost } from '../src/preview/gateway.js';
import { PreviewRouteTable, startPreviewGateway, type RunningPreviewGateway } from '../src/preview/gatewayServer.js';
import { PreviewManager, PreviewQuotaError, PreviewUnavailableError } from '../src/preview/manager.js';
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
 * THE WHOLE CHAIN, END TO END: a delivered workspace is classified at
 * delivery, opened by a member, and its actual bytes come back through the
 * gateway under the gateway's own headers.
 *
 * The STATIC path needs no container at all — the gateway serves the
 * materialised copy — so this proves the complete product path on any host,
 * including the parts a container test would skip. What it deliberately does
 * NOT prove is the isolation of a Node preview, which needs a real gVisor
 * runtime and is asserted where that exists.
 */

const VISUALIZER = 'https://app.example.com';
const DOMAIN = 'previews.example.net';

let root: string;
let db: Database.Database;
let projects: ProjectStore;
let previews: PreviewStore;
let gateway: RunningPreviewGateway | null = null;
let orgId: string;
let principalId: string;
let projectId: string;
let projectRunId: string;
let deliveredWorkspace: string;

const config: PreviewConfig = {
  domain: DOMAIN,
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

/** A launcher that only has to issue workspaces: the static path uses no unit. */
class WorkspaceOnlyLauncher implements ContainerLauncher {
  constructor(private readonly rootDir: string) {}
  networkName(spec: LauncherNetworkSpec): string {
    return `net-${spec.ownerId}`;
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
    // The relay is the one unit the engine publishes on loopback; without a
    // port here the Node path stops at "not published on a reachable port".
    // The manager's injected probe answers readiness, so nothing listens on it.
    return {
      kind: spec.kind,
      ownerId: spec.ownerId,
      name: this.unitName(spec.kind, spec.ownerId),
      ...(spec.kind === 'preview-ingress' ? { hostPort: 49_154 } : {}),
    };
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-e2e-'));
  db = new Database(join(root, 'product.db'));
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db);
  previews = new PreviewStore(db);

  orgId = randomUUID();
  principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)').run(
    orgId,
    'Org',
    now
  );
  db.prepare(
    `INSERT INTO auth_principals (principal_id, kind, display_name, created_at)
     VALUES (?, 'human', ?, ?)`
  ).run(principalId, 'Member', now);
  db.prepare(
    `INSERT INTO auth_memberships (org_id, principal_id, role, created_at)
     VALUES (?, ?, 'org:owner', ?)`
  ).run(orgId, principalId, now);

  const project = projects.createProject({
    orgId,
    principalId,
    project: {
      name: 'Site',
      slug: 'site',
      initialPrompt: '',
      family: 'build',
      repositoryTarget: { installationId: '1', owner: 'acme', name: 'site', visibility: 'private' },
    },
  });
  projectId = project.projectId;

  deliveredWorkspace = join(root, 'delivered');
  mkdirSync(deliveredWorkspace, { recursive: true });
  writeFileSync(join(deliveredWorkspace, 'index.html'), '<h1>the delivered artifact</h1>');
  writeFileSync(join(deliveredWorkspace, '.env'), 'SECRET=nope');

  const run = projects.createProjectRun({
    orgId,
    projectId,
    principalId,
    request: { goal: 'build a page', idempotencyKey: 'k1' },
    hostPaths: {
      workspacePath: deliveredWorkspace,
      runsPath: join(root, 'traces'),
      logPath: join(root, 'run.log'),
    },
  })!.run;
  projectRunId = run.projectRunId;
  // The delivery-time descriptor, written by the same call the coordinator makes.
  recordDeliveredPreview(previews, {
    orgId,
    projectId,
    projectRunId,
    workspaceRoot: deliveredWorkspace,
  });
});

afterEach(async () => {
  await gateway?.close();
  gateway = null;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function manager(): { manager: PreviewManager; routes: PreviewRouteTable; claims: PreviewClaimRegistry } {
  const routes = new PreviewRouteTable();
  const claims = new PreviewClaimRegistry();
  return {
    routes,
    claims,
    manager: new PreviewManager({
      store: previews,
      launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes,
      claims,
      config,
      workspaceOf: () => deliveredWorkspace,
      probe: async () => true,
      log: () => undefined,
    }),
  };
}

interface Reply {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/** Low level, because the boundary keys on the Host header and fetch will not set one. */
function call(port: number, host: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('previewing a delivered artifact, end to end', () => {
  it('classifies at delivery, opens for a member, and serves the real bytes', async () => {
    const { manager: previewManager, routes, claims } = manager();

    // 1. What delivery observed.
    const descriptor = previews.getDescriptor(orgId, projectRunId);
    expect(descriptor?.availability).toBe('available');
    expect(descriptor?.kind).toBe('static');

    // 2. A member opens it.
    const opened = await previewManager.open({
      orgId,
      projectId,
      projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });
    expect(opened.summary.state).toBe('ready');
    expect(opened.url).toContain(`.${DOMAIN}/#`);

    const url = new URL(opened.url);
    const host = url.hostname;
    const secret = url.hash.slice(1);
    expect(routes.get(host)).not.toBeNull();

    // 3. The gateway is what the browser talks to.
    gateway = await startPreviewGateway({
      host: '127.0.0.1',
      port: 0,
      routes,
      claims,
      visualizerOrigin: VISUALIZER,
      log: () => undefined,
    });

    // 4. No cookie yet: the bootstrap page, because the secret is in a
    //    fragment only a script on this origin can read.
    const bootstrap = await call(gateway.port, host, '/');
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toContain('location.hash');

    // 5. The exchange the bootstrap page performs.
    const exchanged = await call(gateway.port, host, '/.atoma/claim', {}, 'POST', secret);
    expect(exchanged.status).toBe(204);
    const cookie = /(__Host-AtomaPreview=[^;]+)/.exec(String(exchanged.headers['set-cookie']))?.[1];
    expect(cookie).toBeTruthy();

    // 6. THE ARTIFACT ITSELF.
    const page = await call(gateway.port, host, '/', { cookie: cookie! });
    expect(page.status).toBe(200);
    expect(page.body).toBe('<h1>the delivered artifact</h1>');
    expect(String(page.headers['content-security-policy'])).toContain(
      `frame-ancestors ${VISUALIZER}`
    );

    // 7. And what publication refuses, the preview refuses too.
    const secret_file = await call(gateway.port, host, '/.env', { cookie: cookie! });
    expect(secret_file.status).toBe(404);
  });

  it('never mutates the delivered workspace', async () => {
    const { manager: previewManager } = manager();
    await previewManager.open({
      orgId,
      projectId,
      projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });
    // The workspace is the durable deliverable AND the seed of the next run.
    const { readFileSync, readdirSync } = await import('node:fs');
    expect(readFileSync(join(deliveredWorkspace, 'index.html'), 'utf8')).toBe(
      '<h1>the delivered artifact</h1>'
    );
    expect(readdirSync(deliveredWorkspace).sort()).toEqual(['.env', 'index.html']);
  });

  it('reuses one generation when two members open at once', async () => {
    const { manager: previewManager } = manager();
    const opener = { principalId, sessionId: 'session-1' };
    const first = await previewManager.open({ orgId, projectId, projectRunId, opener });
    const second = await previewManager.open({ orgId, projectId, projectRunId, opener });

    expect(second.summary.generation).toBe(first.summary.generation);
    // A fresh claim each time, so "open in a new tab" never copies a stale one.
    expect(second.url).not.toBe(first.url);
  });

  it('mints a new origin on the next generation, so an old grant cannot follow', async () => {
    const { manager: previewManager, routes, claims } = manager();
    const opener = { principalId, sessionId: 'session-1' };
    const first = await previewManager.open({ orgId, projectId, projectRunId, opener });
    const firstHost = new URL(first.url).hostname;

    await previewManager.stop(orgId, projectId, projectRunId, 'restart');
    // Routes and grants go before the runtime does.
    expect(routes.get(firstHost)).toBeNull();
    expect(claims.size.grants).toBe(0);

    const second = await previewManager.open({ orgId, projectId, projectRunId, opener });
    expect(new URL(second.url).hostname).not.toBe(firstHost);
    expect(second.summary.generation).toBe(first.summary.generation + 1);
  });

  it('extends a preview only through the trusted heartbeat', async () => {
    const { manager: previewManager } = manager();
    const opened = await previewManager.open({
      orgId,
      projectId,
      projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });
    expect(previewManager.heartbeat(orgId, projectRunId, opened.summary.generation)).toBe(true);
    // A generation that has moved on is not an error; the browser is a beat
    // behind and the caller says so.
    expect(previewManager.heartbeat(orgId, projectRunId, opened.summary.generation + 1)).toBe(false);
  });

  it('classifies a Node deliverable in flight from the SOURCE manifest, not the stripped copy', async () => {
    // MEASURED ON A LIVE RUN (2026-09-02, snapshot at 16:49): the member
    // clicked Preview mid-run and got `unsupported-deliverable`. The in-flight
    // path copies under the COPY policy, which strips every `.atoma*` file —
    // the probe manifest included — and then classified the copy. `kinds` was
    // therefore always empty, so a Node deliverable in flight could never be
    // anything but unsupported; only an `index.html` already on disk classified.
    //
    // The manifest is host-observed evidence the CLASSIFY policy admits at the
    // workspace root, so it is read from the SOURCE while every file check
    // stays on the frozen copy. This workspace has NO index.html on purpose.
    const building = join(root, 'in-flight-node');
    mkdirSync(building, { recursive: true });
    writeFileSync(join(building, 'server.js'), 'require("http").createServer().listen(8080);');
    writeFileSync(
      join(building, '.atoma-probes.json'),
      JSON.stringify({
        version: 1,
        entries: [{ probe: 'http', method: 'GET', path: '/', status: 200, entry: 'server.js' }],
      })
    );

    const run = projects.createProjectRun({
      orgId,
      projectId,
      principalId,
      request: { goal: 'an API, in progress', idempotencyKey: 'live-node-1' },
      hostPaths: {
        workspacePath: building,
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;

    const routes = new PreviewRouteTable();
    const claims = new PreviewClaimRegistry();
    const previewManager = new PreviewManager({
      store: previews,
      launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes,
      claims,
      config,
      workspaceOf: () => building,
      probe: async () => true,
      log: () => undefined,
    });

    const opened = await previewManager.openInFlight({
      orgId,
      projectId,
      projectRunId: run.projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });

    expect(opened.summary.state).toBe('ready');
    expect(opened.summary.source).toBe('in-flight');
    // `kind` on the SUMMARY comes from the descriptor, and an in-flight preview
    // has none by contract; what proves the Node path was taken is the route
    // the gateway would serve this generation from.
    const host = `${previewGenerationHost(orgId, run.projectRunId, opened.summary.generation)}.${config.domain}`;
    const route = routes.get(host);
    expect(route?.kind).toBe('node');
    expect(route?.upstreamPort).toBe(49_154);
    // And the copy the isolate mounts still carries NO manifest: the policy
    // split is intact, only the classifier's manifest read moved.
    const copies = join(root, 'copies');
    const copied = readdirSync(copies).map((owner) => join(copies, owner));
    expect(copied.length).toBeGreaterThan(0);
    for (const copy of copied) {
      expect(existsSync(join(copy, '.atoma-probes.json'))).toBe(false);
      expect(existsSync(join(copy, 'server.js'))).toBe(true);
    }
  });

  it('previews a run that is STILL BUILDING, from a snapshot of the moment', async () => {
    // The target: a member watching work in progress. The run's workspace is
    // being written; we only ever read it, and we copy.
    const building = join(root, 'in-flight-workspace');
    mkdirSync(building, { recursive: true });
    writeFileSync(join(building, 'index.html'), '<h1>half built</h1>');

    const run = projects.createProjectRun({
      orgId,
      projectId,
      principalId,
      request: { goal: 'a page, in progress', idempotencyKey: 'live-1' },
      hostPaths: {
        workspacePath: building,
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;
    // NO DESCRIPTOR: a descriptor is what delivery observed, and this run has
    // not delivered. The snapshot is a moment, not a fact about the run.
    expect(previews.getDescriptor(orgId, run.projectRunId)).toBeNull();

    const routes = new PreviewRouteTable();
    const claims = new PreviewClaimRegistry();
    const previewManager = new PreviewManager({
      store: previews,
      launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes,
      claims,
      config,
      workspaceOf: () => building,
      probe: async () => true,
      log: () => undefined,
    });

    const opened = await previewManager.openInFlight({
      orgId,
      projectId,
      projectRunId: run.projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });

    expect(opened.summary.state).toBe('ready');
    // The surface can say WHAT it is showing and WHEN, so nobody reads a
    // snapshot as the present.
    expect(opened.summary.source).toBe('in-flight');
    expect(opened.summary.snapshotAt).not.toBeNull();
    // Not a legacy run: the absence of a descriptor here means something else.
    expect(opened.summary.reason).toBeNull();

    // And the bytes actually come back.
    const url = new URL(opened.url);
    gateway = await startPreviewGateway({
      host: '127.0.0.1',
      port: 0,
      routes,
      claims,
      visualizerOrigin: VISUALIZER,
      log: () => undefined,
    });
    const exchanged = await call(
      gateway.port,
      url.hostname,
      '/.atoma/claim',
      {},
      'POST',
      url.hash.slice(1)
    );
    const cookie = /(__Host-AtomaPreview=[^;]+)/.exec(String(exchanged.headers['set-cookie']))![1]!;
    const page = await call(gateway.port, url.hostname, '/', { cookie });
    expect(page.body).toBe('<h1>half built</h1>');

    // The run keeps building; the workspace it is writing was never touched.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(building, 'index.html'), 'utf8')).toBe('<h1>half built</h1>');
  });

  it('takes a NEW snapshot on every reopen, on a new origin', async () => {
    const building = join(root, 'moving-workspace');
    mkdirSync(building, { recursive: true });
    writeFileSync(join(building, 'index.html'), '<h1>first</h1>');
    const run = projects.createProjectRun({
      orgId,
      projectId,
      principalId,
      request: { goal: 'moving', idempotencyKey: 'live-2' },
      hostPaths: {
        workspacePath: building,
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;

    const routes = new PreviewRouteTable();
    const claims = new PreviewClaimRegistry();
    const previewManager = new PreviewManager({
      store: previews,
      launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes,
      claims,
      config,
      workspaceOf: () => building,
      probe: async () => true,
      log: () => undefined,
    });
    const opener = { principalId, sessionId: 'session-1' };

    const first = await previewManager.openInFlight({
      orgId,
      projectId,
      projectRunId: run.projectRunId,
      opener,
    });

    // The run writes more.
    writeFileSync(join(building, 'index.html'), '<h1>second</h1>');

    const second = await previewManager.openInFlight({
      orgId,
      projectId,
      projectRunId: run.projectRunId,
      opener,
    });

    // A reopen is a NEW moment: new generation, new origin, old grant gone.
    expect(second.summary.generation).toBe(first.summary.generation + 1);
    expect(new URL(second.url).hostname).not.toBe(new URL(first.url).hostname);
    expect(routes.get(new URL(first.url).hostname)).toBeNull();

    gateway = await startPreviewGateway({
      host: '127.0.0.1',
      port: 0,
      routes,
      claims,
      visualizerOrigin: VISUALIZER,
      log: () => undefined,
    });
    const url = new URL(second.url);
    const exchanged = await call(
      gateway.port,
      url.hostname,
      '/.atoma/claim',
      {},
      'POST',
      url.hash.slice(1)
    );
    const cookie = /(__Host-AtomaPreview=[^;]+)/.exec(String(exchanged.headers['set-cookie']))![1]!;
    const page = await call(gateway.port, url.hostname, '/', { cookie });
    // The second snapshot shows the newer bytes.
    expect(page.body).toBe('<h1>second</h1>');
  });

  it('says a run in flight has nothing runnable yet, rather than failing obscurely', async () => {
    const empty = join(root, 'nothing-yet');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'notes.md'), '# thinking');
    const run = projects.createProjectRun({
      orgId,
      projectId,
      principalId,
      request: { goal: 'not started', idempotencyKey: 'live-3' },
      hostPaths: {
        workspacePath: empty,
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;

    const previewManager = new PreviewManager({
      store: previews,
      launcher: new WorkspaceOnlyLauncher(join(root, 'copies')),
      routes: new PreviewRouteTable(),
      claims: new PreviewClaimRegistry(),
      config,
      workspaceOf: () => empty,
      probe: async () => true,
      log: () => undefined,
    });
    await expect(
      previewManager.openInFlight({
        orgId,
        projectId,
        projectRunId: run.projectRunId,
        opener: { principalId, sessionId: 'session-1' },
      })
    ).rejects.toBeInstanceOf(PreviewUnavailableError);
  });

  it('refuses a run with nothing to preview, as a fact rather than a probe', async () => {
    mkdirSync(join(root, 'cli-workspace'), { recursive: true });
    writeFileSync(join(root, 'cli-workspace', 'cli.js'), 'console.log(1);');
    const emptyRun = projects.createProjectRun({
      orgId,
      projectId,
      principalId,
      request: { goal: 'a CLI', idempotencyKey: 'k2' },
      hostPaths: {
        workspacePath: join(root, 'cli-workspace'),
        runsPath: join(root, 'traces'),
        logPath: join(root, 'run.log'),
      },
    })!.run;
    recordDeliveredPreview(previews, {
      orgId,
      projectId,
      projectRunId: emptyRun.projectRunId,
      workspaceRoot: join(root, 'cli-workspace'),
    });

    const { manager: previewManager } = manager();
    await expect(
      previewManager.open({
        orgId,
        projectId,
        projectRunId: emptyRun.projectRunId,
        opener: { principalId, sessionId: 'session-1' },
      })
    ).rejects.toBeInstanceOf(PreviewUnavailableError);
  });

  it('refuses past its capacity rather than evicting someone else', async () => {
    const { manager: previewManager } = manager();
    await previewManager.open({
      orgId,
      projectId,
      projectRunId,
      opener: { principalId, sessionId: 'session-1' },
    });

    // A second run of the same organisation, with the per-org cap at two.
    const runs = [1, 2].map((n) => {
      const record = projects.createProjectRun({
        orgId,
        projectId,
        principalId,
        request: { goal: 'another page', idempotencyKey: `cap-${n}` },
        hostPaths: {
          workspacePath: deliveredWorkspace,
          runsPath: join(root, 'traces'),
          logPath: join(root, 'run.log'),
        },
      })!.run;
      recordDeliveredPreview(previews, {
        orgId,
        projectId,
        projectRunId: record.projectRunId,
        workspaceRoot: deliveredWorkspace,
      });
      return record.projectRunId;
    });

    await previewManager.open({
      orgId,
      projectId,
      projectRunId: runs[0]!,
      opener: { principalId, sessionId: 'session-1' },
    });
    await expect(
      previewManager.open({
        orgId,
        projectId,
        projectRunId: runs[1]!,
        opener: { principalId, sessionId: 'session-1' },
      })
    ).rejects.toBeInstanceOf(PreviewQuotaError);
    // The first two are still running: nobody was evicted to make room.
    expect(previews.countLiveInstances(orgId).org).toBe(2);
  });
});
