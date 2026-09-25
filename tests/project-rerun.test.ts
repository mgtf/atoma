import { haystackTestEnvironment } from './helpers/haystack.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { ACCEPTANCE_SOURCE_ENV, ACCEPTANCE_SPEC_ENV } from '../src/contracts/acceptanceChecklist.js';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ProjectRunConfigurationError, ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { PROJECT_TABLES_DDL, ProjectStateConflict, ProjectStore } from '../src/projects/store.js';
import { readAcceptanceSpec } from '../src/run/acceptanceSpec.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

type SpawnRunOptions = Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0];

/**
 * COMPARISON RERUNS through the real coordinator and store, with the child
 * replaced at the driver seam: what argv, env and rows a rerun produces, and
 * what it must never do to the project's line (src/projects/AGENTS.md).
 */

const roots: string[] = [];
const DELIVERED: RunStats = {
  outcome: 'delivered', costUsd: 0.01, llmCalls: 1, opusCalls: 1, sonnetCalls: 0, haikuCalls: 0,
  otherCalls: 0, deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingReasons: [],
  escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0, refusals: 0,
  compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0,
};
const OVERRIDES = {
  l1: 'api:anthropic:claude-haiku-4-5',
  l2: 'api:anthropic:claude-sonnet-4-5',
  l3: 'api:anthropic:claude-opus-4-5',
};
const DRAFT = JSON.stringify({
  items: [
    { behaviour: 'The page shows the current time', check: { kind: 'review' } },
    { behaviour: 'The page is served', check: { kind: 'http', method: 'GET', path: '/' } },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-project-rerun-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin(
    { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false },
    null
  );
  if (!login) throw new Error('owner bootstrap failed');
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId,
    principalId: login.viewer.principalId,
    project: {
      name: 'Clock', slug: 'clock', initialPrompt: 'Build a clock.',
      repositoryTarget: { installationId: '123', owner: 'owner', name: 'clock', visibility: 'private' },
    },
  });
  // Every run writes a file naming ITSELF, so a seed is identifiable by content.
  const driver = vi.fn(async (options: SpawnRunOptions) => {
    const env = options.env ?? {};
    const runId = env['ATOMA_RUN_ID']!;
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    const runs = env['ATOMA_RUNS_DIR']!;
    const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(workspace, 'index.html'), `<h1>${runId}</h1>`, 'utf8');
    writeFileSync(declarations, JSON.stringify({
      version: 1, runId, generatedAt: new Date().toISOString(), outputs: ['index.html'],
    }), 'utf8');
    writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
      id: runId,
      endedAt: new Date().toISOString(),
      result: { summary: 'verified' },
      events: [{ kind: 'llm', role: 'draft-checklist', model: 'm', response: DRAFT }],
    }), 'utf8');
    return formatRunStatsEpilogue(DELIVERED) + '\n✓ build finished\n';
  });
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const coordinator = new ProjectRunCoordinator({
    store,
    dbPath,
    projectsRoot: root,
    hostEnv: { ...haystackTestEnvironment(root), PATH: process.env['PATH'], ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'model-key' },
    driver,
    acquireLease: async () => ({ path: '/test/lease', attachChild: vi.fn(), release: vi.fn() }),
    publisher,
  });
  const start = async (request: Parameters<typeof coordinator.start>[0]['request']) => {
    const run = await coordinator.start({
      orgId: login.viewer.orgId, principalId: login.viewer.principalId, projectId: project.projectId, request,
    });
    await coordinator.waitForIdle();
    return store.getProjectRun(login.viewer.orgId, run.projectRunId)!;
  };
  const seedOf = (call: number): string | undefined => {
    const args = driver.mock.calls[call]?.[0].extraArgs ?? [];
    const at = args.indexOf('--seed');
    return at >= 0 ? args[at + 1] : undefined;
  };
  return { root, dbPath, store, viewer: login.viewer, project, driver, publisher, coordinator, start, seedOf };
}

describe('comparison reruns', () => {
  it('reruns from the state the origin STARTED from, on the requested models, outside the line', async () => {
    const f = fixture();
    const r0 = await f.start({ idempotencyKey: 'r0', goal: 'Build a clock.' });
    const a = await f.start({ idempotencyKey: 'a', goal: 'Add a timezone selector.' });
    expect(r0.seed).toEqual({ kind: 'none' });
    expect(a.seed).toEqual({ kind: 'run', runId: r0.projectRunId });

    const b = await f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
    expect(b.status).toBe('delivered');
    expect(b.rerunOf).toBe(a.projectRunId);
    expect(b.modelOverrides).toEqual(OVERRIDES);
    expect(b.goal).toBe(a.goal);
    // A's seed, not A's own output and not the project's latest run.
    expect(f.seedOf(2)).toBe(r0.hostPaths.workspacePath);
    expect(b.seed).toEqual({ kind: 'run', runId: r0.projectRunId });
    const env = f.driver.mock.calls[2]![0].env!;
    expect([env['ATOMA_MODEL_L1'], env['ATOMA_MODEL_L2'], env['ATOMA_MODEL_L3']]).toEqual([OVERRIDES.l1, OVERRIDES.l2, OVERRIDES.l3]);
    expect(f.store.getRunPayers(f.viewer.orgId, b.projectRunId)?.l2).toMatchObject({ selection: OVERRIDES.l2, source: 'run' });
    // Same protocol as its origin: no comparison arm, no depth override.
    expect(f.driver.mock.calls[2]![0].extraArgs).not.toContain('--comparison');
    expect(f.driver.mock.calls[2]![0].extraArgs).not.toContain('--depth');
    // A drafted its own list; B is judged against THAT list, as a draft.
    expect(readAcceptanceSpec(env)?.items.map((item) => item.behaviour)).toEqual([
      'The page shows the current time', 'The page is served',
    ]);
    expect(env[ACCEPTANCE_SOURCE_ENV]).toBe('drafted');
    expect(f.store.getRunAcceptance(f.viewer.orgId, b.projectRunId)?.source).toBe('drafted');

    // Never published, and a retry is refused before the publisher.
    expect(f.publisher.publish).toHaveBeenCalledTimes(2);
    await expect(f.coordinator.retryPublication(f.viewer.orgId, b.projectRunId)).rejects.toBeInstanceOf(ProjectStateConflict);
    expect(() => f.store.reservePublication({
      orgId: f.viewer.orgId, projectRunId: b.projectRunId, idempotencyKey: 'pub-b',
    })).toThrow(/never published/);

    // The next ordinary run continues the LINE, from A, not from the rerun.
    const c = await f.start({ idempotencyKey: 'c', goal: 'Add an alarm.' });
    expect(f.seedOf(3)).toBe(a.hostPaths.workspacePath);
    expect(c.seed).toEqual({ kind: 'run', runId: a.projectRunId });
  });

  it('is idempotent on its key, and refuses the key for other models or another origin', async () => {
    const f = fixture();
    await f.start({ idempotencyKey: 'r0', goal: 'Build a clock.' });
    const a = await f.start({ idempotencyKey: 'a', goal: 'Add a timezone selector.' });
    const b = await f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
    const again = await f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
    expect(again.projectRunId).toBe(b.projectRunId);
    expect(f.driver).toHaveBeenCalledTimes(3);
    await expect(f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: { ...OVERRIDES, l1: OVERRIDES.l2 } }))
      .rejects.toThrow(/different input/);
    await expect(f.start({ idempotencyKey: 'b', goal: 'Add a timezone selector.' })).rejects.toThrow(/different input/);
  });

  it('copies a user-approved list verbatim and says nothing about its source', async () => {
    const f = fixture();
    const a = await f.start({
      idempotencyKey: 'a', goal: 'Build a clock.',
      acceptanceChecklist: [{ behaviour: 'An unknown path is refused', check: { kind: 'http', method: 'GET', path: '/nope', status: 404 } }],
    });
    const b = await f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
    const origin = f.store.getRunAcceptance(f.viewer.orgId, a.projectRunId)!;
    expect(f.store.getRunAcceptance(f.viewer.orgId, b.projectRunId)).toEqual(origin);
    expect(origin.source).toBe('user');
    const env = f.driver.mock.calls[1]![0].env!;
    expect(env[ACCEPTANCE_SPEC_ENV]).toBe(f.driver.mock.calls[0]![0].env![ACCEPTANCE_SPEC_ENV]);
    expect(env[ACCEPTANCE_SOURCE_ENV]).toBeUndefined();
    // A first run had no seed, and neither does its rerun.
    expect(f.seedOf(1)).toBeUndefined();
    expect(b.seed).toEqual({ kind: 'none' });
  });

  it('finds a legacy origin\'s seed from its retrieval receipt', async () => {
    const f = fixture();
    const r0 = await f.start({ idempotencyKey: 'r0', goal: 'Build a clock.' });
    const a = await f.start({ idempotencyKey: 'a', goal: 'Add a timezone selector.' });
    // A row written before `seed_json` existed: the column is simply NULL.
    const db = new Database(f.dbPath);
    db.exec('DROP TRIGGER project_runs_seed_immutable');
    db.prepare('UPDATE project_runs SET seed_json = NULL WHERE project_run_id = ?').run(a.projectRunId);
    db.close();
    await f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES });
    expect(f.seedOf(2)).toBe(r0.hostPaths.workspacePath);
  });

  it('refuses before reserving when the origin cannot be rerun from where it started', async () => {
    const f = fixture();
    const r0 = await f.start({ idempotencyKey: 'r0', goal: 'Build a clock.' });
    const a = await f.start({ idempotencyKey: 'a', goal: 'Add a timezone selector.' });
    const db = new Database(f.dbPath);
    db.prepare('UPDATE project_runs SET bytes_expired_at = ? WHERE project_run_id = ?').run(new Date().toISOString(), r0.projectRunId);
    db.close();
    await expect(f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: OVERRIDES }))
      .rejects.toThrow(/has expired/);
    await expect(f.start({ idempotencyKey: 'c', rerunOf: '00000000-0000-4000-8000-000000000000', models: OVERRIDES }))
      .rejects.toThrow('project run not found');
    expect(f.store.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(2);
    expect(f.driver).toHaveBeenCalledTimes(2);
  });

  it('refuses a run-level model it cannot honour instead of falling through', async () => {
    const f = fixture();
    const a = await f.start({ idempotencyKey: 'a', goal: 'Build a clock.' });
    // No zai key anywhere: a stored preference would fall through, a rerun must not.
    await expect(f.start({ idempotencyKey: 'b', rerunOf: a.projectRunId, models: { ...OVERRIDES, l1: 'api:zai:glm-4.5-air' } }))
      .rejects.toBeInstanceOf(ProjectRunConfigurationError);
    // A host subscription needs the grant, whatever level names it.
    await expect(f.start({ idempotencyKey: 'c', rerunOf: a.projectRunId, models: { ...OVERRIDES, l2: 'sub:anthropic:sonnet' } }))
      .rejects.toThrow(/host subscription/);
    expect(f.driver).toHaveBeenCalledTimes(1);
  });
});

describe('a store whose payer ledger predates the run level', () => {
  it('is rebuilt so its source CHECK admits run, keeping every row and the immutability trigger', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-payers-migration-'));
    roots.push(root);
    const dbPath = join(root, 'atoma.db');
    AuthStore.open(dbPath).completeLogin(
      { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false },
      null
    );
    const legacy = new Database(dbPath);
    legacy.exec(PROJECT_TABLES_DDL.replace(
      `CHECK (source IN ('run','account','org','host'))`,
      `CHECK (source IN ('account','org','host'))`
    ));
    // A payer row with no run above it: foreign keys off, as the rebuild copies with them off.
    legacy.pragma('foreign_keys = OFF');
    legacy.prepare(`INSERT INTO project_run_payers (project_run_id, tier, org_id, selection, provider, payer, source, recorded_at)
      VALUES ('r', 'l1', 'o', 'api:zai:glm-4.5-air', 'zai-api', 'org-key', 'org', 't')`).run();
    expect(() => legacy.prepare(`INSERT INTO project_run_payers (project_run_id, tier, org_id, selection, provider, payer, source, recorded_at)
      VALUES ('r', 'l2', 'o', 'x', 'y', 'org-key', 'run', 't')`).run()).toThrow(/CHECK constraint failed/);
    legacy.close();

    ProjectStore.open(dbPath);
    closeStoreHandles();

    const after = new Database(dbPath);
    const ddl = after.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_run_payers'`).get() as { sql: string };
    expect(ddl.sql).toContain(`'run'`);
    expect(after.prepare('SELECT selection, source FROM project_run_payers').all()).toEqual([
      { selection: 'api:zai:glm-4.5-air', source: 'org' },
    ]);
    expect(() => after.prepare(`UPDATE project_run_payers SET selection = 'forged'`).run()).toThrow(/immutable/);
    const objects = (after.prepare(`SELECT name FROM sqlite_master WHERE type IN ('index','trigger')`).all() as { name: string }[])
      .map((row) => row.name);
    expect(objects).toEqual(expect.arrayContaining([
      'project_run_payers_org_idx', 'project_run_payers_immutable',
      'project_runs_rerun_immutable', 'project_runs_seed_immutable',
    ]));
    after.close();
  });
});
