import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ACCEPTANCE_SOURCE_ENV,
  ACCEPTANCE_SPEC_ENV,
  MAX_CHECKLIST_ITEMS,
  approvedChecklistInputSchema,
  coverAcceptanceChecklist,
  parseChecklistLines,
  renderChecklistCoverage,
} from '../src/contracts/acceptanceChecklist.js';
import { createProjectRunInputSchema } from '../src/contracts/projects.js';
import { captureAcceptanceSpec, encodeAcceptanceSpec, readAcceptanceSource, readAcceptanceSpec } from '../src/run/acceptanceSpec.js';
import { withAcceptanceChecklist } from '../src/run/depth.js';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStateConflict, ProjectStore } from '../src/projects/store.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { haystackTestEnvironment } from './helpers/haystack.js';

/**
 * USER-APPROVED ACCEPTANCE CRITERIA — docs/acceptance-contract-2026-09-14.md.
 *
 * The list crosses THREE boundaries before a model sees it: the API schema,
 * the project store's reservation transaction, and the coordinator → child
 * environment. Every one of them refuses rather than repairs, because a
 * criterion the user approved and the run silently lost is the failure the
 * contract names. This file crosses each boundary with the real code.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const LIST = [
  { behaviour: 'lists the notes', check: { kind: 'http' as const, method: 'GET', path: '/api/notes' } },
  { behaviour: 'an unknown id is refused', check: { kind: 'http' as const, method: 'GET', path: '/api/notes/:id', status: 404 } },
  { behaviour: 'the page shows the monthly total', check: { kind: 'review' as const } },
];

describe('the line grammar', () => {
  it('reads http criteria only from an uppercase method and an absolute path, and keeps every other line as written', () => {
    const { items, errors } = parseChecklistLines([
      'GET /api/notes/:id 404 — an unknown id is refused',
      '- POST /api/notes: creates a note',
      '',
      'DELETE /api/notes/:id',
      'Get the monthly total under the chart',
      '* The page shows 2024 figures',
      'GET /api/report 2024 figures',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { behaviour: 'an unknown id is refused', check: { kind: 'http', method: 'GET', path: '/api/notes/:id', status: 404 } },
      { behaviour: 'creates a note', check: { kind: 'http', method: 'POST', path: '/api/notes' } },
      { behaviour: 'DELETE /api/notes/:id', check: { kind: 'http', method: 'DELETE', path: '/api/notes/:id' } },
      { behaviour: 'Get the monthly total under the chart', check: { kind: 'review' } },
      { behaviour: 'The page shows 2024 figures', check: { kind: 'review' } },
      { behaviour: '2024 figures', check: { kind: 'http', method: 'GET', path: '/api/report' } },
    ]);
  });

  it('reports a bad line by number and a thirteenth criterion, instead of dropping either', () => {
    const tooLong = parseChecklistLines(`ok\n${'x'.repeat(161)}`);
    expect(tooLong.items).toHaveLength(1);
    expect(tooLong.errors.map((error) => error.line)).toEqual([2]);
    const many = parseChecklistLines(Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, i) => `criterion ${i}`).join('\n'));
    expect(many.errors).toEqual([{ line: 0, message: `at most ${MAX_CHECKLIST_ITEMS} criteria` }]);
  });

  it('reads the host notation and a parenthesised status as the status (review 1.5)', () => {
    const { items, errors } = parseChecklistLines([
      'GET /api/notes/:id → 404',
      'GET /api/notes/:id -> 404: unknown id',
      'GET /api/notes/:id (404) unknown id',
      // As people end a sentence or skip the space (2026-09-25 adversarial review).
      'GET /api/notes/:id 404.',
      'GET /api/notes/:id → 404.',
      'GET /api/notes/:id→404',
      'GET /api/notes/:id(404)',
      'DELETE /api/notes/:id: 404 when it does not exist',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(items.map((item) => item.check)).toEqual([
      ...Array.from({ length: 7 }, () => ({ kind: 'http', method: 'GET', path: '/api/notes/:id', status: 404 })),
      { kind: 'http', method: 'DELETE', path: '/api/notes/:id', status: 404 },
    ]);
  });

  it('refuses an http line that names a status where it is not read, instead of accepting any 2xx', () => {
    // Read as written, each would be a 2xx check shown OBSERVED on the happy
    // path, for an error the run never provoked (2026-09-25 review, 1.5).
    for (const line of [
      'POST /api/notes returns 400 for invalid input',
      'POST /api/notes returns 400.',
      'GET /api/notes/:id — 404 for an unknown id',
    ]) {
      const { items, errors } = parseChecklistLines(line);
      expect(items).toEqual([]);
      expect(errors[0]?.message).toMatch(/names \d{3} but not where its status is read/);
    }
  });

  it('refuses a second status in the text, which the one check would never exercise', () => {
    const { items, errors } = parseChecklistLines('POST /api/notes 201 — and 400 when the title is missing');
    expect(items).toEqual([]);
    expect(errors[0]?.message).toMatch(/checks 201 but also names 400; write one criterion per expected status/);
    expect(parseChecklistLines('POST /api/notes 201 — creates a note and returns 201').errors).toEqual([]);
  });

  it('does not read a count, a port or a version in the text as a status', () => {
    const { items, errors } = parseChecklistLines([
      'GET /api/items returns the first 100 items',
      'GET /api/items returns 300 items at most',
      'GET / serves the page on localhost:300',
      'GET /api/report 2024 figures',
      'GET /api/v2/items lists items in schema 2.500.1',
    ].join('\n'));
    // `300 items` is a count the grammar cannot tell from a status: refused, not guessed.
    expect(errors.map((error) => error.line)).toEqual([2]);
    expect(items.map((item) => item.check)).toEqual([
      { kind: 'http', method: 'GET', path: '/api/items' },
      { kind: 'http', method: 'GET', path: '/' },
      { kind: 'http', method: 'GET', path: '/api/report' },
      { kind: 'http', method: 'GET', path: '/api/v2/items' },
    ]);
  });

  it('refuses at the door a list the child could not be handed (review 2.3)', () => {
    const escapeHeavy = Array.from({ length: MAX_CHECKLIST_ITEMS }, () => ({
      behaviour: '\u0001'.repeat(160), check: { kind: 'http' as const, method: 'GET', path: `/${'\u0001'.repeat(199)}` },
    }));
    const parsed = approvedChecklistInputSchema.safeParse(escapeHeavy);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/too long together/);
  });
});

describe('capture and transport', () => {
  it('numbers in submitted order and digests the canonical form, whatever the key order submitted', () => {
    const spec = captureAcceptanceSpec(LIST);
    expect(spec.items.map((item) => item.id)).toEqual(['c1', 'c2', 'c3']);
    const reordered = captureAcceptanceSpec([
      { check: { status: 404, path: '/api/notes', method: 'get', kind: 'http' }, behaviour: 'x' },
    ]);
    const canonical = captureAcceptanceSpec([
      { behaviour: 'x', check: { kind: 'http', method: 'GET', path: '/api/notes', status: 404 } },
    ]);
    expect(reordered.digest).toBe(canonical.digest);
    expect(captureAcceptanceSpec([...LIST].reverse()).digest).not.toBe(spec.digest);
  });

  it('refuses an unknown key, an id, an empty list and a thirteenth item at the API schema', () => {
    const base = { goal: 'Build a notes API', idempotencyKey: 'k-1' };
    expect(createProjectRunInputSchema.safeParse({ ...base, acceptanceChecklist: LIST }).success).toBe(true);
    for (const acceptanceChecklist of [
      [{ ...LIST[0], extra: true }],
      [{ ...LIST[0], id: 'c7' }],
      [{ behaviour: 'x', check: { kind: 'review', note: 'y' } }],
      [],
      Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, () => LIST[2]),
    ]) {
      expect(createProjectRunInputSchema.safeParse({ ...base, acceptanceChecklist }).success).toBe(false);
    }
  });

  it('reads the spec back from the environment and THROWS on anything it cannot trust', () => {
    const spec = captureAcceptanceSpec(LIST);
    expect(readAcceptanceSpec({})).toBeNull();
    expect(readAcceptanceSpec({ [ACCEPTANCE_SPEC_ENV]: encodeAcceptanceSpec(spec) })).toEqual(spec);
    const forged = { ...spec, items: spec.items.map((item) => item.id === 'c2'
      ? { ...item, check: { kind: 'http' as const, method: 'GET' as const, path: '/api/notes/:id', status: 200 } } : item) };
    expect(() => readAcceptanceSpec({ [ACCEPTANCE_SPEC_ENV]: JSON.stringify(forged) })).toThrow(/digest/);
    expect(() => readAcceptanceSpec({ [ACCEPTANCE_SPEC_ENV]: '{not json' })).toThrow(/not valid JSON/);
    expect(() => readAcceptanceSpec({ [ACCEPTANCE_SPEC_ENV]: JSON.stringify({ ...spec, items: [] }) })).toThrow(/invalid/);
    expect(() => readAcceptanceSpec({ [ACCEPTANCE_SPEC_ENV]: 'x'.repeat(20_000) })).toThrow(/exceeds/);
  });

  it('reads who wrote the carried spec, and refuses a label it cannot place', () => {
    const encoded = encodeAcceptanceSpec(captureAcceptanceSpec(LIST));
    expect(readAcceptanceSource({})).toBe('user');
    expect(readAcceptanceSource({ [ACCEPTANCE_SPEC_ENV]: encoded })).toBe('user');
    expect(readAcceptanceSource({ [ACCEPTANCE_SPEC_ENV]: encoded, [ACCEPTANCE_SOURCE_ENV]: 'drafted' })).toBe('drafted');
    expect(() => readAcceptanceSource({ [ACCEPTANCE_SPEC_ENV]: encoded, [ACCEPTANCE_SOURCE_ENV]: 'user' })).toThrow(/must be/);
    expect(() => readAcceptanceSource({ [ACCEPTANCE_SOURCE_ENV]: 'drafted' })).toThrow(/without/);
    // A rerun of an origin judged without a list: nothing to carry, nothing to draft.
    expect(readAcceptanceSource({ [ACCEPTANCE_SOURCE_ENV]: 'none' })).toBe('none');
    expect(() => readAcceptanceSource({ [ACCEPTANCE_SPEC_ENV]: encoded, [ACCEPTANCE_SOURCE_ENV]: 'none' })).toThrow(/beside/);
  });
});

describe('what the planner and the acceptor read', () => {
  const spec = captureAcceptanceSpec(LIST);

  it('says who wrote the list', () => {
    const task = { description: 'Build a notes API' };
    const user = withAcceptanceChecklist(task, spec.items, 'user').inputs?.['acceptanceChecklist'] as { note: string; items: string[] };
    expect(user.note).toMatch(/^Approved by the user before launch/);
    expect(user.items[1]).toBe('c2: an unknown id is refused (GET /api/notes/:id → 404)');
    const drafted = withAcceptanceChecklist(task, spec.items).inputs?.['acceptanceChecklist'] as { note: string };
    expect(drafted.note).toMatch(/^Drafted from the goal/);
    expect(withAcceptanceChecklist(task, [], 'user')).toBe(task);
  });

  it('renders a user list of review items alone, which a drafted one never does', () => {
    const reviewOnly = captureAcceptanceSpec([LIST[2]!]).items;
    const coverage = coverAcceptanceChecklist(reviewOnly, []);
    expect(renderChecklistCoverage(reviewOnly, coverage)).toBe('');
    const block = renderChecklistCoverage(reviewOnly, coverage, { source: 'user' });
    expect(block).toMatch(/^ACCEPTANCE CRITERIA — approved by the user before launch/);
    expect(block).toContain('- [REVIEW] c1 the page shows the monthly total (judged by review)');
    expect(block).toMatch(/decides nothing by itself/);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-acceptance-'));
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

function reserve(f: ReturnType<typeof fixture>, request: Parameters<ProjectStore['createProjectRun']>[0]['request']) {
  return f.store.createProjectRun({
    orgId: f.viewer.orgId,
    principalId: f.viewer.principalId,
    projectId: f.project.projectId,
    request,
    hostPaths: { workspacePath: join(f.root, 'w'), runsPath: join(f.root, 'r'), logPath: join(f.root, 'l.log') },
  })!;
}

describe('the project store', () => {
  it('captures the list with the reservation, immutably, and reads it back re-digested', () => {
    const f = fixture();
    const { run } = reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-1', acceptanceChecklist: LIST });
    const stored = f.store.getRunAcceptanceSpec(f.viewer.orgId, run.projectRunId);
    expect(stored).toEqual(captureAcceptanceSpec(LIST));
    const db = new Database(f.dbPath);
    try {
      expect(() => db.prepare("UPDATE project_run_acceptance SET spec_json = '{}' WHERE project_run_id = ?").run(run.projectRunId))
        .toThrow(/immutable/);
    } finally { db.close(); }
    const { run: plain } = reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-2' });
    expect(f.store.getRunAcceptanceSpec(f.viewer.orgId, plain.projectRunId)).toBeNull();
  });

  it('treats the same key and goal with a different list as a different request, never a retry', () => {
    const f = fixture();
    const first = reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-1', acceptanceChecklist: LIST });
    const retry = reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-1', acceptanceChecklist: LIST });
    expect(retry).toEqual({ run: first.run, created: false });
    expect(() => reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-1', acceptanceChecklist: LIST.slice(0, 2) }))
      .toThrow(ProjectStateConflict);
    expect(() => reserve(f, { goal: 'Build a notes API', idempotencyKey: 'k-1' })).toThrow(ProjectStateConflict);
  });
});

describe('across the coordinator boundary', () => {
  it('hands the child the list the STORE captured, in the environment and never in argv', async () => {
    const f = fixture();
    const driver = vi.fn(async (options: { env?: Record<string, string | undefined>; extraArgs?: readonly string[] }) => {
      void options;
      return '';
    });
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
      driver,
      acquireLease: async () => ({ path: '/test/lease', attachChild: vi.fn(), release: vi.fn() }),
    });
    await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'coord-1', goal: 'Build a notes API', acceptanceChecklist: LIST },
    });
    await coordinator.waitForIdle();
    const call = driver.mock.calls[0]?.[0];
    expect(readAcceptanceSpec(call?.env ?? {})).toEqual(captureAcceptanceSpec(LIST));
    expect((call?.extraArgs ?? []).join(' ')).not.toContain('monthly total');

    const plain = vi.fn(async () => '');
    const second = new ProjectRunCoordinator({
      store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: { ...haystackTestEnvironment(f.root), PATH: process.env['PATH'],
        ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5', ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-5',
        ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5', ANTHROPIC_API_KEY: 'model-key' },
      driver: plain,
      acquireLease: async () => ({ path: '/test/lease', attachChild: vi.fn(), release: vi.fn() }),
    });
    await second.start({
      orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { idempotencyKey: 'coord-2', goal: 'Build a notes API' },
    });
    await second.waitForIdle();
    const env = (plain.mock.calls[0] as unknown as [{ env?: Record<string, string | undefined> }] | undefined)?.[0].env ?? {};
    expect(env[ACCEPTANCE_SPEC_ENV]).toBeUndefined();
  });
});
