import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import type { ArtifactManifest } from '../src/contracts/projects.js';
import type { RunStats } from '../src/contracts/runStats.js';
import { hasProjectTables, ProjectStateConflict, ProjectStore } from '../src/projects/store.js';

let root: string;
let db: Database.Database;
let store: ProjectStore;

interface Actor {
  orgId: string;
  principalId: string;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-project-store-'));
  db = new Database(join(root, 'product.db'));
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  store = new ProjectStore(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function actor(label: string): Actor {
  const orgId = randomUUID();
  const principalId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)'
  ).run(orgId, `Org ${label}`, now);
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

function createProject(owner: Actor, slug = 'weather-lab') {
  return store.createProject({
    orgId: owner.orgId,
    principalId: owner.principalId,
    project: {
      name: 'Weather Lab',
      slug,
      family: 'build',
      repositoryTarget: {
        installationId: '12345',
        owner: 'atoma-test',
        name: slug,
        visibility: 'private',
      },
    },
  });
}

function runRequest(
  idempotencyKey: string,
  goal = 'Build a small weather dashboard in index.html.'
) {
  return { idempotencyKey, goal };
}

function hostPaths(run: string = randomUUID()) {
  return {
    workspacePath: join(root, 'workspaces', run),
    runsPath: join(root, 'runs', run),
    logPath: join(root, 'logs', `${run}.log`),
  };
}

const deliveredStats: RunStats = {
  outcome: 'delivered',
  costUsd: 0.12,
  llmCalls: 3,
  opusCalls: 1,
  sonnetCalls: 1,
  haikuCalls: 1,
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

const manifest: ArtifactManifest = {
  version: 1,
  files: [
    {
      path: 'index.html',
      size: 3,
      sha256: 'a'.repeat(64),
      mode: '100644',
    },
  ],
  totalBytes: 3,
};

describe('ProjectStore — organisation boundary and host-owned identity', () => {
  it('requires an organisation membership and scopes every read by org', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const project = createProject(alice);

    expect(store.getProject(alice.orgId, project.projectId)?.slug).toBe('weather-lab');
    expect(store.getProject(bob.orgId, project.projectId)).toBeNull();
    expect(store.listProjects(bob.orgId)).toEqual([]);

    const untitled = store.createProject({
      orgId: alice.orgId,
      principalId: alice.principalId,
      project: {
        name: 'Notes',
        slug: 'notes',
        repositoryTarget: {
          installationId: '12345',
          owner: 'atoma-test',
          name: 'notes',
          visibility: 'private',
        },
      },
    });
    expect(untitled.initialPrompt).toBe('');
    expect(() =>
      store.createProjectRun({
        orgId: alice.orgId,
        projectId: untitled.projectId,
        principalId: alice.principalId,
        request: { idempotencyKey: 'missing-goal' } as never,
        hostPaths: hostPaths('missing-goal'),
      })
    ).toThrow();
    const first = store.createProjectRun({
      orgId: alice.orgId,
      projectId: untitled.projectId,
      principalId: alice.principalId,
      request: runRequest('notes-1', 'Build a notes CLI.'),
      hostPaths: hostPaths('notes-1'),
    })!;
    const second = store.createProjectRun({
      orgId: alice.orgId,
      projectId: untitled.projectId,
      principalId: alice.principalId,
      request: runRequest('notes-2', 'Add tags to the notes CLI.'),
      hostPaths: hostPaths('notes-2'),
    })!;
    expect(first.run.goal).toBe('Build a notes CLI.');
    expect(second.run.goal).toBe('Add tags to the notes CLI.');

    expect(() =>
      store.createProject({
        orgId: alice.orgId,
        principalId: bob.principalId,
        project: {
          name: 'Crossed',
          slug: 'crossed',
          initialPrompt: 'Build one file.',
          repositoryTarget: {
            installationId: '9',
            owner: 'alice',
            name: 'crossed',
            visibility: 'private',
          },
        },
      })
    ).toThrow(/FOREIGN KEY/);
  });

  it('makes org ids, run ownership and host paths immutable at SQLite level', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const project = createProject(alice);
    const reserved = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('run-1'),
      hostPaths: hostPaths('run-1'),
    })!;

    expect(() =>
      db.prepare('UPDATE projects SET org_id = ? WHERE project_id = ?').run(bob.orgId, project.projectId)
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare('UPDATE project_runs SET workspace_path = ? WHERE project_run_id = ?')
        .run(join(root, 'other'), reserved.run.projectRunId)
    ).toThrow(/immutable/);
    expect(store.getProjectRun(bob.orgId, reserved.run.projectRunId)).toBeNull();
    expect(store.listProjectRuns(bob.orgId, project.projectId)).toBeNull();
  });

  it('accepts only canonical absolute host paths and keeps them out of request input', () => {
    const alice = actor('Alice');
    const project = createProject(alice);
    expect(() =>
      store.createProjectRun({
        orgId: alice.orgId,
        projectId: project.projectId,
        principalId: alice.principalId,
        request: runRequest('run-relative'),
        hostPaths: {
          workspacePath: 'relative/workspace',
          runsPath: join(root, 'runs'),
          logPath: join(root, 'log'),
        },
      })
    ).toThrow(/canonical absolute/);
  });
});

describe('ProjectStore — idempotency and CAS state machines', () => {
  it('reserves a run once and returns the original receipt on an exact retry', () => {
    const alice = actor('Alice');
    const project = createProject(alice);
    const first = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('launch-42'),
      hostPaths: hostPaths('first'),
    })!;
    const retry = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('launch-42'),
      // A caller may have generated a fresh path before discovering the
      // retry. The persisted host capability remains the original one.
      hostPaths: hostPaths('discarded-retry'),
    })!;
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.run.projectRunId).toBe(first.run.projectRunId);
    expect(retry.run.hostPaths).toEqual(first.run.hostPaths);

    expect(() =>
      store.createProjectRun({
        orgId: alice.orgId,
        projectId: project.projectId,
        principalId: alice.principalId,
        request: runRequest('launch-42', 'A different goal'),
        hostPaths: hostPaths('bad-retry'),
      })
    ).toThrow(ProjectStateConflict);
  });

  it('moves a run with compare-and-swap, accepts identical replay and refuses stale/conflicting writes', () => {
    const alice = actor('Alice');
    const project = createProject(alice);
    const run = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('run-cas'),
      hostPaths: hostPaths('run-cas'),
    })!.run;

    expect(
      store.transitionProjectRun({
        orgId: alice.orgId,
        projectRunId: run.projectRunId,
        from: 'queued',
        to: 'running',
      })?.status
    ).toBe('running');
    expect(
      store.transitionProjectRun({
        orgId: alice.orgId,
        projectRunId: run.projectRunId,
        from: 'queued',
        to: 'running',
      })?.status
    ).toBe('running');

    const delivered = store.transitionProjectRun({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      from: 'running',
      to: 'delivered',
      traceId: 'trace-42',
      stats: deliveredStats,
    })!;
    expect(delivered).toMatchObject({ status: 'delivered', traceId: 'trace-42' });
    expect(
      store.transitionProjectRun({
        orgId: alice.orgId,
        projectRunId: run.projectRunId,
        from: 'running',
        to: 'delivered',
        traceId: 'trace-42',
        stats: deliveredStats,
      })?.status
    ).toBe('delivered');
    expect(() =>
      store.transitionProjectRun({
        orgId: alice.orgId,
        projectRunId: run.projectRunId,
        from: 'running',
        to: 'delivered',
        traceId: 'another-trace',
        stats: deliveredStats,
      })
    ).toThrow(ProjectStateConflict);
    expect(() =>
      store.transitionProjectRun({
        orgId: alice.orgId,
        projectRunId: run.projectRunId,
        from: 'running',
        to: 'failed',
        error: 'late writer',
      })
    ).toThrow(ProjectStateConflict);
  });

  it('attaches one immutable manifest, then reserves and publishes exactly once', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const project = createProject(alice);
    const run = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('publish-run'),
      hostPaths: hostPaths('publish-run'),
    })!.run;
    store.transitionProjectRun({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      from: 'queued',
      to: 'running',
    });
    store.transitionProjectRun({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      from: 'running',
      to: 'delivered',
      traceId: 'trace-publish',
      stats: deliveredStats,
    });
    const attached = store.saveArtifactManifest(alice.orgId, run.projectRunId, manifest)!;
    expect(attached.artifactManifest).toEqual(manifest);
    expect(store.saveArtifactManifest(alice.orgId, run.projectRunId, manifest)).toEqual(attached);
    expect(store.saveArtifactManifest(bob.orgId, run.projectRunId, manifest)).toBeNull();
    expect(() =>
      store.saveArtifactManifest(alice.orgId, run.projectRunId, {
        ...manifest,
        files: [{ ...manifest.files[0]!, sha256: 'b'.repeat(64) }],
      })
    ).toThrow(ProjectStateConflict);

    const first = store.reservePublication({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      idempotencyKey: 'publication-1',
    })!;
    const retry = store.reservePublication({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      idempotencyKey: 'publication-1',
    })!;
    expect(first.created).toBe(true);
    expect(retry).toEqual({ publication: first.publication, created: false });
    expect(store.getPublication(bob.orgId, first.publication.publicationId)).toBeNull();

    expect(
      store.transitionPublication({
        orgId: alice.orgId,
        publicationId: first.publication.publicationId,
        from: 'pending',
        to: 'publishing',
      })?.status
    ).toBe('publishing');
    const receipt = {
      repositoryId: '777',
      fullName: 'atoma-test/weather-lab',
      url: 'https://github.com/atoma-test/weather-lab',
      defaultBranch: 'main',
      commitSha: 'c'.repeat(40),
    } as const;
    const published = store.transitionPublication({
      orgId: alice.orgId,
      publicationId: first.publication.publicationId,
      from: 'publishing',
      to: 'published',
      receipt,
    })!;
    expect(published).toMatchObject({ status: 'published', commitSha: 'c'.repeat(40) });
    expect(
      store.transitionPublication({
        orgId: alice.orgId,
        publicationId: first.publication.publicationId,
        from: 'publishing',
        to: 'published',
        receipt,
      })
    ).toEqual(published);
  });

  it('reconciles crash-orphaned runs and publications to failed at boot, leaving terminal rows alone', () => {
    // The defect this pins: the only writers that move `queued`/`running`
    // runs and `publishing` publications are in-memory drivers in the viz
    // server process. After a crash those rows were stuck forever — and the
    // publisher short-circuits on `publishing`, so even a retry was blocked.
    const alice = actor('Alice');
    const bob = actor('Bob');
    const aliceProject = createProject(alice);
    const bobProject = (() => {
      return store.createProject({
        orgId: bob.orgId,
        principalId: bob.principalId,
        project: {
          name: 'Bob Lab',
          slug: 'bob-lab',
          family: 'build',
          repositoryTarget: {
            installationId: '54321',
            owner: 'atoma-test',
            name: 'bob-lab',
            visibility: 'private',
          },
        },
      });
    })();
    const makeRun = (owner: Actor, projectId: string, key: string) =>
      store.createProjectRun({
        orgId: owner.orgId,
        projectId,
        principalId: owner.principalId,
        request: runRequest(key),
        hostPaths: hostPaths(key),
      })!.run;
    const advance = (owner: Actor, runId: string, to: 'running' | 'delivered') => {
      store.transitionProjectRun({
        orgId: owner.orgId,
        projectRunId: runId,
        from: 'queued',
        to: 'running',
      });
      if (to === 'delivered') {
        store.transitionProjectRun({
          orgId: owner.orgId,
          projectRunId: runId,
          from: 'running',
          to: 'delivered',
          traceId: `trace-${runId}`,
          stats: deliveredStats,
        });
      }
    };

    const orphanQueued = makeRun(alice, aliceProject.projectId, 'orphan-queued');
    const orphanRunning = makeRun(alice, aliceProject.projectId, 'orphan-running');
    advance(alice, orphanRunning.projectRunId, 'running');
    const bobRunning = makeRun(bob, bobProject.projectId, 'bob-running');
    advance(bob, bobRunning.projectRunId, 'running');
    const deliveredStuck = makeRun(alice, aliceProject.projectId, 'delivered-stuck');
    advance(alice, deliveredStuck.projectRunId, 'delivered');
    store.saveArtifactManifest(alice.orgId, deliveredStuck.projectRunId, manifest);
    const deliveredDone = makeRun(alice, aliceProject.projectId, 'delivered-done');
    advance(alice, deliveredDone.projectRunId, 'delivered');
    store.saveArtifactManifest(alice.orgId, deliveredDone.projectRunId, manifest);

    const stuck = store.reservePublication({
      orgId: alice.orgId,
      projectRunId: deliveredStuck.projectRunId,
      idempotencyKey: 'stuck',
    })!.publication;
    store.transitionPublication({
      orgId: alice.orgId,
      publicationId: stuck.publicationId,
      from: 'pending',
      to: 'publishing',
    });
    const done = store.reservePublication({
      orgId: alice.orgId,
      projectRunId: deliveredDone.projectRunId,
      idempotencyKey: 'done',
    })!.publication;
    store.transitionPublication({
      orgId: alice.orgId,
      publicationId: done.publicationId,
      from: 'pending',
      to: 'publishing',
    });
    store.transitionPublication({
      orgId: alice.orgId,
      publicationId: done.publicationId,
      from: 'publishing',
      to: 'published',
      receipt: {
        repositoryId: '777',
        fullName: 'atoma-test/weather-lab',
        url: 'https://github.com/atoma-test/weather-lab',
        defaultBranch: 'main',
        commitSha: 'c'.repeat(40),
      },
    });

    expect(store.reconcileInterrupted('interrupted by server restart')).toEqual({
      runs: 3,
      publications: 1,
    });

    for (const [owner, runId] of [
      [alice, orphanQueued.projectRunId],
      [alice, orphanRunning.projectRunId],
      [bob, bobRunning.projectRunId],
    ] as const) {
      const failed = store.getProjectRun(owner.orgId, runId)!;
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('interrupted by server restart');
      expect(failed.endedAt).not.toBeNull();
    }
    expect(store.getProjectRun(alice.orgId, deliveredStuck.projectRunId)!.status).toBe('delivered');
    expect(store.getProjectRun(alice.orgId, deliveredDone.projectRunId)!.status).toBe('delivered');
    const failedPublication = store.getPublication(alice.orgId, stuck.publicationId)!;
    expect(failedPublication.status).toBe('failed');
    expect(failedPublication.error).toBe('interrupted by server restart');
    expect(store.getPublication(alice.orgId, done.publicationId)!.status).toBe('published');

    // Idempotent, and the recovered publication is retryable again.
    expect(store.reconcileInterrupted('interrupted by server restart')).toEqual({
      runs: 0,
      publications: 0,
    });
    expect(
      store.transitionPublication({
        orgId: alice.orgId,
        publicationId: stuck.publicationId,
        from: 'failed',
        to: 'publishing',
      })?.status
    ).toBe('publishing');
  });

  it('keeps repository creation separate and retryable', () => {
    const alice = actor('Alice');
    const project = createProject(alice);
    expect(
      store.transitionRepository({
        orgId: alice.orgId,
        projectId: project.projectId,
        from: 'pending',
        to: 'creating',
      })?.repositoryStatus
    ).toBe('creating');
    expect(
      store.transitionRepository({
        orgId: alice.orgId,
        projectId: project.projectId,
        from: 'creating',
        to: 'failed',
        error: 'GitHub temporarily unavailable',
      })?.repositoryStatus
    ).toBe('failed');
    expect(
      store.transitionRepository({
        orgId: alice.orgId,
        projectId: project.projectId,
        from: 'failed',
        to: 'creating',
      })?.repositoryStatus
    ).toBe('creating');
    const ready = store.transitionRepository({
      orgId: alice.orgId,
      projectId: project.projectId,
      from: 'creating',
      to: 'ready',
      receipt: {
        repositoryId: '42',
        fullName: 'atoma-test/weather-lab',
        url: 'https://github.com/atoma-test/weather-lab',
        defaultBranch: 'main',
      },
    });
    expect(ready).toMatchObject({ repositoryStatus: 'ready', repositoryId: '42' });
  });

  it('locates a project-run trace file only inside the owning organisation', () => {
    const alice = actor('Alice');
    const bob = actor('Bob');
    const project = createProject(alice);
    const reserved = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('run-trace'),
      hostPaths: hostPaths('run-trace'),
    })!;
    const missing = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('run-queued'),
      hostPaths: hostPaths('run-queued'),
    })!;
    mkdirSync(reserved.run.hostPaths.runsPath, { recursive: true });
    const file = join(reserved.run.hostPaths.runsPath, `${reserved.run.projectRunId}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        id: reserved.run.projectRunId,
        label: 'project run',
        startedAt: '2026-08-20T00:00:00.000Z',
      })
    );

    expect(store.listOrgRunTraces(alice.orgId)).toEqual([
      {
        id: reserved.run.projectRunId,
        file,
        projectId: project.projectId,
        projectName: 'Weather Lab',
        projectSlug: 'weather-lab',
      },
    ]);
    expect(store.listOrgRunTraces(bob.orgId)).toEqual([]);
    expect(store.findOrgRunTraceFile(alice.orgId, reserved.run.projectRunId)).toBe(file);
    expect(store.findOrgRunTraceFile(bob.orgId, reserved.run.projectRunId)).toBeNull();
    expect(store.findOrgRunTraceFile(alice.orgId, missing.run.projectRunId)).toBeNull();
    expect(store.findOrgRunTraceFile(alice.orgId, '2026-08-19T23-00-36-516-7b12d830')).toBeNull();
  });
});

/**
 * WHAT A LIVE WATCH READS. The sentinel cannot infer a project run's liveness
 * from `runs/index.json`: each project run writes into its own directory, so
 * there is no shared index to poll. `status = 'running'` is the fact, and this
 * is the only read that exposes it.
 */
describe('ProjectStore — the live-run reader the sentinel uses', () => {
  it('lists only running runs, resolves the trace, and names the scope', () => {
    const alice = actor('Alice');
    const project = createProject(alice);
    const paths = hostPaths('live-run');
    mkdirSync(paths.runsPath, { recursive: true });

    const queued = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('live-queued'),
      hostPaths: hostPaths('queued-run'),
    })!.run;
    const run = store.createProjectRun({
      orgId: alice.orgId,
      projectId: project.projectId,
      principalId: alice.principalId,
      request: runRequest('live-running'),
      hostPaths: paths,
    })!.run;

    // Queued is not live: nothing is executing yet.
    expect(store.listLiveRunTraces()).toEqual([]);

    store.transitionProjectRun({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      from: 'queued',
      to: 'running',
    });

    // Running with no persisted trace: reported with a null file rather than
    // dropped, because a caller must be able to tell "not yet" from "gone".
    expect(store.listLiveRunTraces()).toEqual([
      {
        projectRunId: run.projectRunId,
        orgId: alice.orgId,
        projectId: project.projectId,
        projectSlug: 'weather-lab',
        file: null,
      },
    ]);

    writeFileSync(join(paths.runsPath, `${run.projectRunId}.json`), '{}', 'utf8');
    expect(store.listLiveRunTraces()[0]!.file).toBe(
      join(paths.runsPath, `${run.projectRunId}.json`)
    );

    // And a finished run leaves the live list.
    store.transitionProjectRun({
      orgId: alice.orgId,
      projectRunId: run.projectRunId,
      from: 'running',
      to: 'delivered',
      traceId: run.projectRunId,
      stats: deliveredStats,
    });
    expect(store.listLiveRunTraces()).toEqual([]);
    expect(queued.status).toBe('queued');
  });

  it('answers whether a store holds the control plane without creating it', () => {
    // A reader must not bring a tenant control plane into being by looking.
    const emptyPath = join(root, 'fresh.db');
    const fresh = new Database(emptyPath);
    fresh.exec('CREATE TABLE unrelated (x INTEGER)');
    fresh.close();

    expect(hasProjectTables(emptyPath)).toBe(false);
    expect(hasProjectTables(join(root, 'does-not-exist.db'))).toBe(false);

    const opened = new Database(emptyPath);
    opened.exec(AUTH_TABLES_DDL);
    new ProjectStore(opened);
    opened.close();
    expect(hasProjectTables(emptyPath)).toBe(true);
  });
});
