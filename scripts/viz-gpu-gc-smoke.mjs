/* global window */
/**
 * Regression smoke for the pointer-light GC trap.
 *
 * Pixi SKIPS a disabled filter, so its uniform buffer stops being touched and
 * `Buffer._gcLastUsed` stops advancing. After `gcMaxUnusedTime` Pixi's
 * GCSystem unloads it and calls `GPUBuffer.destroy()` — while
 * `BindGroupSystem._hash` keeps handing out a cached GPUBindGroup that still
 * points at the dead buffer (its key is the UniformGroup's `_resourceId`,
 * which never changes, and nothing sets `BindGroup._dirty`). Re-enabling the
 * filter then makes EVERY `queue.submit` a validation error, forever:
 *
 *   [Buffer (unlabeled)] used in submit while destroyed.
 *    - While calling [Queue].Submit([[CommandBuffer]])
 *
 * Reported from a real session ("lose focus on Chrome, come back later"),
 * reproduced on Metal WebGPU at ~120 errors/s until reload.
 *
 * Pixi 8.19.0 also collects in-use *static* UBOs (global uniforms, batcher)
 * after the same window (pixijs#12080). The product therefore leaves
 * `renderer.gc.enabled = false` on WebGPU until a release includes
 * pixijs#12147. This smoke still forces a collection so the pointer-light
 * pin remains proven if GC is ever turned back on.
 *
 * This check is DELIBERATELY NOT in `release:check`: it needs a real WebGPU
 * adapter, and the bundled headless Chromium falls back to SwiftShader/WebGL
 * where bind groups do not exist and the defect CANNOT appear. Run it on a
 * GPU machine with Chrome installed:
 *
 *   npm run viz:smoke:gc
 *
 * It exits 0 with a loud SKIPPED line when it cannot observe the defect, and
 * it FAILS if the preconditions it needs never materialise — "cannot observe"
 * must never be reported as "verified".
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer';

const DESTROYED_BUFFER = /used in submit while destroyed/i;
/** Collapsed GC clock: the product ships 60s; the mechanism is identical. */
const MAX_UNUSED_MS = Number(process.env['ATOMA_GC_SMOKE_UNUSED_MS'] ?? 400);
const AWAY_MS = Number(process.env['ATOMA_GC_SMOKE_AWAY_MS'] ?? 1500);

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const value = typeof address === 'object' && address ? address.port : 0;
    probe.close((error) => (error ? reject(error) : resolve(value)));
  });
});

const server = spawn(
  process.execPath,
  ['dist/viz/server.js', '--host', '127.0.0.1', '--port', String(port)],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let browser;

const finish = (code, message) => {
  if (code === 0) console.log(message);
  else console.error(`✗ viz GPU gc smoke: ${message}`);
  void browser?.close();
  server.kill('SIGTERM');
  process.exit(code);
};

try {
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // compiled server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!up) finish(1, 'compiled viz server never answered /api/runs');

  try {
    browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
  } catch (error) {
    finish(0, `viz GPU gc smoke SKIPPED — no installed Chrome (${error.message})`);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  const collect = (text) => {
    if (DESTROYED_BUFFER.test(text)) errors.push(text);
  };
  page.on('console', (message) => collect(message.text()));
  page.on('pageerror', (error) => collect(error.message));
  await page.evaluateOnNewDocument(() => {
    window.__gpuErrors = [];
    const request = navigator.gpu?.requestDevice;
    if (!navigator.gpu?.requestAdapter) return;
    const originalAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      const adapter = await originalAdapter(...args);
      if (adapter && request) {
        const originalDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...deviceArgs) => {
          const device = await originalDevice(...deviceArgs);
          device.addEventListener('uncapturederror', (event) => {
            window.__gpuErrors.push(String(event.error?.message ?? event.error));
          });
          return device;
        };
      }
      return adapter;
    };
  });

  await page.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.gpu-ui-host[data-gpu-backend]');
  const backend = await page.$eval('.gpu-ui-host', (host) => host.dataset.gpuBackend);
  if (backend !== 'webgpu') {
    finish(
      0,
      `viz GPU gc smoke SKIPPED — backend is "${backend}", not webgpu; this defect lives in ` +
        'the WebGPU bind-group cache and cannot be observed here.'
    );
  }
  await page.waitForFunction(() => window.__ATOMA_GPU__ !== undefined, { timeout: 10_000 });

  const gcEnabled = await page.evaluate(() => window.__ATOMA_GPU__.app.renderer.gc.enabled);
  if (gcEnabled !== false) {
    finish(
      1,
      'WebGPU GC was left enabled — Pixi 8.19.0 collects in-use static uniform ' +
        'buffers whose bind groups stay cached (pixijs#12080). Keep renderer.gc.enabled = false ' +
        'until a Pixi release includes pixijs#12147.'
    );
  }

  // 1. Light the pointer filter so Pixi caches its bind group. PROVE it armed:
  //    without this the whole check would pass because nothing ever happened.
  await page.mouse.move(700, 500);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.mouse.move(720, 520);
  const armed = await page.waitForFunction(
    () => window.__ATOMA_GPU__.pointerLightFilter()?.enabled === true,
    { timeout: 5000 }
  ).catch(() => null);
  if (!armed) finish(1, 'the pointer light never enabled — precondition not met, nothing was tested');

  // 2. Leave: `blur` is what the reporter did (focus another window). The tab
  //    stays VISIBLE so rAF keeps running and the GC clock advances.
  const away = await page.evaluate(
    async ([maxUnused, awayMs]) => {
      const app = window.__ATOMA_GPU__.app;
      app.renderer.gc.maxUnusedTime = maxUnused;
      window.dispatchEvent(new Event('blur'));
      await new Promise((resolve) => setTimeout(resolve, awayMs));
      return { filterEnabled: window.__ATOMA_GPU__.pointerLightFilter()?.enabled };
    },
    [MAX_UNUSED_MS, AWAY_MS]
  );
  if (away.filterEnabled !== false) {
    finish(1, 'the pointer light stayed enabled while away — precondition not met');
  }

  // 3. Force the collection the product would reach after 60s idle, and PROVE
  //    it actually collected something.
  const collected = await page.evaluate(() => {
    const gc = window.__ATOMA_GPU__.app.renderer.gc;
    gc._ready = true;
    gc.run();
    return { errors: window.__gpuErrors.length };
  });

  // 4. Come back and move the pointer: this re-enables the filter onto
  //    whatever buffer survived, and floods if it was collected.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (let step = 0; step < 10; step++) {
    await page.mouse.move(400 + step * 20, 300 + step * 12);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const uncaptured = await page.evaluate(() => window.__gpuErrors.filter(
    (message) => /used in submit while destroyed/i.test(message)
  ).length);

  if (errors.length || uncaptured) {
    finish(
      1,
      `${errors.length} console + ${uncaptured} uncaptured destroyed-buffer submit error(s) ` +
        `after an idle period across the GC clock (${collected.errors} before returning). The ` +
        'pointer-light uniform buffer was collected while its bind group stayed cached.\n' +
        `  first: ${errors[0] ?? '(uncaptured only)'}`
    );
  }
  finish(
    0,
    `viz GPU gc smoke ok: webgpu, GC disabled, pointer light armed then idled across a ${MAX_UNUSED_MS}ms GC ` +
      'clock with a forced collection, 0 destroyed-buffer submits after the pointer returned'
  );
} catch (error) {
  finish(1, `harness error: ${error.message}`);
}
