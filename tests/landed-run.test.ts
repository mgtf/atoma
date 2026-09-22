import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { dispatchWithAggregation, markLanded } from '../src/atoms/dispatch.js';
import { MIN_PHASE_LANDING_MS, outOfPhaseBudget } from '../src/core/limits.js';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStore, PROJECT_TABLES_DDL } from '../src/projects/store.js';
import { ProjectRunCoordinator, previousSeedRun } from '../src/projects/coordinator.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';
import type { RunStats } from '../src/contracts/runStats.js';
import type { Plan, Result, RunContext } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { haystackTestEnvironment } from './helpers/haystack.js';

/**
 * THE RUN DEADLINE NO LONGER DISCARDS COMPLETED PHASES.
 *
 * Regression cover for the defect measured twice in production on 2026-09-21
 * (`cc894dad`, `d3098d25` — docs/incidents/progressive-runs-2026-09-21.md):
 * three of four phases finished, validated and CREDITED, the fourth aborted
 * mid-flight by the 1800 s deadline, and the run recorded `failed` with no
 * manifest and no publication. 2.83 USD and 3.50 USD bought nothing.
 *
 * The bug lived on TWO sides of a process boundary — the dispatch loop inside
 * the run, and the coordinator that reads the child's epilogue — so this file
 * crosses it too, as `AGENTS.md` requires: the dispatch cases drive the real
 * `dispatchWithAggregation`, and the coordinator cases drive the real
 * coordinator over a driver that returns a child log.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PARTIAL_STATS: RunStats = {
  outcome: 'partial',
  costUsd: 2.83,
  llmCalls: 25,
  opusCalls: 1,
  sonnetCalls: 0,
  haikuCalls: 0,
  otherCalls: 24,
  deterministicPhases: 0,
  deepenings: 0,
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 1,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
  uncoveredObligations: 0,
};

function result(summary: string): Result {
  return {
    output: summary,
    summary,
    trace: [],
    producedBy: { tier: 1, name: 'Methane', viaFallback: false },
  };
}

function plan(mode: Plan['aggregation']['mode'], descriptions: string[]): Plan {
  return {
    reasoning: 'r',
    subtasks: descriptions.map((description) => ({ description })),
    aggregation: { mode },
    expectedOutput: 'anything',
  };
}

/** A ctx whose deadline is `remainingMs` away, with the run signal not yet fired. */
function ctxWithBudget(remainingMs: number): RunContext {
  return { ...makeCtx(), deadlineAt: Date.now() + remainingMs };
}

/**
 * A ctx whose run signal has fired while the clock still reads "plenty left".
 *
 * Artificial by one second and deliberate: it isolates the ABORT route into a
 * landing from the FLOOR route, which would otherwise land the dispatch before
 * a phase could be opened at all. In production both exist and the floor
 * catches most — but `cc894dad` reached the deadline inside a phase, which is
 * this one.
 */
function ctxAbortedMidPhase(): RunContext {
  const controller = new AbortController();
  controller.abort(new Error('The operation was aborted due to timeout'));
  return { ...makeCtx(), signal: controller.signal, deadlineAt: Date.now() + 30 * 60_000 };
}

describe('the phase-landing floor', () => {
  it('refuses a phase only when the remaining budget is under the floor', () => {
    expect(outOfPhaseBudget(Date.now() + MIN_PHASE_LANDING_MS + 1)).toBe(false);
    expect(outOfPhaseBudget(Date.now() + MIN_PHASE_LANDING_MS - 1_000)).toBe(true);
    expect(outOfPhaseBudget(Date.now() - 1)).toBe(true);
    // A context with no deadline is a library or test context, and never lands:
    // the deadline has to be KNOWN to be enforced.
    expect(outOfPhaseBudget(undefined)).toBe(false);
    expect(outOfPhaseBudget(Number.NaN)).toBe(false);
  });
});

describe('a sequential dispatch landing on the run deadline', () => {
  it('stops opening phases the budget cannot pay for, and keeps the ones it ran', async () => {
    const ctx = ctxWithBudget(MIN_PHASE_LANDING_MS - 5_000);
    const ran: number[] = [];
    const outcome = await dispatchWithAggregation(
      plan('sequential', ['implement', 'harden', 'document']).subtasks,
      plan('sequential', ['implement', 'harden', 'document']),
      ctx,
      async (_subtask, idx) => {
        ran.push(idx);
        return result(`phase ${idx + 1}`);
      }
    );
    // Phase 1 runs whatever the clock says — a dispatch with nothing accepted
    // has nothing to land on, so it spends what it has left trying. Phases 2
    // and 3 are refused because under the floor they cannot finish.
    expect(ran).toEqual([0]);
    expect(outcome.results.map((r) => r.summary)).toEqual(['phase 1']);
    expect(outcome.unfinished.map((s) => s.description)).toEqual(['harden', 'document']);
  });

  it('keeps the completed phases when the deadline aborts the phase in flight', async () => {
    // The exact shape of `cc894dad`: phases 1-3 credited, phase 4 opened, its
    // execute call aborted by the deadline, and everything discarded.
    const ctx = ctxAbortedMidPhase();
    const subtasks = ['implement', 're-audit', 'README', 'package'];
    const outcome = await dispatchWithAggregation(
      plan('sequential', subtasks).subtasks,
      plan('sequential', subtasks),
      ctx,
      async (_subtask, idx) => {
        if (idx === 3) throw new Error('The operation was aborted due to timeout');
        return result(`phase ${idx + 1}`);
      }
    );
    expect(outcome.results).toHaveLength(3);
    expect(outcome.unfinished.map((s) => s.description)).toEqual(['package']);
  });

  it('still throws when the deadline lands before any phase completed', async () => {
    const ctx = ctxAbortedMidPhase();
    await expect(
      dispatchWithAggregation(
        plan('sequential', ['implement', 'document']).subtasks,
        plan('sequential', ['implement', 'document']),
        ctx,
        async () => {
          throw new Error('The operation was aborted due to timeout');
        }
      )
    ).rejects.toThrow(/aborted/);
  });

  it('never turns a genuine failure into a landing', async () => {
    // The signal is untouched, so this is a real error and keeps its meaning
    // whatever has already succeeded.
    const ctx = ctxWithBudget(30 * 60_000);
    await expect(
      dispatchWithAggregation(
        plan('sequential', ['implement', 'document']).subtasks,
        plan('sequential', ['implement', 'document']),
        ctx,
        async (_subtask, idx) => {
          if (idx === 1) throw new Error('validator rejected the result');
          return result('phase 1');
        }
      )
    ).rejects.toThrow('validator rejected the result');
  });
});

describe('a parallel dispatch landing on the run deadline', () => {
  it('keeps the branches that settled when the deadline cut their siblings', async () => {
    const ctx = ctxAbortedMidPhase();
    const subtasks = ['api', 'cli', 'page'];
    const outcome = await dispatchWithAggregation(
      plan('concat', subtasks).subtasks,
      plan('concat', subtasks),
      ctx,
      async (_subtask, idx) => {
        if (idx === 1) throw new Error('The operation was aborted due to timeout');
        return result(`branch ${idx + 1}`);
      }
    );
    expect(outcome.results.map((r) => r.summary)).toEqual(['branch 1', 'branch 3']);
    expect(outcome.unfinished.map((s) => s.description)).toEqual(['cli']);
  });

  it('throws a genuine error even when siblings settled', async () => {
    const ctx = ctxWithBudget(30 * 60_000);
    await expect(
      dispatchWithAggregation(
        plan('concat', ['api', 'cli']).subtasks,
        plan('concat', ['api', 'cli']),
        ctx,
        async (_subtask, idx) => {
          if (idx === 1) throw new Error('sandbox refused the write');
          return result('branch 1');
        }
      )
    ).rejects.toThrow('sandbox refused the write');
  });

  it('awaits every branch before reporting, so nothing is left running unobserved', async () => {
    const ctx = ctxAbortedMidPhase();
    const drained: string[] = [];
    await dispatchWithAggregation(
      plan('concat', ['fast', 'slow']).subtasks,
      plan('concat', ['fast', 'slow']),
      ctx,
      async (_subtask, idx) => {
        if (idx === 0) throw new Error('The operation was aborted due to timeout');
        await new Promise((resolve) => setTimeout(resolve, 20));
        drained.push('slow');
        return result('slow');
      }
    );
    expect(drained).toEqual(['slow']);
  });
});

describe('what a landed result says about itself', () => {
  it('names the phases that never ran and marks the summary INCOMPLETE', () => {
    const marked = markLanded(result('wrote index.html'), [
      { description: 'write the README' },
    ] as Plan['subtasks']);
    expect(marked.unfinishedPhases).toEqual(['write the README']);
    expect(marked.summary.startsWith('INCOMPLETE —')).toBe(true);
    expect(marked.summary).toContain('write the README');
    expect(marked.summary).toContain('wrote index.html');
  });

  it('unions what a phase below already reported, so a nested landing survives', () => {
    const fromBelow: Result = { ...result('built the API'), unfinishedPhases: ['smoke the API'] };
    const marked = markLanded(fromBelow, [{ description: 'package' }] as Plan['subtasks']);
    expect(marked.unfinishedPhases).toEqual(['smoke the API', 'package']);
  });

  it('leaves a complete dispatch untouched', () => {
    const complete = result('done');
    expect(markLanded(complete, [])).toBe(complete);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-landed-run-'));
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
      name: 'Notes',
      slug: 'notes',
      initialPrompt: 'Build a notes service.',
      repositoryTarget: { installationId: '123', owner: 'owner', name: 'notes', visibility: 'private' },
    },
  });
  return { root, dbPath, store, viewer: login.viewer, project };
}

/** A child that landed: it wrote real files and reported a `partial` epilogue. */
function landedDriver() {
  return vi.fn(async (options: { env?: Record<string, string | undefined>; onSpawn?: (pid: number) => void }) => {
    const env = options.env ?? {};
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    const runs = env['ATOMA_RUNS_DIR']!;
    const runId = env['ATOMA_RUN_ID']!;
    const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(runs, { recursive: true });
    mkdirSync(join(declarations, '..'), { recursive: true });
    writeFileSync(join(workspace, 'server.mjs'), 'export const ok = true;\n', 'utf8');
    writeFileSync(
      declarations,
      JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        // The plan declared the README too. It is NOT on disk, because the
        // phase that would have written it never ran — and that is not a
        // contradiction the host should refuse.
        outputs: ['server.mjs', 'README.md'],
      }),
      'utf8'
    );
    writeFileSync(
      join(runs, `${runId}.json`),
      JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'INCOMPLETE — …', unfinishedPhases: ['write the README'] },
      }),
      'utf8'
    );
    options.onSpawn?.(4242);
    return (
      formatRunStatsEpilogue(PARTIAL_STATS) +
      '\n◐ build LANDED on its budget: 1 phase(s) were never run\n' +
      '  not run: write the README\n'
    );
  });
}

describe('a landed run, across the coordinator boundary', () => {
  it('records partial with its real manifest, and never publishes it', async () => {
    const f = fixture();
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: {
        ...haystackTestEnvironment(f.root),
        PATH: process.env['PATH'],
        ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5',
        ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
        ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'model-key',
      },
      driver: landedDriver(),
      acquireLease: async () => ({ path: '/test/lease', attachChild: vi.fn(), release: vi.fn() }),
      publisher: publisher,
    });

    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'landed-1', goal: 'Build a notes service.' },
    });
    await coordinator.waitForIdle();

    const finished = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    // NOT 'failed'. That is the whole defect: this run completed a phase, and
    // the phase's bytes are on disk.
    expect(finished.status).toBe('partial');
    expect(finished.traceId).toBe(started.projectRunId);
    // The manifest reports what the workspace ACTUALLY holds, not what the plan
    // declared: the README the unrun phase would have written is absent.
    expect(finished.artifactManifest?.files.map((file) => file.path)).toEqual(['server.mjs']);
    expect(finished.stats?.costUsd).toBe(2.83);
    expect(finished.error).toContain('write the README');
    // Publication is reserved for a complete delivery, by the operator's
    // decision of 2026-09-22.
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('seeds the next run of the project from the landed workspace', async () => {
    const f = fixture();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: {
        ...haystackTestEnvironment(f.root),
        PATH: process.env['PATH'],
        ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5',
        ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
        ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5',
        ANTHROPIC_API_KEY: 'model-key',
      },
      driver: landedDriver(),
      acquireLease: async () => ({ path: '/test/lease', attachChild: vi.fn(), release: vi.fn() }),
    });
    const first = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'landed-2', goal: 'Build a notes service.' },
    });
    await coordinator.waitForIdle();
    expect(f.store.getProjectRun(f.viewer.orgId, first.projectRunId)!.status).toBe('partial');

    // THE HALF THAT RECOVERS THE SPEND. A landed run is the project's seed, so
    // the customer's next run continues from the phases that did complete
    // instead of rebuilding them. Without this the partial status would be a
    // nicer label on the same loss.
    const seed = previousSeedRun(f.store, f.viewer.orgId, f.project.projectId);
    expect(seed?.projectRunId).toBe(first.projectRunId);
  });
});

describe('a store created before landed runs existed', () => {
  it('is rebuilt so its status CHECK admits partial', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-landed-migration-'));
    roots.push(root);
    const dbPath = join(root, 'atoma.db');

    // Build the store as it was BEFORE 2026-09-22: the same DDL with the
    // narrow CHECK, plus one of the additive columns that lives only in the
    // migration and not in the DDL constant.
    // The auth tables first: `project_runs` has foreign keys into them, so a
    // bare store cannot even hold the legacy definition.
    AuthStore.open(dbPath).completeLogin(
      { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false },
      null
    );
    const legacy = new Database(dbPath);
    legacy.exec(
      PROJECT_TABLES_DDL.replace(
        `CHECK (status IN ('queued','running','delivered','partial','failed','cancelled'))`,
        `CHECK (status IN ('queued','running','delivered','failed','cancelled'))`
      )
    );
    legacy.exec('ALTER TABLE project_runs ADD COLUMN bytes_expired_at TEXT');
    legacy.close();

    // A narrow store refuses the row the landing needs to write.
    const before = new Database(dbPath);
    expect(() =>
      before
        .prepare(
          `INSERT INTO project_runs (project_run_id, project_id, org_id, requested_by_principal_id,
             request_key, goal, status, workspace_path, runs_path, log_path, created_at, updated_at)
           VALUES ('r','p','o','pr','k','g','partial','/w','/r','/l','t','t')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
    before.close();

    // Opening it through the store rebuilds the table.
    ProjectStore.open(dbPath);

    const after = new Database(dbPath);
    const ddl = after
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_runs'`)
      .get() as { sql: string };
    expect(ddl.sql).toContain(`'partial'`);
    // The column that lived only in the additive migration survived the copy.
    const columns = (after.prepare('PRAGMA table_info(project_runs)').all() as { name: string }[]).map(
      (column) => column.name
    );
    expect(columns).toContain('bytes_expired_at');
    // The drop took the indexes and the identity trigger with it; re-running
    // the DDL is what brings them back.
    const objects = (
      after
        .prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'project_runs' AND type IN ('index','trigger')`)
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(objects).toContain('project_runs_org_status_idx');
    expect(objects).toContain('project_runs_identity_immutable');
    after.close();
  });
});
