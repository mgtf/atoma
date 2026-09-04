#!/usr/bin/env node
/**
 * `npm run preview:demo` — one command between a fresh checkout and a Preview
 * button you can click.
 *
 * WHY THIS EXISTS. The preview surface is gated three ways, and every one of
 * them is correct in production and in the way on a laptop:
 *
 *   1. previews REQUIRE the auth gate, which requires a complete OAuth client;
 *   2. creating a project REQUIRES an active GitHub App installation
 *      (`src/projects/service.ts`, 400 otherwise);
 *   3. executing a run REQUIRES a POSIX run host (`src/run/platform.ts`), so a
 *      Windows developer cannot produce a deliverable at all.
 *
 * None of those is worth weakening for a local look. So this script satisfies
 * them instead: it runs a real OAuth provider on loopback (the same shape
 * `auth-release-smoke.mjs` already drives the release contract with), then
 * seeds a project and a DELIVERED run through the SAME store calls the
 * coordinator makes — `createProject`, `createProjectRun`,
 * `recordDeliveredPreview`. Nothing is stubbed at the seam under test.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch the preview code path. The
 * classifier classifies the seeded workspace, the manager opens it, the
 * gateway serves it. If the button does not work, this script has not hidden
 * the reason.
 *
 * ORDER MATTERS AND IS HANDLED FOR YOU: the organisation is founded by your
 * FIRST LOGIN, so the seed cannot run before it. The script waits for that
 * membership row to appear, then seeds into your real organisation.
 *
 * Development tooling. Never part of the release contract.
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The subject this harness's identity is keyed by.
 *
 * Deliberately unissuable: no OIDC provider mints a subject shaped like this,
 * so a store seeded by the demo can never be joined to a real person's login.
 */
const DEMO_SUBJECT = 'atoma-preview-demo:local-operator';
const CLIENT_ID = 'atoma-preview-demo';
const CLIENT_SECRET = 'atoma-preview-demo-secret';
const PROVIDER_PORT = Number(process.env['ATOMA_PREVIEW_DEMO_PROVIDER_PORT'] ?? 4319);
const DB_PATH = path.resolve(process.env['ATOMA_DB_PATH'] ?? './atoma.db');
// The coordinator's own default (`DEFAULT_PROJECTS_ROOT`), not a guess. The
// server reads the path this script RECORDS on the run row, so the two agree
// by construction now — but a demo whose files land somewhere a real run's
// never would is a demo that teaches the wrong layout.
const PROJECTS_ROOT = path.resolve(
  process.env['ATOMA_PROJECTS_ROOT'] ?? path.join(homedir(), '.atoma')
);
const SLUG = 'preview-demo';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

if (has('--help') || has('-h')) {
  console.log(`atoma preview:demo — a clickable preview on this machine

usage:
  npm run preview:demo            start the loopback OAuth provider, then seed on first login
  npm run preview:demo -- --seed  seed only (you have already logged in once)
  npm run preview:demo -- --env   print the .env block and exit

flags:
  --seed   skip the provider; seed a project + delivered run into your organisation
  --env    print the configuration this harness expects, and exit
  --help   this

It seeds a STATIC deliverable (one index.html), which needs no container and
therefore no gVisor: the gateway serves the copy itself. That is the whole
preview machinery apart from the isolate, and it is the half a laptop can run.`);
  process.exit(0);
}

/**
 * The `.env` block. Printed rather than written: this file is the operator's,
 * and a script that edited it would be a script that could clobber a real
 * deployment's credentials.
 */
function envBlock() {
  return `# --- npm run preview:demo (development only) ---
ATOMA_VIZ_AUTH=1
ATOMA_VIZ_PUBLIC_ORIGIN=http://127.0.0.1:5173
ATOMA_AUTH_GOOGLE_CLIENT_ID=${CLIENT_ID}
ATOMA_AUTH_GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}
ATOMA_AUTH_GOOGLE_AUTHORIZE_URL=http://127.0.0.1:${PROVIDER_PORT}/authorize
ATOMA_AUTH_GOOGLE_TOKEN_URL=http://127.0.0.1:${PROVIDER_PORT}/token
ATOMA_AUTH_GOOGLE_USERINFO_URL=http://127.0.0.1:${PROVIDER_PORT}/userinfo

ATOMA_PREVIEW=1
ATOMA_PREVIEW_DOMAIN=previews.localhost
ATOMA_PREVIEW_ALLOW_HTTP_DEV=1
ATOMA_PREVIEW_IMAGE=atoma-preview@sha256:${'0'.repeat(64)}
ATOMA_PREVIEW_GATEWAY_HOST=127.0.0.1
ATOMA_PREVIEW_GATEWAY_PORT=4311`;
}

if (has('--env')) {
  console.log(envBlock());
  process.exit(0);
}

const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

async function readBody(request, limit = 32_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new Error('demo provider request body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A real OAuth 2.0 + PKCE provider, bound to loopback.
 *
 * It is not a stub of atoma's client: the client under test performs the whole
 * exchange against it, PKCE included, so a login that works here is a login
 * that works. What it does not do is authenticate anyone — it hands out an
 * identity to whoever asks, which is exactly why it binds 127.0.0.1 and why
 * the banner says so out loud.
 */
function startProvider(port) {
  const codes = new Map();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        const challenge = url.searchParams.get('code_challenge');
        if (!redirectUri || !state || !challenge || url.searchParams.get('client_id') !== CLIENT_ID) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          response.end('the demo provider expects a PKCE authorization request');
          return;
        }
        const code = `demo-code-${codes.size + 1}`;
        codes.set(code, { redirectUri, challenge });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.writeHead(302, { location: callback.href }).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const params = new URLSearchParams(await readBody(request));
        const record = codes.get(params.get('code') ?? '');
        if (
          !record ||
          params.get('client_id') !== CLIENT_ID ||
          params.get('client_secret') !== CLIENT_SECRET ||
          params.get('redirect_uri') !== record.redirectUri ||
          pkceChallenge(params.get('code_verifier') ?? '') !== record.challenge
        ) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'demo-access-token' }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/userinfo') {
        if (request.headers.authorization !== 'Bearer demo-access-token') {
          response.writeHead(401).end();
          return;
        }
        // ONE identity, always. A second login is the same person, so the
        // organisation founded by the first is the one you come back to.
        //
        // AND IT IS NOT A GITHUB IDENTITY. `completeLogin` joins on
        // `(provider, subject)` alone, and a GitHub subject is a decimal user
        // id — so a store seeded under `github` with `900001` would admit the
        // REAL GitHub user #900001 as this organisation's founding owner the
        // day the deployment is pointed at a real client. The `google` shape
        // takes any non-whitespace subject, so this one can be a string no
        // provider will ever issue.
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(
          JSON.stringify({ sub: DEMO_SUBJECT, name: 'Preview Demo', email_verified: false })
        );
        return;
      }
      response.writeHead(404).end();
    })().catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** The first membership in the store: the organisation your login founded. */
function findViewer(db) {
  const row = db
    .prepare(
      `SELECT org_id AS orgId, principal_id AS principalId
         FROM auth_memberships
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get();
  return row ?? null;
}

/**
 * A trace, because a run without one is DROPPED from the runs index
 * (`resolveProjectRunTraceFile` returns null and `listRunFiles` skips it), and
 * a run the index does not carry never reaches the summary card the preview
 * control is drawn beside. Minimal but well-formed: the projection reads these
 * members by name.
 */
function demoTrace(id, goal) {
  const t0 = Date.parse('2026-09-02T10:00:00.000Z');
  const ev = (offsetS, fields) => ({ id: `ev-${offsetS}`, ts: t0 + offsetS * 1000, ...fields });
  return {
    id,
    label: `${goal} [build-app]`,
    task: { description: goal },
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t0 + 42_000).toISOString(),
    durationMs: 42_000,
    events: [
      ev(0, { kind: 'llm', role: 'plan', actor: { tier: 3, name: 'Meristem' }, durationMs: 6000 }),
      ev(8, {
        kind: 'llm',
        role: 'execute',
        actor: { tier: 1, name: 'Methane' },
        model: 'claude-haiku-4-5-20251001',
        durationMs: 26_000,
        costUsd: 0.02,
        usage: { input_tokens: 1200, output_tokens: 3400 },
      }),
      ev(36, {
        kind: 'tool',
        name: 'write_file',
        actor: { tier: 1, name: 'Methane' },
        args: { path: 'index.html' },
        result: { ok: true },
      }),
    ],
    result: {
      summary: 'A single-page deliverable, written to the workspace.',
      producedBy: { tier: 3, name: 'Meristem' },
    },
    totals: { calls: 2, inputTokens: 1200, outputTokens: 3400, costUsd: 0.02 },
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview demo</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #0b111e; color: #e6edf7; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .6rem; color: #6ea8ff; }
  p { margin: 0 0 1rem; color: #9fb4d4; }
  code { background: #131b2c; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 8px; cursor: pointer;
           border: 1px solid #6ea8ff; background: #131b2c; color: #e6edf7; }
  output { display: block; margin-top: 1rem; color: #7ee787; min-height: 1.6em; }
</style>
</head>
<body>
<main>
  <h1>This page is the deliverable</h1>
  <p>It is served from a filtered copy of a run's workspace, on its own origin,
     behind a one-time claim. The chrome around this frame belongs to atoma and
     this document cannot reach it.</p>
  <p>Its origin is <code id="origin"></code>.</p>
  <button id="go">Prove scripts run here</button>
  <output id="out"></output>
</main>
<script>
  document.getElementById('origin').textContent = location.origin;
  document.getElementById('go').addEventListener('click', function () {
    document.getElementById('out').textContent =
      'Yes — and this counted as no activity: only the visualizer heartbeat keeps a preview alive.';
  });
</script>
</body>
</html>
`;

/**
 * Seed one project and one DELIVERED run, through the production store calls.
 *
 * `createProject` is reached directly rather than through the HTTP service on
 * purpose: the service requires an active GitHub App installation, which is a
 * correct rule about where a deliverable gets PUBLISHED and has nothing to say
 * about whether a preview can be looked at. The store validates the schema and
 * writes the same row either way.
 */
async function seed() {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `no store at ${DB_PATH}. Start the visualizer once (npm run viz:gpu) so it creates one, then log in.`
    );
  }
  const src = (rel) => pathToFileURL(path.resolve('src', rel)).href;
  const { ProjectStore } = await import(src('projects/store.ts'));
  const { projectRunHostLayout } = await import(src('projects/coordinator.ts'));
  const { PreviewStore } = await import(src('preview/store.ts'));
  const { recordDeliveredPreview } = await import(src('preview/service.ts'));

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    const viewer = findViewer(db);
    if (!viewer) {
      return { seeded: false, reason: 'no organisation yet' };
    }
    const projects = new ProjectStore(db);
    const previews = new PreviewStore(db);

    const existing = (projects.listProjects(viewer.orgId) ?? []).find((p) => p.slug === SLUG);
    const project =
      existing ??
      projects.createProject({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        project: {
          name: 'Preview demo',
          slug: SLUG,
          initialPrompt: '',
          family: 'build',
          // Never contacted: nothing in this script publishes, and the
          // publisher is only ever reached from a delivered run's own
          // coordinator. The schema wants a decimal installation id, so this
          // is one that cannot collide with a real App, beside an owner that
          // reads as local at a glance.
          repositoryTarget: {
            installationId: '999000001',
            owner: 'local',
            name: SLUG,
            visibility: 'private',
          },
        },
      });

    const goal = 'a one-page deliverable, for looking at';
    // RESERVE THE ID FIRST, then derive the paths from it, then hand both to
    // the store — the coordinator's own sequence (`startProjectRun`). Letting
    // the store pick the id and deriving paths from a THROWAWAY one recorded a
    // workspace keyed to a run that does not exist, which the server then read
    // and found empty.
    const projectRunId = randomUUID();
    const layout = projectRunHostLayout(
      PROJECTS_ROOT,
      viewer.orgId,
      project.projectId,
      projectRunId
    );
    const created = projects.createProjectRun({
      orgId: viewer.orgId,
      projectId: project.projectId,
      principalId: viewer.principalId,
      projectRunId,
      request: { goal, idempotencyKey: `preview-demo-${randomUUID()}` },
      hostPaths: {
        workspacePath: layout.workspacePath,
        runsPath: layout.runsPath,
        logPath: layout.logPath,
      },
    });
    if (!created) throw new Error('the store refused the seeded run');
    const run = created.run;
    if (run.projectRunId !== projectRunId) {
      throw new Error('the store assigned a different run id than the one reserved');
    }
    mkdirSync(layout.workspacePath, { recursive: true });
    mkdirSync(layout.runsPath, { recursive: true });
    writeFileSync(path.join(layout.workspacePath, 'index.html'), PAGE, 'utf8');
    writeFileSync(
      path.join(layout.runsPath, `${run.projectRunId}.json`),
      JSON.stringify(demoTrace(run.projectRunId, goal), null, 2),
      'utf8'
    );
    writeFileSync(layout.logPath, '--- seeded by preview:demo ---\n✓ build finished\n', 'utf8');

    projects.transitionProjectRun({
      orgId: viewer.orgId,
      projectRunId: run.projectRunId,
      from: 'queued',
      to: 'running',
    });
    projects.transitionProjectRun({
      orgId: viewer.orgId,
      projectRunId: run.projectRunId,
      from: 'running',
      to: 'delivered',
      traceId: run.projectRunId,
      // The runner's own epilogue shape (`runStatsSchema`), in full: every
      // counter is required, and a partial object is refused rather than
      // defaulted. Zeroes are honest here — no model was called.
      stats: {
        outcome: 'delivered',
        costUsd: 0.02,
        llmCalls: 2,
        opusCalls: 0,
        sonnetCalls: 0,
        haikuCalls: 2,
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
      },
    });

    // THE SAME CALL THE COORDINATOR MAKES at delivery. Without a descriptor the
    // summary reads `legacy-run` and the control is never drawn.
    recordDeliveredPreview(previews, {
      orgId: viewer.orgId,
      projectId: project.projectId,
      projectRunId: run.projectRunId,
      workspaceRoot: layout.workspacePath,
    });

    const descriptor = previews.getDescriptor(viewer.orgId, run.projectRunId);
    return {
      seeded: true,
      project: project.name,
      runId: run.projectRunId,
      workspace: layout.workspacePath,
      availability: descriptor?.availability ?? 'unknown',
      kind: descriptor?.kind ?? null,
      reason: descriptor?.unavailableReason ?? null,
    };
  } finally {
    db.close();
  }
}

function reportSeed(result) {
  if (!result.seeded) return false;
  console.log(`\nseeded: ${result.project} · run ${result.runId}`);
  console.log(`  workspace  ${result.workspace}`);
  console.log(`  classified ${result.availability}${result.kind ? ` (${result.kind})` : ''}` +
    (result.reason ? ` — ${result.reason}` : ''));
  if (result.availability !== 'available') {
    console.log('\n  The classifier refused this workspace, so no button will appear.');
    console.log('  That is the real classifier talking — read src/preview/descriptor.ts.');
    return true;
  }
  if (result.kind !== 'static') {
    console.log('\n  NOTE: classified as a node deliverable, which needs a container.');
  }
  console.log(`
Now, in the browser at http://127.0.0.1:5173 (maximise the window — the run
summary card is not drawn below 1050 CSS px):

  1. Projects  →  click the "Preview demo" row          (a project must be
                                                         SELECTED, or the run
                                                         list never loads)
  2. click the run row inside it                        (goes to Runs)
  3. "Preview the app", under the run summary card
`);
  return true;
}

async function main() {
  if (has('--seed')) {
    const result = await seed();
    if (!reportSeed(result)) {
      console.error(
        'No organisation in the store yet. Start the visualizer, log in once (that founds it), then re-run.'
      );
      process.exitCode = 1;
    }
    return;
  }

  const server = await startProvider(PROVIDER_PORT).catch((error) => {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `port ${PROVIDER_PORT} is busy. Set ATOMA_PREVIEW_DEMO_PROVIDER_PORT to a free one.`
      );
    }
    throw error;
  });

  console.log(`atoma preview:demo

A LOOPBACK-ONLY OAuth provider is now running on 127.0.0.1:${PROVIDER_PORT}. It
authenticates NOBODY — it hands an identity to whoever asks. That is why it
binds loopback, and why you must not point a reachable deployment at it.

1. Put this in the checkout .env (npm run viz:gpu reads it; viz:serve does not):

${envBlock()}

2. Nothing. No proxy, no certificate, no DNS.

   ATOMA_PREVIEW_ALLOW_HTTP_DEV=1 serves previews over plain HTTP on
   *.previews.localhost. Browsers resolve that family to loopback themselves
   and treat it as a SECURE CONTEXT, so the grant cookie keeps every attribute
   it has in production and is still stored inside the frame. It travels in
   the clear on this machine — which is why the flag refuses to resolve unless
   the domain is under .localhost AND the visualizer origin is loopback AND
   the gateway is bound to loopback.

3. In another terminal: npm run viz:gpu
   Wait for "[atoma viz] preview gateway on 4311". If it says previews are off,
   that line is the whole diagnosis.

4. Open http://127.0.0.1:5173 and sign in. The first login founds your
   organisation — this script is watching for it and will seed as soon as it
   appears.

Ctrl-C to stop the provider.
`);

  let seeded = false;
  const tick = async () => {
    if (seeded) return;
    try {
      const result = await seed();
      if (result.seeded) {
        seeded = true;
        reportSeed(result);
      }
    } catch (error) {
      // A store that does not exist yet, or one mid-migration, is the normal
      // state before the first boot. Only report it once we have waited a
      // while, so the banner above is not immediately buried.
      if (waited > 20) console.error(`preview:demo: ${String(error)}`);
    }
  };
  let waited = 0;
  const timer = setInterval(() => {
    waited += 1;
    void tick();
  }, 1000);

  const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(`preview:demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
