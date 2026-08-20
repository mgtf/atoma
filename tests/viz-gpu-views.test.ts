import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Container, Graphics } from 'pixi.js';
import type { Text, Ticker } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { I18N_CATALOGS, translate } from '../src/viz/client/i18n.js';
import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  SkillSummary,
  VizEvent,
  VizRun,
} from '../src/viz/client/types.js';
import { emptyRenderMetrics } from '../src/viz/client-gl/gpu-renderer.js';
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
import { drawProjects, PROJECTS_DOM_FORM_HEIGHT, PROJECTS_DOM_FORM_TOP, projectsGpuContentTop } from '../src/viz/client-gl/renderer/views/projects.js';
import {
  authAccountLayout,
  drawAuthAccount,
} from '../src/viz/client-gl/renderer/views/auth-account.js';
import { attachAtomaMark, ATOMA_MARK_ENV_MIN_SCALE, ATOMA_MARK_HEADER_SCALE } from '../src/viz/client-gl/renderer/atoma-mark.js';
import { drawWelcome, welcomeLayout, WELCOME_SHOW_INSPECT } from '../src/viz/client-gl/renderer/views/welcome.js';
import {
  pinMarkElapsedMs,
  setMarkBeadVisible,
} from '../src/viz/client-gl/renderer/mark-clock.js';
import { drawRegistry } from '../src/viz/client-gl/renderer/views/registry.js';
import { TUNING_KEYS } from '../src/viz/client-gl/tuning.js';
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
  onActivate?: (id: string) => void;
}

interface RecordedEventCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shaderMode: number;
  selected: boolean;
  /** The card's content container, so a test can group its labels. */
  content: Container;
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
  tuningRows: { key: string; x: number; y: number; width: number }[];
}

/**
 * Draw with a chosen `location.search`. `tuningPanelVisible()` reads it the
 * same way `prefersReducedMotion()` reads a media query — a global the render
 * path is allowed, and one a test has to stand in for rather than route around.
 */
function withTuningPanel(body: () => void, search = '?atomaTune=1') {
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    value: { search },
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
  }
}

function textStub(value: string, options?: { size?: number }): Text {
  const lines = value.length === 0 ? 1 : Math.ceil(value.length / 80);
  const anchor = {
    x: 0,
    y: 0,
    set(x: number, y = 0) {
      this.x = x;
      this.y = y;
    },
  };
  return {
    height: lines * 16,
    // Layout that reads a label back — the event card places its actor column
    // after the title's MEASURED width — needs a width here, or it computes
    // NaN and the test proves nothing.
    width: value.length * ((options?.size ?? 12) * 0.58),
    text: value,
    anchor,
    position: { set() {} },
    style: {},
    alpha: 1,
    eventMode: 'none',
  } as unknown as Text;
}

function createRecordingCtx(): RecordingCtx {
  const ctx: RecordingCtx = {
    // No renderer here, on purpose. The crystal's refraction pass needs one and
    // must SKIP itself without one — these tests are the standing proof that the
    // mark still builds and lays out in a context that cannot render off-screen.
    pixiRenderer: undefined as unknown as RecordingCtx['pixiRenderer'],
    root: new Container(),
    markRoot: new Container(),
    texts: [],
    buttons: [],
    filterButtons: [],
    tuningRows: [],
    statCards: [],
    atomButtons: [],
    eventCards: [],
    tickers: [],
    exitCalls: 0,
    metrics: emptyRenderMetrics(),
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
      return textStub(value, options);
    },
    panel(parent, x, y, width, height) {
      const graphics = new Graphics();
      graphics.rect(x, y, Math.max(0, width), Math.max(0, height));
      parent.addChild(graphics);
      return graphics;
    },
    tuningRow(parent, key, x, y, width) {
      ctx.tuningRows.push({ key, x, y, width });
      ctx.metrics.hitTargets.push({
        id: `tuning:${key}`,
        role: 'slider',
        label: key,
        x,
        y,
        width,
        height: 22,
      });
      return { trackLocalX: x, trackWidth: width };
    },
    turnSlider(parent, x, y, width, label, liveLabel) {
      ctx.text(parent, label, x, y);
      ctx.text(parent, liveLabel, x + width - 40, y);
      ctx.metrics.hitTargets.push({
        id: 'welcome.turn',
        role: 'slider',
        label,
        x,
        y,
        width,
        height: 28,
      });
      ctx.metrics.hitTargets.push({
        id: 'welcome.turnLive',
        role: 'button',
        label: liveLabel,
        x: x + width - 40,
        y,
        width: 40,
        height: 28,
      });
    },
    markBeadCheck(parent, id, x, y, width, label) {
      ctx.text(parent, label, x, y);
      ctx.metrics.hitTargets.push({
        id,
        role: 'checkbox',
        label,
        x,
        y,
        width,
        height: 28,
      });
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
    button(parent, id, role, label, x, y, width, height, active, onActivate) {
      ctx.buttons.push({ id, label, x, y, width, height, active, onActivate });
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
      const content = new Container();
      ctx.eventCards.push({ id, x, y, width, height, shaderMode, selected, content });
      ctx.metrics.hitTargets.push({
        id,
        role: 'button',
        label: id,
        x,
        y,
        width,
        height,
      });
      parent.addChild(content);
      return content;
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

const t = (key: string, vars?: Record<string, unknown>): string =>
  translate('en', key, vars);

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
    selectedProjectId: null,
    selectedGithubInstallationId: null,
    runFilters: { kind: 'all', role: 'all', branchId: 'all' },
    branchHeadingExpanded: true,
    runSummaryExpanded: true,
    search: {
      run: '',
      registry: '',
      skills: '',
      launch: '',
      projectName: '',
      projectPrompt: '',
      projectRepository: '',
    },
    focusedInput: null,
    runPickerScrollY: 0,
    runPickerActiveIndex: 0,
    burninFamily: 'all',
    burninOutcome: 'all',
    burninPreset: 'all',
    burninPage: 1,
    scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: 0, launch: 0 },
    refreshNonce: 0,
    entered: true,
    enter: noop,
    setView: noop,
    setLocale: noop,
    selectRun: noop,
    selectEvent: noop,
    selectAtom: noop,
    selectRegistry: noop,
    selectRegistryAtom: noop,
    selectSkill: noop,
    selectProject: noop,
    selectGithubInstallation: noop,
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
    auth: null,
    runs: [],
    run: null,
    registries: [],
    registry: null,
    skillNamespaces: [],
    skillsByNamespace: {},
    skillDetail: null,
    burnin: null,
    profiles: [],
    projects: [],
    projectRuns: {},
    githubInstallations: [],
    loading: false,
    fetching: false,
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
    releaseVersion: '9.8.7',
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
  pinMarkElapsedMs(null);
  setMarkBeadVisible(true);
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

describe('drawProjects', () => {
  it('keeps GPU empty-state copy below the DOM create form', () => {
    const ctx = createRecordingCtx();
    drawProjects(ctx, makeSnapshot({ view: 'projects' }), 1280, 720);
    const title = ctx.texts.find((text) => text.value === 'Projects');
    const empty = ctx.texts.find((text) => text.value.includes('connect a GitHub App'));
    expect(title?.y).toBeLessThan(PROJECTS_DOM_FORM_TOP);
    expect((title?.y ?? 0) + 40).toBeLessThanOrEqual(PROJECTS_DOM_FORM_TOP);
    expect(empty?.y).toBe(projectsGpuContentTop());
    expect(empty?.y).toBeGreaterThanOrEqual(PROJECTS_DOM_FORM_TOP + PROJECTS_DOM_FORM_HEIGHT);
    expect(readFileSync('src/viz/client-gl/styles.css', 'utf8')).toMatch(
      new RegExp(`\\.gpu-project-form\\s*\\{[\\s\\S]*?top:\\s*${PROJECTS_DOM_FORM_TOP}px`)
    );
  });

  it('renders a project row and expands its runs when selected', () => {
    const ctx = createRecordingCtx();
    const projectId = '3c584a3c-933d-4488-ac44-4cdcc8e66f31';
    drawProjects(
      ctx,
      makeSnapshot(
        { view: 'projects', selectedProjectId: projectId },
        {
          projects: [
            {
              projectId,
              name: 'Weather Lab',
              slug: 'weather-lab',
              status: 'active',
              family: 'build',
              repositoryTarget: {
                installationId: '501',
                owner: 'atoma-org',
                name: 'weather-lab',
                visibility: 'private',
              },
              repositoryStatus: 'ready',
              repositoryFullName: 'atoma-org/weather-lab',
              repositoryUrl: 'https://github.com/atoma-org/weather-lab',
              repositoryError: null,
              createdAt: '2026-08-20T00:00:00.000Z',
              updatedAt: '2026-08-20T00:00:00.000Z',
            },
          ],
          projectRuns: {
            [projectId]: [
              {
                projectRunId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                projectId,
                goal: 'Build a weather dashboard.',
                status: 'delivered',
                traceId: 'trace-1',
                costUsd: 0.12,
                durationS: 12,
                error: null,
                createdAt: '2026-08-20T00:01:00.000Z',
                endedAt: '2026-08-20T00:02:00.000Z',
                publication: {
                  status: 'published',
                  repositoryUrl: 'https://github.com/atoma-org/weather-lab',
                  commitSha: 'a'.repeat(40),
                },
              },
              {
                projectRunId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
                projectId,
                goal: 'Broken scene.',
                status: 'failed',
                traceId: null,
                costUsd: null,
                durationS: null,
                error: '401 API key is invalid.',
                createdAt: '2026-08-20T00:03:00.000Z',
                endedAt: '2026-08-20T00:03:02.000Z',
                publication: null,
              },
            ],
          },
        }
      ),
      1280,
      720
    );
    expect(ctx.metrics.visibleLabels).toContain('Projects');
    expect(ctx.metrics.visibleLabels.some((label) => label.includes('Weather Lab'))).toBe(true);
    expect(ctx.buttons.some((button) => button.id === `project.select.${projectId}` && button.label === 'Weather Lab')).toBe(true);
    expect(ctx.buttons.some((button) => button.id === 'project.run.trace-1')).toBe(true);
    expect(
      ctx.buttons.some((button) => button.id === 'project.run.bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
    ).toBe(true);
    expect(ctx.texts.some((text) => String(text.value).includes('401 API key is invalid'))).toBe(true);
    expect(ctx.scrollMax.projects).toBeGreaterThanOrEqual(0);
    expect(ctx.scrollMax.projects).toBeLessThan(200);
  });
});

describe('GPU account control', () => {
  it('projects the account and logout action into Pixi', () => {
    const ctx = createRecordingCtx();
    const activated: string[] = [];
    const snapshot = makeSnapshot({}, {
      auth: {
        viewer: {
          displayName: 'Ada Lovelace',
          role: 'org:owner',
          activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
          organisations: [
            { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
            { id: 'org-b', name: 'Difference Engines', role: 'org:member' },
          ],
        },
        failure: false,
        signingOut: false,
        switchingOrganisationId: null,
      },
    });
    snapshot.onActivate = (id) => activated.push(id);

    drawAuthAccount(ctx, snapshot, 1280, 720);

    expect(ctx.metrics.visibleLabels).toContain('Signed in as Ada Lovelace');
    expect(ctx.metrics.visibleLabels).toContain('Organisation: Analytical Engines');
    expect(ctx.buttons.find((button) => button.id === 'org.switch.org-b')).toBeTruthy();
    const logout = ctx.buttons.find((button) => button.id === 'auth.signOut');
    expect(logout?.label).toBe('Sign out');
    logout?.onActivate?.(logout.id);
    expect(activated).toEqual(['auth.signOut']);
  });

  it('stays absent without a viewer and keeps its failure panel on-screen', () => {
    const hidden = createRecordingCtx();
    drawAuthAccount(hidden, makeSnapshot(), 360, 240);
    expect(hidden.buttons).toHaveLength(0);

    const failed = createRecordingCtx();
    drawAuthAccount(failed, makeSnapshot({}, {
      auth: {
        viewer: {
          displayName: 'Grace Hopper',
          role: 'org:member',
          activeOrganisation: null,
          organisations: [],
        },
        failure: true,
        signingOut: false,
        switchingOrganisationId: null,
      },
    }), 360, 240);
    expect(failed.metrics.visibleLabels).toContain('Account action failed');
    const layout = authAccountLayout(360, 240, true);
    expect(layout.x).toBeGreaterThanOrEqual(0);
    expect(layout.y).toBeGreaterThanOrEqual(0);
    expect(layout.x + layout.width).toBeLessThanOrEqual(360);
    expect(layout.y + layout.height).toBeLessThanOrEqual(240);
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
            projects: 0,
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
    skillNamespaces: [{ l1Name: 'ammonia-atom-id', l1Label: 'Ammonia', count: skills.length }],
    skillsByNamespace: { 'ammonia-atom-id': skills },
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
          search: {
            run: '',
            registry: '',
            skills: 'replay',
            launch: '',
            projectName: '',
            projectPrompt: '',
            projectRepository: '',
          },
        },
        {
          skillNamespaces: [{ l1Name: 'ammonia-atom-id', l1Label: 'Ammonia', count: pair.length }],
          skillsByNamespace: { 'ammonia-atom-id': pair },
        }
      ),
      WIDTH,
      800
    );
    const ids = ctx.buttons.map((button) => button.id);
    expect(ids).toContain('skill.select.ammonia-atom-id::replay-recorded-shell-probes');
    expect(ids).not.toContain('skill.select.ammonia-atom-id::recover-manifest-run');
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
          scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: 500, launch: 0 },
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
          scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: SCROLL, launch: 0 },
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
// Arrival gate
// ---------------------------------------------------------------------------

describe('drawWelcome gate', () => {
  it('centers a catalog Continue control below the viewport midpoint', () => {
    const WIDTH = 1280;
    const HEIGHT = 800;
    const ctx = createRecordingCtx();
    drawWelcome(ctx, makeSnapshot(), WIDTH, HEIGHT);
    const button = ctx.buttons.find((item) => item.id === 'welcome.continue');
    expect(button).toBeTruthy();
    expect(button!.label).toBe(I18N_CATALOGS.en['welcome.continue']);
    const layout = welcomeLayout(WIDTH, HEIGHT);
    expect(button!.x).toBe(layout.buttonX);
    expect(button!.y).toBe(layout.buttonY);
    expect(button!.y).toBeGreaterThan(HEIGHT / 2);
    expect(button!.x + button!.width / 2).toBe(WIDTH / 2);
    expect(ctx.tickers.length).toBeGreaterThan(0);
    expect(ctx.markRoot.children.length).toBe(1);
    expect(ctx.root.children.length).toBeGreaterThan(0);
    const tagline = ctx.texts.find((text) => text.value === I18N_CATALOGS.en['welcome.tagline']);
    expect(tagline).toBeTruthy();
    expect(tagline!.x).toBe(layout.copyX);
    expect(tagline!.y).toBe(layout.copyY);
    expect(layout.copyY).toBe(layout.sliderY);
    expect(layout.buttonY).toBeGreaterThan(layout.copyY + layout.copyHeight);
    expect(layout.sliderY).toBeGreaterThan(HEIGHT / 2);
    expect(WELCOME_SHOW_INSPECT).toBe(false);
    const version = ctx.texts.find((text) => text.value === 'v9.8.7');
    expect(version).toBeTruthy();
    expect(version!.x).toBe(layout.versionX);
    expect(version!.y).toBe(layout.versionY);
    expect(version!.options).toMatchObject({ size: 10, mono: true, alpha: 0.55 });
    // Inspect knobs stay implemented, but the public gate does not mount them.
    expect(ctx.metrics.hitTargets.find((target) => target.id === 'welcome.turn')).toBeUndefined();
    expect(ctx.metrics.hitTargets.find((target) => target.id === 'welcome.bead')).toBeUndefined();
  });

  it('keeps the button on-screen while the mark grows with the viewport', () => {
    const short = welcomeLayout(800, 480);
    const compact = welcomeLayout(800, 600);
    const wide = welcomeLayout(1920, 1080);
    expect(wide.scale).toBeGreaterThan(compact.scale);
    expect(compact.scale).toBeGreaterThan(short.scale);
    expect(compact.buttonY + compact.buttonHeight).toBeLessThan(600);
    expect(wide.buttonY + wide.buttonHeight).toBeLessThan(1080);
    expect(compact.copyY + compact.copyHeight).toBeLessThan(compact.buttonY);
    expect(compact.buttonY + compact.buttonHeight)
      .toBeLessThan(compact.versionY - compact.versionHeight);
    expect(
      compact.versionY - compact.versionHeight - compact.buttonY - compact.buttonHeight
    ).toBeGreaterThanOrEqual(10);
    expect(compact.versionY).toBeLessThan(600);
    expect(wide.buttonY + wide.buttonHeight)
      .toBeLessThan(wide.versionY - wide.versionHeight);
    expect(wide.versionY).toBeLessThan(1080);
    expect(short.buttonY + short.buttonHeight)
      .toBeLessThan(short.versionY - short.versionHeight);
    expect(short.versionY).toBeLessThan(480);
    expect(compact.beadY).toBe(compact.sliderY);
    expect(compact.markX + 14).toBe(400);
    expect(compact.markY + 14).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Brand mark layering
// ---------------------------------------------------------------------------

describe('attachAtomaMark glass layering', () => {
  it('paints the bead between the far walls and the near glass, clipped to the crystal', () => {
    // The defect this pins: with the bead painted LAST it sat on top of the
    // near faces at any size, and blown up to the arrival gate it read as a
    // sticker on the outside of the crystal rather than a light inside it.
    // The shell is a MESH; in the headless test environment its shader cannot
    // compile (no canvas to probe), so the shell layers sit as EMPTY
    // placeholders — the layer ORDER is the structure this test pins, and it
    // holds whether or not a real adapter dropped the meshes into them.
    const parent = new Container();
    const tickers: ((ticker: Ticker) => void)[] = [];
    const mark = attachAtomaMark(parent, (callback) => tickers.push(callback), 0, 0, 8);
    const crystal = mark.children[0] as Container;
    // The far shell and the bead now live inside 'mark-behind-glass', which the
    // refraction pass renders into its own texture. Grouping them changed the
    // DEPTH of these nodes, never their order — so the order is still what this
    // asserts, flattened so the structure may keep evolving under it.
    const flatten = (node: Container): string[] =>
      node.children.flatMap((child) => [
        child.label,
        ...(child instanceof Container ? flatten(child) : []),
      ]);
    const labels = flatten(crystal);
    const layer = (label: string) => labels.indexOf(label);

    expect(layer('mark-behind-glass')).toBeGreaterThanOrEqual(0);
    expect(layer('mark-shell-back-layer')).toBeGreaterThanOrEqual(0);
    expect(layer('mark-interior')).toBeGreaterThan(layer('mark-shell-back-layer'));
    expect(layer('mark-shell-mid-layer')).toBeGreaterThan(layer('mark-interior'));
    expect(layer('mark-shell-front-layer')).toBeGreaterThan(layer('mark-shell-mid-layer'));
    // No 'mark-edges' layer: facet outlines were removed — a stroke around
    // every triangle read as a wireframe border on the crystal.
    expect(layer('mark-edges')).toBe(-1);
    expect(layer('mark-glass-glow')).toBeGreaterThan(layer('mark-shell-front-layer'));
    // No Pixi floor disc: lantern light is written to the far-field sample
    // the aurora mesh reads. A coloured ellipse under the gem read as
    // a ground plane, which is the opposite of a wall facing the camera.
    expect(layer('mark-rear-light')).toBe(-1);

    const behind = crystal.children.find(
      (child) => child.label === 'mark-behind-glass'
    ) as Container;
    const interior = behind.children.find(
      (child) => child.label === 'mark-interior'
    ) as Container;
    // Masked, so the bead and its light pool cannot spill past the outline.
    expect(interior.mask).toBeTruthy();
    expect(interior.children.map((child) => child.label))
      .toEqual(['mark-core']);
    const glassGlow = crystal.children.find(
      (child) => child.label === 'mark-glass-glow'
    ) as Container;
    expect(glassGlow.mask).toBeTruthy();
    expect(glassGlow.children.map((child) => child.label))
      .toEqual(['mark-transmitted-light', 'mark-transmitted-core']);
  });

  it('captures scene reflections only on the hero mark, never by redrawing in-app cards', () => {
    expect(ATOMA_MARK_ENV_MIN_SCALE).toBeGreaterThan(ATOMA_MARK_HEADER_SCALE);
    const source = readFileSync(
      resolve('src/viz/client-gl/renderer/atoma-mark.ts'),
      'utf8'
    );
    expect(source).toContain('container.visible = false');
    expect(source).toContain('visualScale < ATOMA_MARK_ENV_MIN_SCALE');
    expect(source).toContain('shell.setEnv');
    expect(source).toContain('mark-cursor-echo');
    expect(source).toContain('paintCursorEcho');
    expect(source).toContain('pointerClip');
  });

  it('does not overlay a transmitted disc once the shell can draw it', () => {
    // The turn film showed a circular sticker on every pose. The front glass
    // already samples the bead out of the backdrop; an additive disc after it
    // is a second copy on the OUTSIDE of the crystal. Hidden when a mesh
    // compiled; kept for the headless fallback that has no shader.
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/viz/client-gl/renderer/atoma-mark.ts'),
      'utf8'
    );
    expect(source).toContain('if (shell) glassGlow.visible = false');
    expect(source).toContain('behind.visible = false');
    expect(source).toContain('shell?.update(frame, { beadVisible, lamp, pointerClip })');
    expect(source).toContain('pointerLampForLocal');
    expect(source).toContain('bobPx');
    const paintStart = source.indexOf('const paint = ');
    const paint = source.slice(
      paintStart,
      source.indexOf('const elapsedForPaint', paintStart)
    );
    expect(paint.indexOf('container.y')).toBeGreaterThan(-1);
    expect(paint.indexOf('container.y')).toBeLessThan(paint.indexOf('pointerLampForLocal'));
    expect(source).toContain('writeMarkFieldLight');
    expect(source).toContain('clearMarkFieldLight');
    expect(source).toContain('collectPointerFieldSpills');
    expect(source).toContain('readPointerLight');
    expect(source).toContain('markHaloMinPx');
    expect(source).not.toContain('mark-rear-light');
    // A Pixi ellipse under the gem is a floor. Lantern light lives on the
    // aurora field; this file must not paint a disc in the foreground.
    expect(source).not.toMatch(/\.ellipse\(/);
  });

  it('animates one crystal per attach and still ticks under reduced motion', () => {
    const parent = new Container();
    const moving: ((ticker: Ticker) => void)[] = [];
    attachAtomaMark(parent, (callback) => moving.push(callback), 0, 0);
    expect(moving).toHaveLength(1);

    setReducedMotionOverrideForTests(true);
    const still: ((ticker: Ticker) => void)[] = [];
    attachAtomaMark(parent, (callback) => still.push(callback), 0, 0);
    // Reduced motion freezes the turn at t=0 but must keep ticking so the
    // welcome inspect knobs (pinned pose, bead checkbox) can still drive it.
    expect(still).toHaveLength(1);
    expect(parent.children).toHaveLength(2);
  });

  it('hides the interior bead when the inspect flag is off', () => {
    const parent = new Container();
    const tickers: ((ticker: Ticker) => void)[] = [];
    attachAtomaMark(parent, (callback) => tickers.push(callback), 0, 0);
    const flatten = (node: Container): Container[] =>
      node.children.flatMap((child) =>
        child instanceof Container ? [child, ...flatten(child)] : []
      );
    const core = flatten(parent).find((child) => child.label === 'mark-core');
    expect(core).toBeTruthy();
    expect(core!.visible).toBe(true);
    setMarkBeadVisible(false);
    tickers[0]!({ deltaMS: 16 } as Ticker);
    expect(core!.visible).toBe(false);
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

  it('never lets a long event title run into the actor column', () => {
    // `registry · recordSuccess` is ~24 characters of 11px bold, ~150px wide,
    // and the actor used to be pinned at a fixed x=118 — so the molecule name
    // was drawn straight through the end of the title.
    const events: VizEvent[] = [
      ...eventsWithRoles(),
      {
        id: 'long-title',
        ts: Date.parse('2026-08-14T10:02:00.000Z'),
        kind: 'tool',
        name: 'reverify_recorded_probe_manifest',
        actor: { tier: 1, name: 'Ammonia' },
        args: { path: 'src/index.ts' },
        result: { ok: true },
      },
    ];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);

    const opts = (text: RecordedText) => (text.options ?? {}) as { weight?: string; size?: number };
    const inCards = ctx.texts.filter((text) =>
      ctx.eventCards.some((card) => card.content === text.parent));

    // Target THE card, not "whatever cards happen to exist": a loop that
    // skips cards without an actor passes whether or not the bug is present,
    // which is exactly how the first version of this test proved nothing.
    const title = inCards.find((text) => text.value.includes('reverify_recorded_probe'));
    expect(title, 'fixture must produce the long title').toBeDefined();
    const sameCard = inCards.filter((text) => text.parent === title!.parent);
    const actor = sameCard.find((text) => opts(text).size === 9 && text.y === 7);
    expect(actor, 'the card must draw an actor for this to mean anything').toBeDefined();

    // The stub measures a label at size * 0.58 per character.
    const titleEnd = title!.x + title!.value.length * 11 * 0.58;
    expect(titleEnd).toBeGreaterThan(118); // the old fixed actor column
    expect(actor!.x).toBeGreaterThanOrEqual(titleEnd);
  });

  it('truncates a long body rather than the facts after it', () => {
    // The card's second line is body + footer. Truncating the pair as one
    // string dropped the served model, tokens, cache read and cost first —
    // exactly when an event had enough reasoning to be worth reading.
    const events: VizEvent[] = [
      makeLlmEvent('verbose', {
        role: 'execute',
        reasoning: 'x'.repeat(400),
        model: 'claude-haiku-4-5-20251001',
        servedModel: 'haiku',
        costUsd: 0.0585,
        usage: { inputTokens: 32, outputTokens: 2600, cacheReadInputTokens: 177_000 },
      }),
    ];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);

    const detail = ctx.texts.find((text) =>
      ctx.eventCards.some((card) => card.content === text.parent) && text.y === 28);
    expect(detail, 'the card must draw a detail line').toBeDefined();
    expect(detail!.value).toContain('cache 177k');
    expect(detail!.value).toContain('$');
    expect(detail!.value).toContain('⇢ haiku');
  });

  it('draws the tuning panel by default — it is where it was asked for', () => {
    const events: VizEvent[] = [makeLlmEvent('a', { role: 'plan' })];
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    expect(ctx.tuningRows.length).toBeGreaterThan(0);
  });

  it('drops it entirely on ?atomaTune=0, taking its hit targets with it', () => {
    const events: VizEvent[] = [makeLlmEvent('a', { role: 'plan' })];
    const ctx = createRecordingCtx();
    withTuningPanel(() => {
      drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    }, '?atomaTune=0');
    expect(ctx.tuningRows).toHaveLength(0);
    // A hidden control that still answers the pointer is worse than no control.
    expect(ctx.metrics.hitTargets.filter((t) => t.id.startsWith('tuning:'))).toHaveLength(0);
  });

  it('draws one row per knob, and registers each as a hit target', () => {
    const events: VizEvent[] = [makeLlmEvent('a', { role: 'plan' })];
    const ctx = createRecordingCtx();
    withTuningPanel(() => {
      drawRuns(ctx, makeSnapshot({}, { run: makeRun(events) }), WIDTH, HEIGHT);
    });
    expect(ctx.tuningRows.map((row) => row.key)).toEqual([...TUNING_KEYS]);
    // Registered like every other control: a control no observer can see is a
    // control no test and no a11y bridge can reach.
    for (const key of TUNING_KEYS) {
      expect(
        ctx.metrics.hitTargets.some((target) => target.id === `tuning:${key}`),
        key
      ).toBe(true);
    }
    expect(ctx.metrics.hitTargets.some((target) => target.id === 'tuning:reset')).toBe(true);
  });

  it('reserves the panel its own space instead of drawing over the detail pane', () => {
    // An event must be SELECTED for the detail pane to exist at all — with
    // nothing selected both runs report a null bound and the comparison would
    // pass while proving nothing.
    const events: VizEvent[] = [makeLlmEvent('a', { role: 'plan' })];
    const state = { selectedEventId: 'a' };
    const plain = createRecordingCtx();
    withTuningPanel(() => {
      drawRuns(plain, makeSnapshot(state, { run: makeRun(events) }), WIDTH, HEIGHT);
    }, '?atomaTune=0');
    const tuned = createRecordingCtx();
    withTuningPanel(() => {
      drawRuns(tuned, makeSnapshot(state, { run: makeRun(events) }), WIDTH, HEIGHT);
    });
    expect(plain.detailBounds, 'the plain draw must have a detail pane').not.toBeNull();
    const topRow = Math.min(...tuned.tuningRows.map((row) => row.y));
    // Every row sits below the detail pane's new bottom, not on top of it.
    expect(tuned.detailBounds?.height ?? HEIGHT)
      .toBeLessThan(plain.detailBounds?.height ?? HEIGHT);
    expect(topRow).toBeGreaterThan(0);
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
            projects: 0,
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
