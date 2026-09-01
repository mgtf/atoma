import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import type { PreviewDescriptor } from '../src/contracts/preview.js';
import type { RunStats } from '../src/contracts/runStats.js';
import { previewSummary, readPreviewSummary } from '../src/preview/service.js';
import { effectiveEgressHosts, PreviewStateConflict, PreviewStore } from '../src/preview/store.js';
import { ProjectStore } from '../src/projects/store.js';

/**
 * PREVIEW STATE, THROUGH THE REAL STORE.
 *
 * Every row here hangs off a delivered project run, which hangs off a project,
 * which hangs off an organisation — the composite foreign keys ARE the org
 * boundary — so the fixtures seed `auth_*`, then a project and a run through
 * `ProjectStore`, then open `PreviewStore` on the same handle.
 */

let root: string;
let db: Database.Database;
let projects: ProjectStore;
let preview: PreviewStore;

interface Actor {
  orgId: string;
  principalId: string;
}

interface Scene {
  alice: Actor;
  bob: Actor;
  projectId: string;
  projectRunId: string;
}

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-store-'));
  db = new Database(join(root, 'product.db'));
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db);
  preview = new PreviewStore(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

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

/** A delivered run in Alice's org, plus a Bob who owns nothing of it. */
function scene(slug = 'weather-lab'): Scene {
  const alice = actor('Alice');
  const bob = actor('Bob');
  const project = projects.createProject({
    orgId: alice.orgId,
    principalId: alice.principalId,
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
  const run = projects.createProjectRun({
    orgId: alice.orgId,
    projectId: project.projectId,
    principalId: alice.principalId,
    request: { idempotencyKey: `${slug}-1`, goal: 'Build a small weather dashboard.' },
    hostPaths: {
      workspacePath: join(root, 'workspaces', slug),
      runsPath: join(root, 'runs', slug),
      logPath: join(root, 'logs', `${slug}.log`),
    },
  })!.run;
  // A descriptor is written inside the delivery path, so the fixture delivers.
  projects.transitionProjectRun({
    orgId: alice.orgId,
    projectRunId: run.projectRunId,
    from: 'queued',
    to: 'running',
  });
  projects.transitionProjectRun({
    orgId: alice.orgId,
    projectRunId: run.projectRunId,
    from: 'running',
    to: 'delivered',
    traceId: `trace-${slug}`,
    stats: deliveredStats,
  });
  return { alice, bob, projectId: project.projectId, projectRunId: run.projectRunId };
}

function nodeDescriptor(
  s: Pick<Scene, 'projectId' | 'projectRunId'> & { orgId: string },
  hosts: readonly string[] = ['api.example.com']
): PreviewDescriptor {
  return {
    projectRunId: s.projectRunId,
    projectId: s.projectId,
    orgId: s.orgId,
    availability: 'available',
    kind: 'node',
    entry: 'server.js',
    unavailableReason: null,
    requestedHosts: [...hosts],
    createdAt: '2026-08-31T12:00:00.000Z',
  };
}

describe('PreviewStore — the descriptor is written once and never revised', () => {
  it('stores the delivery-time descriptor and returns the ORIGINAL row on a second, different write', () => {
    const s = scene();
    const first = preview.putDescriptor(nodeDescriptor({ ...s, orgId: s.alice.orgId }));
    expect(first).toEqual(nodeDescriptor({ ...s, orgId: s.alice.orgId }));
    expect(preview.getDescriptor(s.alice.orgId, s.projectRunId)).toEqual(first);

    // Delivery is terminal, so the only way back here is a retry — and a retry
    // must neither fail a delivered run nor rewrite what delivery observed.
    const second = preview.putDescriptor({
      projectRunId: s.projectRunId,
      projectId: s.projectId,
      orgId: s.alice.orgId,
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'not-runnable',
      requestedHosts: [],
      createdAt: '2026-09-01T09:00:00.000Z',
    });
    expect(second).toEqual(first);
    expect(preview.getDescriptor(s.alice.orgId, s.projectRunId)).toEqual(first);
  });

  it('refuses an UPDATE at the SQLite level, not only in the writer', () => {
    const s = scene();
    preview.putDescriptor(nodeDescriptor({ ...s, orgId: s.alice.orgId }));
    expect(() =>
      db
        .prepare('UPDATE project_run_preview_descriptors SET entry = ? WHERE project_run_id = ?')
        .run('other.js', s.projectRunId)
    ).toThrow(/preview descriptors are immutable/);
    expect(preview.getDescriptor(s.alice.orgId, s.projectRunId)?.entry).toBe('server.js');
  });
});

describe('PreviewStore — the organisation boundary', () => {
  it('answers null for another organisation, even with a real run id', () => {
    const s = scene();
    preview.putDescriptor(nodeDescriptor({ ...s, orgId: s.alice.orgId }));
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });

    expect(preview.getDescriptor(s.alice.orgId, s.projectRunId)).not.toBeNull();
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)).not.toBeNull();
    // An IDOR is a missing row here, never a leaked one.
    expect(preview.getDescriptor(s.bob.orgId, s.projectRunId)).toBeNull();
    expect(preview.getInstance(s.bob.orgId, s.projectRunId)).toBeNull();
  });

  it('refuses a descriptor whose org does not own the run, by composite foreign key', () => {
    const s = scene();
    // Bob's organisation exists; the pair (run, org) does not. Every CHECK is
    // satisfied on purpose, so the refusal can only be the foreign key.
    expect(() =>
      db
        .prepare(
          `INSERT INTO project_run_preview_descriptors
             (project_run_id, project_id, org_id, availability, kind, entry,
              unavailable_reason, requested_hosts_json, created_at)
           VALUES (?, ?, ?, 'available', 'static', NULL, NULL, '[]', '2026-08-31T12:00:00.000Z')`
        )
        .run(s.projectRunId, s.projectId, s.bob.orgId)
    ).toThrow(/FOREIGN KEY/);
    expect(preview.getDescriptor(s.bob.orgId, s.projectRunId)).toBeNull();
  });
});

describe('PreviewStore — instance lifecycle and monotonic generations', () => {
  it('opens once, reuses starting and ready, and mints the next generation after a stop', () => {
    const s = scene();
    const opened = preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });
    expect(opened.started).toBe(true);
    expect(opened.instance.generation).toBe(1);
    expect(opened.instance.state).toBe('starting');
    expect(opened.instance.startedAt).toBe('2026-09-01T10:00:00.000Z');

    // Two members clicking Preview at once get ONE isolate, not two.
    const whileStarting = preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:01.000Z'),
    });
    expect(whileStarting.started).toBe(false);
    expect(whileStarting.instance.generation).toBe(1);
    expect(whileStarting.instance.state).toBe('starting');

    preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      expiresAt: '2026-09-01T11:00:00.000Z',
      now: new Date('2026-09-01T10:00:05.000Z'),
    });
    const whileReady = preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:06.000Z'),
    });
    expect(whileReady.started).toBe(false);
    expect(whileReady.instance.generation).toBe(1);
    expect(whileReady.instance.state).toBe('ready');

    preview.beginStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'manual',
      now: new Date('2026-09-01T10:10:00.000Z'),
    });
    preview.finishStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'manual',
      now: new Date('2026-09-01T10:10:01.000Z'),
    });

    // A restart is a NEW browser origin.
    const restarted = preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:20:00.000Z'),
    });
    expect(restarted.started).toBe(true);
    expect(restarted.instance.generation).toBe(2);
    expect(restarted.instance.state).toBe('starting');

    // And so is reopening after a failed start.
    preview.markFailed({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 2,
      errorCode: 'readiness-timeout',
      now: new Date('2026-09-01T10:20:30.000Z'),
    });
    const afterFailure = preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:21:00.000Z'),
    });
    expect(afterFailure.started).toBe(true);
    expect(afterFailure.instance.generation).toBe(3);
    expect(afterFailure.instance.state).toBe('starting');
    expect(afterFailure.instance.errorCode).toBeNull();
  });

  it('refuses to open while the previous generation is still stopping', () => {
    const s = scene();
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });
    preview.beginStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'idle',
    });
    expect(() =>
      preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId })
    ).toThrow(PreviewStateConflict);
    expect(() =>
      preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId })
    ).toThrow(/stopping/);
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)?.state).toBe('stopping');
  });

  it('marks ready only from starting, only on the live generation, and records what served it', () => {
    const s = scene();
    preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });

    // A worker holding a stale generation cannot promote the live one.
    expect(() =>
      preview.markReady({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 2,
        expiresAt: '2026-09-01T11:00:00.000Z',
      })
    ).toThrow(PreviewStateConflict);

    const ready = preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      expiresAt: '2026-09-01T11:00:00.000Z',
      now: new Date('2026-09-01T10:00:05.000Z'),
    });
    expect(ready).toMatchObject({
      state: 'ready',
      generation: 1,
      readyAt: '2026-09-01T10:00:05.000Z',
      lastActivityAt: '2026-09-01T10:00:05.000Z',
      expiresAt: '2026-09-01T11:00:00.000Z',
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      errorCode: null,
    });

    // `starting` is the only source state, so a second promotion is refused.
    expect(() =>
      preview.markReady({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 1,
        expiresAt: '2026-09-01T12:00:00.000Z',
      })
    ).toThrow(PreviewStateConflict);
  });

  it('carries a bounded error code into failed, and keeps it there', () => {
    const s = scene();
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });
    preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      expiresAt: '2026-09-01T11:00:00.000Z',
    });

    const failed = preview.markFailed({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      errorCode: 'server-exited',
    });
    // The row PARSES: the schema pairs `failed` with a non-null code, so this
    // is proof the two halves agree and not merely that a column was written.
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('server-exited');
    expect(failed.readyAt).toBeNull();
    expect(failed.expiresAt).toBeNull();
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)).toEqual(failed);

    // `failed` is the state that carries the one field explaining why the
    // button did not work, so teardown may not quietly move it to `stopped`.
    expect(() =>
      preview.finishStop({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 1,
        reason: 'crash',
      })
    ).toThrow(PreviewStateConflict);
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)?.errorCode).toBe('server-exited');
  });

  it('clears the attribution of a generation when it reaches stopped', () => {
    const s = scene();
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });
    preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      expiresAt: '2026-09-01T11:00:00.000Z',
    });

    // Teardown removes routes before runtime, so what served the generation is
    // still on the row while it is stopping.
    const stopping = preview.beginStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'idle',
      now: new Date('2026-09-01T10:29:00.000Z'),
    });
    expect(stopping).toMatchObject({
      state: 'stopping',
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      lastStopReason: 'idle',
      readyAt: null,
      expiresAt: null,
    });

    const stopped = preview.finishStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'idle',
      now: new Date('2026-09-01T10:30:00.000Z'),
    });
    expect(stopped).toMatchObject({
      state: 'stopped',
      generation: 1,
      imageDigest: null,
      runtime: null,
      errorCode: null,
      readyAt: null,
      expiresAt: null,
      lastStopReason: 'idle',
      updatedAt: '2026-09-01T10:30:00.000Z',
    });
  });

  it('extends a preview only from a ready row on the live generation', () => {
    const s = scene();
    preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });
    // Nothing to extend while it is still coming up.
    expect(
      preview.touchActivity({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 1,
        now: new Date('2026-09-01T10:00:02.000Z'),
      })
    ).toBeNull();

    preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      expiresAt: '2026-09-01T11:00:00.000Z',
      now: new Date('2026-09-01T10:00:05.000Z'),
    });
    const beat = preview.touchActivity({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      now: new Date('2026-09-01T10:05:00.000Z'),
    });
    expect(beat?.lastActivityAt).toBe('2026-09-01T10:05:00.000Z');
    expect(beat?.state).toBe('ready');

    // A browser a beat behind is told so, not failed at.
    expect(
      preview.touchActivity({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 2,
        now: new Date('2026-09-01T10:06:00.000Z'),
      })
    ).toBeNull();
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)?.lastActivityAt).toBe(
      '2026-09-01T10:05:00.000Z'
    );

    preview.beginStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'manual',
    });
    expect(
      preview.touchActivity({
        orgId: s.alice.orgId,
        projectRunId: s.projectRunId,
        generation: 1,
        now: new Date('2026-09-01T10:07:00.000Z'),
      })
    ).toBeNull();
  });

  it('refuses a generation that goes backwards, at the SQLite level', () => {
    const s = scene();
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });
    preview.beginStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'manual',
    });
    preview.finishStop({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      reason: 'manual',
    });
    preview.openInstance({ orgId: s.alice.orgId, projectRunId: s.projectRunId });
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)?.generation).toBe(2);

    // A reused origin would let a stale service worker control the next one.
    expect(() =>
      db
        .prepare('UPDATE project_run_preview_instances SET generation = 1 WHERE project_run_id = ?')
        .run(s.projectRunId)
    ).toThrow(/preview generation must not go backwards/);
    expect(preview.getInstance(s.alice.orgId, s.projectRunId)?.generation).toBe(2);
  });
});

describe('PreviewStore — egress approvals are replaced, never merged', () => {
  it('replaces the whole set, lists it sorted, collapses duplicates and refuses a bad host', () => {
    const s = scene();
    expect(preview.listApprovedHosts(s.alice.orgId, s.projectId)).toEqual([]);

    expect(
      preview.replaceApprovedHosts({
        orgId: s.alice.orgId,
        projectId: s.projectId,
        hosts: ['cdn.example.com', 'api.example.com'],
        approvedByPrincipalId: s.alice.principalId,
      })
    ).toEqual(['api.example.com', 'cdn.example.com']);
    expect(preview.listApprovedHosts(s.alice.orgId, s.projectId)).toEqual([
      'api.example.com',
      'cdn.example.com',
    ]);

    // The admin screen PUTs the whole set, so an unchecked box must mean
    // something: this is a replacement, not a merge.
    preview.replaceApprovedHosts({
      orgId: s.alice.orgId,
      projectId: s.projectId,
      hosts: ['tiles.example.org'],
      approvedByPrincipalId: s.alice.principalId,
    });
    expect(preview.listApprovedHosts(s.alice.orgId, s.projectId)).toEqual(['tiles.example.org']);

    // Duplicates collapse rather than colliding on the primary key.
    expect(
      preview.replaceApprovedHosts({
        orgId: s.alice.orgId,
        projectId: s.projectId,
        hosts: ['a.example.com', 'a.example.com', 'b.example.com'],
        approvedByPrincipalId: s.alice.principalId,
      })
    ).toEqual(['a.example.com', 'b.example.com']);

    for (const bad of ['API.example.com', 'localhost', '10.0.0.1', 'db.internal', 'api.example.com:443']) {
      expect(() =>
        preview.replaceApprovedHosts({
          orgId: s.alice.orgId,
          projectId: s.projectId,
          hosts: [bad],
          approvedByPrincipalId: s.alice.principalId,
        })
      ).toThrow();
    }
    // Every host is parsed before anything is deleted, so a refused write
    // leaves the approved set exactly as it was.
    expect(preview.listApprovedHosts(s.alice.orgId, s.projectId)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
    expect(preview.listApprovedHosts(s.bob.orgId, s.projectId)).toEqual([]);
  });

  it('splits what a run requested against what an admin approved, in requested order', () => {
    expect(
      effectiveEgressHosts(
        ['b.example.com', 'a.example.com', 'c.example.com'],
        ['a.example.com', 'c.example.com', 'unrequested.example.com']
      )
    ).toEqual({
      allowed: ['a.example.com', 'c.example.com'],
      blocked: ['b.example.com'],
    });
    expect(effectiveEgressHosts([], ['a.example.com'])).toEqual({ allowed: [], blocked: [] });
    expect(effectiveEgressHosts(['a.example.com'], [])).toEqual({
      allowed: [],
      blocked: ['a.example.com'],
    });
  });
});

describe('previewSummary — the only shape a browser receives', () => {
  it('reads a run with no descriptor as a legacy run, stopped at generation zero', () => {
    expect(previewSummary({ descriptor: null, instance: null, approvedHosts: [] })).toEqual({
      availability: 'unavailable',
      kind: null,
      reason: 'legacy-run',
      state: 'stopped',
      generation: 0,
      readyAt: null,
      expiresAt: null,
      errorCode: null,
      requestedHosts: [],
      allowedHosts: [],
      blockedHosts: [],
    });
  });

  it('assembles the three rows and carries neither the image digest nor the runtime', () => {
    const s = scene();
    const descriptor = preview.putDescriptor(
      nodeDescriptor({ ...s, orgId: s.alice.orgId }, ['api.example.com', 'blocked.example.com'])
    );
    preview.replaceApprovedHosts({
      orgId: s.alice.orgId,
      projectId: s.projectId,
      hosts: ['api.example.com'],
      approvedByPrincipalId: s.alice.principalId,
    });
    preview.openInstance({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      now: new Date('2026-09-01T10:00:00.000Z'),
    });
    const instance = preview.markReady({
      orgId: s.alice.orgId,
      projectRunId: s.projectRunId,
      generation: 1,
      imageDigest: IMAGE_DIGEST,
      runtime: 'runsc',
      expiresAt: '2026-09-01T11:00:00.000Z',
      now: new Date('2026-09-01T10:00:05.000Z'),
    });

    const expected = {
      availability: 'available',
      kind: 'node',
      reason: null,
      state: 'ready',
      generation: 1,
      readyAt: '2026-09-01T10:00:05.000Z',
      expiresAt: '2026-09-01T11:00:00.000Z',
      errorCode: null,
      requestedHosts: ['api.example.com', 'blocked.example.com'],
      allowedHosts: ['api.example.com'],
      blockedHosts: ['blocked.example.com'],
    };
    const summary = previewSummary({
      descriptor,
      instance,
      approvedHosts: ['api.example.com'],
    });
    expect(summary).toEqual(expected);
    // Attribution stays server-side: the summary is an allowlist, and a
    // projection would acquire whatever the instance row gains next.
    expect(Object.keys(summary).sort()).toEqual(Object.keys(expected).sort());
    expect('imageDigest' in summary).toBe(false);
    expect('runtime' in summary).toBe(false);
    expect(instance.imageDigest).toBe(IMAGE_DIGEST);

    // And the reader assembles the same answer from the three tables alone.
    expect(
      readPreviewSummary(preview, {
        orgId: s.alice.orgId,
        projectId: s.projectId,
        projectRunId: s.projectRunId,
      })
    ).toEqual(expected);

    // Another organisation sees a run it does not own as a legacy run.
    expect(
      readPreviewSummary(preview, {
        orgId: s.bob.orgId,
        projectId: s.projectId,
        projectRunId: s.projectRunId,
      })
    ).toMatchObject({ availability: 'unavailable', reason: 'legacy-run', generation: 0 });
  });
});
