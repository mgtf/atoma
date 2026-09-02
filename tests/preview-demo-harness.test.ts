import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { PROJECT_TABLES_DDL, ProjectStore } from '../src/projects/store.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { PreviewStore } from '../src/preview/store.js';

/**
 * `npm run preview:demo` — the harness that makes the preview clickable on a
 * machine that cannot run the real thing.
 *
 * WHY THIS IS TESTED AT ALL, given it is development tooling: the harness
 * writes a workspace at a path it DERIVES, and the visualizer later looks for
 * that workspace at a path IT derives (`workspaceOf` in `src/viz/server.ts`
 * recomputes the layout rather than reading the stored row). Two derivations
 * of one path is exactly the coupling that breaks silently — the button would
 * appear, the open would fail, and nothing would say which of the two moved.
 *
 * It crosses the PROCESS boundary on purpose. The script is `.mjs` run under
 * tsx, so an in-process import would prove neither that it parses nor that its
 * dynamic imports of `src/**` resolve the way `npm run preview:demo` resolves
 * them.
 */

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'preview-demo.mjs');

let root: string;
let dbPath: string;
let projectsRoot: string;
let orgId: string;
let principalId: string;

/**
 * `ATOMA_PROJECTS_ROOT` is OPTIONAL here on purpose.
 *
 * Always setting it is what hid the defect this file exists to catch: the
 * script and the server each derived the workspace path from their own
 * default, the two defaults differed, and a suite that pinned the variable in
 * every case could not see it. The unset case is now a test of its own.
 */
function seedEnv(withRoot = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ATOMA_DB_PATH: dbPath };
  if (withRoot) env['ATOMA_PROJECTS_ROOT'] = projectsRoot;
  else delete env['ATOMA_PROJECTS_ROOT'];
  return env;
}

async function seed(withRoot = true): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), SCRIPT, '--seed'], {
    cwd: REPO,
    env: seedEnv(withRoot),
    timeout: 120_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-demo-'));
  dbPath = join(root, 'atoma.db');
  projectsRoot = join(root, 'projects');
  orgId = randomUUID();
  principalId = randomUUID();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Read the store and CLOSE IT.
 *
 * Windows refuses to remove a file an open handle still holds, so a reader
 * that leaked one turned every teardown into `EPERM` and reported four
 * failures for one mistake. Scoping the handle is the fix, not a retry loop.
 */
function readStore<T>(read: (deps: { projects: ProjectStore; previews: PreviewStore }) => T): T {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    // ONE handle for both stores. `PreviewStore.open` would take a second, and
    // a store with no `close()` cannot give it back.
    return read({ projects: new ProjectStore(db), previews: new PreviewStore(db) });
  } finally {
    db.close();
  }
}

/** The one seeded project and its runs, newest last. */
function seeded(): { projectId: string; runs: ReturnType<ProjectStore['listProjectRuns']> } {
  return readStore(({ projects }) => {
    const project = (projects.listProjects(orgId) ?? [])[0];
    if (!project) throw new Error('no project was seeded');
    return { projectId: project.projectId, runs: projects.listProjectRuns(orgId, project.projectId) };
  });
}

/** The rows a first login leaves behind, and nothing more. */
function foundOrganisation(): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(AUTH_TABLES_DDL);
  db.exec(PROJECT_TABLES_DDL);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)').run(
    orgId,
    'Demo Org',
    now
  );
  db.prepare(
    `INSERT INTO auth_principals (principal_id, kind, display_name, created_at)
     VALUES (?, 'human', ?, ?)`
  ).run(principalId, 'Preview Demo', now);
  db.prepare(
    `INSERT INTO auth_memberships (org_id, principal_id, role, created_at)
     VALUES (?, ?, 'org:owner', ?)`
  ).run(orgId, principalId, now);
  db.close();
}

describe('the preview demo harness', () => {
  it('refuses to invent an organisation, and says how to get one', async () => {
    // The organisation is founded by the FIRST LOGIN. A harness that created
    // one would seed into an org the browser session does not belong to, and
    // every read would 404 with the project sitting right there in the store.
    const failure = await seed().catch((error: unknown) => error as { stderr: string; code: number });

    expect('stderr' in failure ? failure.stderr : '').toMatch(/no store at|No organisation/);
  });

  it('seeds a run the real classifier calls previewable', async () => {
    foundOrganisation();

    const { stdout } = await seed();

    expect(stdout).toContain('classified available (static)');
    // STATIC is the point: that branch starts no container at all
    // (`src/preview/manager.ts`), so it is the half of the machinery a laptop
    // without gVisor can actually run.
    const { runs } = seeded();
    const projectRun = (runs ?? [])[0];
    expect(projectRun).toBeDefined();

    const descriptor = readStore(({ previews }) =>
      previews.getDescriptor(orgId, projectRun!.projectRunId)
    );
    expect(descriptor?.availability).toBe('available');
    expect(descriptor?.kind).toBe('static');
    // No egress: nothing was requested, so nothing can be approved.
    expect(descriptor?.requestedHosts).toEqual([]);
  });

  it('writes the workspace where the SERVER will look for it', async () => {
    foundOrganisation();
    await seed();

    const { projectId, runs } = seeded();
    const projectRun = (runs ?? [])[0]!;

    // THE COUPLING THIS FILE EXISTS FOR. `src/viz/server.ts` derives
    // `workspaceOf` from this same helper and its own PROJECTS_ROOT; it never
    // reads the path the store recorded. If the two derivations drift, the
    // Preview button appears and the open fails on an empty directory.
    const layout = projectRunHostLayout(projectsRoot, orgId, projectId, projectRun.projectRunId);
    expect(existsSync(join(layout.workspacePath, 'index.html'))).toBe(true);
    expect(readFileSync(join(layout.workspacePath, 'index.html'), 'utf8')).toContain(
      'This page is the deliverable'
    );
  });

  it('writes the trace, without which the run never reaches the runs index', async () => {
    foundOrganisation();
    await seed();

    const { projectId, runs } = seeded();
    const projectRun = (runs ?? [])[0]!;
    const layout = projectRunHostLayout(projectsRoot, orgId, projectId, projectRun.projectRunId);

    // `resolveProjectRunTraceFile` drops a run with no trace file, and a run
    // the index does not carry never reaches the summary card the preview
    // control is drawn beside — the button would be missing with the
    // descriptor sitting there saying `available`.
    const trace = join(layout.runsPath, `${projectRun.projectRunId}.json`);
    expect(existsSync(trace)).toBe(true);
    const parsed = JSON.parse(readFileSync(trace, 'utf8')) as Record<string, unknown>;
    expect(parsed['id']).toBe(projectRun.projectRunId);
    expect(Array.isArray(parsed['events'])).toBe(true);
    expect(projectRun.status).toBe('delivered');
  });

  it('records a workspace the SERVER can find with ATOMA_PROJECTS_ROOT unset', async () => {
    // THE DEFECT THIS PINS, and the reason the variable is optional above: the
    // script derived the workspace from its own default while the server
    // derived it from `DEFAULT_PROJECTS_ROOT`, and the two differed. With the
    // variable unset — the ordinary case — the seed wrote where the server
    // never looked: the Preview button appeared and the click failed on an
    // empty copy, with nothing saying which derivation had moved.
    //
    // The server now READS the path off the run row, so what this asserts is
    // the property that makes that safe: the recorded path is where the bytes
    // actually are.
    foundOrganisation();

    await seed(false);

    const { runs } = seeded();
    const projectRun = (runs ?? [])[0]!;
    expect(existsSync(join(projectRun.hostPaths.workspacePath, 'index.html'))).toBe(true);
    // And it is the coordinator's own layout, not a third convention.
    expect(projectRun.hostPaths.workspacePath).toContain(join('.atoma', 'orgs'));
    rmSync(projectRun.hostPaths.workspacePath, { recursive: true, force: true });
  });

  it('is idempotent enough to run twice: one project, a second run', async () => {
    foundOrganisation();
    await seed();
    await seed();

    const all = readStore(({ projects }) => projects.listProjects(orgId) ?? []);
    // The slug is unique per organisation, so a second seed must REUSE the
    // project rather than fail on the constraint.
    expect(all).toHaveLength(1);
    expect((seeded().runs ?? []).length).toBe(2);
  });

  it('prints a configuration whose preview domain does not collide with the visualizer', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), SCRIPT, '--env'],
      { cwd: REPO, timeout: 60_000 }
    );

    // The harness's whole value is that its printed config BOOTS. A domain
    // sharing a registrable domain with the visualizer origin is refused by
    // `snapshotPreviewConfig`, so printing one would be printing a trap.
    expect(stdout).toContain('ATOMA_VIZ_PUBLIC_ORIGIN=http://127.0.0.1:5173');
    // The three conditions the cleartext profile refuses to resolve without,
    // printed together — a block missing one is a block that will not boot.
    expect(stdout).toContain('ATOMA_PREVIEW_DOMAIN=previews.localhost');
    expect(stdout).toContain('ATOMA_PREVIEW_ALLOW_HTTP_DEV=1');
    expect(stdout).toContain('ATOMA_PREVIEW_GATEWAY_HOST=127.0.0.1');
    // And the image is pinned by digest, because the config refuses a tag.
    expect(stdout).toMatch(/ATOMA_PREVIEW_IMAGE=\S+@sha256:[a-f0-9]{64}/);
  });
});
