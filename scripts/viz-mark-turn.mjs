#!/usr/bin/env node
/* global document, requestAnimationFrame, window */
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
 *   npm run viz:mark-turn -- --degree 47
 *   npm run viz:mark-turn -- --pointer
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
const SLIDER_HEIGHT = 28;
const MARK_TO_SLIDER = 22;
const SLIDER_TO_BUTTON = 18;
const EDGE = 28;

function crystalClip(width, height) {
  const buttonBlock = MARK_TO_SLIDER + SLIDER_HEIGHT + SLIDER_TO_BUTTON + BUTTON_HEIGHT + EDGE;
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
  // taller catches the inspect row (turn slider + bead check) and Continue,
  // which are Pixi controls (not DOM) and cannot be hidden with a stylesheet.
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
  if (argv.includes('--pointer')) return resolve(repoRoot, '.atoma-mark-pointer');
  return resolve(repoRoot, '.atoma-mark-turn');
}

function parseDegree(argv) {
  const flag = argv.indexOf('--degree');
  if (flag < 0) return null;
  const raw = argv[flag + 1];
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`viz:mark-turn --degree needs a number, got ${raw ?? '(missing)'}`);
  }
  return ((value % 360) + 360) % 360;
}

function parsePointer(argv) {
  return argv.includes('--pointer');
}

/**
 * Welcome-mark local (28×28) → CSS pixels. Same scale as `crystalClip` /
 * `welcomeLayout`, rest pose `frame.scale === 1`.
 */
function localToClient(localX, localY, width, height) {
  const buttonBlock = MARK_TO_SLIDER + SLIDER_HEIGHT + SLIDER_TO_BUTTON + BUTTON_HEIGHT + EDGE;
  const maxMarkPx = Math.min(
    Math.min(width, height) * MARK_VIEWPORT_FRACTION,
    Math.max(LOCAL_SIZE * 6, (height - buttonBlock - EDGE) * 0.92)
  );
  const scale = Math.max(6, maxMarkPx / LOCAL_SIZE);
  return {
    x: width / 2 + (localX - LOCAL_SIZE / 2) * scale,
    y: height / 2 + (localY - LOCAL_SIZE / 2) * scale,
  };
}

/** Rest-pose pointer stations: off the gem, then on the tables. */
const POINTER_SHOTS = [
  { name: 'off', local: null },
  { name: 'center', local: [14, 14] },
  { name: 'up', local: [14, 7] },
  { name: 'down', local: [14, 21] },
  { name: 'left', local: [7, 14] },
  { name: 'right', local: [21, 14] },
  { name: 'ul', local: [8, 8] },
  { name: 'ur', local: [20, 8] },
  { name: 'll', local: [8, 20] },
  { name: 'lr', local: [20, 20] },
];

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
  const argv = process.argv.slice(2);
  const outDir = options.outDir ?? parseOutDir(argv);
  const degree = options.degree ?? parseDegree(argv);
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
      ['--import', 'tsx', 'scripts/viz-dev.mjs', '--ui', 'gpu'],
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
      () => window.__ATOMA_GPU__?.pinMarkElapsedMs && window.__ATOMA_GPU__?.movePointerLight,
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

    const placePointer = async (local) => {
      await page.evaluate(async (coords) => {
        const handle = window.__ATOMA_GPU__;
        if (!coords) handle.hidePointerLight();
        else {
          const client = handle.projectRendererPoint(coords.x, coords.y);
          handle.movePointerLight(client.x, client.y);
        }
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        await frame();
        await frame();
        handle.app?.render?.();
        await frame();
      }, local);
    };

    // Prime the ping-pong backdrop at t=0 so frame 0000 is not last-pose junk.
    await settle(0);
    await settle(0);

    const pointer = options.pointer ?? parsePointer(process.argv.slice(2));
    const host = await page.evaluate(() => ({
      width: window.__ATOMA_GPU__.app.screen.width,
      height: window.__ATOMA_GPU__.app.screen.height,
    }));

    let shots;
    if (pointer) {
      const elapsedMs = (degree ?? 0) / 360 * TURN_MS;
      await settle(elapsedMs);
      shots = POINTER_SHOTS.map((shot, index) => {
        const client = shot.local
          ? localToClient(shot.local[0], shot.local[1], host.width, host.height)
          : null;
        return {
          index,
          elapsedMs,
          file: `pointer-${shot.name}.png`,
          degree: degree ?? 0,
          pointer: client,
        };
      });
    } else {
      shots = degree === null
        ? Array.from({ length: FRAME_COUNT }, (_, index) => ({
          index,
          elapsedMs: index * STEP_MS,
          file: `frame-${String(index).padStart(4, '0')}.png`,
          degree: index * STEP_MS / TURN_MS * 360,
          pointer: undefined,
        }))
        : [{
          index: 0,
          elapsedMs: degree / 360 * TURN_MS,
          file: `degree-${String(Math.round(degree)).padStart(3, '0')}.png`,
          degree,
          pointer: undefined,
        }];
    }

    for (const shot of shots) {
      if (!pointer) await settle(shot.elapsedMs);
      if (pointer) await placePointer(shot.pointer);
      const path = resolve(outDir, shot.file);
      await page.screenshot({ path, type: 'png', clip, captureBeyondViewport: false });
      frames.push(shot);
      if (pointer || degree !== null || shot.index % 10 === 0) {
        process.stdout.write(
          `viz:mark-turn ${shot.file}  t=${shot.elapsedMs}ms  deg=${shot.degree.toFixed(1)}  backend=${backend}\n`
        );
      }
    }

    const manifest = {
      turnMs: TURN_MS,
      stepMs: STEP_MS,
      frameCount: shots.length,
      degree,
      pointer,
      backend,
      viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT, deviceScaleFactor: DEVICE_SCALE },
      clip,
      frames,
    };
    await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `viz:mark-turn wrote ${shots.length} frame${shots.length === 1 ? '' : 's'} to ${outDir} (${backend})\n`
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
