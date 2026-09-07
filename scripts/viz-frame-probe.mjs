/* global document, requestAnimationFrame, window, PointerEvent, GPUQueue, GPUDevice, GPUCommandEncoder, GPURenderPassEncoder, GPUTexture, GPUAdapter, GPUBufferUsage, GPUMapMode, MutationObserver, WheelEvent */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

/**
 * Frame-cost probe for the GPU client. DEVELOPMENT TOOLING, never a gate.
 *
 * `viz:smoke` proves behaviour and budgets one P95; this answers a different
 * question — WHERE a frame's time goes on the machine in front of you — so the
 * next optimisation is measured rather than guessed. It drives the compiled
 * client (`npm run build` first) through the same scenarios on every run:
 * the arrival crystal, the Projects and Runs views idle and under a moving
 * pointer, a wheel-scroll rebuild cycle, and Registry. For each it reports:
 *
 *   - rAF interval mean / P95 and the share of frames over 20ms;
 *   - main-thread ms per frame spent inside Pixi's ticker (every app ticker
 *     plus the render at LOW priority), read between a HIGH-priority marker
 *     and a UTILITY-priority one;
 *   - per-frame WebGPU call counts (passes, draws, bind groups, buffer and
 *     image uploads) and Pixi instruction rebuilds, wrapped at the prototype
 *     level before any app script runs;
 *   - with `--unlock`, Chrome's vsync and frame-rate limit are off, so the
 *     interval IS the frame cost rather than the display period;
 *   - with `--profile`, a CDP CPU profile per scenario, its hot functions
 *     mapped back through the build's source maps when `vite build
 *     --sourcemap` produced them and `source-map` is installed;
 *   - with `--gpu-time`, GPU nanoseconds per frame from `timestamp-query`
 *     (Chrome exposes it under `--enable-webgpu-developer-features`; the
 *     readback itself costs frames, so keep it out of before/after runs);
 *   - with `--dirty`, which containers dirtied which render group, per frame
 *     — the report that finds an animation sitting in the wrong batch.
 *
 * READ THE NUMBERS WITH THE MACHINE IN MIND. On an integrated GPU the whole
 * main thread blocks inside WebGPU calls (`end`, `writeBuffer`, `submit`)
 * when the GPU is behind, so CPU self-time in a profile is back-pressure, not
 * that call's own cost; two runs minutes apart can differ by a third as
 * clocks and thermals move. Compare arms back to back, and trust the
 * structural counters (rebuilds, uploads) over a single interval.
 *
 * Usage:
 *   npm run viz:frame-probe -- --label before [--dpr 2] [--width 1280 --height 800]
 *       [--unlock] [--profile] [--gpu-time] [--dirty] [--headful]
 *       [--frames 300] [--only runs] [--query renderer=webgl] [--out DIR]
 *
 * Results land in `.atoma-frame-probe/` (gitignored) as JSON per run.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let SourceMapConsumer = null;
try {
  ({ SourceMapConsumer } = require('source-map'));
} catch {
  // Optional: profiles then keep the bundle's own function names.
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const label = option('--label', 'probe');
const dpr = Number(option('--dpr', '2'));
const width = Number(option('--width', '1280'));
const height = Number(option('--height', '800'));
const unlock = flag('--unlock');
const profile = flag('--profile');
const headful = flag('--headful');
const gpuTime = flag('--gpu-time');
const dirty = flag('--dirty');
const frames = Number(option('--frames', '300'));
const only = option('--only', null);
const query = option('--query', '');
const syntheticInput = flag('--synthetic-input');
const outDir = option('--out', join(repoRoot, '.atoma-frame-probe'));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * The same synthetic trace `viz-gpu-smoke.mjs` serves: 80 rows, so the Runs
 * list has something to scroll, and a fixed clock, so the run is never live
 * and never starts the 1Hz trace poll.
 */
const FIXTURE_EVENT_ROWS = 80;
async function writeRunFixture(dir) {
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
  const id = 'probe-fixture-run';
  const runLabel = 'probe: fixture';
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    id,
    label: runLabel,
    task: { description: 'frame probe fixture' },
    startedAt,
    endedAt,
    durationMs,
    events,
    result: { summary: 'fixture complete', output: 'fixture', producedBy: { tier: 3, name: 'Meristem' } },
    totals: { calls: events.length, costUsd: 0.032 },
  }));
  await writeFile(join(dir, 'index.json'), JSON.stringify([{
    id,
    label: runLabel,
    startedAt,
    endedAt,
    durationMs,
    hasError: false,
    costUsd: 0.032,
    calls: events.length,
  }]));
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const mean = samples.reduce((s, v) => s + v, 0) / Math.max(1, samples.length);
  return {
    n: samples.length,
    mean: +mean.toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
  };
}

/**
 * Installed before any script: counts WebGPU API calls and, when asked and
 * offered, stamps every render pass with timestamp queries so GPU time per
 * frame can be read back.
 */
async function installGpuCounters(page) {
  await page.evaluateOnNewDocument((enableTimestamps) => {
    const stats = {
      calls: {},
      bytes: { writeBuffer: 0, createBuffer: 0 },
      gpuNs: 0,
      gpuSubmits: 0,
      timestamps: 'unavailable',
    };
    Object.defineProperty(window, '__ATOMA_GPU_STATS__', {
      value: stats,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    const count = (name) => { stats.calls[name] = (stats.calls[name] ?? 0) + 1; };
    const wrap = (proto, method, extra) => {
      if (!proto || typeof proto[method] !== 'function') return;
      const original = proto[method];
      proto[method] = function (...a) {
        count(method);
        if (extra) extra(a, this);
        return original.apply(this, a);
      };
    };
    if (typeof GPUQueue === 'undefined') return;

    // Pixi requests a throwaway device to probe support before the real one,
    // so timing resources are created PER DEVICE, lazily, on the device that
    // actually encodes.
    const QUERY_CAPACITY = 512;
    const RING = 12;
    const timings = new WeakMap();
    let timestampCapable = false;
    const timingFor = (device) => {
      if (!device || !timestampCapable) return null;
      let timing = timings.get(device);
      if (timing === undefined) {
        try {
          const querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_CAPACITY });
          const resolveBuffer = device.createBuffer({
            size: QUERY_CAPACITY * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          });
          const readBuffers = Array.from({ length: RING }, () => ({
            buffer: device.createBuffer({
              size: QUERY_CAPACITY * 8,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
            busy: false,
          }));
          timing = { device, querySet, resolveBuffer, readBuffers, next: 0 };
          stats.timestamps = 'active';
        } catch (error) {
          timing = null;
          stats.timestamps = `failed: ${String(error)}`;
        }
        timings.set(device, timing);
      }
      return timing;
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (descriptor = {}) {
      const wanted = enableTimestamps && this.features?.has?.('timestamp-query');
      const required = new Set(descriptor.requiredFeatures ?? []);
      if (wanted) required.add('timestamp-query');
      const device = await requestDevice.call(this, { ...descriptor, requiredFeatures: [...required] });
      if (wanted) timestampCapable = true;
      else if (enableTimestamps) stats.timestamps = 'feature-missing';
      device.queue.__probeDevice = device;
      return device;
    };
    const createCommandEncoder = GPUDevice.prototype.createCommandEncoder;
    GPUDevice.prototype.createCommandEncoder = function (...a) {
      count('createCommandEncoder');
      const encoder = createCommandEncoder.apply(this, a);
      encoder.__probeDevice = this;
      return encoder;
    };
    const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
      count('beginRenderPass');
      const timing = timingFor(this.__probeDevice);
      if (timing && timing.next + 2 <= QUERY_CAPACITY && descriptor && !descriptor.timestampWrites) {
        descriptor = {
          ...descriptor,
          timestampWrites: {
            querySet: timing.querySet,
            beginningOfPassWriteIndex: timing.next,
            endOfPassWriteIndex: timing.next + 1,
          },
        };
        timing.next += 2;
      }
      return beginRenderPass.call(this, descriptor);
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commandBuffers) {
      count('submit');
      const timing = timingFor(this.__probeDevice);
      if (!timing || timing.next === 0) return submit.call(this, commandBuffers);
      const used = timing.next;
      timing.next = 0;
      const slot = timing.readBuffers.find((entry) => !entry.busy);
      if (!slot) return submit.call(this, commandBuffers);
      slot.busy = true;
      const encoder = timing.device.createCommandEncoder();
      encoder.resolveQuerySet(timing.querySet, 0, used, timing.resolveBuffer, 0);
      encoder.copyBufferToBuffer(timing.resolveBuffer, 0, slot.buffer, 0, used * 8);
      const result = submit.call(this, [...commandBuffers, encoder.finish()]);
      slot.buffer.mapAsync(GPUMapMode.READ, 0, used * 8).then(() => {
        const values = new BigUint64Array(slot.buffer.getMappedRange(0, used * 8));
        let total = 0n;
        for (let i = 0; i + 1 < used; i += 2) {
          const delta = values[i + 1] - values[i];
          if (delta > 0n && delta < 10_000_000_000n) total += delta;
        }
        stats.gpuNs += Number(total);
        stats.gpuSubmits += 1;
        slot.buffer.unmap();
        slot.busy = false;
      }).catch(() => { slot.busy = false; });
      return result;
    };

    wrap(GPUQueue.prototype, 'writeBuffer', (a) => {
      const data = a[2];
      const size = a[4] ?? ((data?.byteLength ?? 0) - (a[3] ?? 0));
      stats.bytes.writeBuffer += Number.isFinite(size) ? size : 0;
    });
    wrap(GPUQueue.prototype, 'copyExternalImageToTexture');
    wrap(GPUQueue.prototype, 'writeTexture');
    wrap(GPUDevice.prototype, 'createBuffer', (a) => { stats.bytes.createBuffer += a[0]?.size ?? 0; });
    wrap(GPUDevice.prototype, 'createBindGroup');
    wrap(GPUDevice.prototype, 'createTexture');
    wrap(GPUDevice.prototype, 'createRenderPipeline');
    wrap(GPUCommandEncoder.prototype, 'copyTextureToTexture');
    wrap(GPURenderPassEncoder.prototype, 'draw');
    wrap(GPURenderPassEncoder.prototype, 'drawIndexed');
    wrap(GPURenderPassEncoder.prototype, 'setVertexBuffer');
    wrap(GPURenderPassEncoder.prototype, 'setIndexBuffer');
    wrap(GPURenderPassEncoder.prototype, 'setBindGroup');
    wrap(GPURenderPassEncoder.prototype, 'setPipeline');
    wrap(GPURenderPassEncoder.prototype, 'setScissorRect');
    wrap(GPURenderPassEncoder.prototype, 'end');
    wrap(GPUTexture.prototype, 'createView');
  }, gpuTime);
}

/**
 * Samples rAF intervals, main-thread ticker time per frame, GPU time when
 * armed, per-frame WebGPU call counts and Pixi instruction rebuilds.
 */
async function sampleFrames(page, target, budgetMs = 8_000) {
  return await page.evaluate((count, budget) => new Promise((resolve) => {
    const handle = globalThis.__ATOMA_GPU__;
    const ticker = handle?.app?.ticker;
    const renderGroupSystem = handle?.app?.renderer?.renderGroup;
    const proto = renderGroupSystem ? Object.getPrototypeOf(renderGroupSystem) : null;
    if (proto && !proto.__probeWrapped) {
      proto.__probeWrapped = true;
      globalThis.__ATOMA_PIXI_STATS__ = { buildInstructions: 0, updateRenderables: 0 };
      for (const method of ['_buildInstructions', '_updateRenderables']) {
        const original = proto[method];
        proto[method] = function (...a) {
          globalThis.__ATOMA_PIXI_STATS__[method.replace(/^_/, '')] += 1;
          return original.apply(this, a);
        };
      }
    }
    const snapshotGpu = () => {
      const s = globalThis.__ATOMA_GPU_STATS__ ?? { calls: {}, bytes: {}, gpuNs: 0, gpuSubmits: 0 };
      return {
        calls: { ...s.calls },
        bytes: { ...s.bytes },
        gpuNs: s.gpuNs,
        gpuSubmits: s.gpuSubmits,
        timestamps: s.timestamps,
      };
    };
    const gpuStart = snapshotGpu();
    const pixiStart = { ...(globalThis.__ATOMA_PIXI_STATS__ ?? {}) };
    const intervals = [];
    const tickerMs = [];
    let frameStart = 0;
    const begin = () => { frameStart = performance.now(); };
    const end = () => { tickerMs.push(performance.now() - frameStart); };
    ticker?.add(begin, null, 1000);
    ticker?.add(end, null, -1000);
    let previous;
    const started = performance.now();
    const frame = (now) => {
      if (previous !== undefined) intervals.push(now - previous);
      previous = now;
      if (intervals.length < count && performance.now() - started < budget) {
        requestAnimationFrame(frame);
        return;
      }
      ticker?.remove(begin);
      ticker?.remove(end);
      // Stop structural counters at the sampling boundary. Counting the next
      // 150ms while waiting for GPU timestamps inflated unlocked-frame costs.
      const gpuEnd = snapshotGpu();
      const pixiEnd = { ...(globalThis.__ATOMA_PIXI_STATS__ ?? {}) };
      // Only asynchronous timestamp readbacks need the grace period.
      setTimeout(() => {
        const timingEnd = snapshotGpu();
        const perFrame = {};
        const n = Math.max(1, tickerMs.length);
        for (const key of new Set([...Object.keys(gpuEnd.calls), ...Object.keys(gpuStart.calls)])) {
          perFrame[key] = +(((gpuEnd.calls[key] ?? 0) - (gpuStart.calls[key] ?? 0)) / n).toFixed(1);
        }
        perFrame.writeBufferKB = +(((gpuEnd.bytes.writeBuffer ?? 0) - (gpuStart.bytes.writeBuffer ?? 0)) / n / 1024).toFixed(1);
        perFrame.createBufferKB = +(((gpuEnd.bytes.createBuffer ?? 0) - (gpuStart.bytes.createBuffer ?? 0)) / n / 1024).toFixed(1);
        for (const key of Object.keys(pixiEnd)) {
          perFrame[key] = +(((pixiEnd[key] ?? 0) - (pixiStart[key] ?? 0)) / n).toFixed(2);
        }
        const gpuSubmits = timingEnd.gpuSubmits - gpuStart.gpuSubmits;
        const submits = (gpuEnd.calls.submit ?? 0) - (gpuStart.calls.submit ?? 0);
        // GPU ns are attributed to the frames whose submits were read back.
        const gpuMsPerFrame = gpuSubmits > 0
          ? ((timingEnd.gpuNs - gpuStart.gpuNs) / 1e6) / n * (submits / Math.max(1, gpuSubmits))
          : null;
        resolve({
          intervals,
          tickerMs: tickerMs.slice(1),
          perFrame,
          gpuMsPerFrame: gpuMsPerFrame === null ? null : +gpuMsPerFrame.toFixed(2),
          timestamps: gpuEnd.timestamps,
        });
      }, 150);
    };
    requestAnimationFrame(frame);
  }), target, budgetMs);
}

function formatPerFrame(p) {
  const pick = (k) => p[k] ?? 0;
  return `passes ${pick('beginRenderPass')} draws ${(pick('draw') + pick('drawIndexed')).toFixed(1)} ` +
    `setVB ${pick('setVertexBuffer')} setBG ${pick('setBindGroup')} pipes ${pick('setPipeline')} ` +
    `wb ${pick('writeBuffer')}/${pick('writeBufferKB')}KB copyImg ${pick('copyExternalImageToTexture')} ` +
    `views ${pick('createView')} newBG ${pick('createBindGroup')} newBuf ${pick('createBuffer')} ` +
    `newTex ${pick('createTexture')} submits ${pick('submit')} | rebuild ${pick('buildInstructions')} ` +
    `updRend ${pick('updateRenderables')}`;
}

/**
 * Who dirties which render group? Wraps `RenderGroup.updateRenderable` (every
 * per-frame view/transform update that re-packs a batch element) and
 * `BatcherPipe.upload` (the whole-buffer re-upload it causes) for N frames.
 */
async function dirtyReport(page, sampleFrameCount = 60) {
  return await page.evaluate((count) => new Promise((resolve) => {
    const handle = globalThis.__ATOMA_GPU__;
    const app = handle.app;
    const groupProto = Object.getPrototypeOf(app.stage.renderGroup);
    const batchPipe = app.renderer.renderPipes.batch;
    const batchProto = Object.getPrototypeOf(batchPipe);
    const labelOfGroup = new Map();
    const walk = (group) => {
      const root = group.root;
      labelOfGroup.set(
        group.instructionSet.uid,
        root === app.stage ? 'app.stage' : (root.label || root.constructor.name)
      );
      for (const child of group.renderGroupChildren) walk(child);
    };
    const updates = new Map();
    const uploads = new Map();
    const originalUpdate = groupProto.updateRenderable;
    groupProto.updateRenderable = function (renderable) {
      walk(app.stage.renderGroup);
      const groupLabel = labelOfGroup.get(this.instructionSet.uid) ?? '?';
      const path = [];
      let cursor = renderable;
      while (cursor && path.length < 5) {
        path.push(cursor.label || cursor.constructor.name);
        cursor = cursor.parent;
      }
      const key = `${groupLabel} :: ${path.join(' < ')}`;
      updates.set(key, (updates.get(key) ?? 0) + 1);
      return originalUpdate.call(this, renderable);
    };
    const originalUpload = batchProto.upload;
    batchProto.upload = function (instructionSet) {
      walk(app.stage.renderGroup);
      const batchers = this._batchersByInstructionSet[instructionSet.uid];
      for (const i in batchers) {
        const batcher = batchers[i];
        if (batcher.dirty) {
          const key = labelOfGroup.get(instructionSet.uid) ?? `uid ${instructionSet.uid}`;
          const entry = uploads.get(key) ?? { count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += batcher.attributeSize * 4;
          uploads.set(key, entry);
        }
      }
      return originalUpload.call(this, instructionSet);
    };
    let seen = 0;
    const frame = () => {
      seen += 1;
      if (seen < count) {
        requestAnimationFrame(frame);
        return;
      }
      groupProto.updateRenderable = originalUpdate;
      batchProto.upload = originalUpload;
      resolve({
        frames: seen,
        updates: [...updates.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 18)
          .map(([k, v]) => [k, +(v / seen).toFixed(2)]),
        uploads: [...uploads.entries()]
          .map(([k, v]) => [k, +(v.count / seen).toFixed(2), +(v.bytes / seen / 1024).toFixed(1)]),
      });
    };
    requestAnimationFrame(frame);
  }), sampleFrameCount);
}

/**
 * Continuous mouse motion. By default it is driven from Node through Chrome's
 * real input path, one CDP round trip per move; `--synthetic-input` instead
 * dispatches `pointermove` from a rAF loop INSIDE the page, which tells apart
 * a frame the app spent from one the automation's input plumbing did.
 */
function mouseSweep(page, points, periodMs = 16) {
  if (syntheticInput) {
    return {
      start() {
        const started = page.evaluate((path) => {
          const canvas = document.querySelector('.gpu-ui-canvas');
          let index = 0;
          let stop = false;
          const tick = () => {
            if (stop) return;
            const [x, y] = path[index % path.length];
            index += 1;
            canvas?.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerType: 'mouse',
              pointerId: 1,
              isPrimary: true,
            }));
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          globalThis.__ATOMA_PROBE_STOP_SWEEP__ = () => { stop = true; };
        }, points);
        return {
          stop: async () => {
            await started;
            await page.evaluate(() => globalThis.__ATOMA_PROBE_STOP_SWEEP__?.());
          },
        };
      },
    };
  }
  return {
    start() {
      let stopped = false;
      let index = 0;
      const run = (async () => {
        while (!stopped) {
          const [x, y] = points[index % points.length];
          index += 1;
          await page.mouse.move(x, y);
          await new Promise((r) => setTimeout(r, periodMs));
        }
      })();
      return { stop: async () => { stopped = true; await run; } };
    },
  };
}

function railSweepPoints() {
  const points = [];
  const bottom = Math.min(640, height - 60);
  for (let y = 120; y <= bottom; y += 8) points.push([60, y]);
  for (let y = bottom; y >= 120; y -= 8) points.push([60, y]);
  return points;
}
function timelineSweepPoints() {
  const points = [];
  for (let t = 0; t < 120; t += 1) {
    const angle = (t / 120) * Math.PI * 2;
    points.push([
      width / 2 + Math.cos(angle) * width * 0.16,
      height * 0.56 + Math.sin(angle) * height * 0.22,
    ]);
  }
  return points;
}

const mapCache = new Map();
async function consumerFor(url) {
  if (!SourceMapConsumer) return null;
  if (mapCache.has(url)) return mapCache.get(url);
  let consumer = null;
  try {
    const response = await fetch(`${url}.map`);
    if (response.ok) consumer = await new SourceMapConsumer(await response.json());
  } catch {
    // No map for this chunk: keep the bundle's names.
  }
  mapCache.set(url, consumer);
  return consumer;
}

/** Profiles `work()` on the page's main thread and prints where its time went. */
async function cpuProfile(name, page, work, results) {
  const client = await page.createCDPSession();
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 250 });
  await client.send('Profiler.start');
  const outcome = await work();
  const { profile: cpu } = await client.send('Profiler.stop');
  await client.detach();
  await writeFile(join(outDir, `profile-${label}-${name}.cpuprofile`), JSON.stringify(cpu));
  const selfTime = new Map();
  const byId = new Map(cpu.nodes.map((node) => [node.id, node]));
  for (let i = 0; i < cpu.samples.length; i++) {
    const id = cpu.samples[i];
    selfTime.set(id, (selfTime.get(id) ?? 0) + (cpu.timeDeltas[i] ?? 0));
  }
  const total = cpu.endTime - cpu.startTime;
  const byFunction = new Map();
  const byModule = new Map();
  let idle = 0;
  for (const [id, micros] of selfTime) {
    const frame = byId.get(id).callFrame;
    if (frame.functionName === '(idle)') {
      idle += micros;
      continue;
    }
    let fn = frame.functionName || '(anonymous)';
    let source = frame.url ? basename(frame.url) : '';
    if (frame.url && frame.lineNumber >= 0) {
      const consumer = await consumerFor(frame.url);
      if (consumer) {
        const pos = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
        if (pos.source) {
          source = pos.source.replace(/^.*\/node_modules\//, 'nm:').replace(/^.*\/src\/viz\//, '');
          if (pos.name) fn = pos.name;
          else if (!frame.functionName) fn = `(anon@${pos.line})`;
        }
      }
    }
    const key = `${fn} [${source}]`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + micros);
    const moduleKey = source.startsWith('nm:') ? source.split('/').slice(0, 2).join('/') : source;
    byModule.set(moduleKey, (byModule.get(moduleKey) ?? 0) + micros);
  }
  const busy = total - idle;
  console.log(
    `  --- CPU profile ${name}: main thread busy ${(busy / total * 100).toFixed(1)}% ` +
    `(${(busy / 1000).toFixed(0)}ms of ${(total / 1000).toFixed(0)}ms) ---`
  );
  const top = [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  for (const [key, micros] of top) {
    console.log(`  ${(micros / total * 100).toFixed(1).padStart(5)}%  ${(micros / 1000).toFixed(0).padStart(5)}ms  ${key}`);
  }
  console.log('  --- by module ---');
  for (const [key, micros] of [...byModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${(micros / total * 100).toFixed(1).padStart(5)}%  ${(micros / 1000).toFixed(0).padStart(5)}ms  ${key}`);
  }
  results.scenarios[name] = {
    ...(results.scenarios[name] ?? {}),
    profile: {
      busyPct: +(busy / total * 100).toFixed(1),
      top: top.map(([k, v]) => [k, +(v / 1000).toFixed(1)]),
    },
  };
  return outcome;
}

async function passArrivalGate(page) {
  await page.waitForFunction(
    () => document.querySelector('.gpu-a11y-bridge [data-release-version]') !== null ||
      document.querySelector('[role="tab"]') !== null,
    { timeout: 60_000 }
  );
  const gate = await page.$('.gpu-a11y-bridge [data-release-version]');
  if (gate) {
    await page.evaluate(() => {
      const bridge = document
        .querySelector('.gpu-a11y-bridge [data-release-version]')
        ?.closest('.gpu-a11y-bridge');
      const control = bridge?.querySelector('button');
      if (!control) throw new Error('arrival gate control missing');
      control.click();
    });
  }
  await page.waitForSelector('[role="tab"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => !document.querySelector('.gpu-entry-veil')?.hasAttribute('data-phase'),
    { timeout: 60_000 }
  );
  await waitSettled(page);
}

async function waitSettled(page, settleMs = 1500) {
  await page.waitForFunction(
    () => document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-motion') === 'settled',
    { timeout: 60_000 }
  );
  await new Promise((r) => setTimeout(r, settleMs));
}

async function openView(page, name) {
  await page.evaluate((target) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === target);
    if (!tab) throw new Error(`nav tab missing: ${target}`);
    if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  }, name);
  await page.waitForFunction(
    (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
    { timeout: 60_000 },
    name
  );
  await waitSettled(page);
}

async function hideLight(page) {
  await page.evaluate(() => globalThis.__ATOMA_GPU__?.hidePointerLight());
  await new Promise((r) => setTimeout(r, 600));
}

/** The smoke's scroll cycle, reported as rebuild cost rather than budgeted. */
async function scrollRebuilds(page) {
  return await page.evaluate(async () => {
    const host = document.querySelector('.gpu-ui-host');
    const canvas = host?.querySelector('canvas');
    const handle = globalThis.__ATOMA_GPU__;
    const samples = [];
    const observer = new MutationObserver(() => samples.push(Number(host.dataset.gpuRenderMs)));
    observer.observe(host, { attributes: true, attributeFilter: ['data-gpu-render-ms'] });
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const awaitRender = async () => {
      const before = samples.length;
      let waited = 0;
      while (samples.length === before && waited < 6) {
        await frame();
        waited += 1;
      }
      return samples.length > before;
    };
    const p = handle.projectRendererPoint(handle.app.screen.width * 0.2, handle.app.screen.height * 0.6);
    let missed = 0;
    let retainedTicks = 0;
    const content = () => handle.app.stage.getChildByLabel('timeline-scroll-content', true);
    for (let tick = 0; tick < 32; tick++) {
      const previousContent = content();
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: tick < 16 ? 140 : -140,
        clientX: p.x,
        clientY: p.y,
        bubbles: true,
        cancelable: true,
      }));
      if (!(await awaitRender())) missed += 1;
      if (previousContent && previousContent === content()) retainedTicks += 1;
    }
    observer.disconnect();
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      renders: samples.length,
      retainedTicks,
      missed,
      p50: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    };
  });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const fixtureDir = await mkdtemp(join(tmpdir(), 'viz-frame-probe-'));
  await writeRunFixture(fixtureDir);
  const port = await freePort();
  const server = spawn(
    process.execPath,
    ['dist/viz/server.js', '--host', '127.0.0.1', '--port', String(port), '--dir', fixtureDir, '--no-sentinel'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const results = { label, dpr, width, height, unlock, query, startedAt: new Date().toISOString(), scenarios: {} };

  async function scenarioReport(name, page, activity) {
    if (only && !name.includes(only)) return;
    const activityHandle = activity ? activity.start() : null;
    const raw = await sampleFrames(page, frames);
    if (activityHandle) await activityHandle.stop();
    const interval = summarise(raw.intervals);
    const ticker = summarise(raw.tickerMs);
    const over20 = raw.intervals.filter((v) => v > 20).length / Math.max(1, raw.intervals.length);
    const meta = await page.evaluate(() => {
      const host = document.querySelector('.gpu-ui-host');
      return {
        objects: Number(host?.dataset.gpuObjects ?? 0),
        renderMs: Number(host?.dataset.gpuRenderMs ?? 0),
        backend: host?.dataset.gpuBackend ?? null,
        lightEnabled: globalThis.__ATOMA_GPU__?.pointerLightFilter()?.enabled ?? null,
      };
    });
    const entry = {
      interval,
      fps: +(1000 / interval.mean).toFixed(1),
      over20Pct: +(over20 * 100).toFixed(1),
      tickerMs: ticker,
      gpuMs: raw.gpuMsPerFrame,
      timestamps: raw.timestamps,
      perFrame: raw.perFrame,
      ...meta,
    };
    results.scenarios[name] = entry;
    console.log(
      `${name.padEnd(22)} rAF ${String(interval.mean).padStart(6)}ms mean ${String(interval.p95).padStart(6)}ms p95 ` +
      `(${String(entry.fps).padStart(5)} fps, >20ms ${entry.over20Pct}%) | cpu ${String(ticker.mean).padStart(5)}ms ` +
      `| gpu ${raw.gpuMsPerFrame === null ? '  n/a' : `${String(raw.gpuMsPerFrame).padStart(5)}ms`} ` +
      `| obj ${meta.objects} light ${meta.lightEnabled}`
    );
    console.log(`  ${formatPerFrame(raw.perFrame)}`);
    if (dirty && !activity) {
      const report = await dirtyReport(page);
      console.log(`  --- dirty report ${name} (per frame, over ${report.frames} frames) ---`);
      for (const [key, perFrame, kb] of report.uploads) {
        console.log(`  upload ${String(perFrame).padStart(5)}x ${String(kb).padStart(7)}KB  ${key}`);
      }
      for (const [key, perFrame] of report.updates) {
        console.log(`  update ${String(perFrame).padStart(6)}  ${key}`);
      }
      entry.dirty = report;
    }
    if (profile) {
      await cpuProfile(name, page, async () => {
        const handle = activity ? activity.start() : null;
        await new Promise((r) => setTimeout(r, 4_000));
        if (handle) await handle.stop();
      }, results);
    }
  }

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
        if (response.ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        throw new Error('the compiled viz server did not start — run `npm run build` first');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const chromeArgs = ['--no-sandbox', '--enable-unsafe-swiftshader'];
    if (gpuTime) chromeArgs.push('--enable-webgpu-developer-features');
    if (unlock) chromeArgs.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
    const browser = await puppeteer.launch({
      headless: !headful,
      args: chromeArgs,
      protocolTimeout: 300_000,
      defaultViewport: { width, height, deviceScaleFactor: dpr },
    });
    try {
      const page = await browser.newPage();
      await installGpuCounters(page);
      const diagnostics = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warn') {
          diagnostics.push(`${message.type()}: ${message.text().slice(0, 200)}`);
        }
      });
      page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
      page.on('response', (response) => {
        if (response.status() >= 400) diagnostics.push(`http ${response.status()}: ${response.url()}`);
      });
      await page.goto(`http://127.0.0.1:${port}/?atomaDiag=1${query ? `&${query}` : ''}`, { waitUntil: 'load' });
      await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: 60_000 });
      const env = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        const rasteriser = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        const screen = globalThis.__ATOMA_GPU__?.app?.screen;
        return {
          rasteriser,
          backend: document.querySelector('.gpu-ui-host')?.dataset.gpuBackend,
          dpr: window.devicePixelRatio,
          screen: screen ? [screen.width, screen.height] : null,
          resolution: globalThis.__ATOMA_GPU__?.app?.renderer?.resolution,
          timestamps: globalThis.__ATOMA_GPU_STATS__?.timestamps,
        };
      });
      results.env = env;
      console.log(
        `env: backend=${env.backend} dpr=${env.dpr} resolution=${env.resolution} screen=${env.screen} ` +
        `timestamps=${env.timestamps} unlock=${unlock} rasteriser="${env.rasteriser}"`
      );
      await new Promise((r) => setTimeout(r, 2000));

      await scenarioReport('welcome-idle', page, null);
      await page.mouse.move(width / 2, height / 2);
      await page.waitForFunction(
        () => Math.max(0, ...(globalThis.__ATOMA_MARK_CAUSTIC__?.optics ?? []).map((o) => o.intensity)) > 0.001,
        { polling: 'raf', timeout: 30_000 }
      ).catch(() => console.log('  (caustic never armed)'));
      await scenarioReport('welcome-crystal', page, null);
      await page.mouse.move(width - 80, height - 50);
      await new Promise((r) => setTimeout(r, 800));
      await scenarioReport('welcome-pointer-far', page, null);

      await passArrivalGate(page);
      await new Promise((r) => setTimeout(r, 1500));
      await hideLight(page);
      await scenarioReport('projects-idle', page, null);
      await scenarioReport('projects-hover-rail', page, mouseSweep(page, railSweepPoints()));
      await hideLight(page);
      await scenarioReport('projects-idle-after', page, null);

      await openView(page, 'Runs');
      await hideLight(page);
      await scenarioReport('runs-idle', page, null);
      await scenarioReport('runs-hover-timeline', page, mouseSweep(page, timelineSweepPoints()));
      await hideLight(page);
      if (!only || 'runs-scroll'.includes(only)) {
        // The rebuild cost is CPU work the smoke budgets; profiled here so a
        // slow wheel tick can be attributed rather than merely measured.
        const scroll = profile
          ? await cpuProfile('runs-scroll-rebuild', page, () => scrollRebuilds(page), results)
          : await scrollRebuilds(page);
        results.scenarios['runs-scroll-rebuild'] = {
          ...(results.scenarios['runs-scroll-rebuild'] ?? {}),
          ...scroll,
        };
        console.log(
          `runs-scroll-rebuild     updates ${scroll.renders} retained ${scroll.retainedTicks} missed ${scroll.missed} | ` +
          `renderMs p50 ${scroll.p50} p95 ${scroll.p95} max ${scroll.max}`
        );
      }
      await openView(page, 'Registry');
      await hideLight(page);
      await scenarioReport('registry-idle', page, null);

      results.diagnostics = diagnostics.slice(0, 20);
      if (diagnostics.length) {
        console.log(`diagnostics (${diagnostics.length}):\n  ${diagnostics.slice(0, 8).join('\n  ')}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
    const file = join(
      outDir,
      `frame-probe-${label}-${width}x${height}-dpr${dpr}${unlock ? '-unlocked' : ''}.json`
    );
    await writeFile(file, JSON.stringify(results, null, 2));
    console.log(`wrote ${file}`);
  }
}

await main();
