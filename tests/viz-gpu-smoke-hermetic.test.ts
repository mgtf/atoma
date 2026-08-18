import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `npm run viz:smoke` is part of `release:check`, so CI runs it on a machine
 * with no GPU — and two of the smoke's own assumptions, not the renderer, are
 * what CI failed on for every push between 2026-08-13 and 2026-08-18:
 *
 * 1. It navigated with `waitUntil: 'networkidle0'`. The client polls /api/runs
 *    for as long as it is open, and on a software rasteriser Blink never emits
 *    the `networkIdle` lifecycle signal Puppeteer waits for. Measured under
 *    `--disable-gpu --use-angle=swiftshader`: the page's own `load` fires at
 *    ~75ms and page-visible in-flight requests sit at zero for ~2.8s at a
 *    stretch, yet networkidle0 stays unresolved after 120 SECONDS — so a bigger
 *    timeout is not the fix, the condition is unreachable there.
 *
 * 2. Its main arm read the repository's ambient `runs/`. A fresh checkout has
 *    none, so the RUNS list had nothing to scroll, all 24 wheel ticks were
 *    no-ops, and `missed: 24` reported the fixture's absence as a renderer
 *    regression.
 *
 * Neither is observable from this suite — no browser, no GPU, no Chrome
 * lifecycle — so the guard is over the text of the script CI actually runs.
 */
const smoke = readFileSync(
  resolve(import.meta.dirname, '../scripts/viz-gpu-smoke.mjs'),
  'utf8'
);

describe('viz GPU smoke — what CI can actually observe', () => {
  it('never gates a navigation on networkidle0', () => {
    expect(smoke).not.toMatch(/waitUntil:\s*'networkidle0'/);
  });

  it('gates every navigation on load, and none on anything else', () => {
    const navigations = smoke.match(/\.goto\(/g) ?? [];
    const loadGates = smoke.match(/waitUntil:\s*'load'/g) ?? [];
    expect(navigations.length).toBeGreaterThan(0);
    expect(loadGates).toHaveLength(navigations.length);
  });

  it('serves its own fixture rather than the repository runs directory', () => {
    // The fixture is written to a temp dir and handed to the compiled server
    // explicitly: a `dist/viz/server.js` spawned without `--dir` defaults to
    // `./runs`, which is exactly the ambient state that made the scroll arm
    // depend on the machine it ran on.
    expect(smoke).toMatch(/mkdtemp\(join\(tmpdir\(\), 'viz-gpu-smoke-'\)\)/);
    expect(smoke).toMatch(/'--dir', fixtureDir/);
    expect(smoke).toMatch(/rm\(fixtureDir, \{ recursive: true, force: true \}\)/);
    const spawns = smoke.match(/'dist\/viz\/server\.js'/g) ?? [];
    const dirFlags = smoke.match(/'--dir',/g) ?? [];
    expect(dirFlags).toHaveLength(spawns.length);
  });

  it('waits for the custom cursor only where the environment allows one', () => {
    // `AtomaCursor` enables itself only for `(any-hover: hover) and
    // (any-pointer: fine)`, so a headless runner with no pointing device keeps
    // the cursor hidden — correctly — and an unconditional wait for it burns 30s
    // and fails. Every wait must sit behind the environment read, and that read
    // must go to the media queries rather than to the component's own attribute.
    const waits = smoke.match(/'\.atoma-pointer-cursor\[data-visible="true"\]'/g) ?? [];
    const guards = smoke.match(/if \(\w*[Cc]ursorEnv\.expected\)/g) ?? [];
    expect(waits.length).toBeGreaterThan(0);
    expect(guards).toHaveLength(waits.length);
    expect(smoke).toMatch(/matchMedia\('\(any-hover: hover\) and \(any-pointer: fine\)'\)/);
  });

  it('bounds the frame sampler by the clock, not only by a frame count', () => {
    // 120 unbounded rAF samples are ~2s of a real display and over three minutes
    // of a software rasteriser — past Puppeteer's 180s protocol timeout, which
    // killed the CI job outright with `Runtime.callFunctionOn timed out`.
    expect(smoke).toMatch(/const FRAME_SAMPLE_BUDGET_MS = [\d_]+;/);
    expect(smoke).toMatch(/samples\.length < target && performance\.now\(\) - started < budgetMs/);
  });

  it('sizes the fixture against the travel the scroll arm dispatches', () => {
    // 16 ticks x 140px must all still move the list, and `views/runs.ts`
    // computes scrollMax as rows * 46px + 38 - listHeight with the pane never
    // taller than the 800px viewport.
    const rows = Number(/const FIXTURE_EVENT_ROWS = (\d+);/.exec(smoke)?.[1]);
    expect(rows).toBeGreaterThan(0);
    expect(rows * 46 + 38 - 800).toBeGreaterThan(16 * 140);
  });
});
