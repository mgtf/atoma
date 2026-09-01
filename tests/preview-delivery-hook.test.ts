import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  ProjectRunCoordinator,
  type DeliveredPreviewSubject,
  type ProjectRunDriver,
} from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { readPreviewSummary, recordDeliveredPreview } from '../src/preview/service.js';
import { PreviewStore } from '../src/preview/store.js';

/**
 * THE DELIVERY HOOK — the ONE place the result preview touches the run path.
 *
 * `describeDeliveredPreview` is a narrow collaborator on the coordinator, like
 * `publisher` and `onRunFinished`: the coordinator owns WHEN a run is
 * delivered, the caller owns what a preview is. Everything this file pins is a
 * property of that seam rather than of the classifier, which is why the
 * classifier appears only in the last case, wired for real.
 *
 * The most important case here is FAIL-OPEN. A preview is a convenience over
 * work that is already delivered and already paid for, and this repository has
 * measured what the other choice costs: a trace-size cap recorded delivered run
 * `2857a579` as `failed`, erased $0.84 of stats, and made the NEXT run of that
 * project seed from an older workspace — because `previousDeliveredWorkspace`
 * only ever seeds from a row whose status is `delivered`. Nothing on this path
 * may downgrade a delivered run.
 */

type SpawnRunOptions = Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0];

const roots: string[] = [];

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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-delivery-'));
  roots.push(root);
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
  );
  if (!login) throw new Error('owner bootstrap failed');
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId,
    principalId: login.viewer.principalId,
    project: {
      name: 'Clock',
      slug: 'clock',
      initialPrompt: 'Build a clock in one index.html.',
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

function lease() {
  return {
    path: '/test/lease',
    attachChild: vi.fn(),
    release: vi.fn(),
  };
}

/**
 * A driver that DELIVERS for real: a deliverable in the workspace, a declared
 * artifact manifest, and a trace the coordinator's own verifier accepts. The
 * `index.html` is not decoration — it is what makes the last case classify as
 * a static preview through the real classifier.
 */
function deliveringDriver(stats: RunStats = DELIVERED_STATS): ReturnType<typeof vi.fn> {
  return vi.fn(async (options: SpawnRunOptions) => {
    const env = options.env ?? {};
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    const runs = env['ATOMA_RUNS_DIR']!;
    const runId = env['ATOMA_RUN_ID']!;
    const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(runs, { recursive: true });
    mkdirSync(join(declarations, '..'), { recursive: true });
    writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
    writeFileSync(
      declarations,
      JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }),
      'utf8'
    );
    writeFileSync(
      join(runs, `${runId}.json`),
      JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }),
      'utf8'
    );
    return `${formatRunStatsEpilogue(stats)}\n✓ build finished\n`;
  });
}

/** A publisher whose mock also satisfies `ProjectRunPublisher` structurally. */
function publisherSpy() {
  return { publish: vi.fn(async (_input: unknown) => undefined) };
}

function coordinatorFor(
  f: ReturnType<typeof fixture>,
  driver: ReturnType<typeof vi.fn>,
  options: {
    readonly describeDeliveredPreview?: (input: DeliveredPreviewSubject) => void;
    readonly publisher?: ReturnType<typeof publisherSpy>;
  } = {}
): ProjectRunCoordinator {
  return new ProjectRunCoordinator({
    store: f.store,
    dbPath: f.dbPath,
    projectsRoot: f.root,
    hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
    driver: driver as unknown as ProjectRunDriver,
    acquireLease: async () => lease(),
    ...(options.describeDeliveredPreview
      ? { describeDeliveredPreview: options.describeDeliveredPreview }
      : {}),
    ...(options.publisher ? { publisher: options.publisher } : {}),
  });
}

async function runOnce(
  f: ReturnType<typeof fixture>,
  coordinator: ProjectRunCoordinator,
  idempotencyKey: string,
  goal = 'Build a clock in one index.html.'
) {
  const started = await coordinator.start({
    orgId: f.viewer.orgId,
    principalId: f.viewer.principalId,
    projectId: f.project.projectId,
    request: { idempotencyKey, goal },
  });
  await coordinator.waitForIdle();
  return { started, row: f.store.getProjectRun(f.viewer.orgId, started.projectRunId)! };
}

describe('the delivered-preview hook fires exactly once, on delivery, for this run', () => {
  it('describes a delivered run once, with its identity and its OWN workspace', async () => {
    const f = fixture();
    const describeDeliveredPreview = vi.fn((_subject: DeliveredPreviewSubject) => undefined);
    const coordinator = coordinatorFor(f, deliveringDriver(), { describeDeliveredPreview });

    const { started, row } = await runOnce(f, coordinator, 'preview-once');

    expect(row.status).toBe('delivered');
    expect(describeDeliveredPreview).toHaveBeenCalledExactlyOnceWith({
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      projectRunId: started.projectRunId,
      workspaceRoot: started.hostPaths.workspacePath,
    });
  });

  /**
   * THE SECOND RUN IS THE INTERESTING ONE. A project run is `--seed`ed from the
   * previous delivered workspace, so two plausible directories exist by the
   * time the second run delivers, and only one of them is what this run built.
   * A hook handed the seed would describe the PREVIOUS deliverable and store it
   * immutably against the new run.
   */
  it('hands each run its own workspace, never the workspace it was seeded from', async () => {
    const f = fixture();
    const subjects: DeliveredPreviewSubject[] = [];
    const coordinator = coordinatorFor(f, deliveringDriver(), {
      describeDeliveredPreview: (subject) => {
        subjects.push(subject);
      },
    });

    const first = await runOnce(f, coordinator, 'preview-seed-1');
    const second = await runOnce(
      f,
      coordinator,
      'preview-seed-2',
      'Add a timezone selector to the clock.'
    );

    expect(first.row.status).toBe('delivered');
    expect(second.row.status).toBe('delivered');
    expect(subjects.map((subject) => subject.projectRunId)).toEqual([
      first.started.projectRunId,
      second.started.projectRunId,
    ]);
    expect(subjects[0]?.workspaceRoot).toBe(first.started.hostPaths.workspacePath);
    expect(subjects[1]?.workspaceRoot).toBe(second.started.hostPaths.workspacePath);
    expect(subjects[1]?.workspaceRoot).not.toBe(subjects[0]?.workspaceRoot);
  });

  it('never describes a FAILED run', async () => {
    const f = fixture();
    const describeDeliveredPreview = vi.fn((_subject: DeliveredPreviewSubject) => undefined);
    const driver = vi.fn(async (_options: SpawnRunOptions) => {
      throw new Error('driver died');
    });
    const coordinator = coordinatorFor(f, driver, { describeDeliveredPreview });

    const { row } = await runOnce(f, coordinator, 'preview-failed');

    expect(row.status).toBe('failed');
    expect(describeDeliveredPreview).not.toHaveBeenCalled();
  });

  it('never describes a CANCELLED run', async () => {
    const f = fixture();
    const describeDeliveredPreview = vi.fn((_subject: DeliveredPreviewSubject) => undefined);
    const cancelled: RunStats = { ...DELIVERED_STATS, outcome: 'cancelled' };
    const driver = vi.fn(
      async (_options: SpawnRunOptions) =>
        `${formatRunStatsEpilogue(cancelled)}\n✖ build cancelled\n`
    );
    const coordinator = coordinatorFor(f, driver, { describeDeliveredPreview });

    const { row } = await runOnce(f, coordinator, 'preview-cancelled');

    expect(row.status).toBe('cancelled');
    expect(describeDeliveredPreview).not.toHaveBeenCalled();
  });

  /**
   * The hook is gated on the STORED status, not on the runner's claim. A run
   * whose epilogue says `delivered` but whose trace the control plane refuses
   * ends `failed`, and a preview described for it would outlive a delivery that
   * never happened — the descriptor is immutable and has no delete.
   */
  it('never describes a run the runner claimed but the trace check refused', async () => {
    const f = fixture();
    const describeDeliveredPreview = vi.fn((_subject: DeliveredPreviewSubject) => undefined);
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      // Everything a delivery needs EXCEPT the trace.
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(declarations, '..'), { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(
        declarations,
        JSON.stringify({
          version: 1,
          runId: env['ATOMA_RUN_ID']!,
          generatedAt: new Date().toISOString(),
          outputs: ['index.html'],
        }),
        'utf8'
      );
      return `${formatRunStatsEpilogue(DELIVERED_STATS)}\n✓ build finished\n`;
    });
    const coordinator = coordinatorFor(f, driver, { describeDeliveredPreview });

    const { row } = await runOnce(f, coordinator, 'preview-trace-refused');

    expect(row.status).toBe('failed');
    expect(row.error).toBe('run trace was never written');
    expect(describeDeliveredPreview).not.toHaveBeenCalled();
  });

  /**
   * ORDERING, observed from inside the callback rather than inferred from the
   * source. The descriptor records what delivery observed, so a hook that ran
   * before the transition would describe a run no reader could yet find — and,
   * worse, a store failure there would be indistinguishable from a run that
   * never delivered.
   */
  it('runs AFTER the run is durably delivered, manifest included', async () => {
    const f = fixture();
    const observed: Array<{
      status: string;
      traceId: string | null;
      files: string[] | undefined;
    }> = [];
    const coordinator = coordinatorFor(f, deliveringDriver(), {
      describeDeliveredPreview: (subject) => {
        const row = f.store.getProjectRun(subject.orgId, subject.projectRunId);
        observed.push({
          status: row?.status ?? 'missing',
          traceId: row?.traceId ?? null,
          files: row?.artifactManifest?.files.map((file) => file.path),
        });
      },
    });

    const { started } = await runOnce(f, coordinator, 'preview-after-delivery');

    expect(observed).toEqual([
      {
        status: 'delivered',
        traceId: started.projectRunId,
        files: ['index.html'],
      },
    ]);
  });
});

/**
 * FAIL-OPEN, AND IT IS NOT A SHRUG.
 *
 * A throwing describer must leave the run exactly as delivered — status, cost,
 * trace id and artifact manifest — because the alternative has been measured on
 * this repository's own runs (`2857a579`: delivered, $0.8421, recorded
 * `failed`). The throw is reported to stderr instead, since the surrounding
 * catch only repairs a row that is still `running` and would otherwise swallow
 * it in silence.
 */
describe('a throwing describer never downgrades a delivered run', () => {
  it('keeps the run delivered with its stats and manifest, and says so on stderr', async () => {
    const f = fixture();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const paidStats: RunStats = {
      ...DELIVERED_STATS,
      costUsd: 0.8421,
      llmCalls: 20,
      learnedSkills: 1,
    };
    const publisher = publisherSpy();
    const describeDeliveredPreview = vi.fn((_subject: DeliveredPreviewSubject) => {
      throw new Error('preview store unavailable');
    });
    const coordinator = coordinatorFor(f, deliveringDriver(paidStats), {
      describeDeliveredPreview,
      publisher,
    });

    const { started, row } = await runOnce(f, coordinator, 'preview-throws');

    expect(describeDeliveredPreview).toHaveBeenCalledOnce();
    // THE RUN IS STILL DELIVERED. Nothing about the convenience over it moved.
    expect(row.status).toBe('delivered');
    expect(row.error).toBeNull();
    expect(row.traceId).toBe(started.projectRunId);
    // The stats are intact: this is the $0.84 that was erased once already.
    expect(row.stats?.costUsd).toBe(0.8421);
    expect(row.stats?.llmCalls).toBe(20);
    expect(row.stats?.outcome).toBe('delivered');
    expect(row.artifactManifest?.files.map((file) => file.path)).toEqual(['index.html']);
    // And publication is NOT skipped: the hook sits before it, so a throw that
    // escaped would have taken the repository push with it.
    expect(publisher.publish).toHaveBeenCalledOnce();
    // Contained, but never silent.
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('preview descriptor unavailable');
    expect(written).toContain(started.projectRunId);
  });

  /**
   * A failed description leaves NO row, and the reader says `legacy-run` — the
   * value the writer never emits and the reader synthesises for a run nothing
   * described. There is deliberately no backfill, so this is the state a member
   * actually meets.
   */
  it('leaves no descriptor behind, and the summary reads legacy-run', async () => {
    const f = fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const preview = PreviewStore.open(f.dbPath);
    const coordinator = coordinatorFor(f, deliveringDriver(), {
      describeDeliveredPreview: () => {
        throw new Error('preview store unavailable');
      },
    });

    const { started, row } = await runOnce(f, coordinator, 'preview-throws-legacy');

    expect(row.status).toBe('delivered');
    expect(preview.getDescriptor(f.viewer.orgId, started.projectRunId)).toBeNull();
    expect(
      readPreviewSummary(preview, {
        orgId: f.viewer.orgId,
        projectId: f.project.projectId,
        projectRunId: started.projectRunId,
      })
    ).toMatchObject({ availability: 'unavailable', kind: null, reason: 'legacy-run' });
  });
});

/**
 * END TO END, with the real writer and the real classifier over the real
 * workspace: `recordDeliveredPreview` wired straight onto the coordinator hook,
 * a `PreviewStore` over the same product DB, and a deliverable a member could
 * open. Nothing here reads model prose — the workspace has an `index.html` and
 * no probe manifest, which is exactly the `static` shape.
 */
describe('the hook wired to the real preview writer', () => {
  it('stores an immutable available/static descriptor for the delivered run', async () => {
    const f = fixture();
    const preview = PreviewStore.open(f.dbPath);
    const coordinator = coordinatorFor(f, deliveringDriver(), {
      describeDeliveredPreview: (subject) => {
        recordDeliveredPreview(preview, subject);
      },
    });

    const { started, row } = await runOnce(f, coordinator, 'preview-e2e');
    expect(row.status).toBe('delivered');

    const descriptor = preview.getDescriptor(f.viewer.orgId, started.projectRunId);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.availability).toBe('available');
    expect(descriptor?.kind).toBe('static');
    // A static preview runs no start command, so it carries no entry.
    expect(descriptor?.entry).toBeNull();
    expect(descriptor?.unavailableReason).toBeNull();
    expect(descriptor?.orgId).toBe(f.viewer.orgId);
    expect(descriptor?.projectId).toBe(f.project.projectId);
    // v1 has no run-side channel for declaring hosts, so every descriptor
    // requests nothing and every preview starts with egress denied.
    expect(descriptor?.requestedHosts).toEqual([]);

    // And the one shape a browser receives agrees, with nothing running yet.
    expect(
      readPreviewSummary(preview, {
        orgId: f.viewer.orgId,
        projectId: f.project.projectId,
        projectRunId: started.projectRunId,
      })
    ).toMatchObject({
      availability: 'available',
      kind: 'static',
      reason: null,
      state: 'stopped',
      generation: 0,
      allowedHosts: [],
      blockedHosts: [],
    });
  });

  /**
   * The row is written INSIDE delivery, against a run the store already holds
   * — which is what makes the descriptor's composite foreign keys into
   * `project_runs` and `projects` satisfiable at all. A hook that fired before
   * the transition, or for a run of another organisation, would be refused by
   * the store rather than merely be wrong.
   */
  it('writes a descriptor per delivered run, and a re-describe is a no-op', async () => {
    const f = fixture();
    const preview = PreviewStore.open(f.dbPath);
    const subjects: DeliveredPreviewSubject[] = [];
    const coordinator = coordinatorFor(f, deliveringDriver(), {
      describeDeliveredPreview: (subject) => {
        subjects.push(subject);
        recordDeliveredPreview(preview, subject);
      },
    });

    const first = await runOnce(f, coordinator, 'preview-e2e-1');
    const second = await runOnce(f, coordinator, 'preview-e2e-2', 'Add a timezone selector.');

    const firstDescriptor = preview.getDescriptor(f.viewer.orgId, first.started.projectRunId);
    const secondDescriptor = preview.getDescriptor(f.viewer.orgId, second.started.projectRunId);
    expect(firstDescriptor?.kind).toBe('static');
    expect(secondDescriptor?.kind).toBe('static');
    expect(firstDescriptor?.projectRunId).not.toBe(secondDescriptor?.projectRunId);

    // Delivery is terminal, so the only way here twice is a retry — and a
    // retry must not fail a run that is already delivered.
    const replayed = recordDeliveredPreview(preview, subjects[0]!);
    expect(replayed).toEqual(firstDescriptor);
  });
});
