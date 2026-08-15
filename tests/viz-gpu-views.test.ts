import { Container, Graphics } from 'pixi.js';
import type { Text, Ticker } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { I18N_CATALOGS } from '../src/viz/client/i18n.js';
import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  SkillSummary,
  VizEvent,
  VizRun,
} from '../src/viz/client/types.js';
import type {
  GpuDataSnapshot,
  GpuRenderSnapshot,
  RendererCtx,
} from '../src/viz/client-gl/gpu-renderer.js';
import {
  prefersReducedMotion,
  setReducedMotionOverrideForTests,
} from '../src/viz/client-gl/renderer/motion.js';
import { drawBurnin } from '../src/viz/client-gl/renderer/views/burnin.js';
import { drawLaunch } from '../src/viz/client-gl/renderer/views/launch.js';
import { drawRegistry } from '../src/viz/client-gl/renderer/views/registry.js';
import { drawRuns } from '../src/viz/client-gl/renderer/views/runs.js';
import { drawSkills } from '../src/viz/client-gl/renderer/views/skills.js';
import { timelineConnectorGeometry } from '../src/viz/client-gl/renderer/timeline-rails.js';
import type { GpuUiState } from '../src/viz/client-gl/store.js';

// ---------------------------------------------------------------------------
// Recording context: implements RendererCtx without a GPU. Pixi Container /
// Graphics / Rectangle construct headless; Text does not (canvas measurement),
// so text() returns a stub whose height estimate lets views size scroll panes.
// ---------------------------------------------------------------------------

interface RecordedText {
  parent: Container;
  value: string;
  x: number;
  y: number;
  options: unknown;
}

interface RecordedButton {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

interface RecordedEventCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shaderMode: number;
  selected: boolean;
}

interface RecordingCtx extends RendererCtx {
  texts: RecordedText[];
  buttons: RecordedButton[];
  filterButtons: RecordedButton[];
  statCards: { id: string; label: string; value: string }[];
  atomButtons: RecordedButton[];
  eventCards: RecordedEventCard[];
  tickers: ((ticker: Ticker) => void)[];
  exitCalls: number;
}

function textStub(value: string): Text {
  const lines = value.length === 0 ? 1 : Math.ceil(value.length / 80);
  return {
    height: lines * 16,
    text: value,
    anchor: { x: 0 },
    position: { set() {} },
    style: {},
    alpha: 1,
    eventMode: 'none',
  } as unknown as Text;
}

function createRecordingCtx(): RecordingCtx {
  const ctx: RecordingCtx = {
    root: new Container(),
    texts: [],
    buttons: [],
    filterButtons: [],
    statCards: [],
    atomButtons: [],
    eventCards: [],
    tickers: [],
    exitCalls: 0,
    metrics: {
      backend: 'unknown',
      objectCount: 0,
      runCollapseOffset: 0,
      visibleLabels: [],
      hitTargets: [],
    },
    scrollMax: {},
    detailScrollY: 0,
    detailScrollMax: 0,
    detailBounds: null,
    roleRowTransition: null,
    seenAnimatedControls: new Set<string>(),
    previousFilterBounds: new Map(),
    text(parent, value, x, y, options) {
      ctx.texts.push({ parent, value, x, y, options });
      ctx.metrics.visibleLabels.push(value);
      return textStub(value);
    },
    panel(parent, x, y, width, height) {
      const graphics = new Graphics();
      graphics.rect(x, y, Math.max(0, width), Math.max(0, height));
      parent.addChild(graphics);
      return graphics;
    },
    filterBlockFrame(parent, block) {
      const graphics = new Graphics();
      graphics.rect(block.x, block.y, block.width, block.height);
      parent.addChild(graphics);
      return graphics;
    },
    collapseCaret(parent) {
      const graphics = new Graphics();
      parent.addChild(graphics);
      return graphics;
    },
    detailMask(x, y, width, height) {
      const mask = new Graphics();
      mask.rect(x, y, width, height);
      mask.eventMode = 'none';
      ctx.root.addChild(mask);
      return mask;
    },
    button(parent, id, role, label, x, y, width, height, active) {
      ctx.buttons.push({ id, label, x, y, width, height, active });
      ctx.metrics.hitTargets.push({ id, role, label, x, y, width, height });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    filterButton(parent, id, label, x, y, width, height, active) {
      ctx.filterButtons.push({ id, label, x, y, width, height, active });
      ctx.metrics.hitTargets.push({
        id,
        role: 'button',
        label,
        x,
        y,
        width,
        height,
      });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    statCard(parent, id, label, value) {
      ctx.statCards.push({ id, label, value });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    atomButton(parent, id, label, _tier, x, y, width, height, active) {
      ctx.atomButtons.push({ id, label, x, y, width, height, active });
      ctx.metrics.hitTargets.push({
        id,
        role: 'button',
        label,
        x,
        y,
        width,
        height,
      });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    eventCard(parent, id, x, y, width, height, _accent, shaderMode, selected) {
      ctx.eventCards.push({ id, x, y, width, height, shaderMode, selected });
      ctx.metrics.hitTargets.push({
        id,
        role: 'button',
        label: id,
        x,
        y,
        width,
        height,
      });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    addTicker(callback) {
      ctx.tickers.push(callback);
    },
    drawExitingFilterButtons() {
      ctx.exitCalls += 1;
    },
    animateEnteringFilterSpace() {},
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Snapshot factories. `t` resolves through the REAL English catalog so any
// hardcoded label diverging from i18n fails these tests.
// ---------------------------------------------------------------------------

const t = (key: string): string => I18N_CATALOGS.en[key] ?? key;

function makeState(overrides: Partial<GpuUiState> = {}): GpuUiState {
  const noop = () => {};
  return {
    view: 'runs',
    locale: 'en',
    selectedRunId: null,
    selectedEventId: null,
    selectedAtomName: null,
    selectedRegistryId: null,
    selectedRegistryAtom: null,
    selectedSkill: null,
    runFilters: { kind: 'all', role: 'all', branchId: 'all' },
    branchHeadingExpanded: true,
    runSummaryExpanded: true,
    search: { run: '', registry: '', skills: '', launch: '' },
    focusedInput: null,
    runPickerScrollY: 0,
    runPickerActiveIndex: 0,
    burninFamily: 'all',
    burninOutcome: 'all',
    burninPreset: 'all',
    burninPage: 1,
    scrollY: { runs: 0, registry: 0, skills: 0, burnin: 0, launch: 0 },
    refreshNonce: 0,
    setView: noop,
    setLocale: noop,
    selectRun: noop,
    selectEvent: noop,
    selectAtom: noop,
    selectRegistry: noop,
    selectRegistryAtom: noop,
    selectSkill: noop,
    setRunFilters: noop,
    toggleBranchHeading: noop,
    toggleRunSummary: noop,
    setSearch: noop,
    setFocusedInput: noop,
    setRunPickerScrollY: noop,
    setRunPickerActiveIndex: noop,
    setBurninFilter: noop,
    setBurninPage: noop,
    setScrollY: noop,
    refresh: noop,
    ...overrides,
  };
}

function makeData(overrides: Partial<GpuDataSnapshot> = {}): GpuDataSnapshot {
  return {
    runs: [],
    run: null,
    registries: [],
    registry: null,
    skillNamespaces: [],
    skillsByNamespace: {},
    skillDetail: null,
    burnin: null,
    profiles: [],
    loading: false,
    error: null,
    ...overrides,
  };
}

function makeSnapshot(
  state: Partial<GpuUiState> = {},
  data: Partial<GpuDataSnapshot> = {}
): GpuRenderSnapshot {
  return {
    state: makeState(state),
    data: makeData(data),
    t,
    onActivate: () => {},
    onScroll: () => {},
    onRunPickerScroll: () => {},
  };
}

function makeRegistryType(name: string, overrides: Partial<RegistryType> = {}): RegistryType {
  return {
    tier: 1,
    ordinal: 1,
    name,
    description: `${name} capability`,
    systemPrompt: 'You are a helper.',
    tools: ['read_file'],
    params: {},
    createdBy: 'seed',
    createdAt: '2026-08-14T00:00:00.000Z',
    version: 1,
    successes: 2,
    failures: 0,
    ...overrides,
  };
}

const REGISTRY_SUMMARY: RegistrySummary = {
  id: 'main',
  label: 'Main',
  path: 'store.db',
  exists: true,
  counts: { 1: 10, 2: 2, 3: 1, total: 13 },
};

function makeSkill(id: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id,
    description: `${id} description`,
    whenToUse: 'when asked to do the thing',
    kind: 'llm',
    successes: 1,
    failures: 0,
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeBurninRow(index: number, overrides: Partial<BurninRow> = {}): BurninRow {
  return {
    ts: new Date(Date.UTC(2026, 7, 1 + (index % 12), 8, index % 50)).toISOString(),
    taskId: `task-${index}`,
    family: index % 2 ? 'cli' : 'web',
    outcome: index % 3 ? 'delivered' : 'failed',
    costUsd: 0.1 + index * 0.01,
    durationS: 30 + index,
    llmCalls: 5,
    opusCalls: 1,
    sonnetCalls: 2,
    haikuCalls: 2,
    otherCalls: 0,
    deterministicPhases: 0,
    escalations: 0,
    learnedSkills: 0,
    learnedEventSkills: 0,
    promotions: 0,
    refusals: 0,
    compileErrors: 0,
    demotions: 0,
    dispatchFallbacks: 0,
    trace: `trace-${index}.json`,
    provider: 'claude-cli',
    ...overrides,
  };
}

const LAUNCH_PROFILE: LaunchProfile = {
  id: 'build',
  npmScript: 'run:build',
  label: 'Build applications',
  help: 'Long help text describing the family.',
  examples: Array.from({ length: 8 }, (_, index) => `Example goal number ${index + 1}`),
};

function makeLlmEvent(id: string, overrides: Partial<VizEvent> = {}): VizEvent {
  return {
    id,
    ts: Date.parse('2026-08-14T10:00:00.000Z'),
    kind: 'llm',
    role: 'plan',
    actor: { tier: 3, name: 'Meristem' },
    model: 'claude-x',
    response: 'ok',
    durationMs: 900,
    costUsd: 0.01,
    ...overrides,
  };
}

function makeRun(events: VizEvent[], overrides: Partial<VizRun> = {}): VizRun {
  return {
    id: 'run-1',
    label: 'build-app: GPU dashboard',
    task: { description: 'Build a dashboard' },
    startedAt: '2026-08-14T10:00:00.000Z',
    endedAt: '2026-08-14T10:30:00.000Z',
    durationMs: 1_800_000,
    events,
    totals: { calls: events.length, inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
    ...overrides,
  };
}

function containersWithMask(root: Container): Container[] {
  const found: Container[] = [];
  const walk = (node: Container) => {
    if (node.mask) found.push(node);
    for (const child of node.children) {
      if (child instanceof Container) walk(child);
    }
  };
  walk(root);
  return found;
}

/** The shared thumb (scroll-pane.ts) labels its Graphics; count them. */
function scrollbarThumbs(root: Container): Container[] {
  const found: Container[] = [];
  const walk = (node: Container) => {
    if (node.label === 'scrollbar-thumb') found.push(node);
    for (const child of node.children) {
      if (child instanceof Container) walk(child);
    }
  };
  walk(root);
  return found;
}

function findByLabel(root: Container, label: string): Container | undefined {
  const walk = (node: Container): Container | undefined => {
    if (node.label === label) return node;
    for (const child of node.children) {
      if (child instanceof Container) {
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(root);
}

/**
 * Read a Graphics back as drawn paths. Pixi keeps one path per stroke/fill
 * instruction, so a vertical rail comes back as moveTo+lineTo and a connector
 * as moveTo+bezierCurveTo — enough to assert that every connector endpoint
 * actually touches a rail.
 */
interface PathCommand {
  action: string;
  data: readonly (number | null)[];
}

function strokedPaths(graphics: Graphics): PathCommand[][] {
  const instructions = graphics.context.instructions as readonly {
    action: string;
    data?: { path?: { instructions?: PathCommand[] } };
  }[];
  return instructions
    .filter((entry) => entry.action === 'stroke')
    .map((entry) => entry.data?.path?.instructions ?? []);
}

function findByCursor(root: Container, cursor: string): Container | undefined {
  const walk = (node: Container): Container | undefined => {
    if (node.cursor === cursor) return node;
    for (const child of node.children) {
      if (child instanceof Container) {
        const hit = walk(child);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(root);
}

afterEach(() => {
  setReducedMotionOverrideForTests(null);
});

// ---------------------------------------------------------------------------
// Motion override
// ---------------------------------------------------------------------------

describe('reduced-motion override', () => {
  it('forces the preference for tests and resets to the media query', () => {
    setReducedMotionOverrideForTests(true);
    expect(prefersReducedMotion()).toBe(true);
    setReducedMotionOverrideForTests(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry view
// ---------------------------------------------------------------------------

describe('drawRegistry scrolling honesty', () => {
  const WIDTH = 1280;
  const HEIGHT = 420;
  const ATOM_COUNT = 30;
  const types = Array.from({ length: ATOM_COUNT }, (_, index) =>
    makeRegistryType(`Molecule${index}`)
  );
  const data = {
    registries: [REGISTRY_SUMMARY],
    registry: { registry: REGISTRY_SUMMARY, types },
  };

  it('reports the true content bottom for a pane the window cannot fit', () => {
    const ctx = createRecordingCtx();
    drawRegistry(ctx, makeSnapshot({ view: 'registry' }, data), WIDTH, HEIGHT);
    // Pane math mirrors the view: header 52 + gap 10 = top 62, pane top 154.
    const paneTop = 62 + 92;
    const paneHeight = HEIGHT - 10 - paneTop;
    const finalCursor = 28 + ATOM_COUNT * 37 + 8;
    expect(ctx.scrollMax.registry).toBe(Math.max(0, finalCursor + 12 - paneHeight));
    expect(ctx.scrollMax.registry).toBeGreaterThan(0);
  });

  it('culls rows beyond the margin but keeps them reachable by scrolling', () => {
    const unscrolled = createRecordingCtx();
    drawRegistry(unscrolled, makeSnapshot({ view: 'registry' }, data), WIDTH, HEIGHT);
    const last = `registry.atom.Molecule${ATOM_COUNT - 1}`;
    expect(unscrolled.buttons.some((button) => button.id === 'registry.atom.Molecule0')).toBe(
      true
    );
    expect(unscrolled.buttons.some((button) => button.id === last)).toBe(false);

    const scrolled = createRecordingCtx();
    drawRegistry(
      scrolled,
      makeSnapshot(
        {
          view: 'registry',
          scrollY: {
            runs: 0,
            registry: unscrolled.scrollMax.registry!,
            skills: 0,
            burnin: 0,
            launch: 0,
          },
        },
        data
      ),
      WIDTH,
      HEIGHT
    );
    expect(scrolled.buttons.some((button) => button.id === last)).toBe(true);
    expect(scrolled.buttons.some((button) => button.id === 'registry.atom.Molecule0')).toBe(
      false
    );
  });

  it('masks the scrolling tier list to its pane', () => {
    const ctx = createRecordingCtx();
    drawRegistry(ctx, makeSnapshot({ view: 'registry' }, data), WIDTH, HEIGHT);
    expect(containersWithMask(ctx.root).length).toBeGreaterThan(0);
  });

  it('draws the shared scrollbar thumb only when the list overflows', () => {
    const overflowing = createRecordingCtx();
    drawRegistry(overflowing, makeSnapshot({ view: 'registry' }, data), WIDTH, HEIGHT);
    // The list pane overflows (thumb); the default atom's short prompt does not.
    expect(scrollbarThumbs(overflowing.root).length).toBe(1);

    const fitting = createRecordingCtx();
    drawRegistry(
      fitting,
      makeSnapshot(
        { view: 'registry' },
        {
          registries: [REGISTRY_SUMMARY],
          registry: { registry: REGISTRY_SUMMARY, types: [makeRegistryType('Sole')] },
        }
      ),
      WIDTH,
      900
    );
    expect(fitting.scrollMax.registry).toBe(0);
    expect(scrollbarThumbs(fitting.root).length).toBe(0);
  });

  it('scrolls a long system prompt inside the detail pane', () => {
    const ctx = createRecordingCtx();
    const longTypes = [
      makeRegistryType('Verbose', { systemPrompt: 'x'.repeat(5000) }),
    ];
    drawRegistry(
      ctx,
      makeSnapshot(
        { view: 'registry', selectedRegistryAtom: 'Verbose' },
        { registries: [REGISTRY_SUMMARY], registry: { registry: REGISTRY_SUMMARY, types: longTypes } }
      ),
      WIDTH,
      HEIGHT
    );
    expect(ctx.detailScrollMax).toBeGreaterThan(0);
    // The detail bounds cover the right panel rect the wheel router checks.
    const leftWidth = Math.min(560, WIDTH * 0.45);
    const rightX = 10 + leftWidth + 10;
    expect(ctx.detailBounds).not.toBeNull();
    expect(ctx.detailBounds!.x).toBe(rightX);
    expect(ctx.detailBounds!.y).toBe(62);
    expect(ctx.detailBounds!.width).toBe(WIDTH - rightX - 10);
    expect(ctx.detailBounds!.height).toBe(HEIGHT - 62 - 10);
    // One atom fits the list, so the only thumb is the detail pane's.
    expect(scrollbarThumbs(ctx.root).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Skills view
// ---------------------------------------------------------------------------

describe('drawSkills scrolling honesty and search', () => {
  const WIDTH = 1280;
  const HEIGHT = 420;
  const skills = Array.from({ length: 24 }, (_, index) => makeSkill(`skill-${index}`));
  const data = {
    skillNamespaces: [{ l1Name: 'Ammonia', count: skills.length }],
    skillsByNamespace: { Ammonia: skills },
  };

  it('reports list overflow through scrollMax.skills', () => {
    const ctx = createRecordingCtx();
    drawSkills(ctx, makeSnapshot({ view: 'skills' }, data), WIDTH, HEIGHT);
    expect(ctx.scrollMax.skills).toBeGreaterThan(0);
    expect(containersWithMask(ctx.root).length).toBeGreaterThan(0);
    // The overflowing namespace list advertises itself with the shared thumb.
    expect(scrollbarThumbs(ctx.root).length).toBe(1);
  });

  it('scrolls a long skill body inside the masked detail pane', () => {
    const ctx = createRecordingCtx();
    drawSkills(
      ctx,
      makeSnapshot(
        { view: 'skills' },
        { ...data, skillDetail: makeSkill('verbose', { body: 'y'.repeat(6000) }) }
      ),
      WIDTH,
      HEIGHT
    );
    expect(ctx.detailScrollMax).toBeGreaterThan(0);
    const leftWidth = Math.min(560, WIDTH * 0.45);
    const rightX = leftWidth + 20;
    expect(ctx.detailBounds).not.toBeNull();
    expect(ctx.detailBounds!.x).toBe(rightX);
    expect(ctx.detailBounds!.width).toBe(WIDTH - rightX - 10);
    // Both the overflowing list and the long body get the shared thumb.
    expect(scrollbarThumbs(ctx.root).length).toBe(2);
  });

  it('filters on visible identity, never on hidden when_to_use text', () => {
    const ctx = createRecordingCtx();
    const pair = [
      makeSkill('replay-recorded-shell-probes'),
      makeSkill('recover-manifest-run', {
        whenToUse: 'replay the recorded probes when stdout varies',
      }),
    ];
    drawSkills(
      ctx,
      makeSnapshot(
        {
          view: 'skills',
          search: { run: '', registry: '', skills: 'replay', launch: '' },
        },
        {
          skillNamespaces: [{ l1Name: 'Ammonia', count: pair.length }],
          skillsByNamespace: { Ammonia: pair },
        }
      ),
      WIDTH,
      800
    );
    const ids = ctx.buttons.map((button) => button.id);
    expect(ids).toContain('skill.select.Ammonia::replay-recorded-shell-probes');
    expect(ids).not.toContain('skill.select.Ammonia::recover-manifest-run');
  });
});

// ---------------------------------------------------------------------------
// Burn-in view
// ---------------------------------------------------------------------------

describe('drawBurnin scroll, pagination and lifecycle columns', () => {
  const WIDTH = 1400;
  const rows = Array.from({ length: 120 }, (_, index) => makeBurninRow(index));
  const data = { burnin: { rows, csvPath: 'burnin.csv' } };

  it('reports no scroll in a tall window and a positive max in a short one', () => {
    setReducedMotionOverrideForTests(true);
    const tall = createRecordingCtx();
    drawBurnin(tall, makeSnapshot({ view: 'burnin' }, data), WIDTH, 1400);
    expect(tall.scrollMax.burnin).toBe(0);

    // The table shrinks with the window (availableRows), so overflow starts
    // only once the fixed filter/stat/chart stack itself exceeds the height.
    const short = createRecordingCtx();
    drawBurnin(short, makeSnapshot({ view: 'burnin' }, data), WIDTH, 360);
    expect(short.scrollMax.burnin).toBeGreaterThan(0);
  });

  it('keeps pagination independent of wheel scroll', () => {
    setReducedMotionOverrideForTests(true);
    const HEIGHT = 420;
    const rowIds = (ctx: RecordingCtx) =>
      ctx.metrics.hitTargets
        .filter((target) => target.id.startsWith('burnin.trace.'))
        .map((target) => target.id);

    const unscrolled = createRecordingCtx();
    drawBurnin(unscrolled, makeSnapshot({ view: 'burnin', burninPage: 2 }, data), WIDTH, HEIGHT);
    const scrolled = createRecordingCtx();
    drawBurnin(
      scrolled,
      makeSnapshot(
        {
          view: 'burnin',
          burninPage: 2,
          scrollY: { runs: 0, registry: 0, skills: 0, burnin: 500, launch: 0 },
        },
        data
      ),
      WIDTH,
      HEIGHT
    );
    expect(rowIds(unscrolled).length).toBeGreaterThan(0);
    expect(rowIds(scrolled)).toEqual(rowIds(unscrolled));
    const pageLabel = unscrolled.texts.find((text) => /^\d+\/\d+$/.test(text.value));
    expect(pageLabel?.value.startsWith('2/')).toBe(true);
  });

  it('renders compiler refusals and transport errors present in the rows', () => {
    setReducedMotionOverrideForTests(true);
    const lifecycleRows = [
      makeBurninRow(0, { refusals: 2, compileErrors: 3, taskId: 'lifecycle-task' }),
    ];
    const ctx = createRecordingCtx();
    drawBurnin(
      ctx,
      makeSnapshot({ view: 'burnin' }, { burnin: { rows: lifecycleRows, csvPath: 'b.csv' } }),
      WIDTH,
      1200
    );
    const lifecycle = ctx.texts.find((text) => text.value.includes('⛔2'));
    expect(lifecycle).toBeDefined();
    expect(lifecycle!.value).toContain('⚠3');
  });

  it('exposes the chart and every plotted run to hit testing', () => {
    setReducedMotionOverrideForTests(true);
    const ctx = createRecordingCtx();
    drawBurnin(ctx, makeSnapshot({ view: 'burnin' }, data), WIDTH, 1400);
    const ids = ctx.metrics.hitTargets.map((target) => target.id);
    expect(ids).toContain('burnin.chart');
    expect(ids.filter((id) => id.startsWith('burnin.point.')).length).toBe(rows.length);
    // The interactive chart now lives inside the masked scroll pane.
    expect(findByCursor(ctx.root, 'crosshair')).toBeDefined();
  });

  it('masks the scrolled content under one pane and pins the pager to the viewport', () => {
    setReducedMotionOverrideForTests(true);
    const HEIGHT = 420;
    const SCROLL = 13;
    const ctx = createRecordingCtx();
    drawBurnin(
      ctx,
      makeSnapshot(
        {
          view: 'burnin',
          scrollY: { runs: 0, registry: 0, skills: 0, burnin: SCROLL, launch: 0 },
        },
        data
      ),
      WIDTH,
      HEIGHT
    );
    // One masked pane owns filters, stats, chart and table rows; the pane
    // applies the wheel offset to its content layer so scrolled rows clip at
    // the pane rect instead of sliding over the header or under the pager.
    const masked = containersWithMask(ctx.root);
    expect(masked.length).toBe(1);
    const content = masked[0]!.children[0] as Container;
    expect(content.position.y).toBe(-SCROLL);
    expect(ctx.scrollMax.burnin).toBeGreaterThan(0);
    expect(scrollbarThumbs(ctx.root).length).toBe(1);
    // The pager never scrolls: viewport coordinates regardless of the wheel.
    const next = ctx.buttons.find((button) => button.id === 'burnin.page.next');
    expect(next).toBeDefined();
    expect(next!.y).toBe(HEIGHT - 34);
    const pageLabel = ctx.texts.find((text) => /^\d+\/\d+$/.test(text.value));
    expect(pageLabel).toBeDefined();
    expect(pageLabel!.y).toBe(HEIGHT - 26);
    // A tall window has nothing to scroll and therefore no thumb.
    const tall = createRecordingCtx();
    drawBurnin(tall, makeSnapshot({ view: 'burnin' }, data), WIDTH, 1400);
    expect(scrollbarThumbs(tall.root).length).toBe(0);
  });

  it('draws the same widgets under reduced motion', () => {
    setReducedMotionOverrideForTests(false);
    const animated = createRecordingCtx();
    drawBurnin(animated, makeSnapshot({ view: 'burnin' }, data), WIDTH, 1400);
    setReducedMotionOverrideForTests(true);
    const reduced = createRecordingCtx();
    drawBurnin(reduced, makeSnapshot({ view: 'burnin' }, data), WIDTH, 1400);
    expect(reduced.statCards).toEqual(animated.statCards);
    expect(reduced.metrics.hitTargets.map((target) => target.id)).toEqual(
      animated.metrics.hitTargets.map((target) => target.id)
    );
  });
});

// ---------------------------------------------------------------------------
// Launch view
// ---------------------------------------------------------------------------

describe('drawLaunch scrolling honesty', () => {
  it('lets a short window reach examples and the command panel', () => {
    const ctx = createRecordingCtx();
    drawLaunch(
      ctx,
      makeSnapshot({ view: 'launch' }, { profiles: [LAUNCH_PROFILE] }),
      1000,
      420
    );
    expect(ctx.scrollMax.launch).toBeGreaterThan(0);
    expect(ctx.buttons.some((button) => button.id === 'launch.example.7')).toBe(true);
    expect(ctx.buttons.some((button) => button.id === 'launch.copy')).toBe(true);
  });

  it('does not invent scroll for a window that fits everything', () => {
    const ctx = createRecordingCtx();
    drawLaunch(
      ctx,
      makeSnapshot(
        { view: 'launch' },
        { profiles: [{ ...LAUNCH_PROFILE, examples: LAUNCH_PROFILE.examples.slice(0, 2) }] }
      ),
      1000,
      900
    );
    expect(ctx.scrollMax.launch).toBe(0);
  });

  it('extends layout and scroll max by the measured wrapped help height', () => {
    const HEIGHT = 420;
    // Both paragraphs wrap far past the historical fixed slot, so every
    // downstream block must shift by exactly the measured height difference.
    const mediumHelp = 'm'.repeat(800);
    const longHelp = 'l'.repeat(2400);
    const draw = (help: string) => {
      const ctx = createRecordingCtx();
      drawLaunch(
        ctx,
        makeSnapshot({ view: 'launch' }, { profiles: [{ ...LAUNCH_PROFILE, help }] }),
        1000,
        HEIGHT
      );
      return ctx;
    };
    const medium = draw(mediumHelp);
    const long = draw(longHelp);
    const heightDelta = textStub(longHelp).height - textStub(mediumHelp).height;
    expect(heightDelta).toBeGreaterThan(0);
    expect(long.scrollMax.launch! - medium.scrollMax.launch!).toBe(heightDelta);
    // Examples start below the measured paragraph instead of overlapping it.
    const helpText = long.texts.find((text) => text.value === longHelp)!;
    const firstExample = long.buttons.find((button) => button.id === 'launch.example.0')!;
    expect(firstExample.y).toBeGreaterThanOrEqual(helpText.y + textStub(longHelp).height);
    // The backdrop panel is drawn into the z-slot reserved before the text,
    // sized by the same layout cursor (one pass, no analytic duplicate).
    const backdrop = long.root.children[0] as Container;
    expect(backdrop.children.length).toBe(1);
    expect(backdrop.children[0]).toBeInstanceOf(Graphics);
  });
});

// ---------------------------------------------------------------------------
// Runs view
// ---------------------------------------------------------------------------

describe('drawRuns behavior', () => {
  const WIDTH = 1280;
  const HEIGHT = 800;

  function eventsWithRoles(): VizEvent[] {
    return [
      makeLlmEvent('e1', { role: 'plan' }),
      makeLlmEvent('e2', { role: 'execute', actor: { tier: 1, name: 'Ammonia' } }),
      {
        id: 'e3',
        ts: Date.parse('2026-08-14T10:01:00.000Z'),
        kind: 'tool',
        name: 'read_file',
        actor: { tier: 1, name: 'Ammonia' },
        args: { path: 'src/index.ts' },
        result: { ok: true },
      },
    ];
  }

  it('labels the role filter chip from the i18n catalog', () => {
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(eventsWithRoles()) }), WIDTH, HEIGHT);
    const allRoles = ctx.filterButtons.find((button) => button.id === 'run.filter.role.all');
    expect(allRoles).toBeDefined();
    expect(allRoles!.label).toBe(I18N_CATALOGS.en['filters.allRoles']!.toUpperCase());
    expect(allRoles!.label).toBe('ALL ROLES');
  });

  it('offers only the kind filters present in the trace', () => {
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(eventsWithRoles()) }), WIDTH, HEIGHT);
    const kindIds = ctx.filterButtons
      .filter((button) => button.id.startsWith('run.filter.kind.'))
      .map((button) => button.id);
    expect(kindIds).toContain('run.filter.kind.all');
    expect(kindIds).toContain('run.filter.kind.llm');
    expect(kindIds).not.toContain('run.filter.kind.cache');
  });

  it('draws atom lanes only for tiers that actually acted', () => {
    const events: VizEvent[] = [
      ...eventsWithRoles(),
      {
        id: 'r1',
        ts: Date.parse('2026-08-14T10:02:00.000Z'),
        kind: 'registry',
        op: 'create',
        snapshot: makeRegistryType('Ammonia', { tier: 1 }),
      },
    ];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    expect(ctx.atomButtons.some((button) => button.label === 'Ammonia')).toBe(true);
    // Actors stub lanes too: Meristem (L3) and Ammonia (L1) acted; no L2 did.
    const laneLabels = ctx.texts.map((text) => text.value);
    expect(laneLabels).toContain(t('lanes.l1'));
    expect(laneLabels).toContain(t('lanes.l3'));
    expect(laneLabels).not.toContain(t('lanes.l2'));
  });

  it('windows the timeline, masks it, and reports the scroll bound', () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      makeLlmEvent(`bulk-${index}`, {
        ts: Date.parse('2026-08-14T10:00:00.000Z') + index * 1000,
      })
    );
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    expect(ctx.scrollMax.runs).toBeGreaterThan(0);
    expect(ctx.eventCards.length).toBeGreaterThan(0);
    expect(ctx.eventCards.length).toBeLessThan(events.length);
    // The windowed list is masked and hit-testable without swallowing the pane.
    const masked = containersWithMask(ctx.root);
    expect(masked.length).toBeGreaterThan(0);
    const listLayer = masked.find((container) => container.hitArea !== null);
    expect(listLayer).toBeDefined();
    expect(listLayer!.mask).toBeInstanceOf(Graphics);
    expect((listLayer!.mask as Graphics).eventMode).toBe('none');
    // Newest first: the most recent event is on screen unscrolled, and the
    // OLDEST is what scrolling to the reported max reaches.
    expect(ctx.eventCards.some((card) => card.id === 'bulk-199')).toBe(true);
    expect(ctx.eventCards.some((card) => card.id === 'bulk-0')).toBe(false);
    const scrolled = createRecordingCtx();
    drawRuns(
      scrolled,
      makeSnapshot(
        {
          scrollY: {
            runs: ctx.scrollMax.runs!,
            registry: 0,
            skills: 0,
            burnin: 0,
            launch: 0,
          },
        },
        { run: makeRun(events) }
      ),
      WIDTH,
      HEIGHT
    );
    expect(scrolled.eventCards.some((card) => card.id === 'bulk-0')).toBe(true);
  });

  it('keeps the summary card and event copy on the GPU right pane', () => {
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(eventsWithRoles()) }), WIDTH, HEIGHT);
    expect(ctx.metrics.hitTargets.some((target) => target.id === 'run.summary.toggle')).toBe(
      true
    );
    // Event cards carry catalog-backed copy and per-family shader modes.
    const toolCard = ctx.eventCards.find((card) => card.id === 'e3');
    const llmCard = ctx.eventCards.find((card) => card.id === 'e1');
    expect(toolCard).toBeDefined();
    expect(llmCard).toBeDefined();
    expect(toolCard!.shaderMode).not.toBe(llmCard!.shaderMode);
    expect(ctx.texts.some((text) => text.value.includes('read_file'))).toBe(true);
  });

  it('shows the branch heading toggle when a branch filter is active', () => {
    const ctx = createRecordingCtx();
    drawRuns(
      ctx,
      makeSnapshot(
        { runFilters: { kind: 'all', role: 'all', branchId: 'branch-x' } },
        { run: makeRun(eventsWithRoles()) }
      ),
      WIDTH,
      HEIGHT
    );
    expect(ctx.metrics.hitTargets.some((target) => target.id === 'branch.heading.toggle')).toBe(
      true
    );
  });

  it('scrolls a long selected event detail inside a masked layer', () => {
    const events = [
      ...eventsWithRoles(),
      makeLlmEvent('long', { response: 'lorem '.repeat(2000) }),
    ];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({ selectedEventId: 'long' }, { run: makeRun(events) }), WIDTH, HEIGHT);
    expect(ctx.detailScrollMax).toBeGreaterThan(0);
    expect(ctx.detailBounds).not.toBeNull();
    expect(ctx.detailBounds!.x).toBeGreaterThan(WIDTH / 2);
    // The overflowing detail draws the shared scrollbar thumb.
    expect(scrollbarThumbs(ctx.root).length).toBe(1);
  });

  it('hands vanished role filters to the exit transition', () => {
    const ctx = createRecordingCtx();
    ctx.previousFilterBounds.set('run.filter.role.all', {
      id: 'run.filter.role.all',
      role: 'button',
      label: 'ALL ROLES',
      x: 20,
      y: 200,
      width: 90,
      height: 27,
      active: true,
      accent: 0,
    });
    drawRuns(
      ctx,
      makeSnapshot(
        { runFilters: { kind: 'tool', role: 'all', branchId: 'all' } },
        { run: makeRun(eventsWithRoles()) }
      ),
      WIDTH,
      HEIGHT
    );
    expect(ctx.roleRowTransition?.phase).toBe('exit');
    expect(ctx.exitCalls).toBe(1);
  });

  it('renders every view under both motion preferences', () => {
    for (const reduced of [true, false]) {
      setReducedMotionOverrideForTests(reduced);
      const ctx = createRecordingCtx();
      drawRuns(ctx, makeSnapshot({}, { run: makeRun(eventsWithRoles()) }), WIDTH, HEIGHT);
      expect(ctx.eventCards.length).toBeGreaterThan(0);
    }
  });
});

/**
 * What the run's own story looks like — the four defects a real cancelled
 * run exposed on 2026-08-15: no status anywhere, chronological order when
 * the reader wants the end first, a branch rail attached to nothing, and no
 * explicit start/end steps.
 */
describe('drawRuns — run status and timeline bookends', () => {
  const WIDTH = 1400;
  const HEIGHT = 900;
  const textsOf = (ctx: ReturnType<typeof createRecordingCtx>) =>
    ctx.texts.map((entry) => entry.value);

  it('states what happened to the run, cancellation included', () => {
    const events = [makeLlmEvent('a'), makeLlmEvent('b')];
    const cancelled = createRecordingCtx();
    drawRuns(
      cancelled,
      makeSnapshot(
        {},
        {
          run: makeRun(events, {
            cancelled: true,
            error: 'run cancelled by user (signal received)',
          }),
        }
      ),
      WIDTH,
      HEIGHT
    );
    const cancelledTexts = textsOf(cancelled);
    expect(cancelledTexts).toContain(t('runs.flag.cancelled'));
    // Never as a failure: a deliberate kill is not a fault.
    expect(cancelledTexts).not.toContain(t('runs.flag.failed'));

    const delivered = createRecordingCtx();
    drawRuns(delivered, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    expect(textsOf(delivered)).toContain(t('runs.flag.delivered'));

    const failed = createRecordingCtx();
    drawRuns(
      failed,
      makeSnapshot({}, { run: makeRun(events, { error: 'boom' }) }),
      WIDTH,
      HEIGHT
    );
    expect(textsOf(failed)).toContain(t('runs.flag.failed'));
  });

  it('frames the events with a start and an end step, end first', () => {
    const events = [makeLlmEvent('a'), makeLlmEvent('b')];
    const ctx = createRecordingCtx();
    drawRuns(
      ctx,
      makeSnapshot({}, { run: makeRun(events, { cancelled: true }) }),
      WIDTH,
      HEIGHT
    );
    const ended = ctx.texts.find((entry) => entry.value.startsWith(t('timeline.runEnded')));
    const started = ctx.texts.find((entry) => entry.value === t('timeline.runStarted'));
    expect(ended).toBeDefined();
    expect(started).toBeDefined();
    // The end bookend carries the verdict, and newest-first puts it on top.
    expect(ended!.value).toContain(t('runs.flag.cancelled'));
    expect(ended!.y).toBeLessThan(started!.y);
  });

  it('says "not finished" instead of inventing an end for a live run', () => {
    const ctx = createRecordingCtx();
    const live = makeRun([makeLlmEvent('a', { ts: Date.now() })]);
    delete (live as { endedAt?: string }).endedAt;
    drawRuns(ctx, makeSnapshot({}, { run: live }), WIDTH, HEIGHT);
    const texts = textsOf(ctx);
    expect(texts).toContain(t('runs.flag.live'));
    expect(texts.some((value) => value.startsWith(t('timeline.runUnfinished')))).toBe(true);
    expect(texts.some((value) => value.startsWith(t('timeline.runEnded')))).toBe(false);
  });

  /**
   * Rail continuity, 2026-08-15: on a real run every branch END was drawn as a
   * hook hanging half a row above its own rail, because the join connector
   * anchored on the lane it came FROM (the child) instead of the parent.
   */
  it('ends every branch rail on a rail, not in mid-air', () => {
    const at = (offset: number) =>
      Date.parse('2026-08-14T10:00:00.000Z') + offset * 1000;
    const events: VizEvent[] = [
      {
        id: 'p-start',
        ts: at(0),
        kind: 'branch',
        op: 'start',
        branchId: 'parent',
        label: 'Build the files',
        actor: { tier: 3, name: 'Meristem' },
      },
      makeLlmEvent('p-1', { ts: at(1), branchId: 'parent' }),
      {
        id: 'c-start',
        ts: at(2),
        kind: 'branch',
        op: 'start',
        branchId: 'child',
        parentBranchId: 'parent',
        label: 'Verify the files',
        actor: { tier: 2, name: 'Idioblast' },
      },
      makeLlmEvent('c-1', {
        ts: at(3),
        branchId: 'child',
        actor: { tier: 2, name: 'Idioblast' },
      }),
      makeLlmEvent('c-2', {
        ts: at(4),
        branchId: 'child',
        actor: { tier: 1, name: 'Ammonia' },
      }),
      { id: 'c-end', ts: at(5), kind: 'branch', op: 'end', branchId: 'child' },
      makeLlmEvent('p-2', { ts: at(6), branchId: 'parent' }),
      { id: 'p-end', ts: at(7), kind: 'branch', op: 'end', branchId: 'parent' },
    ];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);

    const rails = findByLabel(ctx.root, 'timeline-rails');
    expect(rails).toBeInstanceOf(Graphics);
    const paths = strokedPaths(rails as Graphics);
    const segments = paths
      .filter((path) => path[1]?.action === 'lineTo')
      .map((path) => ({
        x: Number(path[0]!.data[0]),
        top: Math.min(Number(path[0]!.data[1]), Number(path[1]!.data[1])),
        bottom: Math.max(Number(path[0]!.data[1]), Number(path[1]!.data[1])),
      }));
    const connectors = paths
      .filter((path) => path[1]?.action === 'bezierCurveTo')
      .map((path) => [
        { x: Number(path[0]!.data[0]), y: Number(path[0]!.data[1]) },
        { x: Number(path[1]!.data[4]), y: Number(path[1]!.data[5]) },
      ]);
    // Trunk plus one rail per branch, and a fork/join for each branch.
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(connectors).toHaveLength(4);

    const onARail = (point: { x: number; y: number }) =>
      segments.some(
        (segment) =>
          Math.abs(segment.x - point.x) < 0.5 &&
          point.y >= segment.top - 0.5 &&
          point.y <= segment.bottom + 0.5
      );
    for (const [anchor, landing] of connectors) {
      expect(onARail(anchor!)).toBe(true);
      expect(onARail(landing!)).toBe(true);
      // Two different lanes, or it is not a connector at all.
      expect(anchor!.x).not.toBe(landing!.x);
    }
  });

  /**
   * The run summary card is the one surface that answers "what was this run
   * asked to do". It clamped the goal at 140 chars, so on a shorter goal the
   * collapse caret flipped and NOTHING else moved (2026-08-15).
   */
  it('says the goal once, whole when expanded and clamped when collapsed', () => {
    const description = `Build a dashboard that ${'reads every metric '.repeat(12)}`.trim();
    const run = makeRun([makeLlmEvent('a')], {
      label: `build-app: ${description.slice(0, 80)}`,
      task: { description },
      error: 'run cancelled by user (signal received)',
    });
    expect(description.length).toBeGreaterThan(140);

    const expanded = createRecordingCtx();
    drawRuns(expanded, makeSnapshot({ runSummaryExpanded: true }, { run }), WIDTH, HEIGHT);
    const expandedTexts = expanded.texts.map((entry) => entry.value);
    // The goal titles the card, verbatim and exactly once.
    expect(expandedTexts).toContain(description);
    expect(expandedTexts.filter((value) => value === description)).toHaveLength(1);
    // The family — the only thing the label held that the goal cannot — rides
    // the eyebrow, and the stored label itself is never shown.
    expect(expandedTexts).toContain(`${t('run.summary')} · build-app`.toUpperCase());
    expect(expandedTexts.some((value) => value.includes(`build-app: ${description.slice(0, 40)}`)))
      .toBe(false);
    expect(expandedTexts).toContain(run.error);

    const collapsed = createRecordingCtx();
    drawRuns(collapsed, makeSnapshot({ runSummaryExpanded: false }, { run }), WIDTH, HEIGHT);
    const collapsedTexts = collapsed.texts.map((entry) => entry.value);
    // The caret always changes something: the goal is clamped and says so, and
    // the facts and the failure reason step aside for the event detail below.
    expect(collapsedTexts).not.toContain(description);
    expect(collapsedTexts).not.toContain(run.error);
    expect(
      collapsedTexts.some(
        (value) => value.startsWith(description.slice(0, 60)) && value.endsWith('…')
      )
    ).toBe(true);
  });

  it('titles the card from the goal when the stored label was cut mid-word', () => {
    // Exactly the bytes an older trace carries: label = family + bare slice.
    const description =
      'a single index.html page showing a 3x3 grid of coloured tiles that swap colour when clicked';
    const run = makeRun([makeLlmEvent('a')], {
      label: `build-app: ${description.slice(0, 80)}`,
      task: { description },
    });
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({ runSummaryExpanded: true }, { run }), WIDTH, HEIGHT);
    const texts = ctx.texts.map((entry) => entry.value);
    expect(texts).toContain(description);
    expect(texts.some((value) => value.endsWith('colour w'))).toBe(false);
  });

  it('publishes the bookend row offset so overlays project on the same grid', () => {
    const events = [makeLlmEvent('a'), makeLlmEvent('b'), makeLlmEvent('c')];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    const viewport = ctx.metrics.timelineViewport!;
    expect(viewport.rowOffset).toBe(1);
    // Two extra rows of content: the reader can always scroll to both ends.
    expect(viewport.totalHeight).toBe(
      (events.length + 2) * viewport.rowHeight +
        viewport.contentTopPadding +
        viewport.contentBottomPadding
    );
  });
});

describe('timelineConnectorGeometry — which rail carries the anchor', () => {
  const rail = {
    rowHeight: 64,
    connectorY: 300,
    parentTopY: 0,
    parentBottomY: 1000,
  };

  it('always lands on the branch rail and anchors on the parent rail', () => {
    // The layout names lanes by travel direction: a fork goes parent → child,
    // a join child → parent. Both must anchor on the PARENT.
    const fork = timelineConnectorGeometry({
      ...rail,
      kind: 'fork',
      fromLane: 0,
      toLane: 2,
      chronological: false,
    });
    const join = timelineConnectorGeometry({
      ...rail,
      kind: 'join',
      fromLane: 2,
      toLane: 0,
      chronological: false,
    });
    for (const geometry of [fork, join]) {
      expect(geometry.parentLane).toBe(0);
      expect(geometry.branchLane).toBe(2);
      // The branch end is the connector's own row: it touches the rail there.
      expect(geometry.branchY).toBe(300);
    }
    // Newest first: the branch's causal start is BELOW it, its end ABOVE.
    expect(fork.parentY).toBeGreaterThan(300);
    expect(join.parentY).toBeLessThan(300);
  });

  it('mirrors the anchor when the rows run chronologically', () => {
    const fork = timelineConnectorGeometry({
      ...rail,
      kind: 'fork',
      fromLane: 0,
      toLane: 1,
      chronological: true,
    });
    const join = timelineConnectorGeometry({
      ...rail,
      kind: 'join',
      fromLane: 1,
      toLane: 0,
      chronological: true,
    });
    expect(fork.parentY).toBeLessThan(300);
    expect(join.parentY).toBeGreaterThan(300);
  });

  it('never anchors past the end of the parent rail', () => {
    // A child that ends exactly where its parent's drawn span ends: half a row
    // further would hang the anchor off the parent too.
    const geometry = timelineConnectorGeometry({
      ...rail,
      kind: 'join',
      fromLane: 1,
      toLane: 0,
      chronological: false,
      parentTopY: 300,
      parentBottomY: 900,
    });
    expect(geometry.parentY).toBe(300);
    expect(geometry.branchY).toBe(300);
  });
});
