import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, sha256Hex } from '../src/auth/store.js';
import {
  eventLabel,
  EVENT_LABEL_MAX_CHARS,
  platformEventInputSchema,
  type PlatformEventInput,
} from '../src/contracts/platformEvents.js';
import type { RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubStore } from '../src/github/store.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectService } from '../src/projects/service.js';
import { ProjectStore } from '../src/projects/store.js';

const roots: string[] = [];

/** The minimum a store transition to `delivered` accepts. */
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

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-event-emissions-'));
  roots.push(root);
  return root;
}

/**
 * Collect emissions AND validate each one against the contract. Every test
 * here asserts through this: an emitter whose summary is too long or carries
 * a control character is DROPPED by the fail-open log at runtime, so "the
 * call site fired" is not the property that matters — "what it fired is
 * storable" is.
 */
function recorder() {
  const events: PlatformEventInput[] = [];
  const sink = (input: PlatformEventInput) => {
    const parsed = platformEventInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `emitted event violates the contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    events.push(input);
  };
  return { events, sink };
}

describe('eventLabel', () => {
  it('flattens, bounds and never yields an empty label', () => {
    expect(eventLabel('  Acme   Corp  ')).toBe('Acme Corp');
    expect(eventLabel('line one\nline two')).toBe('line one line two');
    expect(eventLabel('\u0000\u0007')).toBe('(unnamed)');
    expect(eventLabel('   ')).toBe('(unnamed)');
    const long = eventLabel('x'.repeat(200));
    expect(long).toHaveLength(EVENT_LABEL_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(eventLabel('x'.repeat(200), 10)).toHaveLength(10);
  });

  it('keeps a hostile display name inside a storable summary', () => {
    // The exact failure mode the helper exists for: a provider display name
    // with a newline and 400 characters would otherwise drop the event.
    const hostile = `${'A'.repeat(400)}\nDROP TABLE`;
    const input: PlatformEventInput = {
      kind: 'org.created',
      actorType: 'principal',
      actorId: 'principal-1',
      orgId: 'org-1',
      summary: `New organisation "${eventLabel(hostile)}" founded by its first login`,
    };
    expect(platformEventInputSchema.safeParse(input).success).toBe(true);
  });
});

describe('AuthStore.completeLogin admission flags', () => {
  function identity(subject: string, displayName = 'Owner') {
    return {
      provider: 'github',
      subject,
      displayName,
      email: null,
      emailVerified: false,
    };
  }

  it('reports a founded organisation only on a first login without invitation', () => {
    const store = AuthStore.open(join(tempRoot(), 'atoma.db'));
    const founder = store.completeLogin(identity('founder'), null);
    expect(founder).toMatchObject({
      createdPrincipal: true,
      createdOrganisation: true,
      joinedOrganisation: false,
    });
    // The same principal returning founds nothing and joins nothing.
    const again = store.completeLogin(identity('founder'), null);
    expect(again).toMatchObject({
      createdPrincipal: false,
      createdOrganisation: false,
      joinedOrganisation: false,
    });
  });

  it('reports a join for an invited newcomer, and no join when re-using a token', () => {
    const store = AuthStore.open(join(tempRoot(), 'atoma.db'));
    const founder = store.completeLogin(identity('founder'), null)!;
    const orgId = founder.viewer.orgId;

    const firstToken = 'invitation-token-one';
    store.createInvitation({
      orgId,
      token: firstToken,
      role: 'org:member',
      ttlMs: 60 * 60 * 1_000,
    });
    const joiner = store.completeLogin(identity('joiner', 'Joiner'), sha256Hex(firstToken));
    expect(joiner).toMatchObject({
      createdPrincipal: true,
      createdOrganisation: false,
      joinedOrganisation: true,
    });
    expect(joiner?.viewer.orgId).toBe(orgId);

    // A second invitation redeemed by someone who is ALREADY a member burns
    // the token but admits nobody — that must not read as an admission.
    const secondToken = 'invitation-token-two';
    store.createInvitation({
      orgId,
      token: secondToken,
      role: 'org:member',
      ttlMs: 60 * 60 * 1_000,
    });
    const rejoin = store.completeLogin(identity('joiner', 'Joiner'), sha256Hex(secondToken));
    expect(rejoin).toMatchObject({
      createdPrincipal: false,
      createdOrganisation: false,
      joinedOrganisation: false,
    });
  });
});

describe('ProjectService emissions', () => {
  function fixture() {
    const root = tempRoot();
    const dbPath = join(root, 'atoma.db');
    const auth = AuthStore.open(dbPath);
    const login = auth.completeLogin(
      {
        provider: 'github',
        subject: 'owner',
        displayName: 'Owner',
        email: null,
        emailVerified: false,
      },
      null
    )!;
    const store = ProjectStore.open(dbPath);
    const project = store.createProject({
      orgId: login.viewer.orgId,
      principalId: login.viewer.principalId,
      project: {
        name: 'Clock\nWidget',
        slug: 'clock',
        initialPrompt: '',
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

  /** A REAL run row, so `publicRun`'s schema parse is exercised, not stubbed. */
  function reserveRun(f: ReturnType<typeof fixture>, goal: string) {
    const projectRunId = randomUUID();
    const reservation = f.store.createProjectRun({
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      principalId: f.viewer.principalId,
      request: { goal, idempotencyKey: `key-${projectRunId}` },
      projectRunId,
      hostPaths: {
        workspacePath: join(f.root, 'workspace'),
        runsPath: join(f.root, 'traces'),
        logPath: join(f.root, 'run.log'),
      },
    });
    if (!reservation) throw new Error('run reservation failed');
    return reservation.run;
  }

  function serviceWith(
    f: ReturnType<typeof fixture>,
    run: { projectRunId: string },
    events?: (input: PlatformEventInput) => void
  ) {
    return new ProjectService({
      store: f.store,
      github: null,
      ...(events ? { events } : {}),
      coordinator: {
        cancel: vi.fn(() => f.store.getProjectRun(f.viewer.orgId, run.projectRunId)),
      } as unknown as ConstructorParameters<typeof ProjectService>[0]['coordinator'],
    });
  }

  it('journals a cancellation with the requesting principal', async () => {
    const f = fixture();
    const { events, sink } = recorder();
    const run = reserveRun(f, 'Build a clock in one index.html.');

    await serviceWith(f, run, sink).cancelProjectRun(
      f.viewer,
      f.project.projectId,
      run.projectRunId
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'run.cancelled',
      actorType: 'principal',
      actorId: f.viewer.principalId,
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      runId: run.projectRunId,
    });
    expect(events[0]?.summary).toContain('Build a clock');
  });

  it('runs identically with no sink injected', async () => {
    const f = fixture();
    const run = reserveRun(f, 'Build a clock in one index.html.');
    await expect(
      serviceWith(f, run).cancelProjectRun(f.viewer, f.project.projectId, run.projectRunId)
    ).resolves.toMatchObject({ projectRunId: run.projectRunId });
  });

  /**
   * THE P0 BLIND SPOT. The publisher's throw is swallowed upstream (the
   * coordinator's catch only transitions runs still `running`), so before the
   * events hook a failed publication existed only as a column nobody read.
   * This drives the real publisher against a real store.
   */
  it('journals a publication failure that the caller only ever saw as a throw', async () => {
    const f = fixture();
    const { events, sink } = recorder();
    const run = reserveRun(f, 'Build a clock in one index.html.');
    f.store.transitionProjectRun({
      orgId: f.viewer.orgId,
      projectRunId: run.projectRunId,
      from: 'queued',
      to: 'running',
    });
    f.store.transitionProjectRun({
      orgId: f.viewer.orgId,
      projectRunId: run.projectRunId,
      from: 'running',
      to: 'delivered',
      traceId: run.projectRunId,
      stats: DELIVERED_STATS,
    });
    const delivered = f.store.saveArtifactManifest(f.viewer.orgId, run.projectRunId, {
      version: 1,
      files: [
        {
          path: 'index.html',
          size: 5,
          sha256: 'a'.repeat(64),
          mode: '100644',
        },
      ],
      totalBytes: 5,
    })!;

    const publisher = new GitHubPublisher({
      store: f.store,
      // An EMPTY installation store: `resolveProjectInstallation` fails closed,
      // which is the shortest real path into the publisher's catch.
      github: GitHubStore.open(f.dbPath),
      client: {} as unknown as ConstructorParameters<typeof GitHubPublisher>[0]['client'],
      events: sink,
    });

    await expect(
      publisher.publish({
        project: f.project,
        run: delivered,
        workspaceRoot: join(f.root, 'workspace'),
        manifestHash: 'b'.repeat(64),
      })
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'publication.failed',
      actorType: 'principal',
      actorId: f.viewer.principalId,
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      runId: run.projectRunId,
    });
    // The row records the failure too — the event does not replace it.
    expect(f.store.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('failed');
  });
});
