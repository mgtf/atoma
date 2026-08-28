/* global document, DOMMatrixReadOnly, DOMPoint, getComputedStyle, HTMLButtonElement, HTMLElement, matchMedia, requestAnimationFrame, MutationObserver, WheelEvent, window */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const packageMetadata = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
const releaseVersion = packageMetadata.version;
if (typeof releaseVersion !== 'string' || releaseVersion.length === 0) {
  throw new Error('package.json must declare a non-empty version');
}

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
 * Browser-generated WebGPU validation errors do not travel through
 * `page.on('console')`: Chrome writes them to DevTools and dispatches an
 * `uncapturederror` event on the GPUDevice. Install the listener before any
 * application module can request the device, or an invalid WGSL module can
 * render nothing while this smoke reports a clean console and a WebGPU
 * backend.
 */
async function captureWebGpuErrors(page) {
  await page.evaluateOnNewDocument(() => {
    const errors = [];
    Object.defineProperty(window, '__ATOMA_WEBGPU_ERRORS__', {
      value: errors,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    const gpu = navigator.gpu;
    if (!gpu) return;
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...args) => {
      const adapter = await requestAdapter(...args);
      if (!adapter) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...deviceArgs) => {
        const device = await requestDevice(...deviceArgs);
        device.addEventListener('uncapturederror', (event) => {
          if (errors.length < 20) {
            errors.push(event.error?.message ?? String(event.error));
          }
        });
        return device;
      };
      return adapter;
    };
  });
}

async function newWebGpuPage(browser) {
  const page = await browser.newPage();
  await captureWebGpuErrors(page);
  return page;
}

async function readWebGpuErrors(page) {
  return await page.evaluate(() => window.__ATOMA_WEBGPU_ERRORS__ ?? []);
}

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
const HARDWARE_FRAME_P95_MAX_MS = 35;

async function sampleFrames(page) {
  return await page.evaluate(
    (target, budgetMs) => new Promise((resolve) => {
      const samples = [];
      let previous;
      const started = performance.now();
      const frame = (now) => {
        if (previous !== undefined) samples.push(now - previous);
        previous = now;
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
}

/**
 * Reach the entered app, passing the ARRIVAL GATE when one is shown.
 *
 * The gate is NOT per-page: `enter()` persists `atoma.viz.entered` in
 * localStorage, which is per ORIGIN, so it is shared by every page of this
 * browser. The first arm that clicks Continue admits every LATER arm
 * automatically, and those pages boot straight into the tablist with no gate
 * and no version span to read. This helper therefore treats the gate as
 * OPTIONAL and asserts on whichever state it actually finds — it used to wait
 * on `.gpu-a11y-bridge button`, a selector that matches the entered app's
 * tablist too, so an already-entered page slipped past the wait and then died
 * on the gate-only span with a bare "failed to find element".
 *
 * The version assertion still runs on every page that DOES show a gate, which
 * is the one that matters: the first arm of a fresh browser profile.
 */
async function passArrivalGate(page) {
  // Either the gate (its version span) or the entered app (its tablist).
  await page.waitForFunction(
    () =>
      document.querySelector('.gpu-a11y-bridge [data-release-version]') !== null ||
      document.querySelector('[role="tab"]') !== null,
    { timeout: READY_TIMEOUT_MS }
  );

  const gate = await page.$('.gpu-a11y-bridge [data-release-version]');
  if (!gate) {
    // Already admitted by an earlier arm's persisted entry. Nothing to click.
    await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });
    return;
  }

  const arrivalVersion = await page.$eval(
    '.gpu-a11y-bridge [data-release-version]',
    (element) => ({
      value: element.getAttribute('data-release-version'),
      label: element.textContent?.trim() ?? '',
    })
  );
  if (arrivalVersion.value !== releaseVersion || arrivalVersion.label !== `v${releaseVersion}`) {
    throw new Error(
      `arrival gate release version mismatch: expected v${releaseVersion}, got ${arrivalVersion.label}`
    );
  }
  await page.evaluate(() => {
    if (document.querySelector('[role="tab"]')) return;
    // Scoped to the GATE's own bridge: the entered app has buttons too, and a
    // document-wide lookup would be a coin toss between the two branches.
    const bridge = document
      .querySelector('.gpu-a11y-bridge [data-release-version]')
      ?.closest('.gpu-a11y-bridge');
    const control = bridge?.querySelector('button');
    if (!(control instanceof HTMLButtonElement)) {
      // A GATED instance renders provider anchors instead of Continue, so this
      // means the fixture failed to stub whoami, not that the app is broken.
      throw new Error(
        bridge?.querySelector('a')
          ? 'arrival gate is a login: whoami is not stubbed as authenticated'
          : 'arrival gate control missing'
      );
    }
    control.click();
  });
  await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });
}

/**
 * Open a view by its nav label, and let the 560ms view transition finish.
 *
 * The app now OPENS ON PROJECTS, so every arm that exercises the RUNS view —
 * the tuning panel, the filter rows, the live trace poll — has to navigate
 * there first. They used to simply arrive on it.
 *
 * The arrival is OBSERVED, not slept through. A fixed settle was sized against
 * a machine that paints in milliseconds; on the CI runner a frame is ~3s, so
 * 700ms after the click the view had not rendered once and the arms that read
 * hit targets right after it reported the app's contents as missing (`tuning
 * row never rendered`, on every run since 2026-08-23). The live region is the
 * same signal the main arm already waits on for its six-view sweep, and it
 * names the view the surface actually rendered. The settle after it is for the
 * 560ms view transition, which the live region does not cover.
 */
async function openView(page, label) {
  await page.evaluate((name) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (candidate) => candidate.textContent === name
    );
    if (!tab) throw new Error(`nav tab missing: ${name}`);
    // This helper opens a destination; re-activating an already-selected row
    // is a different product action now — it toggles the camera overview.
    if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  }, label);
  await page.waitForFunction(
    (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
    { timeout: READY_TIMEOUT_MS },
    label
  );
  await page.waitForFunction(
    () => document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-motion') === 'settled',
    { timeout: READY_TIMEOUT_MS }
  );
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 700)));
}

async function waitForSceneCamera(page, mode) {
  await page.waitForFunction(
    (expected) => {
      const plane = document.querySelector('.gpu-scene-camera');
      return plane?.getAttribute('data-scene-camera-mode') === expected &&
        plane.getAttribute('data-scene-camera-motion') === 'settled';
    },
    { timeout: READY_TIMEOUT_MS },
    mode
  );
}

/** Compare the rAF-published projection with the matrix actually painted. */
async function sampleMovingCameraAlignment(page) {
  return await page.evaluate(async () => {
    const plane = document.querySelector('.gpu-scene-camera');
    const handle = globalThis.__ATOMA_GPU__;
    const target = handle?.hitTargets().find((entry) => entry.id === 'nav.runs');
    if (!(plane instanceof HTMLElement) || !handle?.projectRendererPoint || !target) {
      throw new Error('camera alignment diagnostics did not arm');
    }
    const rendererWidth = handle.app.screen.width;
    const rendererHeight = handle.app.screen.height;
    const rendererPoint = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    for (let frame = 0; frame < 90; frame += 1) {
      const progress = Number(plane.dataset.sceneCameraProgress ?? '1');
      if (plane.dataset.sceneCameraMotion === 'moving' && progress > 0 && progress < 1) {
        const projected = handle.projectRendererPoint(rendererPoint.x, rendererPoint.y);
        const matrix = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
        const painted = matrix.transformPoint(new DOMPoint(
          rendererPoint.x * plane.clientWidth / rendererWidth,
          rendererPoint.y * plane.clientHeight / rendererHeight
        ));
        const paintedX = painted.x / painted.w;
        const paintedY = painted.y / painted.w;
        return {
          sampled: true,
          progress,
          error: Math.hypot(projected.x - paintedX, projected.y - paintedY),
        };
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // A software rasteriser can spend longer than the full travelling shot on
    // one frame. Endpoint clicks below still prove both published poses; unit
    // tests cover every mathematical intermediate on such a runner.
    return { sampled: false, progress: 1, error: 0 };
  });
}

/**
 * Arm BEFORE a camera click and observe the retained Pixi frame against the
 * exact inverse of every painted CSS pose. This includes the stable samples
 * on either side, so a jump at motion start or settle cannot hide between two
 * `moving` samples.
 */
function beginMovingViewFrameRecorder(page) {
  const recording = page.evaluate(async () => {
    const plane = document.querySelector('.gpu-scene-camera');
    const handle = globalThis.__ATOMA_GPU__;
    if (!(plane instanceof HTMLElement) || !handle?.projectRendererPoint) {
      throw new Error('camera frame diagnostics did not arm');
    }
    const host = document.querySelector('.gpu-ui-host');
    const rendererHeight = handle.app.screen.height;
    const samples = [];
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    const startRenderCount = Number(host?.getAttribute('data-gpu-render-count') ?? '0');
    const read = () => {
      let primary = null;
      const walk = (node) => {
        if (node.label === 'view-frame-primary') primary = node;
        for (const child of node.children ?? []) walk(child);
      };
      walk(handle.app.stage);
      if (!primary) throw new Error('primary view frame missing during camera travel');
      const bounds = primary.getBounds();
      const sourceBottom = (bounds.y + bounds.height) *
        plane.clientHeight / Math.max(1, rendererHeight);
      const matrix = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
      const inverse = matrix.inverse();
      const foot = (x) => {
        const point = inverse.transformPoint(new DOMPoint(x, window.innerHeight));
        return point.y / point.w;
      };
      const visibleFoot = Math.min(foot(0), foot(window.innerWidth));
      const bottom = handle.projectRendererPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height
      ).y;
      minimum = Math.min(minimum, bottom);
      maximum = Math.max(maximum, bottom);
      samples.push({
        motion: plane.dataset.sceneCameraMotion ?? null,
        progress: Number(plane.dataset.sceneCameraProgress ?? '1'),
        sourceBottom,
        visibleFoot,
        bottom,
        at: performance.now(),
      });
    };
    read();
    globalThis.__ATOMA_CAMERA_FRAME_RECORDER_ARMED__ = true;
    let moving = false;
    for (let frame = 0; frame < 180; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      read();
      if (plane.dataset.sceneCameraMotion === 'moving') moving = true;
      if (moving && plane.dataset.sceneCameraMotion === 'settled') {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        read();
        break;
      }
    }
    delete globalThis.__ATOMA_CAMERA_FRAME_RECORDER_ARMED__;
    const inset = samples[0].visibleFoot - samples[0].sourceBottom;
    const errors = samples.map((sample) =>
      Math.abs(sample.sourceBottom - (sample.visibleFoot - inset))
    );
    const endRenderCount = Number(host?.getAttribute('data-gpu-render-count') ?? '0');
    return {
      samples,
      movingSamples: samples.filter((sample) => sample.motion === 'moving').length,
      minimum,
      maximum,
      maxTrackingError: Math.max(...errors),
      renderDelta: endRenderCount - startRenderCount,
      viewportHeight: window.innerHeight,
    };
  });
  const armed = page.waitForFunction(
    () => globalThis.__ATOMA_CAMERA_FRAME_RECORDER_ARMED__ === true,
    { timeout: READY_TIMEOUT_MS }
  );
  return { armed, recording };
}

function assertMovingViewFrame(stats, direction, softwareRastered) {
  if (stats.movingSamples === 0 && softwareRastered) return;
  if (stats.movingSamples < 2) {
    throw new Error(`camera frame travel did not arm: ${JSON.stringify(stats)}`);
  }
  const tolerance = 0.75;
  for (let index = 1; index < stats.samples.length; index += 1) {
    const previous = stats.samples[index - 1].sourceBottom;
    const current = stats.samples[index].sourceBottom;
    if (
      (direction === 'zoom' && current > previous + tolerance) ||
      (direction === 'dezoom' && current < previous - tolerance)
    ) {
      throw new Error(
        `camera frame height reversed during ${direction}: ${JSON.stringify(stats)}`
      );
    }
  }
  if (
    stats.maxTrackingError > 1 ||
    stats.minimum < stats.viewportHeight - 16 ||
    stats.maximum > stats.viewportHeight - 0.5 ||
    stats.renderDelta < 1 ||
    stats.renderDelta > 2
  ) {
    throw new Error(
      `camera frame did not resize continuously during ${direction}: ${JSON.stringify(stats)}`
    );
  }
}

/**
 * Read one canvas hit target, waiting for it to exist. Same reason as
 * `openView`: a target the renderer has not drawn yet is indistinguishable
 * from one it will never draw, and only the clock tells them apart.
 */
async function waitForHitTarget(page, id, describe) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const found = await page.evaluate(
      (targetId) =>
        globalThis.__ATOMA_GPU__?.hitTargets().some((entry) => entry.id === targetId) ?? false,
      id
    );
    if (found) return;
    if (Date.now() > deadline) throw new Error(describe);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  }
}

/**
 * Read the real Pixi scene, not a source-code proxy. Every visible RUNS event
 * must own one chrome face and appear in the ONE shared diffuse + normal mesh,
 * with no local filter that would split it into a render-to-texture pass.
 */
async function readTimelineCardMaterials(page) {
  return await page.evaluate(() => {
    const handle = globalThis.__ATOMA_GPU__;
    if (!handle?.app?.stage || !handle.hitTargets) {
      throw new Error('timeline card material diagnostics did not arm');
    }
    const eventIds = [...new Set(handle.hitTargets()
      .map((entry) => entry.id)
      .filter((id) => id.startsWith('event.'))
      .map((id) => id.slice('event.'.length)))].sort();
    const cardIds = [];
    const faceIds = [];
    const underlayIds = [];
    const legacyGrainIds = [];
    const filtered = [];
    const batches = [];
    const visit = (node) => {
      const label = String(node.label ?? '');
      if (label.startsWith('timeline-card') && (node.filters?.length ?? 0) > 0) {
        filtered.push(label);
      }
      if (label.startsWith('timeline-card:')) {
        cardIds.push(label.slice('timeline-card:'.length));
      }
      if (label.startsWith('timeline-card-face:')) {
        faceIds.push(label.slice('timeline-card-face:'.length));
      }
      if (label.startsWith('timeline-card-underlay:')) {
        underlayIds.push(label.slice('timeline-card-underlay:'.length));
      }
      if (label.startsWith('timeline-card-grain:')) {
        legacyGrainIds.push(label.slice('timeline-card-grain:'.length));
      }
      if (label === 'timeline-card-material-batch') {
        const shader = node.shader;
        const resources = shader?.resources ?? {};
        const diffuse = resources.uSandDiffuse;
        const normal = resources.uSandNormal;
        const geometry = node.geometry;
        const cardCount = Number(node.timelineCardCount ?? -1);
        const colorAttribute = geometry?.attributes?.aBaseColor;
        const colorData = colorAttribute?.buffer?.data;
        const colorStride = Number(colorAttribute?.stride ?? 16) / 4;
        const colorOffset = Number(colorAttribute?.offset ?? 0) / 4;
        const baseColors = [];
        for (let face = 0; face < cardCount; face += 1) {
          const offset = face * 9 * colorStride + colorOffset;
          baseColors.push([
            Number(colorData?.[offset] ?? -1),
            Number(colorData?.[offset + 1] ?? -1),
            Number(colorData?.[offset + 2] ?? -1),
          ]);
        }
        batches.push({
          cardIds: [...(node.timelineCardIds ?? [])].sort(),
          cardCount,
          shaderUid: Number(shader?.uid ?? -1),
          compatibleRenderers: Number(shader?.compatibleRenderers ?? -1),
          diffuseLabel: String(diffuse?.label ?? ''),
          normalLabel: String(normal?.label ?? ''),
          diffuseUid: Number(diffuse?.uid ?? -1),
          normalUid: Number(normal?.uid ?? -1),
          diffuseAlive: diffuse?.destroyed === false,
          normalAlive: normal?.destroyed === false,
          diffuseWidth: Number(diffuse?.width ?? 0),
          diffuseHeight: Number(diffuse?.height ?? 0),
          normalWidth: Number(normal?.width ?? 0),
          normalHeight: Number(normal?.height ?? 0),
          diffuseRepeat: diffuse?.style?.addressMode === 'repeat',
          normalRepeat: normal?.style?.addressMode === 'repeat',
          diffuseSamplerBound: resources.uSandDiffuseSampler === diffuse?.style,
          normalSamplerBound: resources.uSandNormalSampler === normal?.style,
          geometrySize: Number(geometry?.getSize?.() ?? 0),
          geometryAttributes: Object.keys(geometry?.attributes ?? {}).sort(),
          baseColors,
        });
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(handle.app.stage);
    return {
      eventIds,
      cardIds: cardIds.sort(),
      faceIds: faceIds.sort(),
      underlayIds: underlayIds.sort(),
      legacyGrainIds: legacyGrainIds.sort(),
      filtered: filtered.sort(),
      batches,
    };
  });
}

function timelineCardsUseSharedMaterial(state) {
  const eventKey = state.eventIds.join('\0');
  const batch = state.batches[0];
  return state.eventIds.length > 0 &&
    state.cardIds.join('\0') === eventKey &&
    state.faceIds.join('\0') === eventKey &&
    state.underlayIds.join('\0') === eventKey &&
    state.legacyGrainIds.length === 0 &&
    state.filtered.length === 0 &&
    state.batches.length === 1 &&
    batch.cardIds.join('\0') === eventKey &&
    batch.cardCount === state.eventIds.length &&
    batch.shaderUid > 0 &&
    batch.compatibleRenderers === 3 &&
    batch.diffuseLabel === 'timeline-sand-diffuse' &&
    batch.normalLabel === 'timeline-sand-normal' &&
    batch.diffuseUid > 0 &&
    batch.normalUid > 0 &&
    batch.diffuseUid !== batch.normalUid &&
    batch.diffuseAlive &&
    batch.normalAlive &&
    batch.diffuseWidth > 1 &&
    batch.diffuseHeight > 1 &&
    batch.normalWidth > 1 &&
    batch.normalHeight > 1 &&
    batch.diffuseRepeat &&
    batch.normalRepeat &&
    batch.diffuseSamplerBound &&
    batch.normalSamplerBound &&
    batch.geometrySize >= state.eventIds.length * 9 &&
    batch.geometryAttributes.join(',') === 'aBaseColor,aMaterialPx,aPosition' &&
    batch.baseColors.length === state.eventIds.length &&
    batch.baseColors.every((color) =>
      color.every((channel) => channel >= 0 && channel < 0.55) &&
      color.some((channel) => channel > 0));
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
 * before the sixteenth tick still moves it. The arm then reverses all sixteen
 * ticks to compare resources at the exact same scroll offset. 80 keeps margin
 * without inflating the per-rebuild layout that the same arm is timing.
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
    const page = await newWebGpuPage(browser);
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
    page.on('error', (error) => diagnostics.push(`page-crash: ${error.message}`));
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
    await page.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
    const rasteriser = await readRasteriser(page);
    const softwareRastered = SOFTWARE_RASTERISERS.test(rasteriser);
    // The gate GATES: nothing navigable exists behind it until it is passed.
    if (await page.$('[role="tab"]')) {
      throw new Error('arrival gate did not hold: nav tabs rendered before Continue');
    }
    let welcomeCrystalFrameStats = null;
    let welcomeRecoveryFrameStats = null;
    if (softwareRastered) {
      console.log(
        `viz GPU welcome crystal performance NOT CHECKED: software rasteriser (${rasteriser})`
      );
    } else {
      // THE CAUSTIC HOT PATH. The ordinary frame sample below runs only after
      // Continue, where the hero crystal is gone. Drive its real centre and
      // arm on the published production cast before measuring, or a missed
      // pointer would flatter the shader through its intensity early-out.
      await page.mouse.move(640, 400);
      await page.waitForFunction(
        () => (globalThis.__ATOMA_MARK_CAUSTIC__?.intensity ?? 0) > 0.001,
        { polling: 'raf', timeout: READY_TIMEOUT_MS }
      );
      welcomeCrystalFrameStats = await sampleFrames(page);
      await page.mouse.move(1200, 750);
      await page.waitForFunction(
        () => (globalThis.__ATOMA_MARK_CAUSTIC__?.intensity ?? 0) < 0.001,
        { polling: 'raf', timeout: READY_TIMEOUT_MS }
      );
      welcomeRecoveryFrameStats = await sampleFrames(page);
      console.log(
        `viz GPU welcome crystal probe: ${welcomeCrystalFrameStats.meanMs.toFixed(2)}ms mean/` +
          `${welcomeCrystalFrameStats.p95Ms.toFixed(2)}ms P95; recovered to ` +
          `${welcomeRecoveryFrameStats.p95Ms.toFixed(2)}ms P95`
      );
    }
    await passArrivalGate(page);
    const arrivalView = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null
    );
    if (arrivalView !== 'Projects') {
      throw new Error(`GPU arrival view must be Projects, got ${String(arrivalView)}`);
    }
    await page.waitForFunction(
      () => !document.querySelector('.gpu-entry-veil')?.hasAttribute('data-phase'),
      { timeout: READY_TIMEOUT_MS }
    );
    const arrivalCamera = await page.evaluate(() => {
      const plane = document.querySelector('.gpu-scene-camera');
      const matrix = plane instanceof HTMLElement
        ? new DOMMatrixReadOnly(getComputedStyle(plane).transform)
        : null;
      const identity = matrix
        ? [
            matrix.m11 - 1, matrix.m12, matrix.m13, matrix.m14,
            matrix.m21, matrix.m22 - 1, matrix.m23, matrix.m24,
            matrix.m31, matrix.m32, matrix.m33 - 1, matrix.m34,
            matrix.m41, matrix.m42, matrix.m43, matrix.m44 - 1,
          ]
        : [Number.POSITIVE_INFINITY];
      let headerBands = 0;
      const walk = (node) => {
        if (node.label === 'header-band') headerBands += 1;
        for (const child of node.children ?? []) walk(child);
      };
      walk(globalThis.__ATOMA_GPU__.app.stage);
      return {
        mode: plane?.getAttribute('data-scene-camera-mode') ?? null,
        motion: plane?.getAttribute('data-scene-camera-motion') ?? null,
        transform: plane instanceof HTMLElement ? plane.style.transform : '',
        identityError: Math.max(...identity.map((value) => Math.abs(value))),
        headerBands,
      };
    });
    if (arrivalCamera.mode !== 'overview' || arrivalCamera.motion !== 'settled') {
      throw new Error(`arrival camera must frame the whole scene: ${JSON.stringify(arrivalCamera)}`);
    }
    if (arrivalCamera.identityError > 1e-9) {
      throw new Error(
        `arrival camera must not deform the authored scene: ${JSON.stringify(arrivalCamera)}`
      );
    }
    if (arrivalCamera.headerBands !== 1) {
      throw new Error(`overview header band missing: ${JSON.stringify(arrivalCamera)}`);
    }

    // Camera navigation through the REAL Pixi rail. First activation advances
    // from the establishing overview to the content column; re-activation of
    // that same destination returns. Both clicks are projected through the
    // live pose, so this also proves endpoint inverse hit-testing.
    await waitForHitTarget(page, 'nav.projects', 'Projects camera target never rendered');
    const projectNavPoint = async () => await page.evaluate(() => {
      const handle = globalThis.__ATOMA_GPU__;
      const target = handle?.hitTargets().find((entry) => entry.id === 'nav.projects');
      if (!target || !handle.projectRendererPoint) return null;
      const point = handle.projectRendererPoint(
        target.x + target.width / 2,
        target.y + target.height / 2
      );
      return point.x >= 1 && point.x <= window.innerWidth - 1 &&
        point.y >= 1 && point.y <= window.innerHeight - 1
        ? point
        : null;
    });
    const overviewNavPoint = await projectNavPoint();
    if (!overviewNavPoint) throw new Error('overview camera could not project Projects menu');
    const focusFrameRecorder = beginMovingViewFrameRecorder(page);
    await focusFrameRecorder.armed;
    await page.mouse.click(overviewNavPoint.x, overviewNavPoint.y);
    const movingCamera = await sampleMovingCameraAlignment(page);
    const focusFrameTravel = await focusFrameRecorder.recording;
    assertMovingViewFrame(focusFrameTravel, 'zoom', softwareRastered);
    await waitForSceneCamera(page, 'focus');
    const focusCamera = await page.evaluate(() => {
      const plane = document.querySelector('.gpu-scene-camera');
      if (!(plane instanceof HTMLElement)) return null;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
      const sourceTop = Number(plane.dataset.sceneCameraSourceTop ?? '0');
      const project = (x, y) => {
        const point = matrix.transformPoint(new DOMPoint(x, y));
        return { x: point.x / point.w, y: point.y / point.w };
      };
      return {
        transform: plane.style.transform,
        sourceTop,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        topLeft: project(0, sourceTop),
        topMiddle: project(plane.clientWidth / 2, sourceTop),
        topRight: project(plane.clientWidth, sourceTop),
        middleRight: project(plane.clientWidth, plane.clientHeight / 2),
        bottomRight: project(plane.clientWidth, plane.clientHeight),
      };
    });
    if (!focusCamera || focusCamera.transform === arrivalCamera.transform) {
      throw new Error('camera focus did not change the scene projection');
    }
    const topEdgeError = Math.max(
      Math.abs(focusCamera.topLeft.y),
      Math.abs(focusCamera.topMiddle.y),
      Math.abs(focusCamera.topRight.y)
    );
    const rightCornerError = Math.abs(
      focusCamera.viewport.width - focusCamera.topRight.x
    );
    if (
      topEdgeError > 0.75 ||
      rightCornerError > 0.75 ||
      focusCamera.middleRight.x < focusCamera.viewport.width - 0.75 ||
      focusCamera.bottomRight.x < focusCamera.viewport.width - 0.75
    ) {
      throw new Error(
        `focused camera exposed the page background: ${JSON.stringify(focusCamera)}`
      );
    }
    if (movingCamera.sampled && movingCamera.error > 0.75) {
      throw new Error(
        `camera projection drifted ${movingCamera.error.toFixed(3)}px at ` +
        `${(movingCamera.progress * 100).toFixed(1)}% travel`
      );
    }
    await page.waitForFunction(
      () => {
        const targets = globalThis.__ATOMA_GPU__?.hitTargets()
          .filter((entry) => entry.id.startsWith('nav.')) ?? [];
        return targets.length > 0 && targets.every((entry) => entry.width <= 44.01);
      },
      { timeout: READY_TIMEOUT_MS }
    );
    const compactRail = await page.evaluate(() => {
      const handle = globalThis.__ATOMA_GPU__;
      const targets = handle.hitTargets().filter((entry) => entry.id.startsWith('nav.'));
      return targets.map((entry) => {
        const centre = handle.projectRendererPoint(
          entry.x + entry.width / 2,
          entry.y + entry.height / 2
        );
        return {
          id: entry.id,
          width: entry.width,
          centre,
          visible: centre.x >= 1 && centre.x <= window.innerWidth - 1 &&
            centre.y >= 1 && centre.y <= window.innerHeight - 1,
        };
      });
    });
    const hiddenCompactTarget = compactRail.find(({ visible }) => !visible);
    if (hiddenCompactTarget) {
      throw new Error(`focused icon rail left a destination off-screen: ${JSON.stringify(hiddenCompactTarget)}`);
    }
    const focusRailChrome = await page.evaluate(() => {
      const handle = globalThis.__ATOMA_GPU__;
      const targets = handle.hitTargets();
      const nav = targets.filter((entry) => entry.id.startsWith('nav.'));
      const control = (id) => {
        const entry = targets.find((candidate) => candidate.id === id);
        if (!entry) return null;
        const centre = handle.projectRendererPoint(
          entry.x + entry.width / 2,
          entry.y + entry.height / 2
        );
        return {
          id,
          source: entry,
          centre,
          visible: centre.x >= 0 && centre.x <= window.innerWidth &&
            centre.y >= 0 && centre.y <= window.innerHeight,
        };
      };
      let headerBands = 0;
      let mark = null;
      let fps = null;
      const walk = (node) => {
        if (node.label === 'header-band') headerBands += 1;
        if (node.label === 'atoma-mark') {
          const origin = node.getGlobalPosition();
          mark = handle.projectRendererPoint(origin.x + 14, origin.y + 14);
        }
        if (node.label === 'fps-readout') {
          const bounds = node.getBounds();
          const topLeft = handle.projectRendererPoint(bounds.x, bounds.y);
          const bottomRight = handle.projectRendererPoint(
            bounds.x + bounds.width,
            bounds.y + bounds.height
          );
          fps = {
            centre: {
              x: (topLeft.x + bottomRight.x) / 2,
              y: (topLeft.y + bottomRight.y) / 2,
            },
            height: Math.abs(bottomRight.y - topLeft.y),
          };
        }
        for (const child of node.children ?? []) walk(child);
      };
      walk(handle.app.stage);
      const firstNav = nav.length > 0
        ? handle.projectRendererPoint(
            nav[0].x + nav[0].width / 2,
            nav[0].y + nav[0].height / 2
          )
        : null;
      const lastNavEntry = nav.at(-1);
      const lastNav = lastNavEntry
        ? handle.projectRendererPoint(
            lastNavEntry.x + lastNavEntry.width / 2,
            lastNavEntry.y + lastNavEntry.height / 2
          )
        : null;
      return {
        viewportHeight: window.innerHeight,
        headerBands,
        mark,
        fps,
        firstNav,
        lastNav,
        profile: control('account.menu.toggle'),
        // `locale.menu.toggle`, matching `account.menu.toggle` beside it. It was
        // `locale.toggle` until the i18n commit renamed the control on
        // 2026-08-27 and left this asking for a name nothing records — a
        // failure that could only ever surface here, since the browser smoke
        // left CI on 2026-08-24. `tests/viz-gpu-smoke-contract.test.ts` now
        // fails on the mismatch inside `npm run check` instead.
        locale: control('locale.menu.toggle'),
      };
    });
    if (
      focusRailChrome.headerBands !== 0 ||
      !focusRailChrome.mark ||
      !focusRailChrome.fps ||
      !focusRailChrome.firstNav ||
      !focusRailChrome.lastNav ||
      !focusRailChrome.locale?.visible ||
      focusRailChrome.mark.y >= focusRailChrome.firstNav.y ||
      focusRailChrome.locale.centre.y <= focusRailChrome.lastNav.y ||
      focusRailChrome.fps.centre.y <= focusRailChrome.locale.centre.y ||
      focusRailChrome.fps.centre.y > focusRailChrome.viewportHeight ||
      focusRailChrome.fps.height > 12 ||
      (focusRailChrome.profile !== null && !focusRailChrome.profile.visible)
    ) {
      throw new Error(`focused rail chrome is misplaced: ${JSON.stringify(focusRailChrome)}`);
    }
    const focusDomEdges = await page.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const bridge = document.querySelector('.gpu-a11y-bridge');
      const firstBridgeButton = bridge?.querySelector('button');
      if (!(bridge instanceof HTMLElement) || !(firstBridgeButton instanceof HTMLElement)) {
        return { viewport, palette: null, push: null, announce: null };
      }
      firstBridgeButton.focus();
      const palette = bounds(bridge);
      firstBridgeButton.blur();

      const plane = document.querySelector('.gpu-scene-camera');
      if (!(plane instanceof HTMLElement)) {
        return { viewport, palette, push: null, announce: null };
      }
      const probe = (className, text) => {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = text;
        plane.append(element);
        const rect = bounds(element);
        element.remove();
        return rect;
      };
      return {
        viewport,
        palette,
        push: probe('gpu-push-prompt', 'Notification permission probe'),
        announce: probe('gpu-panel-skin gpu-announce-form', 'Announcement composer probe'),
      };
    });
    const outsideViewport = (rect) => !rect ||
      rect.left < -0.75 || rect.top < -0.75 ||
      rect.right > focusDomEdges.viewport.width + 0.75 ||
      rect.bottom > focusDomEdges.viewport.height + 0.75;
    if (
      outsideViewport(focusDomEdges.palette) ||
      outsideViewport(focusDomEdges.push) ||
      outsideViewport(focusDomEdges.announce)
    ) {
      throw new Error(
        `focused DOM overlay escaped the camera viewport: ${JSON.stringify(focusDomEdges)}`
      );
    }
    const focusNavPoint = await projectNavPoint();
    if (!focusNavPoint) throw new Error('focus camera could not project Projects menu');
    await page.mouse.move(focusNavPoint.x, focusNavPoint.y);
    await page.waitForFunction(
      () => {
        const tooltip = globalThis.__ATOMA_GPU__?.tooltip?.();
        return tooltip?.visible === true && tooltip.text === 'Projects';
      },
      { timeout: READY_TIMEOUT_MS }
    );
    const focusClickSurface = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        x,
        y,
        tag: element?.tagName ?? null,
        className: element instanceof HTMLElement ? element.className : null,
      };
    }, focusNavPoint);
    const returnFrameRecorder = beginMovingViewFrameRecorder(page);
    await returnFrameRecorder.armed;
    await page.mouse.click(focusNavPoint.x, focusNavPoint.y);
    const returnFrameTravel = await returnFrameRecorder.recording;
    assertMovingViewFrame(returnFrameTravel, 'dezoom', softwareRastered);
    const focusClickMode = await page.evaluate(() =>
      document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-mode'));
    if (focusClickMode !== 'overview') {
      throw new Error(`focus camera return click missed: ${JSON.stringify(focusClickSurface)}`);
    }
    await waitForSceneCamera(page, 'overview');
    const returnedCamera = await page.evaluate(() => {
      const plane = document.querySelector('.gpu-scene-camera');
      return {
        transform: plane instanceof HTMLElement ? plane.style.transform : '',
        tooltip: globalThis.__ATOMA_GPU__?.tooltip?.() ?? null,
      };
    });
    if (returnedCamera.transform !== arrivalCamera.transform || returnedCamera.tooltip?.visible) {
      throw new Error(`camera did not restore the neutral overview cleanly: ${JSON.stringify(returnedCamera)}`);
    }
    console.log(
      `viz GPU camera probe: overview -> focus -> overview through Pixi; ` +
      (movingCamera.sampled
        ? `${movingCamera.error.toFixed(3)}px projection error at ${(movingCamera.progress * 100).toFixed(1)}%`
        : 'mid-travel sample skipped by slow frame') +
      (returnFrameTravel.movingSamples > 0
        ? `; frame tracked within ${Math.max(
            focusFrameTravel.maxTrackingError,
            returnFrameTravel.maxTrackingError
          ).toFixed(3)}px across ${focusFrameTravel.movingSamples + returnFrameTravel.movingSamples} travel samples`
        : '; frame travel sample skipped by slow frame')
    );
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
    const frameStats = await sampleFrames(page);

    const scrollRebuildMax = softwareRastered
      ? SOFTWARE_SCROLL_REBUILD_P95_MAX
      : SCROLL_REBUILD_P95_MAX;
    // Six tabs, matching `visibleViews(null)` on the ungated developer path
    // plus the return to Runs. There is no Launch tab: the family guidance
    // lives inside the project run form.
    const views = ['Projects', 'Registry', 'Skills', 'Burn-in', 'Docs', 'Runs'];
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
    await waitForSceneCamera(page, 'focus');

    // The camera crops the source plane to remove the old header. The view
    // must reflow to the inverse-projected viewport foot too: retaining raw
    // canvas height leaves the lower frame border below the screen, exactly
    // the defect a still screenshot exposed. Runs labels both real panels so
    // this probe observes rendered production geometry, not camera math alone.
    const focusedViewFrames = await page.evaluate(() => {
      const handle = globalThis.__ATOMA_GPU__;
      const frames = [];
      let frameLayer = null;
      let gutter = null;
      const walk = (node) => {
        if (node.label === 'camera-view-frames') frameLayer = node;
        if (node.label === 'camera-view-gutter') gutter = node;
        if (node.label === 'view-frame-primary' || node.label === 'view-frame-secondary') {
          const bounds = node.getBounds();
          const bottom = handle.projectRendererPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height
          );
          frames.push({
            label: node.label,
            parentLabel: node.parent?.label ?? null,
            bottom,
            sourceBounds: bounds,
          });
        }
        for (const child of node.children ?? []) walk(child);
      };
      walk(handle.app.stage);
      const frameLayerChildren = frameLayer?.children ?? [];
      return {
        viewportHeight: window.innerHeight,
        frames,
        frameLayerShadows: frameLayerChildren.filter(
          (node) => node.label === 'cast-shadow'
        ).length,
        frameLayerFilledGraphics: frameLayerChildren.filter(
          (node) => node.context?.instructions?.some(
            (instruction) => instruction.action === 'fill'
          )
        ).length,
        // FOCUS HAS NO GUTTER, and that is the contract, not an omission:
        // `viewFrameGutterRects` returns none there because focus has no
        // horizontal header seam to wash over, and painting one would put a
        // second frame edge under the real one's rounded corner
        // (`renderer/view-frame.ts`, 831654e). This probe asserted the
        // OVERVIEW shape here and was left behind by that change; nothing
        // caught it because the smoke had already left CI two days earlier.
        gutterPresent: gutter !== null,
      };
    });
    if (
      focusedViewFrames.frames.length !== 2 ||
      focusedViewFrames.frameLayerShadows !== 0 ||
      focusedViewFrames.frameLayerFilledGraphics !== focusedViewFrames.frames.length ||
      focusedViewFrames.gutterPresent ||
      focusedViewFrames.frames.some(({ parentLabel }) =>
        parentLabel !== 'camera-view-frames'
      ) ||
      focusedViewFrames.frames.some(({ bottom }) =>
        bottom.y > focusedViewFrames.viewportHeight - 0.5 ||
        bottom.y < focusedViewFrames.viewportHeight - 32
      )
    ) {
      throw new Error(
        `focused view frame composite is invalid: ${JSON.stringify(focusedViewFrames)}`
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
      const handle = globalThis.__ATOMA_GPU__;
      if (!handle?.projectRendererPoint) {
        throw new Error('scene camera projection diagnostics did not arm');
      }
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
      const wheelPoint = handle.projectRendererPoint(
        handle.app.screen.width * 0.2,
        handle.app.screen.height * 0.6
      );
      const clientX = wheelPoint.x;
      const clientY = wheelPoint.y;
      const managedResources = () => {
        const renderer = window.__ATOMA_GPU__?.app?.renderer;
        const graphics = renderer?.graphicsContext?._managedContexts?.items;
        const buffers = renderer?.buffer?._managedBuffers?.items;
        if (!graphics || !buffers) {
          throw new Error('GPU managed-resource diagnostics did not arm');
        }
        const live = (items) => Object.values(items).filter(Boolean).length;
        return {
          graphicsContexts: live(graphics),
          buffers: live(buffers),
        };
      };
      const runCycle = async (onMiss) => {
        for (let tick = 0; tick < 32; tick++) {
          canvas.dispatchEvent(new WheelEvent('wheel', {
            deltaY: tick < 16 ? 140 : -140,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }));
          if (!(await awaitRender())) onMiss();
        }
      };

      // First cycle warms the bounded label cache and material batches across
      // the complete viewport range. The second takes the exact same route and
      // returns to scroll=0, so resource equality is a deterministic lifetime
      // contract — no heap threshold and no timing heuristic. Before the fix,
      // this leaked ~400 GraphicsContexts and ~100 buffers PER rebuild.
      let warmupMissed = 0;
      let missed = 0;
      await runCycle(() => { warmupMissed += 1; });
      await frame();
      const resourcesBefore = managedResources();
      samples.length = 0;
      await runCycle(() => { missed += 1; });
      await frame();
      const resourcesAfter = managedResources();
      observer.disconnect();
      const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      const at = (quantile) => durations[Math.min(durations.length - 1, Math.floor(durations.length * quantile))] ?? 0;
      return {
        renders: samples.length,
        warmupMissed,
        missed,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        maxMs: durations[durations.length - 1] ?? 0,
        created: samples.reduce((sum, sample) => sum + sample.created, 0),
        reused: samples.reduce((sum, sample) => sum + sample.reused, 0),
        resourcesBefore,
        resourcesAfter,
      };
    });
    const cardMaterialStats = await readTimelineCardMaterials(page);

    const result = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      backend: document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-backend'),
      objects: Number(document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-objects')),
      cursorX: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-x'),
      cursorY: document.querySelector('.atoma-pointer-cursor')?.getAttribute('data-y'),
      webgpuErrors: window.__ATOMA_WEBGPU_ERRORS__ ?? [],
    }));
    if (
      result.canvases !== 1 ||
      !['webgpu', 'webgl'].includes(result.backend ?? '') ||
      result.objects < 20 ||
      (cursorEnv.expected && result.cursorX !== '640') ||
      (cursorEnv.expected && result.cursorY !== '400') ||
      // The pointer-light budget is a claim about the PRODUCT's animation
      // cost, so it is asserted where frames are real. Measured on the same
      // build: 17.5ms P95 on this machine's Metal-backed WebGPU against 357ms
      // under `--use-angle=swiftshader`, which times the rasteriser and nothing
      // else. Skipped loudly below rather than silently relaxed.
      (!softwareRastered && (
        frameStats.samples < FRAME_SAMPLES ||
        welcomeCrystalFrameStats.samples < FRAME_SAMPLES ||
        welcomeRecoveryFrameStats.samples < FRAME_SAMPLES
      )) ||
      (!softwareRastered && frameStats.p95Ms > HARDWARE_FRAME_P95_MAX_MS) ||
      (!softwareRastered &&
        welcomeCrystalFrameStats.p95Ms > HARDWARE_FRAME_P95_MAX_MS) ||
      // The scroll scenario must ARM before its numbers mean anything: every
      // tick in BOTH complete cycles has to have produced a rebuild, and there
      // have to be rebuilds.
      scrollStats.warmupMissed !== 0 ||
      scrollStats.missed !== 0 ||
      scrollStats.renders < 30 ||
      scrollStats.p95Ms > scrollRebuildMax ||
      scrollStats.resourcesBefore.graphicsContexts <= 0 ||
      scrollStats.resourcesBefore.buffers <= 0 ||
      scrollStats.resourcesAfter.graphicsContexts !==
        scrollStats.resourcesBefore.graphicsContexts ||
      scrollStats.resourcesAfter.buffers !== scrollStats.resourcesBefore.buffers ||
      // A filter or one material draw per visible card makes ALL slower than
      // TRUST. Exact scene labels and public Shader/Geometry resources prove
      // the scroll scenario used one direct diffuse + normal mesh instead.
      !timelineCardsUseSharedMaterial(cardMaterialStats) ||
      // The sharp one. Label retention is what keeps a rebuild off the canvas
      // text path; losing it drops this straight to zero, where the timing
      // budget above would still pass.
      scrollStats.reused / Math.max(1, scrollStats.reused + scrollStats.created) < 0.8 ||
      // Armed: both views actually rendered. Silent: the round-trips raised
      // nothing new in the console.
      navStats.views.join(',') !== 'Runs,Skills' ||
      navStats.newDiagnostics !== 0 ||
      result.webgpuErrors.length > 0 ||
      diagnostics.length > 0
    ) {
      throw new Error(
        `GPU smoke failed: ${JSON.stringify({
          ...result,
          frameStats,
          welcomeCrystalFrameStats,
          welcomeRecoveryFrameStats,
          scrollStats,
          cardMaterialStats,
          navStats,
          diagnostics,
        })}`
      );
    }
    console.log(
      `viz GPU smoke ok: ${result.canvases} canvases, ${result.backend}, ${result.objects} objects, six views, pointer light ${frameStats.meanMs.toFixed(2)}ms mean/${frameStats.p95Ms.toFixed(2)}ms P95 over ${frameStats.samples} frames`
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
      `viz GPU scroll ok: ${scrollStats.renders} measured rebuilds after a full warm-up ` +
        `(${scrollStats.warmupMissed + scrollStats.missed} ticks missed), ` +
        `${scrollStats.p50Ms.toFixed(2)}ms P50/${scrollStats.p95Ms.toFixed(2)}ms P95/` +
        `${scrollStats.maxMs.toFixed(2)}ms max against a ${scrollRebuildMax}ms ceiling, ` +
        `labels ${scrollStats.reused} reused vs ${scrollStats.created} built, resources stable at ` +
        `${scrollStats.resourcesAfter.graphicsContexts} graphics contexts/` +
        `${scrollStats.resourcesAfter.buffers} buffers, ` +
        `${cardMaterialStats.eventIds.length} cards in one shared diffuse + normal mesh`
    );

    // THE REGRESSION SCENARIO. Scene Tuning is DOM chrome so it can sit above
    // DOM project/settings forms; its sliders still write the mutable sample
    // the Pixi ticker reads. A real browser proves both stacking/drag geometry
    // and that slider motion changes the scene without rebuilding the canvas.
    const tunePage = await newWebGpuPage(browser);
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
      await tunePage.waitForSelector('.gpu-scene-tuning', { timeout: READY_TIMEOUT_MS });

      const panelBefore = await tunePage.$eval('.gpu-scene-tuning', (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const moveHandle = await tunePage.$eval('.gpu-scene-tuning__header', (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await tunePage.mouse.move(moveHandle.x, moveHandle.y);
      await tunePage.mouse.down();
      await tunePage.mouse.move(moveHandle.x - 90, moveHandle.y + 45, { steps: 6 });
      await tunePage.mouse.up();
      const panelAfter = await tunePage.$eval('.gpu-scene-tuning', (node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const panelDelta = {
        x: panelAfter.x - panelBefore.x,
        y: panelAfter.y - panelBefore.y,
      };

      const target = await tunePage.$eval('input[name="lightHue"]', (node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.y + rect.height / 2 };
      });

      const readValue = () =>
        tunePage.evaluate(() => globalThis.__ATOMA_GPU__.tuning().lightHue);
      const renderCount = () =>
        tunePage.evaluate(() =>
          Number(document.querySelector('.gpu-ui-host').dataset.gpuRenderCount ?? 0));

      // DOM range input writes the mutable sample directly: the scene changes,
      // but React never asks the GPU renderer to tear down and rebuild.
      const beforeDrag = await readValue();
      const rendersBefore = await renderCount();
      await tunePage.mouse.move(target.left + 6, target.y);
      await tunePage.mouse.down();
      const span = target.right - target.left;
      await tunePage.mouse.move(target.left + span * 0.75, target.y, { steps: 8 });
      await tunePage.mouse.up();
      const afterDrag = await readValue();
      const rendersAfter = await renderCount();
      await tunePage.mouse.move(target.left + span * 0.1, target.y, { steps: 4 });
      const afterRelease = await readValue();

      tuneStats = {
        beforeDrag,
        afterDrag,
        afterRelease,
        panelDelta,
        rendersDuringSlider: rendersAfter - rendersBefore,
        diagnostics: [
          ...tuneDiagnostics,
          ...(await readWebGpuErrors(tunePage)).map((error) => `webgpu: ${error}`),
        ],
      };
    } finally {
      await tunePage.close();
    }

    if (
      tuneStats.panelDelta.x > -70 ||
      tuneStats.panelDelta.y < 30 ||
      tuneStats.afterDrag === tuneStats.beforeDrag ||
      tuneStats.rendersDuringSlider !== 0 ||
      tuneStats.afterRelease !== tuneStats.afterDrag ||
      tuneStats.diagnostics.length > 0
    ) {
      throw new Error(`GPU tuning drag failed: ${JSON.stringify(tuneStats)}`);
    }
    console.log(
      `viz GPU tuning ok: DOM panel moved ${tuneStats.panelDelta.x.toFixed(0)}×${tuneStats.panelDelta.y.toFixed(0)}px above view overlays; slider changed ${tuneStats.beforeDrag}° -> ${tuneStats.afterDrag}° with 0 GPU rebuilds`
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
    const anchorPage = await newWebGpuPage(browser);
    let anchorStats;
    try {
      await anchorPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      // This arm's whole point is CLICKING the GL arrival control, so it needs
      // a gate to click — and `enter()` persists `atoma.viz.entered`, which is
      // per ORIGIN and therefore shared with every page opened before it. An
      // earlier arm's Continue would admit this one silently, leaving no
      // control on the canvas and no coverage of the thing being proved.
      //
      // Clearing the flag BEFORE the app's scripts run is what a fresh visitor
      // is; `evaluateOnNewDocument` runs on every navigation, ahead of the
      // store's `initialEntered()` read. A separate browser context also gives
      // a clean origin, but its page is never the front page, and headless
      // Chrome does not deliver synthesized clicks into Pixi's hit-testing
      // there — the gate rendered and then swallowed six clicks in a row.
      await anchorPage.evaluateOnNewDocument(() => {
        try {
          localStorage.removeItem('atoma.viz.entered');
        } catch {
          // Storage is optional; the gate simply shows.
        }
      });
      await anchorPage.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, {
        waitUntil: 'load',
      });
      await anchorPage.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS });
      // The splash has to be BUILT before its control can be hit: same
      // observed-not-slept rule as `openView`.
      await waitForHitTarget(
        anchorPage,
        'welcome.continue',
        'anchor scenario: arrival control never rendered'
      );

      const clickTarget = async (id) => {
        const spot = await anchorPage.evaluate((targetId) => {
          const handle = globalThis.__ATOMA_GPU__;
          const row = handle?.hitTargets().find((entry) => entry.id === targetId);
          if (!row || !handle.projectRendererPoint) return null;
          return handle.projectRendererPoint(
            row.x + row.width / 2,
            row.y + row.height / 2
          );
        }, id);
        if (!spot) throw new Error(`anchor scenario: hit target ${id} not found`);
        await anchorPage.mouse.click(spot.x, spot.y);
      };
      // This arm has the diagnostic handle, so it passes the gate through the
      // PIXI control itself: proof that the arrival button is hit-testable on
      // the canvas, not only that the a11y bridge mirrors it.
      //
      // RETRIED, because one click is not a guarantee here. The hit target is
      // published by a render, but the Pixi listener that answers it is
      // attached on the frame that draws the control; on a software rasteriser
      // in a cold storage partition those can be far enough apart that the
      // first synthetic click lands on a button which is drawn but not yet
      // listening, and it is silently swallowed. The ASSERTION is unchanged —
      // the GL control must admit us — this only stops a lost first click from
      // being reported as "the gate never opened".
      //
      // A retry is attempted ONLY while the control is still on the canvas. A
      // landed click removes it, and the runner draws one frame every ~2s, so
      // a fixed short wait between attempts expired while entry was already in
      // flight — the next `clickTarget` then threw "hit target not found" on
      // the gate it had just successfully dismissed. Absence of the control is
      // therefore progress, not an error: wait it out rather than re-click.
      const gateDeadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (await anchorPage.$('[role="tab"]')) break;
        if (Date.now() > gateDeadline) {
          throw new Error('anchor scenario: GL arrival control never admitted the visitor');
        }
        const stillOffered = await anchorPage.evaluate(
          () =>
            globalThis.__ATOMA_GPU__
              ?.hitTargets()
              .some((entry) => entry.id === 'welcome.continue') ?? false
        );
        if (stillOffered) await clickTarget('welcome.continue');
        // Long enough for several frames on a ~2s/frame CPU rasteriser, so a
        // click in flight is never mistaken for one that was swallowed.
        await anchorPage
          .waitForSelector('[role="tab"]', { timeout: 10_000 })
          .catch(() => {});
      }
      // The filter rows this arm animates are the RUNS view's.
      await openView(anchorPage, 'Runs');
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
      anchorStats = {
        initial,
        hidden,
        midFlight,
        settled,
        webgpuErrors: await readWebGpuErrors(anchorPage),
      };
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
      anchorStats.webgpuErrors.length > 0 ||
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


    // THE ACCOUNT ORB AND ITS MENU, on a real device.
    //
    // The orb is a Mesh with its OWN program (AVATAR_ORB_WGSL / _GLSL). A
    // shader that fails to compile is invisible to the mocked suite — no
    // device, no compiler — and the ungated developer path never draws one,
    // because the orb only exists where an account does. So this arm STANDS
    // THE GATE UP IN THE BROWSER: whoami is answered as authenticated and the
    // org-scoped reads are stubbed, which is the smallest fixture that gets
    // the real renderer to compile and draw the program.
    const accountPage = await newWebGpuPage(browser);
    let accountStats;
    const accountDiagnostics = [];
    try {
      await accountPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      accountPage.on('console', (message) => {
        if (
          (message.type() === 'error' || message.type() === 'warn') &&
          !isEnvironmentNoise(message.text())
        ) {
          accountDiagnostics.push(`${message.type()}: ${message.text()}`);
        }
      });
      accountPage.on('pageerror', (error) => {
        accountDiagnostics.push(`pageerror: ${error.message}`);
      });
      await accountPage.setRequestInterception(true);
      const principalId = '11111111-2222-3333-4444-555555555555';
      const projectId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
      const stubs = {
        '/auth/whoami': {
          enabled: true,
          authenticated: true,
          principalId,
          displayName: 'Ada Lovelace',
          displayNameSource: 'provider',
          // No avatar: the procedural interior is the path every account has
          // before its provider picture arrives, so it is the one to prove.
          avatarUrl: null,
          role: 'org:owner',
          platformAdmin: true,
          activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
          organisations: [
            { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
            { id: 'org-b', name: 'Difference Engines', role: 'org:member' },
          ],
          providers: [{ id: 'github', label: 'GitHub' }],
        },
        '/api/org': {
          id: 'org-a',
          name: 'Analytical Engines',
          createdAt: '2026-08-01T10:00:00.000Z',
          viewerRole: 'org:owner',
          members: [
            {
              principalId,
              displayName: 'Ada Lovelace',
              role: 'org:owner',
              joinedAt: '2026-08-01T10:00:00.000Z',
              platformAdmin: true,
              avatarUrl: null,
            },
          ],
          projectCount: 0,
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
        },
        '/api/projects': [
          {
            projectId,
            name: 'Wide Glyph Project',
            slug: 'm'.repeat(48),
            status: 'active',
            family: 'build',
            repositoryTarget: {
              installationId: '501',
              owner: 'm'.repeat(48),
              name: 'm'.repeat(48),
              visibility: 'private',
            },
            repositoryStatus: 'ready',
            repositoryFullName: `${'m'.repeat(48)}/${'m'.repeat(48)}`,
            repositoryUrl: `https://github.com/${'m'.repeat(48)}/${'m'.repeat(48)}`,
            repositoryError: null,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        [`/api/projects/${projectId}/runs`]: [
          {
            projectRunId: 'cccccccc-1111-4222-8333-dddddddddddd',
            projectId,
            goal: 'Exercise the bounded project row copy.',
            status: 'failed',
            traceId: null,
            costUsd: null,
            durationS: 1,
            error: 'W'.repeat(240),
            createdAt: '2026-08-20T00:01:00.000Z',
            endedAt: '2026-08-20T00:01:01.000Z',
            publication: null,
          },
        ],
        '/api/github/installations': [],
        '/api/admin/announce/draft': {
          translated: true,
          reason: null,
          texts: {
            en: { title: 'Smoke announcement', body: 'Exercise the active rail reset.' },
            fr: { title: 'Annonce smoke', body: 'Exercer le reset du rail actif.' },
          },
        },
        '/api/admin/announce': { segment: 'all', orgCount: null },
      };
      accountPage.on('request', (request) => {
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
        void request.continue();
      });

      await accountPage.goto(`http://127.0.0.1:${port}/?atomaDiag=1`, { waitUntil: 'load' });
      await accountPage.waitForSelector('.gpu-ui-host[data-gpu-backend]', {
        timeout: READY_TIMEOUT_MS,
      });
      const clickAccountTarget = async (id) => {
        const spot = await accountPage.evaluate((targetId) => {
          const handle = globalThis.__ATOMA_GPU__;
          const row = handle?.hitTargets().find((entry) => entry.id === targetId);
          if (!row || !handle.projectRendererPoint) return null;
          for (const fraction of [0.5, 0.7, 0.85, 0.95]) {
            const projected = handle.projectRendererPoint(
              row.x + row.width * fraction,
              row.y + row.height / 2
            );
            if (
              projected.x < 1 || projected.x > window.innerWidth - 1 ||
              projected.y < 1 || projected.y > window.innerHeight - 1
            ) continue;
            const top = document.elementFromPoint(projected.x, projected.y);
            if (!top) continue;
            return {
              ...projected,
              target: row,
              screen: { width: handle.app.screen.width, height: handle.app.screen.height },
              dom: { tag: top.tagName, className: String(top.className ?? '') },
            };
          }
          return null;
        }, id);
        if (!spot) throw new Error(`account scenario: hit target ${id} not found`);
        await accountPage.mouse.click(spot.x, spot.y);
        return spot;
      };
      const targetIds = () =>
        accountPage.evaluate(() =>
          globalThis.__ATOMA_GPU__.hitTargets().map((entry) => entry.id)
        );

      // The welcome scene needs to be built before its control can be hit;
      // the GL path through `welcome.continue` is already proven by the anchor
      // arm above, so this one goes through the a11y bridge and spends its
      // budget on the account surface instead.
      await accountPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));
      await passArrivalGate(accountPage);
      await accountPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));

      // Real Pixi metrics, at the width that exposed the regression: a
      // character-count estimate is not enough for wide proportional glyphs.
      // Project metadata and a long run error must be one line AND fit their
      // declared column after Pixi has measured the actual font.
      await accountPage.setViewport({ width: 528, height: 800, deviceScaleFactor: 2 });
      await accountPage.waitForFunction(
        (targetId) => {
          const handle = globalThis.__ATOMA_GPU__;
          const row = handle?.hitTargets().find((entry) => entry.id === targetId);
          return Math.abs((handle?.app.screen.width ?? 0) - window.innerWidth) < 1 &&
            row !== undefined && row.x + row.width <= handle.app.screen.width;
        },
        { timeout: READY_TIMEOUT_MS },
        `project.select.${projectId}`
      );
      await waitForHitTarget(
        accountPage,
        `project.select.${projectId}`,
        `account scenario: project row ${projectId} never rendered`
      );
      const accountUrlBeforeProjectClick = accountPage.url();
      await clickAccountTarget(`project.select.${projectId}`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (accountPage.url() !== accountUrlBeforeProjectClick) {
        throw new Error(
          `account scenario: project-row click navigated ${accountUrlBeforeProjectClick} -> ${accountPage.url()}`
        );
      }
      const boundedProjectCopy = await accountPage.evaluate(() => {
        const rows = [];
        const walk = (node) => {
          // CONTAINS, not starts-with. The adversarial runs are what identify
          // these labels, and the metadata line now leads with the
          // repository's audience ("private · <slug> · <owner>/<name>"), which
          // an anchored pattern stopped seeing — reporting one label where
          // there are two, and failing on the count rather than on any real
          // geometry.
          if (typeof node.text === 'string' && /(m{4}|W{4})/.test(node.text)) {
            rows.push({
              text: node.text,
              width: node.width,
              height: node.height,
              scaleX: node.scale.x,
              wordWrap: node.style.wordWrap,
              wordWrapWidth: node.style.wordWrapWidth,
              lineHeight: node.style.lineHeight,
            });
          }
          for (const child of node.children ?? []) walk(child);
        };
        walk(globalThis.__ATOMA_GPU__.app.stage);
        return rows;
      });
      await accountPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      // The orb only exists at this width, and the re-render that brings it
      // back is one frame — which on a software rasteriser is seconds.
      await waitForHitTarget(
        accountPage,
        'account.menu.toggle',
        'account scenario: orb never returned at full width'
      );
      const withOrb = await targetIds();

      // Drive the GL controls — the orb, then the menu row — and OBSERVE the
      // result rather than sleeping on it. The fixed 500ms/900ms waits this
      // replaces were bets on a rasteriser's frame time, and losing one
      // surfaced two clicks later as "account.settings not found".
      //
      // Each click is also retried, because a hit target is published by a
      // RENDER while the Pixi listener answering it attaches on the frame that
      // draws the control; right after a viewport change those can be far
      // enough apart that the first synthetic click hits a drawn-but-not-yet
      // -listening control and is swallowed. Every attempt waits many frames
      // (the CI runner draws one roughly every 2s) so a click still in flight
      // is never mistaken for one that was lost. The assertions are unchanged:
      // the GL orb must open the menu, and the menu must reach Settings.
      // `reached` is a PREDICATE, not an id, because the two things this drives
      // to no longer land in the same layer: the menu publishes a Pixi hit
      // target, while Settings' model pickers became real DOM when per-tier
      // defaults and BYO keys landed (`OrgModelsForm`, e05c7b8). Asking for a
      // hit target there waited for a control the renderer had stopped
      // drawing — and nothing said so, because this file had already left CI.
      const clickUntil = async (clickId, reached, describe) => {
        const attempts = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (await reached()) return;
          // Re-click ONLY while the control is still offered. A landed click
          // removes it (the menu toggles, Settings navigates), so its absence
          // is progress to wait out — and re-clicking a toggle that already
          // worked would undo it.
          if ((await targetIds()).includes(clickId)) {
            attempts.push(await clickAccountTarget(clickId));
          }
          const settleBy = Date.now() + 20_000;
          while (Date.now() < settleBy) {
            if (await reached()) return;
            await accountPage.evaluate(
              () => new Promise((resolve) => setTimeout(resolve, 250))
            );
          }
        }
        throw new Error(`${describe}: ${JSON.stringify(attempts)}`);
      };
      const hasTarget = (id) => async () => (await targetIds()).includes(id);

      await clickUntil(
        'account.menu.toggle',
        hasTarget('account.settings'),
        'account scenario: menu never opened from the orb'
      );
      const opened = await targetIds();

      // ...and through the menu into Settings, where the orb is drawn again at
      // a different size — a second retain of the same program.
      await clickUntil(
        'account.settings',
        // The Settings body is DOM: the account form plus, for a viewer with an
        // organisation, the models/keys panel. Its presence is what proves the
        // view rendered, and it is the layer the controls actually live in now.
        () => accountPage.evaluate(
          () => document.querySelector('.gpu-settings-form') !== null
        ),
        'account scenario: Settings never opened from the menu'
      );
      const settings = await targetIds();
      const countScene = () => accountPage.evaluate(() => {
        let orbs = 0;
        const walk = (node) => {
          if (node.label === 'avatar-orb') orbs += 1;
          for (const child of node.children ?? []) walk(child);
        };
        walk(globalThis.__ATOMA_GPU__.app.stage);
        return { orbs, canvases: document.querySelectorAll('canvas').length };
      });
      const meshes = await countScene();

      // THE TAB-CHANGE REPRO. A view change rebuilds the scene under the SAME
      // account-control retain key, which is precisely the path a fresh-attach cannot
      // cover: the first version of the orb was destroyed by the markRoot
      // teardown and its key-matched resume() re-attached a dead mesh —
      // invisible account avatar on every tab switch, while every arm that
      // CHANGED the key (menu, Settings) still passed.
      await clickAccountTarget('nav.runs');
      await accountPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));
      const afterTab = await targetIds();
      const meshesAfterTab = await countScene();

      // THE ACTIVE ADMIN-NAV REPRO. After a send, Announcements is already the
      // selected rail destination; clicking it again must reset the receipt to
      // the empty composer. A DOM-tab test cannot prove the Pixi pointertap
      // path the user actually clicks, so drive the real hit target here.
      await clickAccountTarget('nav.announce');
      await accountPage.waitForSelector('.gpu-announce-form input[aria-label="Title — English"]', {
        timeout: READY_TIMEOUT_MS,
      });
      await accountPage.type(
        '.gpu-announce-form input[aria-label="Title — English"]',
        'Smoke announcement'
      );
      await accountPage.type(
        '.gpu-announce-form textarea[aria-label="Message — English"]',
        'Exercise the active rail reset.'
      );
      const clickAnnouncementButton = async (label) => {
        const clicked = await accountPage.evaluate((wanted) => {
          const button = [...document.querySelectorAll('.gpu-announce-form button')]
            .find((candidate) => candidate.textContent?.trim() === wanted);
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        }, label);
        if (!clicked) throw new Error(`account scenario: announcement button ${label} missing`);
      };
      const waitForAnnouncementButton = (label) =>
        accountPage.waitForFunction(
          (wanted) => [...document.querySelectorAll('.gpu-announce-form button')]
            .some((candidate) => candidate.textContent?.trim() === wanted),
          { timeout: READY_TIMEOUT_MS },
          label
        );
      await clickAnnouncementButton('Translate');
      await waitForAnnouncementButton('Send');
      await clickAnnouncementButton('Send');
      await waitForAnnouncementButton('Confirm — this cannot be recalled');
      await clickAnnouncementButton('Confirm — this cannot be recalled');
      await accountPage.waitForSelector('.gpu-announce-form [role="status"]', {
        timeout: READY_TIMEOUT_MS,
      });
      await clickAccountTarget('nav.announce');
      await waitForAnnouncementButton('Translate');
      const announcementReset = await accountPage.evaluate(() => ({
        receipt: document.querySelector('.gpu-announce-form [role="status"]')?.textContent ?? null,
        title: document.querySelector('.gpu-announce-form input')?.value ?? null,
      }));
      accountStats = {
        boundedProjectCopy,
        withOrb,
        opened,
        settings,
        meshes,
        afterTab,
        meshesAfterTab,
        announcementReset,
        webgpuErrors: await readWebGpuErrors(accountPage),
      };
    } finally {
      await accountPage.close();
    }

    const accountHas = (ids, id) => ids.includes(id);
    if (
      // ARMED: both adversarial labels reached the real renderer, stayed one
      // line, and fitted the measured Pixi width rather than a character-count
      // approximation.
      accountStats.boundedProjectCopy.length < 2 ||
      accountStats.boundedProjectCopy.some((label) =>
        label.wordWrap !== false ||
        label.height > label.lineHeight + 1 ||
        label.width > label.wordWrapWidth + 0.5
      ) ||
      // ARMED, on the OUTCOME rather than the mechanism: at least one label
      // had to give something up, or these `mmmm`/`WWWW` fixtures stopped
      // being adversarial and the wide-glyph failure is no longer exercised.
      // It used to require `scaleX < 0.99`, i.e. that the x-squeeze backstop
      // fired — but copy is now ellipsised to a MEASURED width before it is
      // drawn, so a correctly bounded label reaches the stage at scale 1 and
      // that clause failed on the fix rather than on any real overflow.
      !accountStats.boundedProjectCopy.some(
        (label) => label.scaleX < 0.99 || /…$/.test(label.text)
      ) ||
      // ARMED: the gated chrome actually drew the account orb.
      !accountHas(accountStats.withOrb, 'account.menu.toggle') ||
      // Closed, the menu contributes nothing.
      accountHas(accountStats.withOrb, 'auth.signOut') ||
      // Open, it carries its actions and the other organisation.
      !accountHas(accountStats.opened, 'auth.signOut') ||
      !accountHas(accountStats.opened, 'account.settings') ||
      !accountHas(accountStats.opened, 'org.switch.org-b') ||
      // Settings is reachable from the menu and offers a cell per tier.
      !accountHas(accountStats.settings, 'settings.model.1.default') ||
      !accountHas(accountStats.settings, 'settings.model.3.2') ||
      // Settings draws TWO orbs — the global account control and profile — in
      // their own slots. One meant the slots were evicting each other.
      accountStats.meshes.orbs !== 2 ||
      accountStats.meshes.canvases !== 1 ||
      // After a tab change the account orb SURVIVES the same-key rebuild and
      // the Settings one is swept: exactly one mesh, and the control with it.
      !accountHas(accountStats.afterTab, 'account.menu.toggle') ||
      accountStats.meshesAfterTab.orbs !== 1 ||
      // The ACTIVE canvas destination itself returned the sent receipt to a
      // fresh composer; neither stale success copy nor stale title survived.
      accountStats.announcementReset.receipt !== null ||
      accountStats.announcementReset.title !== '' ||
      // This page is the one that compiles the account orb's own shader.
      accountStats.webgpuErrors.length > 0 ||
      accountDiagnostics.length > 0
    ) {
      throw new Error(`GPU account smoke failed: ${JSON.stringify({
        boundedProjectCopy: accountStats.boundedProjectCopy,
        withOrb: accountStats.withOrb.filter((id) => id.startsWith('account.')),
        opened: accountStats.opened.filter((id) => id.startsWith('auth.') || id.startsWith('org.') || id.startsWith('account.')),
        settings: accountStats.settings.filter((id) => id.startsWith('settings.')),
        meshes: accountStats.meshes,
        afterTab: accountStats.afterTab.filter((id) => id.startsWith('account.')),
        meshesAfterTab: accountStats.meshesAfterTab,
        announcementReset: accountStats.announcementReset,
        webgpuErrors: accountStats.webgpuErrors,
        accountDiagnostics,
      })}`);
    }
    console.log(
      `viz GPU account ok: menu opened with ${accountStats.opened.filter((id) => id.startsWith('org.switch.')).length} org switch, settings reached with 2 orbs, account orb survived the tab change, active Announcements reset its receipt`
    );

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
    const livePage = await newWebGpuPage(browser);
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
      // The trace poll under test only runs while the RUNS view is open.
      await openView(livePage, 'Runs');
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
        webgpuErrors: await readWebGpuErrors(livePage),
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
      liveStats.rebuildsAfterEvent < 1 ||
      liveStats.webgpuErrors.length > 0
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
    await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&atomaDiag=1`, {
      waitUntil: 'load',
    });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend="webgl"]', { timeout: READY_TIMEOUT_MS });
    await passArrivalGate(page);
    await openView(page, 'Runs');
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
    const fallbackCardMaterialStats = await readTimelineCardMaterials(page);
    if (
      fallbackResult.canvases !== 1 ||
      (fallbackCursorEnv.expected && fallbackResult.cursorX !== '640') ||
      (fallbackCursorEnv.expected && fallbackResult.cursorY !== '400') ||
      !timelineCardsUseSharedMaterial(fallbackCardMaterialStats) ||
      diagnostics.length > 0
    ) {
      throw new Error(`GPU fallback diagnostics: ${JSON.stringify({
        fallbackResult,
        fallbackCardMaterialStats,
        diagnostics,
      })}`);
    }
    console.log(
      `viz GPU fallback ok: WebGL, ${fallbackCardMaterialStats.eventIds.length} cards in one ` +
        `shared diffuse + normal mesh${fallbackCursorEnv.expected ? '' : ' (pointer cursor not checked)'}`
    );
  } finally {
    await fallbackBrowser.close();
  }
} finally {
  server.kill('SIGTERM');
  await rm(fixtureDir, { recursive: true, force: true });
}
