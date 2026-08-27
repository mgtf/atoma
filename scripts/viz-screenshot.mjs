/* global document, HTMLButtonElement */
/**
 * viz-screenshot — capture a PNG of the GPU client for visual review.
 *
 * Agent/developer tool, NOT a release gate: after editing the viz, run this to
 * SEE the change instead of asserting around it. Documented in
 * docs/viz-screenshot.md.
 *
 *   npm run viz:shot                                   # ungated Projects view
 *   npm run viz:shot -- --auth --select-first          # logged-in, project open
 *   npm run viz:shot -- --view Runs --out /tmp/runs.png
 *   npm run viz:shot -- --url http://127.0.0.1:5173    # attach to a running dev stack
 *
 * Flags:
 *   --view <Tab label>   Nav tab to open (Projects, Runs, Registry, Skills,
 *                        Burn-in, Docs — a gated session also has the admin
 *                        plane). Settings is not a rail tab: `--auth --view
 *                        Settings` opens the a11y account menu and clicks
 *                        Settings. Default: Projects, the arrival view.
 *   --auth               Logged-in rendering WITHOUT a real OAuth session:
 *                        /auth/whoami and the org-scoped reads are stubbed in
 *                        the browser (same technique as viz-gpu-smoke's
 *                        account arm), so the gate, the account orb and the
 *                        project surfaces all render as a member would see
 *                        them. Without it: the ungated developer rendering.
 *   --select-first       Click the first project row after arrival (the run
 *                        list + run form state).
 *   --scroll-end         Scroll the Settings body form to its end before
 *                        capture (org directory below the keys).
 *   --camera <mode>      Camera pose after navigation: focus (default) or
 *                        overview. Overview re-activates the selected menu,
 *                        exercising the real return transition.
 *   --tuning             Open the floating Scene Tuning window.
 *   --out <path>         PNG destination. Default:
 *                        screenshots/<view>-<auth-mode>-<camera>.png
 *   --url <base>         Attach to an already-running UI server instead of
 *                        spawning a dev stack. With no --url the script spawns
 *                        `scripts/viz-dev.mjs` on two free ports and tears it
 *                        down afterwards (source path — no build needed).
 *   --width/--height     Viewport (default 1600x900, deviceScaleFactor 2).
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const READY_TIMEOUT_MS = 60_000;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const view = arg('--view', 'Projects');
const authed = has('--auth');
const tuning = has('--tuning');
const selectFirst = has('--select-first');
const scrollEnd = has('--scroll-end');
const cameraMode = arg('--camera', 'focus');
if (cameraMode !== 'overview' && cameraMode !== 'focus') {
  throw new Error(`--camera must be overview or focus, got ${cameraMode}`);
}
const width = Number(arg('--width', '1600'));
const height = Number(arg('--height', '900'));
const outPath = resolve(
  arg('--out', `screenshots/${view.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${authed ? 'gated' : 'ungated'}-${cameraMode}.png`)
);

/**
 * Reserve N distinct ports by holding them all open at once. Two sequential
 * `listen(0)` calls can hand back the SAME port (the first is freed before
 * the second asks), and the two dev-stack children then race one bind.
 */
async function freePorts(count) {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolvePort(server));
      })
    )
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())))
    )
  );
  return ports;
}

/** Same fixture shape as viz-gpu-smoke's account arm: the smallest stub set
 * that makes the client render as an authenticated org member. */
function gatedStubs() {
  const principalId = '11111111-2222-3333-4444-555555555555';
  const projectId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
  const runs = [
    ['delivered', 0.63, null, { status: 'published', commitSha: 'c28afe4f8e3d2b1a0c9e', repositoryUrl: 'https://github.com/example/stopwatch' }],
    ['failed', null, 'control-plane JSON is not a bounded regular file: /tmp/example/trace.json', null],
    ['failed', null, 'runner finished with outcome failed', null],
    ['delivered', 0.38, null, null],
    ['delivered', 0.25, null, { status: 'published', commitSha: 'f66b0fffceb1a2d3e4f5', repositoryUrl: 'https://github.com/example/stopwatch' }],
  ].map(([status, costUsd, error, publication], index) => ({
    projectRunId: `cccccccc-1111-4222-8333-dddddddddd${String(10 + index)}`,
    projectId,
    goal: [
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a lap button to the stopwatch: each press records the current elapsed time in a list below the controls, and reset clears the list.',
      'Build a single-page stopwatch in index.html: start, stop and reset buttons, elapsed time shown as mm:ss.cc, no external dependencies.',
    ][index],
    status,
    traceId: status === 'delivered' ? `trace-${index}` : null,
    costUsd,
    durationS: 60 + index,
    error,
    createdAt: `2026-08-20T00:0${index}:00.000Z`,
    endedAt: `2026-08-20T00:0${index}:59.000Z`,
    publication,
  }));
  return {
    '/auth/whoami': {
      enabled: true,
      authenticated: true,
      principalId,
      displayName: 'Ada Lovelace',
      displayNameSource: 'provider',
      avatarUrl: null,
      role: 'org:owner',
      platformAdmin: false,
      activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
      organisations: [{ id: 'org-a', name: 'Analytical Engines', role: 'org:owner' }],
      providers: [{ id: 'github', label: 'GitHub' }],
    },
    '/api/org': {
      id: 'org-a',
      name: 'Analytical Engines',
      createdAt: '2026-08-01T10:00:00.000Z',
      viewerRole: 'org:owner',
      members: [{
        principalId,
        displayName: 'Ada Lovelace',
        role: 'org:owner',
        joinedAt: '2026-08-01T10:00:00.000Z',
        platformAdmin: false,
        avatarUrl: null,
      }],
      projectCount: 1,
      pendingInvitations: 0,
    },
    '/api/account/models': {
      pins: { l1: null, l2: null, l3: null },
      defaults: {
        l1: 'claude-haiku-4-5-20251001',
        l2: 'claude-sonnet-5',
        l3: 'claude-opus-5',
      },
      choices: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
      catalog: [],
    },
    // Settings body fetches this on mount. A 401 here reload-loops the page.
    '/api/org/models': {
      models: { l1: null, l2: null, l3: null },
      keys: [],
      encryptionReady: true,
      catalog: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          credentialEnvVar: 'ANTHROPIC_API_KEY',
          suggestive: false,
          models: [
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
          ],
        },
        {
          id: 'zai',
          label: 'Z.ai',
          credentialEnvVar: 'ZAI_API_KEY',
          suggestive: false,
          models: [{ id: 'glm-4.5', label: 'GLM-4.5' }],
        },
        {
          id: 'ollama',
          label: 'Ollama',
          credentialEnvVar: null,
          suggestive: true,
          models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
        },
      ],
      choices: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
      operatorDefaults: {
        l1: 'claude-haiku-4-5-20251001',
        l2: 'claude-sonnet-5',
        l3: 'claude-opus-5',
      },
    },
    '/api/projects': [{
      projectId,
      name: 'Stopwatch E2E two',
      slug: 'stopwatch-e2e-two',
      status: 'active',
      family: 'build',
      repositoryTarget: {
        installationId: '501',
        owner: 'example',
        name: 'atoma-e2e-stopwatch-2',
        visibility: 'private',
      },
      repositoryStatus: 'ready',
      repositoryFullName: 'example/atoma-e2e-stopwatch-2',
      repositoryUrl: 'https://github.com/example/atoma-e2e-stopwatch-2',
      repositoryError: null,
      runCount: 5,
      lastRunAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }],
    [`/api/projects/${projectId}/runs`]: runs,
    // The Runs view auto-selects the newest index entry and loads its trace,
    // so these two stubs make `--view Runs` render the full run surface:
    // summary card, metric tiles, branch filter chips and the timeline.
    '/api/runs': [
      {
        id: 'run-fixture',
        label:
          'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend.',
        startedAt: '2026-08-23T10:00:00.000Z',
        endedAt: '2026-08-23T10:21:34.000Z',
        durationMs: 1_293_740,
        costUsd: 1.69,
        calls: 26,
        projectId,
        projectName: 'Stopwatch E2E two',
        projectSlug: 'stopwatch-e2e-two',
      },
    ],
    '/api/runs/run-fixture': fixtureTrace(),
    '/api/github/installations': [],
    // WITHOUT this stub the page reload-loops: the checkout `.env` usually arms
    // the auth gate, the browser has no session cookie, and the client treats
    // the resulting 401 on /api/profiles as an expired session.
    '/api/profiles': [{
      id: 'build',
      label: 'Build',
      help: 'Describe the artifact to build and its acceptance criteria in one or two sentences.',
      examples: [
        'Build a single-page stopwatch in index.html: start, stop and reset buttons, no external dependencies.',
        'Add a lap button to the stopwatch: each press records the current elapsed time in a list below the controls.',
      ],
    }],
  };
}

/** One delivered two-phase run whose phases each fork a parallel branch —
 * enough structure for the Runs view to draw the summary card, the four
 * metric tiles, the branch filter chips and a forked timeline. */
function fixtureTrace() {
  const t0 = Date.parse('2026-08-23T10:00:00.000Z');
  let seq = 0;
  const at = (offsetS) => t0 + offsetS * 1000;
  const ev = (offsetS, fields) => ({ id: `ev-${seq++}`, ts: at(offsetS), ...fields });
  const events = [
    ev(0, { kind: 'llm', role: 'plan', actor: { tier: 3, name: 'Meristem' }, durationMs: 9000 }),
    ev(10, {
      kind: 'branch', op: 'start', branchId: 'p1', index: 0, total: 2,
      aggregationMode: 'sequential', actor: { tier: 3, name: 'Meristem' },
      label: 'Write index.html and app.js: expense form, list and totals',
    }),
    ev(12, { kind: 'llm', role: 'plan', branchId: 'p1', actor: { tier: 2, name: 'Tracheid' }, durationMs: 8000 }),
    ev(20, {
      kind: 'branch', op: 'start', branchId: 'c1', parentBranchId: 'p1',
      actor: { tier: 2, name: 'Tracheid' },
      label: 'Write index.html and app.js against the running API',
    }),
    ev(25, {
      kind: 'llm', role: 'execute', branchId: 'c1', actor: { tier: 1, name: 'Methane' },
      model: 'claude-haiku-4-5-20251001', durationMs: 210_000, costUsd: 0.41,
      usage: { input_tokens: 3200, output_tokens: 24_000 },
    }),
    ev(240, { kind: 'tool', name: 'write_file', branchId: 'c1', actor: { tier: 1, name: 'Methane' }, args: { path: 'index.html' } }),
    ev(250, { kind: 'tool', name: 'write_file', branchId: 'c1', actor: { tier: 1, name: 'Methane' }, args: { path: 'app.js' } }),
    ev(260, { kind: 'llm', role: 'validate-result', branchId: 'p1', actor: { tier: 2, name: 'Tracheid' }, durationMs: 12_000, costUsd: 0.08 }),
    ev(300, { kind: 'branch', op: 'end', branchId: 'c1' }),
    ev(300, { kind: 'branch', op: 'end', branchId: 'p1' }),
    ev(300, {
      kind: 'branch', op: 'start', branchId: 'p2', index: 1, total: 2,
      aggregationMode: 'sequential', actor: { tier: 3, name: 'Meristem' },
      label: 'Read the existing server.js and wire the frontend to its routes',
    }),
    ev(310, {
      kind: 'branch', op: 'start', branchId: 'c2', parentBranchId: 'p2',
      actor: { tier: 2, name: 'Sclereid' },
      label: 'Read the existing server.js and adjust fetch paths',
    }),
    ev(315, { kind: 'tool', name: 'read_file', branchId: 'c2', actor: { tier: 1, name: 'Ethane' }, args: { path: 'server.js' } }),
    ev(330, {
      kind: 'llm', role: 'execute', branchId: 'c2', actor: { tier: 1, name: 'Ethane' },
      model: 'claude-haiku-4-5-20251001', durationMs: 540_000, costUsd: 0.87,
      usage: { input_tokens: 6200, output_tokens: 52_000 },
    }),
    ev(900, { kind: 'llm', role: 'validate-result', branchId: 'p2', actor: { tier: 2, name: 'Sclereid' }, durationMs: 14_000, costUsd: 0.11 }),
    ev(1200, { kind: 'branch', op: 'end', branchId: 'c2' }),
    ev(1200, { kind: 'branch', op: 'end', branchId: 'p2' }),
    ev(1290, { kind: 'llm', role: 'aggregate', actor: { tier: 3, name: 'Meristem' }, durationMs: 4000, costUsd: 0.05 }),
  ];
  return {
    id: 'run-fixture',
    label:
      'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend. [build-app]',
    task: {
      description:
        'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend.',
    },
    startedAt: '2026-08-23T10:00:00.000Z',
    endedAt: '2026-08-23T10:21:34.000Z',
    durationMs: 1_293_740,
    events,
    result: { summary: 'Frontend delivered against the existing API.', producedBy: { tier: 3, name: 'Meristem' } },
    totals: { calls: 26, inputTokens: 10_181, outputTokens: 80_380, costUsd: 1.69 },
  };
}

/** Spawn the source dev stack on free ports; resolve when the UI answers. */
async function spawnDevStack() {
  const [devPort, apiPort] = await freePorts(2);
  const script = fileURLToPath(new URL('./viz-dev.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ATOMA_VIZ_DEV_PORT: String(devPort),
      ATOMA_VIZ_API_PORT: String(apiPort),
      // The screenshot session must not arm a sentinel tick or push prompts.
      ATOMA_VIZ_SENTINEL: '0',
    },
  });
  // DRAIN both pipes: an unread pipe fills at ~64KB and then blocks the dev
  // server's writes, which stalls Vite mid-serve with no error anywhere.
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const url = `http://127.0.0.1:${devPort}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('dev stack never answered on its UI port');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

const attached = arg('--url');
const stack = attached ? { url: attached, stop: () => {} } : await spawnDevStack();

try {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
    if (has('--debug')) {
      page.on('console', (message) => console.error(`[console:${message.type()}] ${message.text().slice(0, 200)}`));
      page.on('requestfailed', (request) =>
        console.error(`[requestfailed] ${request.url().slice(0, 140)} ${request.failure()?.errorText ?? ''}`));
      page.on('response', (response) => {
        if (response.status() >= 400) console.error(`[http ${response.status()}] ${response.url().slice(0, 140)}`);
      });
    }

    if (authed) {
      const stubs = gatedStubs();
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        // NEVER let this handler throw: with interception on, a request whose
        // handler died is never continued and the page hangs on it forever.
        try {
          const path = new URL(request.url()).pathname;
          const stub = stubs[path];
          if (stub !== undefined) {
            void request.respond({
              status: 200,
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
              body: JSON.stringify(stub),
            });
            return;
          }
        } catch {
          // Fall through to continue().
        }
        void request.continue().catch(() => {});
      });
    }

    // Fresh visitor: clear the persisted arrival flag so behaviour does not
    // depend on what an earlier session on this origin did.
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.removeItem('atoma.viz.entered');
      } catch {
        // Storage is optional; the gate simply shows.
      }
    });
    await page.goto(`${stack.url}/?atomaDiag=1${tuning ? '&atomaTune=1' : ''}`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS })
      .catch(async (error) => {
        const body = await page
          .evaluate(() => document.body?.innerHTML.slice(0, 600) ?? '<no body>')
          .catch(() => '<page unreachable>');
        throw new Error(`${error.message}\npage body at timeout:\n${body}`);
      });

    // Pass the arrival gate through the a11y bridge, then wait for the nav.
    await page.waitForFunction(
      () =>
        document.querySelector('.gpu-a11y-bridge [data-release-version]') !== null ||
        document.querySelector('[role="tab"]') !== null,
      { timeout: READY_TIMEOUT_MS }
    );
    const arrival = await page.evaluate(() => {
      if (document.querySelector('[role="tab"]')) return 'entered';
      const bridge = document
        .querySelector('.gpu-a11y-bridge [data-release-version]')
        ?.closest('.gpu-a11y-bridge');
      const control = bridge?.querySelector('button');
      if (!control) {
        // Provider anchors instead of Continue: the instance is GATED and this
        // session is anonymous. That page is itself a valid subject.
        if (bridge?.querySelector('a')) return 'login';
        throw new Error('arrival gate control missing');
      }
      control.click();
      return 'continued';
    });

    if (arrival === 'login') {
      // What a logged-out visitor sees. Nothing to navigate behind it; add
      // --auth to stub a member session and reach the app.
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 800)));
      await mkdir(dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath });
      console.log(`viz screenshot: ${outPath} (login gate — anonymous visitor; use --auth to enter)`);
      await browser.close();
      stack.stop();
      process.exit(0);
    }
    await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });

    // Open the requested view and let the 560ms view transition finish.
    // Settings is reached from the account menu, not the rail.
    if (view === 'Settings') {
      if (!authed) {
        throw new Error('--view Settings requires --auth (the account menu is gated)');
      }
      await page.waitForFunction(
        () => Boolean(document.querySelector('.gpu-a11y-bridge button[aria-expanded]')),
        { timeout: READY_TIMEOUT_MS }
      );
      await page.evaluate(() => {
        const button = document.querySelector('.gpu-a11y-bridge button[aria-expanded]');
        if (button instanceof HTMLButtonElement) button.click();
      });
      await page.waitForFunction(
        (label) =>
          Array.from(document.querySelectorAll('.gpu-a11y-bridge button')).some(
            (el) => el.textContent?.trim() === label
          ),
        { timeout: READY_TIMEOUT_MS },
        'Settings'
      );
      await page.evaluate((label) => {
        const button = Array.from(document.querySelectorAll('.gpu-a11y-bridge button')).find(
          (el) => el.textContent?.trim() === label
        );
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('Settings menu item missing');
        }
        button.click();
      }, 'Settings');
    } else {
      await page.evaluate((name) => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find(
          (candidate) => candidate.textContent === name
        );
        if (!tab) {
          const names = [...document.querySelectorAll('[role="tab"]')]
            .map((candidate) => candidate.textContent)
            .join(', ');
          throw new Error(`nav tab missing: ${name} (have: ${names})`);
        }
        tab.click();
      }, view);
    }
    await page.waitForFunction(
      (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
      { timeout: READY_TIMEOUT_MS },
      view
    );
    if (view === 'Settings') {
      await page.waitForSelector('.gpu-org-models-form', { timeout: READY_TIMEOUT_MS });
    }
    await page.waitForFunction(
      () => document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-motion') === 'settled',
      { timeout: READY_TIMEOUT_MS }
    );

    if (cameraMode === 'overview') {
      if (view === 'Settings') {
        throw new Error('--camera overview re-activates a nav tab; Settings has none');
      }
      // A second activation of the CURRENT destination is the camera return;
      // use the same menu contract as the product instead of mutating state.
      await page.evaluate((name) => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find(
          (candidate) => candidate.textContent === name
        );
        if (!(tab instanceof HTMLButtonElement)) throw new Error(`nav tab missing: ${name}`);
        tab.click();
      }, view);
      await page.waitForFunction(
        () => {
          const plane = document.querySelector('.gpu-scene-camera');
          return plane?.getAttribute('data-scene-camera-mode') === 'overview' &&
            plane.getAttribute('data-scene-camera-motion') === 'settled';
        },
        { timeout: READY_TIMEOUT_MS }
      );
    }
    await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 700)));

    if (scrollEnd) {
      if (view !== 'Settings') {
        throw new Error('--scroll-end is for Settings (the org-models body form)');
      }
      await page.evaluate(() => {
        const form = document.querySelector('.gpu-org-models-form');
        if (form) form.scrollTop = form.scrollHeight;
      });
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 200)));
    }

    if (selectFirst) {
      const spot = await page.evaluate(() => {
        const handle = globalThis.__ATOMA_GPU__;
        const row = handle?.hitTargets().find((entry) => entry.id.startsWith('project.select.'));
        if (!row || !handle.projectRendererPoint) return null;
        return handle.projectRendererPoint(
          row.x + row.width / 2,
          row.y + row.height / 2
        );
      });
      if (!spot) throw new Error('--select-first: no project row on screen');
      await page.mouse.click(spot.x, spot.y);
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 800)));
    }

    await mkdir(dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    console.log(`viz screenshot: ${outPath} (${view}, ${authed ? 'gated' : 'ungated'}, camera ${cameraMode}${selectFirst ? ', first project selected' : ''}, ${width}x${height})`);
  } finally {
    await browser.close();
  }
} finally {
  stack.stop();
}
