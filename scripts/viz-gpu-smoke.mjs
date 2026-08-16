/* global document, HTMLButtonElement, requestAnimationFrame, MutationObserver, WheelEvent */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
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

const port = await freePort();
const server = spawn(
  process.execPath,
  ['dist/viz/server.js', '--host', '127.0.0.1', '--port', String(port)],
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
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    const diagnostics = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
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
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]');
    await page.mouse.move(640, 400);
    await page.waitForSelector('.atoma-pointer-cursor[data-visible="true"]');
    await new Promise((resolve) => setTimeout(resolve, 180));
    const frameStats = await page.evaluate(() => new Promise((resolve) => {
      const samples = [];
      let previous;
      const frame = (now) => {
        if (previous !== undefined) samples.push(now - previous);
        previous = now;
        if (samples.length < 120) requestAnimationFrame(frame);
        else {
          const sorted = [...samples].sort((left, right) => left - right);
          resolve({
            meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
            p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          });
        }
      };
      requestAnimationFrame(frame);
    }));

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
        {},
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
      const awaitRender = async () => {
        const before = samples.length;
        const deadline = performance.now() + 500;
        while (samples.length === before && performance.now() < deadline) await frame();
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
      result.cursorX !== '640' ||
      result.cursorY !== '400' ||
      frameStats.p95Ms > 35 ||
      // The scroll scenario must ARM before its numbers mean anything: every
      // tick has to have produced a rebuild, and there have to be rebuilds.
      scrollStats.missed !== 0 ||
      scrollStats.renders < 20 ||
      // Generous against CI variance — measured P95 is 2.2-3.3ms and one frame
      // is 16.7ms. This catches a collapse, not a drift.
      scrollStats.p95Ms > 12 ||
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
      `viz GPU smoke ok: ${result.canvases} canvases, ${result.backend}, ${result.objects} objects, five views, pointer light ${frameStats.meanMs.toFixed(2)}ms mean/${frameStats.p95Ms.toFixed(2)}ms P95`
    );
    console.log(
      `viz GPU nav ok: 6 RUNS<->SKILLS round-trips past the 560ms view transition, views ${navStats.views.join('/')}, no render error`
    );
    console.log(
      `viz GPU scroll ok: ${scrollStats.renders} rebuilds (${scrollStats.missed} ticks missed), ${scrollStats.p50Ms.toFixed(2)}ms P50/${scrollStats.p95Ms.toFixed(2)}ms P95/${scrollStats.maxMs.toFixed(2)}ms max, labels ${scrollStats.reused} reused vs ${scrollStats.created} built`
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
      if (message.type() === 'error' || message.type() === 'warn') {
        tuneDiagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    tunePage.on('pageerror', (error) => tuneDiagnostics.push(`pageerror: ${error.message}`));
    let tuneStats;
    try {
      await tunePage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await tunePage.goto(`http://127.0.0.1:${port}/?atomaDiag=1&atomaTune=1`, {
        waitUntil: 'networkidle0',
      });
      await tunePage.waitForSelector('.gpu-ui-host[data-gpu-backend]');
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
    const anchorPage = await browser.newPage();
    let anchorStats;
    try {
      await anchorPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await anchorPage.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, {
        waitUntil: 'networkidle0',
      });
      await anchorPage.waitForSelector('.gpu-ui-host[data-gpu-backend]');
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
      !(anchorStats.midFlight.drift < 0.5) ||
      !(anchorStats.settled.drift < 0.5)
    ) {
      throw new Error(`GPU shadow anchors drifted: ${JSON.stringify(anchorStats)}`);
    }
    console.log(
      `viz GPU shadow anchors ok: drift ${anchorStats.midFlight.drift.toFixed(3)}px mid-flight (layer at ${anchorStats.midFlight.offset.toFixed(1)}px), ${anchorStats.settled.drift.toFixed(3)}px settled`
    );
  } finally {
    await browser.close();
  }

  const fallbackBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await fallbackBrowser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const diagnostics = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
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
    await page.goto(`http://127.0.0.1:${port}/?renderer=webgl`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend="webgl"]');
    await page.mouse.move(640, 400);
    await page.waitForSelector('.atoma-pointer-cursor[data-visible="true"]');
    await new Promise((resolve) => setTimeout(resolve, 180));
    const fallbackResult = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      cursorX: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-x'),
      cursorY: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-y'),
    }));
    if (
      fallbackResult.canvases !== 2 ||
      fallbackResult.cursorX !== '640' ||
      fallbackResult.cursorY !== '400' ||
      diagnostics.length > 0
    ) {
      throw new Error(`GPU fallback diagnostics: ${JSON.stringify({ fallbackResult, diagnostics })}`);
    }
    console.log('viz GPU fallback ok: WebGL');
  } finally {
    await fallbackBrowser.close();
  }
} finally {
  server.kill('SIGTERM');
}
