/* global document, HTMLButtonElement, matchMedia, requestAnimationFrame, MutationObserver, WheelEvent */
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Two console lines describe the MACHINE, not the app, and CI is the machine
 * that emits them: with no GPU, Chrome has no WebGPU adapter to offer (which is
 * exactly why the WebGL fallback arm at the bottom exists) and ANGLE reports its
 * own software-raster stalls. Everything else the page says still counts —
 * this is an allowlist of two anchored strings, not a mute button on warnings.
 */
const ENVIRONMENT_CONSOLE = [
  'No available adapters.',
  'GL Driver Message (OpenGL, Performance',
];

function isEnvironmentNoise(text) {
  return ENVIRONMENT_CONSOLE.some((fragment) => text.includes(fragment));
}

/**
 * Frames are only worth timing where they are real. `UNMASKED_RENDERER_WEBGL`
 * names the rasteriser — "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)"
 * against "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...))" — and it must
 * be read on the app's own 127.0.0.1 page, since `navigator.gpu` and the
 * debug-renderer extension both need a secure context.
 */
async function readRasteriser(page) {
  return await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    // Hand the context straight back: the app itself holds two, and Chrome caps
    // how many one page may keep alive.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  });
}

const SOFTWARE_RASTERISERS = /swiftshader|llvmpipe|software|basic render/i;

/**
 * Every wait in this file is sized for a runner that paints in SECONDS, because
 * CI does. Measured on the GitHub runner: 33s from `page.goto` to the app's
 * readiness attribute, against Puppeteer's 30s default for a selector — and one
 * frame there is slow enough that 120 unbounded frame samples ran past the 180s
 * protocol timeout and killed the job with `Runtime.callFunctionOn timed out`.
 *
 * The frame sampler is BOUNDED BY WALL CLOCK as well as by count: on a software
 * rasteriser its number is not asserted anyway, so spending three minutes
 * collecting it was pure cost. `protocolTimeout` is raised because the work does
 * complete there, just slowly — unlike `networkidle0`, which no timeout reaches.
 */
const READY_TIMEOUT_MS = 60_000;
const PROTOCOL_TIMEOUT_MS = 300_000;
const FRAME_SAMPLES = 120;
const FRAME_SAMPLE_BUDGET_MS = 10_000;

/**
 * The app opens on the ARRIVAL GATE: no header, no tabs, no data view until
 * Continue is pressed. Every arm below drives the real UI, so each one passes
 * the gate first, through the a11y bridge control — the same click a keyboard
 * user makes, and the only path that does not need the diagnostic handle.
 */
async function passArrivalGate(page) {
  await page.waitForSelector('.gpu-a11y-bridge button', { timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => {
    if (document.querySelector('[role="tab"]')) return;
    const gate = document.querySelector('.gpu-a11y-bridge button');
    if (!(gate instanceof HTMLButtonElement)) throw new Error('arrival gate control missing');
    gate.click();
  });
  await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });
}

/**
 * The custom cursor is ENVIRONMENT-GATED by design: `AtomaCursor` enables it
 * only while `(any-hover: hover) and (any-pointer: fine)` matches with motion
 * allowed and forced colours off. A headless runner with no pointing device to
 * report does not match it, so on CI the page was RIGHT to keep the cursor
 * hidden and this smoke waited 30s for something that was never coming.
 *
 * The gate reads the same media queries the component reads, never the
 * component's own `data-enabled` — a cursor that breaks on a machine that does
 * have a fine pointer must still fail here. Neither Puppeteer's
 * `emulateMediaFeatures` (rejects `any-pointer`) nor raw
 * `Emulation.setEmulatedMedia` nor `--blink-settings=availablePointerTypes`
 * moves these queries; all three were measured doing nothing.
 */
async function readCursorEnvironment(page) {
  const media = await page.evaluate(() => ({
    finePointer: matchMedia('(any-hover: hover) and (any-pointer: fine)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
  }));
  return {
    ...media,
    expected: media.finePointer && !media.reducedMotion && !media.forcedColors,
  };
}

/**
 * The cast-shadow arm hunts a ~40px class of defect: shadows anchored while a
 * layer sits lifted, never re-aimed as the layer eases down. Mid-flight is the
 * sharp sample and is asserted everywhere, at 0.5px.
 *
 * The RESTING sample is only observable where a frame lands near the end of the
 * hover-out ease, because the residual IS the staleness of the last paint:
 * measured 0.000px at 16.7ms frames, 0.871px at 344ms, and 11.87px on the CI
 * runner at 3433ms. It never converges, and that is the arm's own subject —
 * nothing re-anchors at rest, so forcing a render before the sample would mask
 * exactly the defect it looks for. Where frames are further apart than the ease
 * is long, the arm says so instead of pretending to measure it.
 */
const ANCHOR_DRIFT_MAX = 0.5;
const RESTING_FRAME_CEILING_MS = 50;

/**
 * The scroll rebuild budget catches a COLLAPSE — a rebuild that lost label
 * retention and went back through the canvas text path — not a drift. 12ms is
 * calibrated against 2.2-3.3ms measured on hardware here, with one frame at
 * 16.7ms.
 *
 * It is a CPU measurement, and a software rasteriser is competing for the same
 * thread: the same build measured 1.6ms P95 idle and 8.1ms P95 under load on this
 * machine, so a shared runner several times slower has no headroom under 12ms.
 * 40ms keeps a collapse bound there — losing label reuse costs an order of
 * magnitude, not a factor of three — while the reuse RATIO below stays the sharp
 * detector, and it needs no clock at all.
 */
const SCROLL_REBUILD_P95_MAX = 12;
const SOFTWARE_SCROLL_REBUILD_P95_MAX = 40;

/**
 * The main arm serves its OWN synthetic trace from a temp dir. It used to read
 * the repository's ambient `runs/`, which made the scroll scenario depend on
 * whatever traces happened to be on the machine: a fresh checkout has none, the
 * RUNS list then has nothing to scroll, every wheel tick is a no-op, and
 * `missed: 24` reports the fixture's absence as a renderer regression.
 *
 * THE ROW COUNT IS LOAD-BEARING. The scroll arm dispatches 16 ticks of 140px
 * before reversing, and `views/runs.ts` sets
 * `scrollMax = rows * rowHeight + 38 - listHeight` with `rowHeight` 46 and the
 * list pane never taller than the 800px viewport — so the list needs ~62 rows
 * before the sixteenth tick still moves it. 80 keeps margin without inflating
 * the per-rebuild layout that the same arm is timing.
 */
const FIXTURE_EVENT_ROWS = 80;

async function writeRunFixture(dir) {
  // Fixed clock. Timestamps that follow the wall clock would sit inside
  // `isRunLive`'s 12-minute window and start the trace poll that the live arm
  // at the bottom of this file owns and measures.
  const t0 = Date.parse('2026-01-02T03:04:05.000Z');
  const roles = ['plan', 'validate', 'execute'];
  const tools = ['read_file', 'write_file', 'shell', 'validate_html'];
  const events = [];
  for (let i = 0; i < FIXTURE_EVENT_ROWS; i++) {
    const ts = t0 + i * 1_500;
    events.push(i % 3 === 2
      ? {
        id: `fx-tool-${i}`,
        ts,
        kind: 'tool',
        name: tools[i % tools.length],
        actor: { name: 'Water', tier: 1 },
        durationMs: 40 + (i % 7) * 5,
        args: { path: `src/fixture-${i}.ts` },
        result: `wrote src/fixture-${i}.ts`,
      }
      : {
        id: `fx-llm-${i}`,
        ts,
        kind: 'llm',
        role: roles[i % roles.length],
        model: i % 2 === 0 ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001',
        actor: { name: i % 2 === 0 ? 'Tracheid' : 'Water', tier: i % 2 === 0 ? 2 : 1 },
        stopReason: 'end_turn',
        durationMs: 300 + (i % 11) * 20,
        costUsd: 0.0004,
        usage: { inputTokens: 900 + i, outputTokens: 120 + i },
        subject: `fixture step ${i}`,
      });
  }
  const startedAt = new Date(t0 - 1_000).toISOString();
  const endedAt = new Date(t0 + FIXTURE_EVENT_ROWS * 1_500).toISOString();
  const durationMs = FIXTURE_EVENT_ROWS * 1_500 + 1_000;
  const id = 'smoke-fixture-run';
  const label = 'smoke: scroll fixture';
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    id,
    label,
    task: { description: 'GPU smoke fixture — a trace long enough to scroll' },
    startedAt,
    endedAt,
    durationMs,
    events,
    result: {
      summary: 'fixture complete',
      output: 'fixture',
      producedBy: { tier: 3, name: 'Meristem' },
    },
    totals: { calls: events.length, costUsd: 0.032 },
  }));
  await writeFile(join(dir, 'index.json'), JSON.stringify([{
    id,
    label,
    startedAt,
    endedAt,
    durationMs,
    hasError: false,
    costUsd: 0.032,
    calls: events.length,
  }]));
}

const fixtureDir = await mkdtemp(join(tmpdir(), 'viz-gpu-smoke-'));
await writeRunFixture(fixtureDir);
const port = await freePort();
const server = spawn(
  process.execPath,
  [
    'dist/viz/server.js',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--dir', fixtureDir,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
      if (response.ok) break;
    } catch {
      // Compiled server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    const diagnostics = [];
    page.on('console', (message) => {
      if (
        (message.type() === 'error' || message.type() === 'warn') &&
        !isEnvironmentNoise(message.text())
      ) {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        diagnostics.push(`http ${response.status()}: ${response.url()}`);
      }
    });
    // `load`, never `networkidle0`. The client polls /api/runs for as long as
    // it is open, and on a SOFTWARE renderer — CI has no GPU, so
    // `--enable-unsafe-swiftshader` serves every frame on the CPU — Blink never
    // emits the `networkIdle` lifecycle signal Puppeteer waits for. Measured
    // under those flags: the page's own `load` fires at ~75ms and page-visible
    // in-flight requests sit at zero for ~2.8s at a stretch, yet networkidle0
    // does not resolve in 120 SECONDS. A bigger timeout cannot reach it, so
    // every arm here gates on `load` plus the app's own readiness attribute.
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
    // The gate GATES: nothing navigable exists behind it until it is passed.
    if (await page.$('[role="tab"]')) {
      throw new Error('arrival gate did not hold: nav tabs rendered before Continue');
    }
    await passArrivalGate(page);
    const rasteriser = await readRasteriser(page);
    const softwareRastered = SOFTWARE_RASTERISERS.test(rasteriser);
    const cursorEnv = await readCursorEnvironment(page);
    await page.mouse.move(640, 400);
    if (cursorEnv.expected) {
      await page.waitForSelector('.atoma-pointer-cursor[data-visible="true"]', {
        timeout: READY_TIMEOUT_MS,
      });
    } else {
      console.log(
        `viz GPU pointer cursor NOT CHECKED: this environment reports no usable ` +
          `pointer (${JSON.stringify(cursorEnv)})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    const frameStats = await page.evaluate(
      (target, budgetMs) => new Promise((resolve) => {
        const samples = [];
        let previous;
        const started = performance.now();
        const frame = (now) => {
          if (previous !== undefined) samples.push(now - previous);
          previous = now;
          // Bounded by the clock as well as the count: 120 frames is ~2s of a
          // real display and over three minutes of a software rasteriser, which
          // is past the protocol timeout — and a truncated sample still carries
          // the P95 the budget below reads, over however many frames arrived.
          if (samples.length < target && performance.now() - started < budgetMs) {
            requestAnimationFrame(frame);
          } else {
            const sorted = [...samples].sort((left, right) => left - right);
            resolve({
              samples: samples.length,
              meanMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
              p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            });
          }
        };
        requestAnimationFrame(frame);
      }),
      FRAME_SAMPLES,
      FRAME_SAMPLE_BUDGET_MS
    );

    const scrollRebuildMax = softwareRastered
      ? SOFTWARE_SCROLL_REBUILD_P95_MAX
      : SCROLL_REBUILD_P95_MAX;
    const views = ['Registry', 'Skills', 'Burn-in', 'Launch', 'Runs'];
    for (const label of views) {
      await page.evaluate((name) => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const tab = tabs.find((candidate) => candidate.textContent === name);
        if (!(tab instanceof HTMLButtonElement)) throw new Error(`missing tab ${name}`);
        tab.click();
      }, label);
      await page.waitForFunction(
        (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
        { timeout: READY_TIMEOUT_MS },
        label
      );
    }

    // Scroll rebuild cost. The rAF interval sampled above saturates at vsync
    // and can only detect dropped frames, never the margin a rebuild eats —
    // and it never scrolls, which is the one interaction that tears the scene
    // down and rebuilds it. Wheel ticks are dispatched on the UI canvas and
    // every resulting render is observed through the host's data attributes,
    // which the surface rewrites on each pass.

    // ── VIEW-TRANSITION CRASH ────────────────────────────────────────────────
    // Navigating RUNS↔SKILLS used to kill the renderer with "Cannot read
    // properties of null (reading 'set')": the 560ms view-transition sweep
    // borrows its label from the retained-label cache, then ended in
    // `layer.destroy({ children: true })`, destroying that label behind the
    // cache's back. A later render was handed the corpse and died on
    // `label.position.set`.
    //
    // The settle MUST exceed the transition's 560ms — every faster cadence
    // passes because the transition never completes, which is exactly how this
    // was missed by hand. And the scenario has to ARM: if the click misses and
    // the view never changes, the loop proves nothing.
    const navStats = await (async () => {
      const seen = new Set();
      const before = diagnostics.length;
      for (let i = 0; i < 6; i++) {
        for (const name of ['Skills', 'Runs']) {
          await page.evaluate((target) => {
            [...document.querySelectorAll('[role="tab"]')]
              .find((tab) => tab.textContent === target)?.click();
          }, name);
          await new Promise((resolve) => setTimeout(resolve, 700));
          seen.add(await page.evaluate(() =>
            [...document.querySelectorAll('[role="tab"]')]
              .find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? '?'));
        }
      }
      return { views: [...seen].sort(), newDiagnostics: diagnostics.length - before };
    })();

    const scrollStats = await page.evaluate(async () => {
      const host = document.querySelector('.gpu-ui-host');
      const canvas = host?.querySelector('canvas');
      if (!host || !canvas) throw new Error('no gpu host or UI canvas to scroll');
      const box = canvas.getBoundingClientRect();
      const samples = [];
      const observer = new MutationObserver(() => {
        samples.push({
          ms: Number(host.dataset.gpuRenderMs),
          created: Number(host.dataset.gpuLabelsCreated),
          reused: Number(host.dataset.gpuLabelsReused),
        });
      });
      // setAttribute always records a mutation, even when the value repeats,
      // so this counts renders rather than distinct values.
      observer.observe(host, { attributes: true, attributeFilter: ['data-gpu-render-ms'] });
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      // WAIT for the render, never a fixed number of frames. A wheel tick
      // reaches the renderer through the store and React's scheduler, so a
      // fixed settle silently drops ticks — and drops MORE of them on a slower
      // build, which would flatter exactly the arm that is doing worse.
      // Still waits FOR THE RENDER — never a fixed number of frames, which
      // would drop more ticks the slower the build is and flatter exactly the
      // arm doing worse. The cap is only a backstop, and it is expressed in
      // frames because that is the unit the render arrives in: a 500ms window
      // is 30 frames of a real display and less than one of a software
      // rasteriser, where it would report the runner's speed as a dropped tick.
      const awaitRender = async () => {
        const before = samples.length;
        const deadline = performance.now() + 4_000;
        let waited = 0;
        while (samples.length === before && waited < 4 && performance.now() < deadline) {
          await frame();
          waited += 1;
        }
        return samples.length > before;
      };
      // Left third: the event list, clear of the detail pane, whose wheel path
      // re-renders synchronously instead of going through the store.
      const clientX = box.left + box.width * 0.2;
      const clientY = box.top + box.height * 0.6;
      let missed = 0;
      await awaitRender();
      samples.length = 0;
      for (let tick = 0; tick < 24; tick++) {
        canvas.dispatchEvent(new WheelEvent('wheel', {
          deltaY: tick < 16 ? 140 : -140,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }));
        if (!(await awaitRender())) missed++;
      }
      observer.disconnect();
      const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      const at = (quantile) => durations[Math.min(durations.length - 1, Math.floor(durations.length * quantile))] ?? 0;
      return {
        renders: samples.length,
        missed,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        maxMs: durations[durations.length - 1] ?? 0,
        created: samples.reduce((sum, sample) => sum + sample.created, 0),
        reused: samples.reduce((sum, sample) => sum + sample.reused, 0),
      };
    });

    const result = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      backend: document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-backend'),
      objects: Number(document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-objects')),
      hasLaunchTextarea: !!document.querySelector('.gpu-launch-input'),
      cursorX: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-x'),
      cursorY: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-y'),
    }));
    if (
      result.canvases !== 2 ||
      !['webgpu', 'webgl'].includes(result.backend ?? '') ||
      result.objects < 20 ||
      (cursorEnv.expected && result.cursorX !== '640') ||
      (cursorEnv.expected && result.cursorY !== '400') ||
      // The pointer-light budget is a claim about the PRODUCT's animation
      // cost, so it is asserted where frames are real. Measured on the same
      // build: 17.5ms P95 on this machine's Metal-backed WebGPU against 357ms
      // under `--use-angle=swiftshader`, which times the rasteriser and nothing
      // else. Skipped loudly below rather than silently relaxed.
      (!softwareRastered && frameStats.p95Ms > 35) ||
      // The scroll scenario must ARM before its numbers mean anything: every
      // tick has to have produced a rebuild, and there have to be rebuilds.
      scrollStats.missed !== 0 ||
      scrollStats.renders < 20 ||
      scrollStats.p95Ms > scrollRebuildMax ||
      // The sharp one. Label retention is what keeps a rebuild off the canvas
      // text path; losing it drops this straight to zero, where the timing
      // budget above would still pass.
      scrollStats.reused / Math.max(1, scrollStats.reused + scrollStats.created) < 0.8 ||
      // Armed: both views actually rendered. Silent: the round-trips raised
      // nothing new in the console.
      navStats.views.join(',') !== 'Runs,Skills' ||
      navStats.newDiagnostics !== 0 ||
      diagnostics.length > 0
    ) {
      throw new Error(
        `GPU smoke failed: ${JSON.stringify({ ...result, frameStats, scrollStats, navStats, diagnostics })}`
      );
    }
    console.log(
      `viz GPU smoke ok: ${result.canvases} canvases, ${result.backend}, ${result.objects} objects, five views, pointer light ${frameStats.meanMs.toFixed(2)}ms mean/${frameStats.p95Ms.toFixed(2)}ms P95 over ${frameStats.samples} frames`
    );
    if (softwareRastered) {
      console.log(
        `viz GPU frame budget NOT CHECKED: software rasteriser (${rasteriser}) — ` +
          `${frameStats.p95Ms.toFixed(2)}ms P95 measures the rasteriser, not the scene`
      );
    }
    console.log(
      `viz GPU nav ok: 6 RUNS<->SKILLS round-trips past the 560ms view transition, views ${navStats.views.join('/')}, no render error`
    );
    console.log(
      `viz GPU scroll ok: ${scrollStats.renders} rebuilds (${scrollStats.missed} ticks missed), ${scrollStats.p50Ms.toFixed(2)}ms P50/${scrollStats.p95Ms.toFixed(2)}ms P95/${scrollStats.maxMs.toFixed(2)}ms max against a ${scrollRebuildMax}ms ceiling, labels ${scrollStats.reused} reused vs ${scrollStats.created} built`
    );

    // THE REGRESSION SCENARIO. A tuning drag must keep driving the value
    // across a full scene rebuild. The slider this replaces held a Pixi
    // Container in a module-level `activeSlider`, and `render()` destroys
    // every child of `root` — so the first re-render during a drag destroyed
    // the object the drag was holding. Reading `.position.x` off it threw
    // (Pixi nulls `_position` on destroy), a try/catch then turned that throw
    // into a silent stop, and the drag "stopped sliding while the mouse was
    // still down". Only a real renderer with a real stage can prove the fix:
    // the mocked suite has no hit-testing and no destroy cycle.
    const tunePage = await browser.newPage();
    const tuneDiagnostics = [];
    tunePage.on('console', (message) => {
      if (
        (message.type() === 'error' || message.type() === 'warn') &&
        !isEnvironmentNoise(message.text())
      ) {
        tuneDiagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    tunePage.on('pageerror', (error) => tuneDiagnostics.push(`pageerror: ${error.message}`));
    let tuneStats;
    try {
      await tunePage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await tunePage.goto(`http://127.0.0.1:${port}/?atomaDiag=1&atomaTune=1`, {
        waitUntil: 'load',
      });
      await tunePage.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
      await passArrivalGate(tunePage);
      await tunePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));

      const target = await tunePage.evaluate(() => {
        const handle = globalThis.__ATOMA_GPU__;
        if (!handle) return null;
        const row = handle.hitTargets().find((entry) => entry.id === 'tuning:lightHue');
        if (!row) return null;
        const canvas = document.querySelector('.gpu-ui-canvas');
        const box = canvas.getBoundingClientRect();
        const toClient = (x, y) => ({
          x: box.left + (x / handle.app.screen.width) * box.width,
          y: box.top + (y / handle.app.screen.height) * box.height,
        });
        return {
          left: toClient(row.x, row.y + row.height / 2),
          right: toClient(row.x + row.width, row.y + row.height / 2),
          value: handle.tuning().lightHue,
        };
      });
      if (!target) throw new Error('tuning row never rendered; scenario cannot arm');

      const readValue = () =>
        tunePage.evaluate(() => globalThis.__ATOMA_GPU__.tuning().lightHue);
      const renderCount = () =>
        tunePage.evaluate(() =>
          Number(document.querySelector('.gpu-ui-host').dataset.gpuRenderCount ?? 0));

      // Press near the left end, then walk right in steps with the button held.
      await tunePage.mouse.move(target.left.x + 6, target.left.y);
      await tunePage.mouse.down();
      const afterPress = await readValue();
      const span = target.right.x - target.left.x;
      await tunePage.mouse.move(target.left.x + span * 0.25, target.left.y, { steps: 6 });
      const beforeRender = await readValue();
      const rendersBefore = await renderCount();

      // Force the rebuild that used to kill the drag: a wheel over the event
      // list goes through the store and re-renders the whole scene.
      await tunePage.evaluate(() => {
        const canvas = document.querySelector('.gpu-ui-canvas');
        const box = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new WheelEvent('wheel', {
          deltaY: 240,
          clientX: box.left + box.width * 0.2,
          clientY: box.top + box.height * 0.6,
          bubbles: true,
          cancelable: true,
        }));
      });
      await tunePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
      const rendersAfter = await renderCount();

      // ... and keep dragging, button still down.
      await tunePage.mouse.move(target.left.x + span * 0.75, target.left.y, { steps: 8 });
      const afterRender = await readValue();
      await tunePage.mouse.up();
      await tunePage.mouse.move(target.left.x + span * 0.1, target.left.y, { steps: 4 });
      const afterRelease = await readValue();

      tuneStats = {
        afterPress,
        beforeRender,
        afterRender,
        afterRelease,
        rendersAcross: rendersAfter - rendersBefore,
        diagnostics: tuneDiagnostics,
      };
    } finally {
      await tunePage.close();
    }

    if (
      // ARMED: the drag actually moved the value before the rebuild, and a
      // rebuild actually happened in between. Without both, "the value still
      // changed" would be a scenario that never tested anything.
      !(tuneStats.beforeRender > tuneStats.afterPress) ||
      tuneStats.rendersAcross < 1 ||
      // THE ASSERTION: the drag survived the rebuild.
      !(tuneStats.afterRender > tuneStats.beforeRender) ||
      // And it let go: a release must disarm, or the knob follows the mouse
      // around the screen forever.
      tuneStats.afterRelease !== tuneStats.afterRender ||
      tuneStats.diagnostics.length > 0
    ) {
      throw new Error(`GPU tuning drag failed: ${JSON.stringify(tuneStats)}`);
    }
    console.log(
      `viz GPU tuning ok: drag survived ${tuneStats.rendersAcross} scene rebuild(s) with the button down (${tuneStats.afterPress}° -> ${tuneStats.beforeRender}° -> ${tuneStats.afterRender}°), released clean`
    );

    // Cast-shadow anchors must follow the role-row enter animation. The
    // render anchors every shadow while the entering layer sits lifted; the
    // expand ticker then eases the layer down between renders, and pointer
    // moves never re-render — so without per-tick re-anchoring, every shadow
    // under that layer stays aimed ~40px above its surface until some
    // unrelated render. Only observable here: the mocked suite has no ticker
    // and no stage transforms.
    // The frame period comes from the main page's sampler: same browser, same
    // machine, same rasteriser, so it describes this page's cadence too.
    const restingObservable = frameStats.meanMs < RESTING_FRAME_CEILING_MS;
    const anchorPage = await browser.newPage();
    let anchorStats;
    try {
      await anchorPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await anchorPage.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, {
        waitUntil: 'load',
      });
      await anchorPage.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
      await anchorPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));

      const clickTarget = async (id) => {
        const spot = await anchorPage.evaluate((targetId) => {
          const handle = globalThis.__ATOMA_GPU__;
          const row = handle?.hitTargets().find((entry) => entry.id === targetId);
          if (!row) return null;
          const canvas = document.querySelector('.gpu-ui-canvas');
          const box = canvas.getBoundingClientRect();
          return {
            x: box.left + ((row.x + row.width / 2) / handle.app.screen.width) * box.width,
            y: box.top + ((row.y + row.height / 2) / handle.app.screen.height) * box.height,
          };
        }, id);
        if (!spot) throw new Error(`anchor scenario: hit target ${id} not found`);
        await anchorPage.mouse.click(spot.x, spot.y);
      };
      // This arm has the diagnostic handle, so it passes the gate through the
      // PIXI control itself: proof that the arrival button is hit-testable on
      // the canvas, not only that the a11y bridge mirrors it.
      await clickTarget('welcome.continue');
      await anchorPage.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });
      // Settle AFTER the gate as well as before it: the 600ms above only buys a
      // built splash, and this arm has to catch ONE animation mid-flight — the
      // view's own entry transition running underneath would arm it on the
      // wrong displacement, or hand the enter animation a layer already moving.
      await anchorPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_200)));
      const probe = () =>
        anchorPage.evaluate(() => ({
          drift: globalThis.__ATOMA_GPU__.castShadowAnchorDrift(),
          offset: globalThis.__ATOMA_GPU__.collapseOffset(),
          roleRow: globalThis.__ATOMA_GPU__
            .hitTargets()
            .some((entry) => entry.id.startsWith('run.filter.role.')),
        }));

      const initial = await probe();
      // Hide the role row (kind: tool), let the exit settle and re-render.
      await clickTarget('run.filter.kind.tool');
      await anchorPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));
      const hidden = await probe();
      // Bring it back (kind: llm) and catch the layer MID-FLIGHT: a zero
      // drift is only evidence while the layer is actually displaced.
      await clickTarget('run.filter.kind.llm');
      let midFlight = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const sample = await probe();
        if (sample.offset !== 0) { midFlight = sample; break; }
        await anchorPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 15)));
      }
      // Off the chips before the settled sample: hover scales a chip ±3.5%
      // with centre compensation, which moves the shadow's parent ~1.4px
      // while the pointer sits on it — real, bounded, and not the drift this
      // arm hunts. The animation ticker re-anchors through it mid-flight; at
      // rest nothing does, so the sample must be taken with nothing hovered.
      await anchorPage.mouse.move(10, 780);
      await anchorPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 700)));
      const settled = await probe();
      anchorStats = { initial, hidden, midFlight, settled };
    } finally {
      await anchorPage.close();
    }

    if (
      // ARMED: the role row was there, left, came back, and the enter
      // animation was actually caught displacing the layer.
      !anchorStats.initial.roleRow ||
      anchorStats.hidden.roleRow ||
      !anchorStats.settled.roleRow ||
      anchorStats.midFlight === null ||
      // THE ASSERTION: anchors track the moving layer and its resting place.
      !(anchorStats.midFlight.drift < ANCHOR_DRIFT_MAX) ||
      (restingObservable && !(anchorStats.settled.drift < ANCHOR_DRIFT_MAX))
    ) {
      throw new Error(`GPU shadow anchors drifted: ${JSON.stringify(anchorStats)}`);
    }
    console.log(
      `viz GPU shadow anchors ok: drift ${anchorStats.midFlight.drift.toFixed(3)}px mid-flight (layer at ${anchorStats.midFlight.offset.toFixed(1)}px), ${anchorStats.settled.drift.toFixed(3)}px settled`
    );
    if (!restingObservable) {
      console.log(
        `viz GPU resting anchor NOT CHECKED: ${frameStats.meanMs.toFixed(0)}ms frames ` +
          `outlast the hover-out ease, so the resting sample measures paint staleness`
      );
    }

    // A LIVE run's polling must not rebuild the GPU scene when nothing
    // changed. The trace polls every 1s and the index every 2s; before the
    // reference-stability fixes (spinner flag in the snapshot, per-render
    // byNamespace object, mergeRunDelta returning a copy for an empty delta)
    // that was ~2.5 full scene rebuilds per second — measured as the frame
    // drops on live runs. The repo's own runs/ are all ended (polling stops),
    // so this arm serves its OWN synthetic live run from a temp dir.
    const liveDir = await mkdtemp(join(tmpdir(), 'viz-live-smoke-'));
    const livePort = await freePort();
    let liveServer = null;
    let liveStats;
    const livePage = await browser.newPage();
    try {
      const now = Date.now();
      const liveRun = {
        id: 'smoke-live-run',
        label: 'smoke: synthetic live run',
        startedAt: new Date(now - 60_000).toISOString(),
        events: [
          { id: 'ev1', kind: 'llm', role: 'plan', ts: now - 50_000, title: 'plan' },
          { id: 'ev2', kind: 'tool', ts: now - 40_000, title: 'write_file' },
          { id: 'ev3', kind: 'llm', role: 'execute', ts: now - 5_000, title: 'execute' },
        ],
      };
      const runPath = join(liveDir, 'smoke-live-run.json');
      const writeRun = async () => {
        // Atomic: the server reads this file on every poll, and a torn JSON
        // would surface as a spurious 500 in the diagnostics.
        await writeFile(`${runPath}.tmp`, JSON.stringify(liveRun));
        await rename(`${runPath}.tmp`, runPath);
      };
      await writeRun();
      await writeFile(
        join(liveDir, 'index.json'),
        JSON.stringify([{
          id: liveRun.id,
          label: liveRun.label,
          startedAt: liveRun.startedAt,
          hasError: false,
        }])
      );
      liveServer = spawn(
        process.execPath,
        ['dist/viz/server.js', '--host', '127.0.0.1', '--port', String(livePort), '--dir', liveDir],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const liveDeadline = Date.now() + 10_000;
      while (Date.now() < liveDeadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${livePort}/api/runs`);
          if (response.ok) break;
        } catch {
          // Server still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await livePage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      let tracePolls = 0;
      livePage.on('request', (request) => {
        if (request.url().includes('/api/runs/')) tracePolls += 1;
      });
      await livePage.goto(`http://127.0.0.1:${livePort}/`, { waitUntil: 'load' });
      await livePage.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
      await passArrivalGate(livePage);
      await livePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)));

      const readCount = () =>
        livePage.evaluate(() =>
          Number(document.querySelector('.gpu-ui-host').dataset.gpuRenderCount ?? 0));
      const pollsBefore = tracePolls;
      const idleStart = await readCount();
      // ARM ON THE POLLS, NOT ON THE CLOCK. The trace poll fires every 1s, but a
      // saturated main thread stretches that: under a software rasteriser a
      // fixed 5s window observed exactly 3 polls — the floor this arm asserts,
      // with nothing left for a slower runner. Waiting for the fourth poll keeps
      // the same window on a fast machine and cannot under-arm on a slow one.
      const pollDeadline = Date.now() + 90_000;
      while (tracePolls - pollsBefore < 4 && Date.now() < pollDeadline) {
        await livePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
      }
      const idleEnd = await readCount();
      const idlePolls = tracePolls - pollsBefore;

      // A real event lands: the very next delta must rebuild the scene, or
      // "no rebuilds" above would also pass on a UI that stopped updating.
      liveRun.events.push({ id: 'ev4', kind: 'tool', ts: Date.now(), title: 'read_file' });
      await writeRun();
      // Same reason: wait for the rebuild rather than for a duration that has to
      // contain one. A miss still fails the assertion below — it just fails on
      // the renderer's behaviour instead of on the runner's speed.
      const rebuildDeadline = Date.now() + 90_000;
      let afterEvent = await readCount();
      while (afterEvent <= idleEnd && Date.now() < rebuildDeadline) {
        await livePage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
        afterEvent = await readCount();
      }

      liveStats = {
        idlePolls,
        idleRebuilds: idleEnd - idleStart,
        rebuildsAfterEvent: afterEvent - idleEnd,
      };
    } finally {
      await livePage.close();
      if (liveServer) liveServer.kill('SIGTERM');
      await rm(liveDir, { recursive: true, force: true });
    }

    if (
      // ARMED: the 1s live poll was actually running — with no polls, zero
      // rebuilds would be a scenario that never tested anything.
      liveStats.idlePolls < 3 ||
      // THE ASSERTION: empty polls leave the scene alone...
      liveStats.idleRebuilds !== 0 ||
      // ...and a real delta still reaches it.
      liveStats.rebuildsAfterEvent < 1
    ) {
      throw new Error(`GPU live-poll stability failed: ${JSON.stringify(liveStats)}`);
    }
    console.log(
      `viz GPU live poll ok: ${liveStats.idlePolls} empty polls, 0 rebuilds; real event rebuilt ${liveStats.rebuildsAfterEvent}x`
    );
  } finally {
    await browser.close();
  }

  const fallbackBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  });
  try {
    const page = await fallbackBrowser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const diagnostics = [];
    page.on('console', (message) => {
      if (
        (message.type() === 'error' || message.type() === 'warn') &&
        !isEnvironmentNoise(message.text())
      ) {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        diagnostics.push(`http ${response.status()}: ${response.url()}`);
      }
    });
    await page.goto(`http://127.0.0.1:${port}/?renderer=webgl`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend="webgl"]', { timeout: READY_TIMEOUT_MS });
    await passArrivalGate(page);
    const fallbackCursorEnv = await readCursorEnvironment(page);
    await page.mouse.move(640, 400);
    if (fallbackCursorEnv.expected) {
      await page.waitForSelector('.atoma-pointer-cursor[data-visible="true"]', {
        timeout: READY_TIMEOUT_MS,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    const fallbackResult = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      cursorX: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-x'),
      cursorY: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-y'),
    }));
    if (
      fallbackResult.canvases !== 2 ||
      (fallbackCursorEnv.expected && fallbackResult.cursorX !== '640') ||
      (fallbackCursorEnv.expected && fallbackResult.cursorY !== '400') ||
      diagnostics.length > 0
    ) {
      throw new Error(`GPU fallback diagnostics: ${JSON.stringify({ fallbackResult, diagnostics })}`);
    }
    console.log(
      `viz GPU fallback ok: WebGL${fallbackCursorEnv.expected ? '' : ' (pointer cursor not checked)'}`
    );
  } finally {
    await fallbackBrowser.close();
  }
} finally {
  server.kill('SIGTERM');
  await rm(fixtureDir, { recursive: true, force: true });
}
