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
      diagnostics.length > 0
    ) {
      throw new Error(
        `GPU smoke failed: ${JSON.stringify({ ...result, frameStats, scrollStats, diagnostics })}`
      );
    }
    console.log(
      `viz GPU smoke ok: ${result.canvases} canvases, ${result.backend}, ${result.objects} objects, five views, pointer light ${frameStats.meanMs.toFixed(2)}ms mean/${frameStats.p95Ms.toFixed(2)}ms P95`
    );
    console.log(
      `viz GPU scroll ok: ${scrollStats.renders} rebuilds (${scrollStats.missed} ticks missed), ${scrollStats.p50Ms.toFixed(2)}ms P50/${scrollStats.p95Ms.toFixed(2)}ms P95/${scrollStats.maxMs.toFixed(2)}ms max, labels ${scrollStats.reused} reused vs ${scrollStats.created} built`
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
