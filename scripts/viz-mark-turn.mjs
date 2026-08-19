#!/usr/bin/env node
/* global document, requestAnimationFrame */
/**
 * Capture one full brand-mark rotation, one PNG every 250 ms of animation
 * time, so a lighting/shader change can be judged as a film instead of as a
 * single pose.
 *
 * NOT part of release:check. Needs a real Chrome (channel: chrome) and the
 * arrival-gate page. Steps the mark clock through `__ATOMA_GPU__.pinMarkElapsedMs`
 * rather than waiting 15 s on the wall, so a turn is a few seconds of capture.
 *
 *   npm run viz:mark-turn
 *   npm run viz:mark-turn -- --out .atoma-mark-turn
 *   npm run viz:mark-turn:analyze
 *
 * Frames land in `.atoma-mark-turn/` (gitignored) as `frame-0000.png` …
 * `frame-0060.png` plus `manifest.json`.
 */
import { spawn, execFile as execFileCb } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const execFile = promisify(execFileCb);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Keep in lockstep with ATOMA_MARK_TURN_MS. tests/viz-mark-turn.test.ts holds both. */
export const TURN_MS = 15_000;
export const STEP_MS = 250;
export const FRAME_COUNT = Math.floor(TURN_MS / STEP_MS) + 1;
/** Below this, the film is the aura on an empty field: the shell pipeline refused. */
export const ALIVE_PEAK_MEAN_MIN = 40;

const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 800;
const DEVICE_SCALE = 2;
const READY_TIMEOUT_MS = 60_000;

const LOCAL_SIZE = 28;
const MARK_VIEWPORT_FRACTION = 0.52;
const BUTTON_HEIGHT = 46;
const GAP = 36;
const EDGE = 28;

function crystalClip(width, height) {
  const buttonBlock = GAP + BUTTON_HEIGHT + EDGE;
  const maxMarkPx = Math.min(
    Math.min(width, height) * MARK_VIEWPORT_FRACTION,
    Math.max(LOCAL_SIZE * 6, (height - buttonBlock - EDGE) * 0.92)
  );
  const scale = Math.max(6, maxMarkPx / LOCAL_SIZE);
  const size = LOCAL_SIZE * scale;
  const pad = size * 0.14;
  const cx = width / 2;
  const cy = height / 2;
  // Top pad for the aura; a thin strip below for the contact shadow. Anything
  // taller catches the Continue control, which is a Pixi button (not DOM) and
  // cannot be hidden with a stylesheet.
  return {
    x: Math.max(0, cx - size / 2 - pad),
    y: Math.max(0, cy - size / 2 - pad),
    width: size + pad * 2,
    height: size + pad + 18,
  };
}

export { crystalClip, VIEW_HEIGHT, VIEW_WIDTH };

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function parseOutDir(argv) {
  const flag = argv.indexOf('--out');
  if (flag >= 0 && argv[flag + 1]) return resolve(argv[flag + 1]);
  return resolve(repoRoot, '.atoma-mark-turn');
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not tried';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`viz never answered ${url} (${lastError})`);
}

async function launchChrome() {
  try {
    return await puppeteer.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
    });
  } catch {
    return await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
  }
}

async function assertFilmAlive(outDir) {
  try {
    const { stdout } = await execFile(
      'python3',
      [resolve(repoRoot, 'scripts/viz-mark-turn-analyze.py'), '--dir', outDir]
    );
    if (stdout) process.stdout.write(stdout);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      process.stdout.write('viz:mark-turn: python3 missing, skip alive check\n');
      return;
    }
    throw error;
  }
  const analysis = JSON.parse(await readFile(resolve(outDir, 'analysis.json'), 'utf8'));
  const peakMean = analysis.summary?.peak_mean;
  if (!(peakMean > ALIVE_PEAK_MEAN_MIN)) {
    throw new Error(
      `mark looks dead (peak_mean=${peakMean}); the shell pipeline probably refused`
    );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

export async function captureMarkTurn(options = {}) {
  const outDir = options.outDir ?? parseOutDir(process.argv.slice(2));
  const existingUrl = options.url ?? process.env['ATOMA_MARK_TURN_URL'];
  await mkdir(outDir, { recursive: true });

  let child = null;
  let origin = existingUrl
    ? new URL(existingUrl).origin
    : null;

  if (!origin) {
    const apiPort = await freePort();
    const devPort = await freePort();
    child = spawn(
      process.execPath,
      ['scripts/viz-dev.mjs', '--ui', 'gpu'],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ATOMA_VIZ_UI: 'gpu',
          ATOMA_VIZ_API_PORT: String(apiPort),
          ATOMA_VIZ_DEV_PORT: String(devPort),
        },
      }
    );
    origin = `http://127.0.0.1:${devPort}`;
    await waitForUrl(`${origin}/`, 30_000);
  }

  const browser = await launchChrome();
  const frames = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      deviceScaleFactor: DEVICE_SCALE,
    });
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ]);
    // `load`, never networkidle0: the client polls /api/runs for as long as
    // it is open, and on a software rasteriser Blink never emits networkIdle.
    await page.goto(`${origin}/?atomaDiag=1`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', {
      timeout: READY_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => window.__ATOMA_GPU__?.pinMarkElapsedMs,
      { timeout: READY_TIMEOUT_MS }
    );
    const backend = await page.$eval(
      '.gpu-ui-host',
      (host) => host.dataset.gpuBackend
    );

    const clip = crystalClip(VIEW_WIDTH, VIEW_HEIGHT);
    // Hide the continue control so the crop is the crystal on the field.
    await page.evaluate(() => {
      for (const button of document.querySelectorAll('button')) {
        button.style.visibility = 'hidden';
      }
    });

    const settle = async (elapsedMs) => {
      await page.evaluate(async (ms) => {
        const handle = window.__ATOMA_GPU__;
        handle.pinMarkElapsedMs(ms);
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        // Refraction samples LAST frame's backdrop, so a pin needs two real
        // ticks before the interior matches the pose. Three is the settle.
        await frame();
        await frame();
        await frame();
        handle.app?.render?.();
        await frame();
      }, elapsedMs);
    };

    // Prime the ping-pong backdrop at t=0 so frame 0000 is not last-pose junk.
    await settle(0);
    await settle(0);

    for (let index = 0; index < FRAME_COUNT; index += 1) {
      const elapsedMs = index * STEP_MS;
      await settle(elapsedMs);
      const file = `frame-${String(index).padStart(4, '0')}.png`;
      const path = resolve(outDir, file);
      await page.screenshot({ path, type: 'png', clip, captureBeyondViewport: false });
      frames.push({ index, elapsedMs, file });
      if (index % 10 === 0) {
        process.stdout.write(`viz:mark-turn ${file}  t=${elapsedMs}ms  backend=${backend}\n`);
      }
    }

    const manifest = {
      turnMs: TURN_MS,
      stepMs: STEP_MS,
      frameCount: FRAME_COUNT,
      backend,
      viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT, deviceScaleFactor: DEVICE_SCALE },
      clip,
      frames,
    };
    await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `viz:mark-turn wrote ${FRAME_COUNT} frames to ${outDir} (${backend})\n`
    );
    await assertFilmAlive(outDir);
    return manifest;
  } finally {
    await browser.close();
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
}

if (isMain) {
  captureMarkTurn().catch((error) => {
    console.error(`viz:mark-turn failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
