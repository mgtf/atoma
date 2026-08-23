import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Container, Graphics, Rectangle } from 'pixi.js';
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
  VizProject,
  VizRun,
} from '../src/viz/client/types.js';
import {
  GpuRenderer,
  NAV_HOVER_SCALE,
  emptyRenderMetrics,
} from '../src/viz/client-gl/gpu-renderer.js';
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
import {
  drawProjects,
  PROJECTS_COLUMN_INSET,
  PROJECTS_DOM_FORM_HEIGHT,
  PROJECTS_DOM_FORM_NARROW_HEIGHT,
  PROJECTS_DOM_FORM_TOP,
  PROJECTS_NARROW_CONTENT_WIDTH,
  PROJECTS_ROW_PAD,
  projectsColumn,
  projectsGpuContentTop,
} from '../src/viz/client-gl/renderer/views/projects.js';
import { drawSidebar, sidebarLayout, SIDEBAR_GROUPS } from '../src/viz/client-gl/renderer/views/sidebar.js';
import { viewFrame, VIEW_FRAME_PAD, VIEW_FRAME_TITLE_Y } from '../src/viz/client-gl/renderer/view-frame.js';
import {
  accountMenuLayout,
  drawAccountMenu,
} from '../src/viz/client-gl/renderer/views/account-menu.js';
import {
  drawSettings,
  MEMBER_ROW_HEIGHT,
  modelChipLabel,
  organisationPanelLayout,
  parseSettingsModelId,
  SETTINGS_DOM_FORM_HEIGHT,
  SETTINGS_DOM_FORM_TOP,
  settingsGpuContentTop,
} from '../src/viz/client-gl/renderer/views/settings.js';
import { attachAtomaMark, ATOMA_MARK_ENV_MIN_SCALE, ATOMA_MARK_HEADER_SCALE } from '../src/viz/client-gl/renderer/atoma-mark.js';
import { drawWelcome, welcomeLayout, WELCOME_SHOW_INSPECT } from '../src/viz/client-gl/renderer/views/welcome.js';
import {
  pinMarkElapsedMs,
  setMarkBeadVisible,
} from '../src/viz/client-gl/renderer/mark-clock.js';
import { drawRegistry } from '../src/viz/client-gl/renderer/views/registry.js';
import { TUNING_KEYS } from '../src/viz/client-gl/tuning.js';
import {
  drawRuns,
  RUNS_TWO_PANE_MIN_WIDTH,
} from '../src/viz/client-gl/renderer/views/runs.js';
import { drawSkills } from '../src/viz/client-gl/renderer/views/skills.js';
import { timelineConnectorGeometry } from '../src/viz/client-gl/renderer/timeline-rails.js';
import {
  DOC_THEMES,
  isRoutableView,
  visibleViews,
  type GpuUiState,
} from '../src/viz/client-gl/store.js';
import { drawDocs } from '../src/viz/client-gl/renderer/views/docs.js';
import type { AuthUiSnapshot } from '../src/viz/client-gl/AuthControls.js';
import { GPU_LAYOUT, sidebarWidthForViewport } from '../src/viz/client-gl/theme.js';
import { buildAtomaMarkFrame } from '../src/viz/client-gl/brand-mark.js';
import { drawAdmin } from '../src/viz/client-gl/renderer/views/admin.js';
import { drawJournal, JOURNAL_SEVERITIES } from '../src/viz/client-gl/renderer/views/journal.js';
import { drawLedger } from '../src/viz/client-gl/renderer/views/ledger.js';
import { drawSentinel } from '../src/viz/client-gl/renderer/views/sentinel.js';
import { PLATFORM_EVENT_FAMILIES } from '../src/contracts/platformEvents.js';

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
  node: Text;
}

interface RecordedButton {
  parent: Container;
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
  /** Panel frames, with the layer each was drawn into. */
  panels: { parent: Container; x: number; y: number; width: number; height: number }[];
  /** Account orbs the view asked the renderer to retain, in draw order. */
  retainedOrbs: {
    slot: string;
    x: number;
    y: number;
    size: number;
    photoUrl: string | null;
    seed: string;
    interactive: boolean;
  }[];
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
    panels: [],
    retainedOrbs: [],
    metrics: emptyRenderMetrics(),
    // Headless retention stub: no renderer, so no textures to retain — every
    // call attaches a fresh mark, which is what the layout assertions read.
    // The orb is a Mesh with a shader and a decoded texture: recording the
    // retain call is what a headless context can honestly observe.
    retainAvatarOrb(slot, x, y, size, photoUrl, seed, interactive) {
      ctx.retainedOrbs.push({ slot, x, y, size, photoUrl, seed, interactive });
    },
    retainAtomaMark(x, y, visualScale, options) {
      attachAtomaMark(
        ctx.markRoot,
        (callback) => ctx.tickers.push(callback),
        x,
        y,
        visualScale,
        undefined,
        options
      );
    },
    scrollMax: {},
    detailScrollY: 0,
    detailScrollMax: 0,
    detailBounds: null,
    roleRowTransition: null,
    seenAnimatedControls: new Set<string>(),
    previousFilterBounds: new Map(),
    text(parent, value, x, y, options) {
      const node = textStub(value, options);
      ctx.texts.push({ parent, value, x, y, options, node });
      ctx.metrics.visibleLabels.push(value);
      return node;
    },
    panel(parent, x, y, width, height) {
      ctx.panels.push({ parent, x, y, width, height });
      const graphics = new Graphics();
      graphics.rect(x, y, Math.max(0, width), Math.max(0, height));
      parent.addChild(graphics);
      return graphics;
    },
    recordHitTarget(parent, target) {
      const start = parent.toGlobal({ x: target.x, y: target.y });
      const end = parent.toGlobal({
        x: target.x + target.width,
        y: target.y + target.height,
      });
      const projected = {
        ...target,
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
      ctx.metrics.hitTargets.push(projected);
      return projected;
    },
    tuningRow(parent, key, x, y, width) {
      ctx.tuningRows.push({ key, x, y, width });
      ctx.recordHitTarget(parent, {
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
      ctx.recordHitTarget(parent, {
        id: 'welcome.turn',
        role: 'slider',
        label,
        x,
        y,
        width,
        height: 28,
      });
      ctx.recordHitTarget(parent, {
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
      ctx.recordHitTarget(parent, {
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
      ctx.buttons.push({ parent, id, label, x, y, width, height, active, onActivate });
      ctx.recordHitTarget(parent, { id, role, label, x, y, width, height });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    navButton(parent, id, label, x, y, width, height, active, onActivate) {
      ctx.buttons.push({ parent, id, label, x, y, width, height, active, onActivate });
      ctx.recordHitTarget(parent, { id, role: 'tab', label, x, y, width, height });
      const container = new Container();
      parent.addChild(container);
      return container;
    },
    filterButton(parent, id, label, x, y, width, height, active) {
      ctx.filterButtons.push({ parent, id, label, x, y, width, height, active });
      ctx.recordHitTarget(parent, {
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
      ctx.atomButtons.push({ parent, id, label, x, y, width, height, active });
      ctx.recordHitTarget(parent, {
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
      ctx.recordHitTarget(parent, {
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
      projectName: '',
      projectPrompt: '',
      projectRepository: '',
      displayName: '',
    },
    focusedInput: null,
    runPickerScrollY: 0,
    runPickerActiveIndex: 0,
    burninFamily: 'all',
    burninOutcome: 'all',
    burninPreset: 'all',
    burninPage: 1,
    journalSeverity: 'all',
    journalFamily: 'all',
    selectedDocsTheme: 'runs',
    scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: 0, docs: 0, admin: 0, journal: 0, ledger: 0, sentinel: 0, settings: 0 },
    entered: true,
    accountMenuOpen: false,
    enter: noop,
    toggleAccountMenu: noop,
    closeAccountMenu: noop,
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
    setJournalFilter: noop,
    selectDocsTheme: noop,
    setScrollY: noop,
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
    adminOrganisations: [],
    adminEvents: [],
    adminEventsHasMore: false,
    adminEventsLoading: false,
    adminLedger: [],
    adminSentinel: null,
    adminInvitation: null,
    adminError: null,
    organisation: null,
    accountModels: null,
    accountError: null,
    login: null,
    loading: false,
    error: null,
    ...overrides,
  };
}

/**
 * One authenticated-viewer fixture. The three account fields (`principalId`,
 * `avatarUrl`, `displayNameSource`) are what the orb and the profile panel read,
 * so they belong in the shared factory rather than in every call site.
 */
function makeAuth(
  viewer: Partial<AuthUiSnapshot['viewer']> = {},
  rest: Partial<Omit<AuthUiSnapshot, 'viewer'>> = {}
): AuthUiSnapshot {
  return {
    viewer: {
      displayName: 'Root',
      role: 'org:owner',
      activeOrganisation: { id: 'org-1', name: 'Org One', role: 'org:owner' },
      organisations: [],
      platformAdmin: false,
      principalId: 'principal-1',
      avatarUrl: null,
      displayNameSource: 'provider',
      ...viewer,
    },
    failure: false,
    signingOut: false,
    switchingOrganisationId: null,
    ...rest,
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

describe('drawWelcome as the login gate', () => {
  const WIDTH = 1280;
  const HEIGHT = 800;

  it('offers one provider button per configured provider instead of Continue', () => {
    const ctx = createRecordingCtx();
    drawWelcome(
      ctx,
      makeSnapshot(
        { entered: false },
        {
          login: {
            providers: [
              { id: 'github', label: 'GitHub' },
              { id: 'google', label: 'Google' },
            ],
            notice: null,
          },
        }
      ),
      WIDTH,
      HEIGHT
    );
    const ids = ctx.buttons.map((button) => button.id);
    expect(ids).toContain('login.provider.github');
    expect(ids).toContain('login.provider.google');
    expect(ids).not.toContain('welcome.continue');
    // The crystal and the tagline stay: the login IS the arrival gate.
    expect(ctx.markRoot.children.length).toBe(1);
    expect(ctx.texts.some((text) => text.value === I18N_CATALOGS.en['welcome.tagline'])).toBe(true);
  });

  it('renders a bounced auth notice from the catalogs, falling back to the generic line', () => {
    const known = createRecordingCtx();
    drawWelcome(
      known,
      makeSnapshot(
        { entered: false },
        { login: { providers: [{ id: 'github', label: 'GitHub' }], notice: 'providerRefused' } }
      ),
      WIDTH,
      HEIGHT
    );
    expect(
      known.texts.some((text) => text.value === I18N_CATALOGS.en['login.notice.providerRefused'])
    ).toBe(true);

    const unknown = createRecordingCtx();
    drawWelcome(
      unknown,
      makeSnapshot(
        { entered: false },
        { login: { providers: [{ id: 'github', label: 'GitHub' }], notice: 'madeUpCode' } }
      ),
      WIDTH,
      HEIGHT
    );
    expect(
      unknown.texts.some((text) => text.value === I18N_CATALOGS.en['login.notice.generic'])
    ).toBe(true);
    expect(unknown.texts.some((text) => text.value.includes('madeUpCode'))).toBe(false);
  });

  it('says so when the gate is on but no provider is configured', () => {
    const ctx = createRecordingCtx();
    drawWelcome(
      ctx,
      makeSnapshot({ entered: false }, { login: { providers: [], notice: null } }),
      WIDTH,
      HEIGHT
    );
    expect(ctx.buttons.map((button) => button.id)).not.toContain('welcome.continue');
    expect(
      ctx.texts.some((text) => text.value === I18N_CATALOGS.en['login.noProviders'])
    ).toBe(true);
  });
});

describe('drawDocs', () => {
  it('renders every theme as a selectable button, active theme first', () => {
    const ctx = createRecordingCtx();
    drawDocs(ctx, makeSnapshot({ view: 'docs' }), 1000, 700);
    for (const theme of DOC_THEMES) {
      const button = ctx.buttons.find((candidate) => candidate.id === `docs.theme.${theme.key}`);
      expect(button).toBeDefined();
      expect(button!.active).toBe(theme.key === 'runs');
    }
    expect(ctx.texts.some((text) => text.value === I18N_CATALOGS.en['docs.theme.runs.title'])).toBe(
      true
    );
    expect(ctx.texts.some((text) => text.value === I18N_CATALOGS.en['docs.theme.runs.body'])).toBe(
      true
    );
    expect(
      ctx.texts.some((text) => text.value === `${I18N_CATALOGS.en['docs.refLabel']} src/run/AGENTS.md`)
    ).toBe(true);
  });

  it('switches the right-hand content to whichever theme is selected', () => {
    const ctx = createRecordingCtx();
    drawDocs(ctx, makeSnapshot({ view: 'docs', selectedDocsTheme: 'mcp' }), 1000, 700);
    const mcpButton = ctx.buttons.find((candidate) => candidate.id === 'docs.theme.mcp');
    expect(mcpButton!.active).toBe(true);
    const runsButton = ctx.buttons.find((candidate) => candidate.id === 'docs.theme.runs');
    expect(runsButton!.active).toBe(false);
    expect(ctx.texts.some((text) => text.value === I18N_CATALOGS.en['docs.theme.mcp.title'])).toBe(
      true
    );
    expect(
      ctx.texts.some((text) => text.value === `${I18N_CATALOGS.en['docs.refLabel']} src/mcp/AGENTS.md`)
    ).toBe(true);
  });

  it('reports a scroll max instead of leaving the pane unbounded', () => {
    const ctx = createRecordingCtx();
    drawDocs(ctx, makeSnapshot({ view: 'docs' }), 1000, 700);
    expect(ctx.scrollMax.docs).toBeGreaterThanOrEqual(0);
  });
});

describe('the nav rail', () => {
  const viewer = {
    displayName: 'A',
    role: 'org:member',
    activeOrganisation: null,
    organisations: [],
    platformAdmin: false,
  };
  const base = { failure: false, signingOut: false, switchingOrganisationId: null };

  it('groups every view visibleViews can offer', () => {
    // A view that reaches the nav without a group here would simply not be
    // drawn — the rail would swallow a whole surface silently. Hold the two
    // lists to each other instead of trusting a reader to notice.
    const grouped = new Set(SIDEBAR_GROUPS.flatMap((group) => group.views));
    const offered = new Set([
      ...visibleViews(null),
      ...visibleViews({ ...base, viewer }),
      ...visibleViews({ ...base, viewer: { ...viewer, platformAdmin: true } }),
    ]);
    for (const view of offered) expect(grouped, `ungrouped view: ${view}`).toContain(view);
    // And nothing is grouped that the nav never offers.
    for (const view of grouped) expect(offered, `grouped but never shown: ${view}`).toContain(view);
  });

  it('drops an empty group whole rather than leaving a bare heading', () => {
    // A gated member gets the workspace group only.
    const rows = sidebarLayout(visibleViews({ ...base, viewer }));
    const groups = rows.filter((row) => row.kind === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ group: 'workspace' });
    expect(rows.filter((row) => row.kind === 'item').map((row) => row.view)).toEqual([
      'projects', 'runs', 'docs',
    ]);
  });

  it('stacks rows in order, and clears its own hover scale', () => {
    const rows = sidebarLayout(visibleViews(null));
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1]!;
      const row = rows[index]!;
      expect(row.y).toBeGreaterThanOrEqual(previous.y + previous.height);
      // navButton grows by its production hover scale, centred: half the overflow must
      // still fit in the gap or a hovered row would climb over its neighbour.
      if (previous.kind !== 'item' || row.kind !== 'item') continue;
      const overflow = (previous.height * NAV_HOVER_SCALE - previous.height) / 2;
      expect(row.y - (previous.y + previous.height)).toBeGreaterThan(overflow);
    }
  });

  it('draws one nav button per view, marking the current one', () => {
    const ctx = createRecordingCtx();
    drawSidebar(ctx, makeSnapshot({ view: 'skills' }), 720);
    const nav = ctx.buttons.filter((button) => button.id.startsWith('nav.'));
    expect(nav.map((button) => button.id)).toEqual([
      'nav.projects', 'nav.runs', 'nav.docs', 'nav.registry', 'nav.skills', 'nav.burnin',
    ]);
    expect(nav.filter((button) => button.active).map((button) => button.id)).toEqual([
      'nav.skills',
    ]);
    // Every row sits inside the rail, and the headings are drawn as copy.
    for (const button of nav) {
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(GPU_LAYOUT.sidebarWidth);
    }
    expect(ctx.texts.map((text) => text.value)).toContain('WORKSPACE');
    expect(ctx.texts.map((text) => text.value)).toContain('OPERATE');
  });

  it('has no Settings row: the account menu owns that entrance', () => {
    const ctx = createRecordingCtx();
    drawSidebar(ctx, makeSnapshot({ view: 'projects' }), 720);
    expect(ctx.buttons.some((button) => button.id === 'nav.settings')).toBe(false);
  });

  it('keeps every admin destination inside a short landscape rail', () => {
    const height = 300;
    const views = visibleViews({ ...base, viewer: { ...viewer, platformAdmin: true } });
    const rows = sidebarLayout(views, height);
    expect(new Set(rows.filter((row) => row.kind === 'item').map((row) => row.view)))
      .toEqual(new Set(views));
    expect(Math.max(...rows.map((row) => row.y + row.height))).toBeLessThanOrEqual(height);
  });

  it('shrinks the rail before it can push the content floor off-screen', () => {
    expect(sidebarWidthForViewport(1280)).toBe(GPU_LAYOUT.sidebarWidth);
    expect(sidebarWidthForViewport(528)).toBe(GPU_LAYOUT.sidebarWidth);
    expect(sidebarWidthForViewport(500)).toBe(180);
    expect(sidebarWidthForViewport(432)).toBe(GPU_LAYOUT.sidebarMinWidth);
    expect(sidebarWidthForViewport(320)).toBe(GPU_LAYOUT.sidebarMinWidth);
  });

  it('keeps the CSS content offset equal to the rail it must clear', () => {
    // The DOM overlays that sit over a VIEW are positioned in the content
    // viewport. Two numbers, one truth: drift here puts an input under the
    // rail with nothing failing.
    const css = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    expect(css).toMatch(new RegExp(
      `--gpu-sidebar:\\s*min\\(100vw, clamp\\(${GPU_LAYOUT.sidebarMinWidth}px,` +
      `[\\s\\S]*?100vw - ${GPU_LAYOUT.contentMinWidth}px[\\s\\S]*?${GPU_LAYOUT.sidebarWidth}px`
    ));
    for (const selector of ['gpu-project-form', 'gpu-view-search', 'gpu-settings-form']) {
      expect(css).toMatch(
        new RegExp(`\\.${selector}\\s*\\{[\\s\\S]*?var\\(--gpu-sidebar\\)`)
      );
    }
  });

  it('projects nested hit targets through the rail, pane and scroll transforms', () => {
    const renderer = new GpuRenderer();
    const stage = new Container();
    const viewport = new Container();
    const pane = new Container();
    const content = new Container();
    viewport.position.set(GPU_LAYOUT.sidebarWidth, 0);
    pane.position.set(150, 108);
    content.position.set(0, -40);
    stage.addChild(viewport);
    viewport.addChild(pane);
    pane.addChild(content);

    const local = {
      id: 'nested.target',
      role: 'button',
      label: 'Nested target',
      x: 16,
      y: 12,
      width: 90,
      height: 28,
    };
    const expectedStart = content.toGlobal({ x: local.x, y: local.y });
    const expectedEnd = content.toGlobal({
      x: local.x + local.width,
      y: local.y + local.height,
    });

    renderer.recordHitTarget(content, local);
    expect(renderer.metrics.hitTargets).toEqual([{
      ...local,
      x: expectedStart.x,
      y: expectedStart.y,
      width: expectedEnd.x - expectedStart.x,
      height: expectedEnd.y - expectedStart.y,
    }]);
  });

  it('projects each non-container viewport escape exactly once', () => {
    const renderer = new GpuRenderer();
    // Headless test: retained paint tickers are irrelevant to coordinate
    // ownership, and Application has no live ticker before init().
    renderer.addTicker = () => {};
    const internals = renderer as unknown as {
      translateViewBounds(offsetX: number): void;
      drawRemovedFilterEffects(): void;
      avatarOrbs: Map<string, {
        key: string;
        handle: {
          container: Container;
          resume(parent: Container, addTicker: (callback: (ticker: Ticker) => void) => void): void;
          setHover(on: boolean): void;
          destroy(): void;
        };
      }>;
    };

    // Wheel routing reads a plain Rectangle, so it receives the rail once.
    renderer.detailBounds = new Rectangle(40, 70, 300, 200);
    internals.translateViewBounds(GPU_LAYOUT.sidebarWidth);
    expect(renderer.detailBounds).toEqual(
      new Rectangle(40 + GPU_LAYOUT.sidebarWidth, 70, 300, 200)
    );

    // Settings asks from view-local space, while the retained orb is attached
    // to markRoot. The renderer resolves that point through the live viewport.
    const viewport = new Container();
    viewport.x = GPU_LAYOUT.sidebarWidth;
    renderer.root = viewport;
    const expectedOrbKey = [GPU_LAYOUT.sidebarWidth + 16, 104, 34, '', 'principal', '0'].join('|');
    let orbResumed = false;
    internals.avatarOrbs.set('settings', {
      key: expectedOrbKey,
      handle: {
        container: new Container(),
        resume: () => { orbResumed = true; },
        setHover: () => {},
        destroy: () => {},
      },
    });
    renderer.retainAvatarOrb('settings', 16, 104, 34, null, 'principal', false);
    const orb = internals.avatarOrbs.get('settings');
    expect(orb?.key).toBe(expectedOrbKey);
    expect(orbResumed).toBe(true);

    // Exit particles outlive the view and draw on stage. They must use the
    // captured renderer projection, never the stale local chip rectangle.
    renderer.root = new Container();
    renderer.previousFilterBounds.set('filter.gone', {
      id: 'filter.gone',
      role: 'button',
      label: 'Gone',
      x: 12,
      y: 20,
      width: 80,
      height: 28,
      active: false,
      accent: 0x6ea8ff,
      rendererX: 220,
      rendererY: 90,
      rendererWidth: 80,
      rendererHeight: 28,
    });
    setReducedMotionOverrideForTests(false);
    internals.drawRemovedFilterEffects();
    const particles = renderer.root.children[0] as Container;
    const firstParticle = particles.children[0]!;
    expect(firstParticle.position.x).toBe(260);
    expect(firstParticle.position.y).toBe(104);
  });
});

describe('visibleViews', () => {
  it('is one nav definition: dev path, gated member, platform admin', () => {
    const viewer = {
      displayName: 'A',
      role: 'org:member',
      activeOrganisation: null,
      organisations: [],
      platformAdmin: false,
    };
    const base = { failure: false, signingOut: false, switchingOrganisationId: null };
    // Gate off: classic operator surfaces, no admin plane.
    expect(visibleViews(null)).toEqual([
      'projects', 'runs', 'registry', 'skills', 'burnin', 'docs',
    ]);
    // No `launch` tab anywhere: describing how to phrase a goal is not a view
    // of its own, it is part of the form that starts the run.
    expect(visibleViews(null)).not.toContain('launch');
    // Gated member: no instance-global operator surfaces — the server 403s
    // them, so the tabs must not exist to poison the global data error.
    // Docs stays: it is static prose, not a fetch of gated data.
    expect(visibleViews({ ...base, viewer })).toEqual(['projects', 'runs', 'docs']);
    // The admin plane is FOUR destinations, one per job, not one tab holding
    // organisations, the journal, the ledger and the sentinel at once.
    expect(
      visibleViews({ ...base, viewer: { ...viewer, platformAdmin: true } })
    ).toEqual([
      'projects', 'runs', 'registry', 'skills', 'burnin', 'docs',
      'admin', 'journal', 'ledger', 'sentinel',
    ]);
  });

  it('routes Settings without giving it a tab', () => {
    const auth = makeAuth();
    // A tab-less view must still be routable, or the "unknown view" guard in
    // GpuApp bounces it back to Projects on the render right after it opened.
    expect(visibleViews(auth)).not.toContain('settings');
    expect(isRoutableView('settings', auth)).toBe(true);
    // ...and only where an account exists at all.
    expect(isRoutableView('settings', null)).toBe(false);
    expect(isRoutableView('admin', auth)).toBe(false);
    expect(isRoutableView('runs', null)).toBe(true);
  });
});

describe('drawAdmin', () => {
  const auth = makeAuth({ platformAdmin: true });
  const organisations = [
    {
      orgId: 'org-1',
      name: 'Org One',
      createdAt: '2026-08-20T00:00:00.000Z',
      members: [
        { principalId: 'p-1', displayName: 'Root', role: 'org:owner' },
        { principalId: 'p-2', displayName: 'Worker', role: 'org:member' },
      ],
    },
    {
      orgId: 'org-2',
      name: 'Org Two',
      createdAt: '2026-08-20T01:00:00.000Z',
      members: [{ principalId: 'p-3', displayName: 'Other', role: 'org:owner' }],
    },
  ];

  it('lists every organisation with members and mints per-org owner/user invitations', () => {
    const ctx = createRecordingCtx();
    drawAdmin(ctx, makeSnapshot({ view: 'admin' }, { auth, adminOrganisations: organisations }), 1280, 720);
    for (const name of ['Org One', 'Org Two', 'Root', 'Worker', 'Other']) {
      expect(ctx.texts.some((text) => text.value === name)).toBe(true);
    }
    const buttonIds = ctx.buttons.map((button) => button.id);
    expect(buttonIds).toContain('admin.invite.org:member.org-1');
    expect(buttonIds).toContain('admin.invite.org:owner.org-1');
    expect(buttonIds).toContain('admin.invite.org:member.org-2');
    expect(buttonIds).toContain('admin.invite.org:owner.org-2');
    expect(ctx.scrollMax.admin).not.toBeUndefined();
    const organisationPanel = ctx.panels.find((panel) => panel.parent !== ctx.root);
    expect(organisationPanel).toBeTruthy();
    expect(
      organisationPanel!.parent.toGlobal({
        x: organisationPanel!.x,
        y: organisationPanel!.y,
      }).x
    ).toBe(viewFrame(1280, 720).innerX);
  });

  it('stacks invitation controls and identity copy inside a narrow admin frame', () => {
    const width = 248;
    const ctx = createRecordingCtx();
    drawAdmin(
      ctx,
      makeSnapshot({ view: 'admin' }, { auth, adminOrganisations: [organisations[0]!] }),
      width,
      720
    );
    const frame = viewFrame(width, 720);
    const invites = ctx.buttons.filter((button) => button.id.startsWith('admin.invite.'));
    expect(invites).toHaveLength(2);
    for (const button of invites) {
      const origin = button.parent.toGlobal({ x: button.x, y: button.y });
      expect(origin.x).toBeGreaterThanOrEqual(frame.innerX);
      expect(origin.x + button.width).toBeLessThanOrEqual(frame.innerX + frame.innerWidth);
    }
    expect(invites[1]!.y).toBeGreaterThan(invites[0]!.y + invites[0]!.height);
    const orgId = ctx.texts.find((text) => text.value === 'org-1');
    expect(orgId).toBeTruthy();
    expect(orgId!.parent.toGlobal({ x: orgId!.x, y: orgId!.y }).x)
      .toBeGreaterThanOrEqual(frame.innerX);
    const firstMember = ctx.texts.find((text) => text.value === 'Root');
    expect(firstMember!.y).toBeGreaterThan(orgId!.y + 10);
  });

  it('shows a minted invitation once, URL visible for manual transcription', () => {
    const ctx = createRecordingCtx();
    const invitation = {
      token: 'tok',
      url: 'https://viz.example/?invite=tok',
      orgId: 'org-2',
      orgName: 'Org Two',
      role: 'org:member',
      expiresAt: '2026-08-21T00:00:00.000Z',
    };
    drawAdmin(
      ctx,
      makeSnapshot(
        { view: 'admin' },
        { auth, adminOrganisations: organisations, adminInvitation: invitation }
      ),
      1280,
      720
    );
    expect(ctx.texts.some((text) => text.value === invitation.url)).toBe(true);
    expect(ctx.texts.some((text) => text.value.includes('Org Two'))).toBe(true);
  });

  it('measures a wrapped bearer URL before sizing the narrow invitation panel', () => {
    const ctx = createRecordingCtx();
    const url = `https://viz.example/?invite=${'token'.repeat(60)}`;
    drawAdmin(
      ctx,
      makeSnapshot(
        { view: 'admin' },
        {
          auth,
          adminOrganisations: [],
          adminInvitation: {
            token: 'tok',
            url,
            orgId: 'org-2',
            orgName: 'Org Two',
            role: 'org:member',
            expiresAt: '2026-08-21T00:00:00.000Z',
          },
        }
      ),
      248,
      720
    );
    const invitePanel = ctx.panels.find((panel) => panel.parent !== ctx.root)!;
    expect(invitePanel.height).toBeGreaterThan(84);
    const copied = ctx.texts.find((text) => text.value.includes('copied to your clipboard'))!;
    const panelTop = invitePanel.parent.toGlobal({ x: 0, y: invitePanel.y }).y;
    const copiedTop = copied.parent.toGlobal({ x: copied.x, y: copied.y }).y;
    expect(copiedTop + copied.node.height).toBeLessThanOrEqual(panelTop + invitePanel.height);
  });
});

/**
 * The admin plane is FOUR views, not one tab with four sections. What these
 * hold: each screen answers its own question and owns its own scroll max; the
 * journal pages and filters SERVER-SIDE; and the sentinel screen offers no
 * control over a run, because a finding flags and never judges.
 */
function journalEvent(
  seq: number,
  overrides: Partial<import('../src/viz/client/types.js').VizPlatformEvent> = {}
): import('../src/viz/client/types.js').VizPlatformEvent {
  return {
    seq,
    at: '2026-08-21T10:30:00.000Z',
    kind: 'publication.failed',
    severity: 'error',
    actorType: 'principal',
    actorId: 'p-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    runId: 'run-1',
    summary: 'Publication failed: repository unreachable',
    ...overrides,
  };
}

describe('drawJournal', () => {
  const auth = makeAuth({ platformAdmin: true });

  it('lists events newest-first with its own scroll max', () => {
    const ctx = createRecordingCtx();
    drawJournal(
      ctx,
      makeSnapshot(
        { view: 'journal' },
        {
          auth,
          adminEvents: [
            journalEvent(9),
            journalEvent(8, {
              at: '2026-08-21T10:00:00.000Z',
              kind: 'org.created',
              severity: 'info',
              summary: 'New organisation "Org Two" founded by its first login',
            }),
          ],
        }
      ),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values).toContain('publication.failed');
    expect(values).toContain('org.created');
    const failed = ctx.texts.find((text) => text.value === 'publication.failed')!;
    const created = ctx.texts.find((text) => text.value === 'org.created')!;
    expect(failed.y).toBeLessThan(created.y);
    // An absolute stamp: this list spans more than the last few minutes.
    expect(values).toContain('2026-08-21 10:30:00');
    expect(ctx.scrollMax.journal).not.toBeUndefined();
  });

  it('renders a kind and severity this bundle does not know, rather than hiding the row', () => {
    // The server's vocabulary can be newer than the client's. Blinding the
    // audit surface is a worse failure than an unfamiliar label.
    const ctx = createRecordingCtx();
    drawJournal(
      ctx,
      makeSnapshot(
        { view: 'journal' },
        {
          auth,
          adminEvents: [
            journalEvent(1, {
              at: 'not-an-instant',
              kind: 'quota.exceeded',
              severity: 'critical',
              actorType: 'system',
              summary: 'from a newer build',
            }),
          ],
        }
      ),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values).toContain('quota.exceeded');
    expect(values).toContain('from a newer build');
    expect(values.some((value) => value.includes('Invalid'))).toBe(false);
    expect(values).toContain('not-an-instant');
  });

  it('offers every severity and every kind family as a filter chip', () => {
    // Derived vocabularies, both of them: a chip list written by hand would be
    // a second definition to keep in step with the contract.
    const ctx = createRecordingCtx();
    drawJournal(
      ctx,
      makeSnapshot({ view: 'journal', journalSeverity: 'security' }, { auth }),
      1280,
      720
    );
    const ids = ctx.filterButtons.map((button) => button.id);
    for (const severity of JOURNAL_SEVERITIES) {
      expect(ids).toContain(`journal.severity.${severity}`);
    }
    for (const family of PLATFORM_EVENT_FAMILIES) {
      expect(ids).toContain(`journal.family.${family}`);
    }
    const active = ctx.filterButtons.filter((button) => button.active);
    expect(active.map((button) => button.id)).toContain('journal.severity.security');
  });

  it('offers the next page only while the server says there is one', () => {
    const withMore = createRecordingCtx();
    drawJournal(
      withMore,
      makeSnapshot(
        { view: 'journal' },
        { auth, adminEvents: [journalEvent(1)], adminEventsHasMore: true }
      ),
      1280,
      720
    );
    expect(withMore.buttons.map((button) => button.id)).toContain('journal.more');

    const atEnd = createRecordingCtx();
    drawJournal(
      atEnd,
      makeSnapshot(
        { view: 'journal' },
        { auth, adminEvents: [journalEvent(1)], adminEventsHasMore: false }
      ),
      1280,
      720
    );
    expect(atEnd.buttons.map((button) => button.id)).not.toContain('journal.more');
    expect(atEnd.texts.some((text) => text.value.includes('whole journal'))).toBe(true);

    // A page in flight says so instead of offering the same page again.
    const loading = createRecordingCtx();
    drawJournal(
      loading,
      makeSnapshot(
        { view: 'journal' },
        {
          auth,
          adminEvents: [journalEvent(1)],
          adminEventsHasMore: true,
          adminEventsLoading: true,
        }
      ),
      1280,
      720
    );
    expect(loading.buttons.map((button) => button.id)).not.toContain('journal.more');
  });

  it('says a filter found nothing rather than "nothing recorded yet"', () => {
    // Two different facts. An empty journal and an empty filter would read
    // the same way, and one of them is a filter the viewer can undo.
    const filtered = createRecordingCtx();
    drawJournal(
      filtered,
      makeSnapshot({ view: 'journal', journalFamily: 'webhook' }, { auth }),
      1280,
      720
    );
    expect(filtered.texts.some((text) => text.value.includes('matches this filter'))).toBe(true);

    const empty = createRecordingCtx();
    drawJournal(empty, makeSnapshot({ view: 'journal' }, { auth }), 1280, 720);
    expect(empty.texts.some((text) => text.value.includes('Nothing recorded yet'))).toBe(true);
  });
});

describe('drawLedger', () => {
  const auth = makeAuth({ platformAdmin: true });

  it('is its own screen, and says what it is not', () => {
    const ctx = createRecordingCtx();
    drawLedger(
      ctx,
      makeSnapshot(
        { view: 'ledger' },
        {
          auth,
          adminLedger: [
            { at: '2026-08-21T09:00:00.000Z', kind: 'promote', entity: 'Water/web-build-loop' },
          ],
        }
      ),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values).toContain('Water/web-build-loop');
    expect(values).toContain('promote');
    expect(values.some((value) => value.includes('separate record'))).toBe(true);
    expect(ctx.scrollMax.ledger).not.toBeUndefined();
  });

  it('says the catalogue has learned nothing yet', () => {
    const ctx = createRecordingCtx();
    drawLedger(ctx, makeSnapshot({ view: 'ledger' }, { auth }), 1280, 720);
    expect(ctx.texts.some((text) => text.value.includes('learned nothing'))).toBe(true);
  });
});

describe('drawSentinel', () => {
  const auth = makeAuth({ platformAdmin: true });
  const armedWatch = {
    armed: true,
    reason: 'armed',
    source: 'viz-server',
    intervalMs: 20_000,
    startedAt: '2026-08-23T08:00:00.000Z',
    armedSince: '2026-08-23T08:00:00.000Z',
    lastTickAt: '2026-08-23T08:00:20.000Z',
    lastTickMs: 4,
    ticks: 3,
    runsScreenedLastTick: 2,
    skippedLastTick: 1,
    emittedSinceBoot: 1,
    consecutiveFailures: 0,
    lastError: null,
    incumbent: null,
  };

  const snapshotPayload = {
    watch: armedWatch,
    rules: [
      { id: 'cost-alert', kind: 'run.anomaly' },
      { id: 'injection-signature', kind: 'security.flagged' },
    ],
    live: [
      {
        runId: 'run-op-1',
        corpus: 'operator' as const,
        orgId: null,
        projectId: null,
        label: 'build-app: a stopwatch',
      },
      {
        runId: 'run-proj-1',
        corpus: 'project' as const,
        orgId: 'org-1',
        projectId: 'proj-1',
        label: 'weather-lab',
      },
    ],
    skipped: [{ runId: 'run-proj-2', reason: 'trace not persisted yet' }],
    findings: [
      journalEvent(12, {
        kind: 'run.anomaly',
        severity: 'warning',
        actorType: 'system',
        actorId: null,
        runId: 'run-op-1',
        summary: 'validate_html failed 3x with the same error',
        detail: { ruleId: 'recurring-tool-error', corpus: 'operator', dedupeKey: 'x' },
      }),
    ],
  };

  it('shows both corpora in flight, the rule table, and the findings', () => {
    const ctx = createRecordingCtx();
    drawSentinel(
      ctx,
      makeSnapshot({ view: 'sentinel' }, { auth, adminSentinel: snapshotPayload }),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    // Both corpora: an operator run and a tenant run, on one screen.
    expect(values).toContain('OPERATOR');
    expect(values).toContain('PROJECT');
    expect(values).toContain('run-op-1');
    expect(values).toContain('run-proj-1');
    // The rule table, with its prose from the catalog.
    expect(values).toContain('cost-alert');
    expect(values.some((value) => value.includes('not a budget'))).toBe(true);
    // A finding, with the rule that produced it on its extra line.
    expect(values.some((value) => value.includes('recurring-tool-error'))).toBe(true);
    // A candidate seen and skipped is reported, never silently dropped.
    expect(values.some((value) => value.includes('trace not persisted yet'))).toBe(true);
    expect(ctx.scrollMax.sentinel).not.toBeUndefined();
  });

  it('claims only what this process can back, and offers no power over a run', () => {
    // The server hosts the watch now, so it may report ITS OWN timer — which
    // is exactly why the scope sentence is mandatory in every state: a watch on
    // another machine or another store is still invisible here. And the
    // sentinel's only possible power is an unsettled design decision, so no
    // control may exercise it: every button is a navigation to a run.
    const ctx = createRecordingCtx();
    drawSentinel(
      ctx,
      makeSnapshot({ view: 'sentinel' }, { auth, adminSentinel: snapshotPayload }),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values.some((value) => value.includes('Watching, one pass every 20s'))).toBe(true);
    expect(values.some((value) => value.includes('3 pass(es)'))).toBe(true);
    // The scope, and no aggregate claim anywhere.
    expect(values.some((value) => value.includes('and only its own'))).toBe(true);
    expect(values.some((value) => value.includes('invisible here'))).toBe(true);
    expect(values.some((value) => value.includes('never a judgment'))).toBe(true);
    for (const button of ctx.buttons) {
      expect(button.id.startsWith('sentinel.run.')).toBe(true);
    }
  });

  it('reports a yielded watch as a fact about the other one, not as a failure', () => {
    // One appending watch per store. A server that yielded to an operator's
    // `npm run sentinel` is not broken, and the screen must name the incumbent
    // rather than render a red light — the reader concludes, the screen
    // reports.
    const ctx = createRecordingCtx();
    drawSentinel(
      ctx,
      makeSnapshot(
        { view: 'sentinel' },
        {
          auth,
          adminSentinel: {
            ...snapshotPayload,
            watch: {
              ...armedWatch,
              armed: false,
              reason: 'lease-held',
              armedSince: null,
              incumbent: {
                source: 'cli',
                ownerPid: 4242,
                label: 'npm run sentinel',
                intervalMs: 20_000,
                startedAt: '2026-08-23T07:55:00.000Z',
                heartbeatAt: '2026-08-23T08:00:10.000Z',
              },
            },
          },
        }
      ),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values.some((value) => value.includes('cli pid 4242'))).toBe(true);
    expect(values.some((value) => value.includes('this server yielded'))).toBe(true);
    // Still no aggregate, and still no control.
    expect(values.some((value) => value.includes('invisible here'))).toBe(true);
    for (const button of ctx.buttons) {
      expect(button.id.startsWith('sentinel.run.')).toBe(true);
    }
  });

  it('says a pass ran long, because that pass shares the HTTP loop', () => {
    const ctx = createRecordingCtx();
    drawSentinel(
      ctx,
      makeSnapshot(
        { view: 'sentinel' },
        {
          auth,
          adminSentinel: { ...snapshotPayload, watch: { ...armedWatch, lastTickMs: 900 } },
        }
      ),
      1280,
      720
    );
    expect(
      ctx.texts.some((text) => text.value.includes('runs on the HTTP loop'))
    ).toBe(true);
  });

  it('says nothing is in flight and nothing has been flagged, without an error', () => {
    const ctx = createRecordingCtx();
    drawSentinel(
      ctx,
      makeSnapshot(
        { view: 'sentinel' },
        {
          auth,
          adminSentinel: { watch: armedWatch, rules: [], live: [], skipped: [], findings: [] },
        }
      ),
      1280,
      720
    );
    const values = ctx.texts.map((text) => text.value);
    expect(values.some((value) => value.includes('No run in flight'))).toBe(true);
    expect(values.some((value) => value.includes('No finding recorded'))).toBe(true);
  });

  it('survives a payload that never arrived', () => {
    const ctx = createRecordingCtx();
    drawSentinel(ctx, makeSnapshot({ view: 'sentinel' }, { auth }), 1280, 720);
    expect(ctx.scrollMax.sentinel).not.toBeUndefined();
  });
});

describe('drawProjects', () => {
  it('tells an ungated viewer the gate is off instead of coaching a 404 connect flow', () => {
    const ctx = createRecordingCtx();
    // Default snapshot: `auth` is null, which in-app means the server runs
    // ungated — project routes do not exist there.
    drawProjects(ctx, makeSnapshot({ view: 'projects' }), 1280, 720);
    expect(ctx.texts.some((text) => text.value.includes('ATOMA_VIZ_AUTH=1'))).toBe(true);
    expect(ctx.texts.some((text) => text.value.includes('connect a GitHub App'))).toBe(false);
  });

  it('reserves the form band only when a form is actually rendered', () => {
    // DomBridge gates the project form on a session, so an ungated instance
    // renders none. Reserving its band anyway left a hole between the title
    // and the copy explaining why there is nothing to show.
    const ungated = createRecordingCtx();
    drawProjects(ungated, makeSnapshot({ view: 'projects' }), 1280, 720);
    const frame = viewFrame(1280, 720);
    const hint = ungated.texts.find((text) => text.value.includes('ATOMA_VIZ_AUTH=1'));
    expect(hint?.y).toBe(frame.contentTop);

    // Gated, the band is reserved: the DOM form occupies it.
    const gated = createRecordingCtx();
    drawProjects(
      gated,
      makeSnapshot({ view: 'projects' }, { auth: makeAuth({ displayName: 'Alice' }) }),
      1280,
      720
    );
    const gatedHint = gated.texts.find((text) => text.value.includes('connect a GitHub App'));
    expect(gatedHint?.y).toBe(projectsGpuContentTop('create', 1280));
    expect(gatedHint?.y).toBeGreaterThan(frame.contentTop);
  });

  it('keeps GPU empty-state copy below the DOM create form', () => {
    const ctx = createRecordingCtx();
    const auth = makeAuth({
      displayName: 'Alice',
      activeOrganisation: { id: 'org-1', name: 'Org', role: 'org:owner' },
    });
    drawProjects(ctx, makeSnapshot({ view: 'projects' }, { auth }), 1280, 720);
    const title = ctx.texts.find((text) => text.value === 'Projects');
    const empty = ctx.texts.find((text) => text.value.includes('connect a GitHub App'));
    // The title sits inside the column frame; the form is the first content
    // below it, and has to clear the title's line box.
    expect(title?.y).toBeLessThan(PROJECTS_DOM_FORM_TOP);
    expect(PROJECTS_DOM_FORM_TOP - (title?.y ?? 0)).toBeGreaterThanOrEqual(24);
    // No project is selected here, so the form is the CREATE form.
    expect(empty?.y).toBe(projectsGpuContentTop('create'));
    expect(empty?.y).toBeGreaterThanOrEqual(
      PROJECTS_DOM_FORM_TOP + PROJECTS_DOM_FORM_HEIGHT.create
    );
    expect(readFileSync('src/viz/client-gl/styles.css', 'utf8')).toMatch(
      new RegExp(`\\.gpu-project-form\\s*\\{[\\s\\S]*?top:\\s*${PROJECTS_DOM_FORM_TOP}px`)
    );
  });

  it('gives the DOM form and the GL project list ONE shared column', () => {
    // Two cards, one stack. The column is FULL-BLEED like the other tabs: no
    // width cap, so both edges come from the content viewport alone. The GL
    // panel draws inside the frame while the form is `position: fixed`, so the
    // form has to land on the same two edges by computation.
    // `projectsColumn` reports the frame's INNER column — where the form and
    // the list both draw, inside the frame's own padding.
    const wide = viewFrame(1072, 800);
    expect(projectsColumn(1072)).toEqual({ x: wide.innerX, width: wide.innerWidth });
    expect(wide.width).toBe(1072 - PROJECTS_COLUMN_INSET);
    // Narrow: the frame gives up width, never its gap.
    const narrow = viewFrame(600, 800);
    expect(narrow.width).toBe(600 - PROJECTS_COLUMN_INSET);
    expect(projectsColumn(600)).toEqual({ x: narrow.innerX, width: narrow.innerWidth });

    const css = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    const form = css.slice(
      css.indexOf('.gpu-project-form {'),
      css.indexOf('.gpu-project-form--run')
    );
    // No cap: the frame is exactly the content viewport minus its inset, so
    // the CSS restatement cannot reintroduce a second width by drift.
    expect(form).toContain(
      `--gpu-frame: calc(var(--gpu-content) - ${PROJECTS_COLUMN_INSET}px)`
    );
    expect(form).not.toContain('min(');
    expect(form).toContain(
      `left: calc(var(--gpu-sidebar) + (var(--gpu-content) - var(--gpu-frame)) / 2 + ${VIEW_FRAME_PAD}px)`
    );
    expect(form).toContain(`width: calc(var(--gpu-frame) - ${VIEW_FRAME_PAD * 2}px)`);
    expect(form).toContain(`top: ${PROJECTS_DOM_FORM_TOP}px`);
    expect(form).toContain(`height: ${PROJECTS_DOM_FORM_HEIGHT.create}px`);
    const runForm = css.slice(
      css.indexOf('.gpu-project-form--run'),
      css.indexOf('.gpu-project-form .gpu-dom-input')
    );
    expect(runForm).toContain(`height: ${PROJECTS_DOM_FORM_HEIGHT.run}px`);
    expect(projectsGpuContentTop('create', PROJECTS_NARROW_CONTENT_WIDTH - 1)).toBe(
      PROJECTS_DOM_FORM_TOP + PROJECTS_DOM_FORM_NARROW_HEIGHT.create + 16
    );
    expect(projectsGpuContentTop('run', PROJECTS_NARROW_CONTENT_WIDTH - 1)).toBe(
      PROJECTS_DOM_FORM_TOP + PROJECTS_DOM_FORM_NARROW_HEIGHT.run + 16
    );
    const narrowWindowMax = PROJECTS_NARROW_CONTENT_WIDTH + GPU_LAYOUT.sidebarWidth - 1;
    expect(css).toContain(`@media (max-width: ${narrowWindowMax}px)`);
    expect(css).toContain(`height: ${PROJECTS_DOM_FORM_NARROW_HEIGHT.create}px`);
    expect(css).toContain(`height: ${PROJECTS_DOM_FORM_NARROW_HEIGHT.run}px`);
    const hint = css.slice(
      css.indexOf('.gpu-project-hint {'),
      css.indexOf('/* At this window width')
    );
    expect(hint).toContain('overflow-wrap: anywhere');
    expect(hint).toContain('-webkit-line-clamp: 2');
  });

  it('renders a project row and expands its runs when selected', () => {
    const ctx = createRecordingCtx();
    const projectId = '3c584a3c-933d-4488-ac44-4cdcc8e66f31';
    const snapshot = makeSnapshot(
        { view: 'projects', selectedProjectId: projectId },
        {
          // Projects only exist behind the gate, and the run form only renders
          // for a session — so this state carries one.
          auth: makeAuth({
            displayName: 'Alice',
            activeOrganisation: { id: 'org-1', name: 'Org', role: 'org:owner' },
          }),
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
      );
    drawProjects(ctx, snapshot, 1280, 720);
    expect(ctx.metrics.visibleLabels).toContain('Projects');
    expect(ctx.metrics.visibleLabels.some((label) => label.includes('Weather Lab'))).toBe(true);
    expect(ctx.buttons.some((button) => button.id === `project.select.${projectId}` && button.label === 'Weather Lab')).toBe(true);
    expect(ctx.buttons.some((button) => button.id === 'project.run.trace-1')).toBe(true);
    expect(
      ctx.buttons.some((button) => button.id === 'project.run.bbbbbbbb-cccc-dddd-eeee-ffffffffffff')
    ).toBe(true);
    expect(ctx.texts.some((text) => String(text.value).includes('401 API key is invalid'))).toBe(true);
    const boundedRowCopy = ctx.texts.filter((text) =>
      text.value === 'repo ready' ||
      String(text.value).startsWith('weather-lab ·') ||
      String(text.value).startsWith('https://github.com/atoma-org/') ||
      String(text.value).startsWith('delivered') ||
      String(text.value).includes('401 API key is invalid')
    );
    expect(boundedRowCopy.length).toBeGreaterThanOrEqual(5);
    for (const label of boundedRowCopy) {
      expect(label.options).toMatchObject({ singleLine: true });
    }
    expect(ctx.scrollMax.projects).toBeGreaterThanOrEqual(0);
    expect(ctx.scrollMax.projects).toBeLessThan(200);

    // The project list lives in a centred scroll pane. Its draw coordinates
    // are pane-local, so applying the real Pixi ancestry must land on the same
    // left edge as the DOM form. Absolute coordinates here would add frame.x
    // twice while every raw-number assertion still passed.
    const listPanel = ctx.panels.find((panel) => panel.parent !== ctx.root);
    expect(listPanel).toBeTruthy();
    const listGlobal = listPanel!.parent.toGlobal({ x: listPanel!.x, y: listPanel!.y });
    expect(listGlobal.x).toBe(projectsColumn(1280).x);
    expect(listPanel!.parent.toGlobal({ x: 0, y: 0 }).y).toBe(
      projectsGpuContentTop('run')
    );

    // The status column is ANCHORED to the card's inner right edge, not left
    // aligned somewhere in the middle of the row. It used to be capped at
    // `columnX + 560`, which on any panel past ~700px floated the verdict a
    // few hundred pixels short of the border it belongs against.
    const column = projectsColumn(1280);
    // The status sits inside the panel border, while the label surface gives
    // that right-hand column its own horizontal space.
    const rowRight = column.x + column.width - 18;
    const rightEdge = rowRight - PROJECTS_ROW_PAD;
    const staleCap = column.x + 18 + 560;
    const repositoryUrl = ctx.texts.find((text) =>
      String(text.value).startsWith('https://github.com/atoma-org/')
    );
    expect(String(repositoryUrl?.value)).toMatch(/…$/);
    for (const [description, label] of [
      ['repo ready', ctx.texts.find((text) => text.value === 'repo ready')],
      ['bounded repository URL', repositoryUrl],
    ] as const) {
      expect(label, `missing status label: ${description}`).toBeTruthy();
      expect(label!.parent.toGlobal({ x: label!.x, y: label!.y }).x).toBe(rightEdge);
      expect(label!.node.anchor.x).toBe(1);
    }
    const verdict = ctx.texts.find((text) => String(text.value).startsWith('delivered'));
    expect(verdict!.parent.toGlobal({ x: verdict!.x, y: verdict!.y }).x).toBe(rightEdge);
    expect(verdict!.node.anchor.x).toBe(1);
    expect(rightEdge).toBeGreaterThan(staleCap);
    const wideProjectButton = ctx.buttons.find(
      (candidate) => candidate.id === `project.select.${projectId}`
    )!;
    const wideButtonOrigin = wideProjectButton.parent.toGlobal({
      x: wideProjectButton.x,
      y: wideProjectButton.y,
    });
    expect(wideButtonOrigin.x + wideProjectButton.width).toBeLessThan(rightEdge);

    // The run goal gives way before the status column on a narrow pane; no
    // forced minimum may push its button through the frame edge.
    const narrowWidth = 248;
    const narrow = createRecordingCtx();
    drawProjects(narrow, snapshot, narrowWidth, 720);
    const narrowFrame = viewFrame(narrowWidth, 720);
    const projectButton = narrow.buttons.find(
      (candidate) => candidate.id === `project.select.${projectId}`
    )!;
    const narrowStatus = narrow.texts.find((text) => text.value === 'repo ready')!;
    expect(narrowStatus.parent.toGlobal({ x: narrowStatus.x, y: narrowStatus.y }).y)
      .toBeGreaterThan(
        projectButton.parent.toGlobal({ x: projectButton.x, y: projectButton.y }).y +
        projectButton.height
      );
    for (const button of narrow.buttons.filter((candidate) => candidate.id.startsWith('project.run.'))) {
      const origin = button.parent.toGlobal({ x: button.x, y: button.y });
      expect(button.width).toBeGreaterThanOrEqual(100);
      expect(origin.x).toBeGreaterThanOrEqual(narrowFrame.innerX);
      expect(origin.x + button.width).toBeLessThanOrEqual(
        narrowFrame.innerX + narrowFrame.innerWidth
      );
    }
  });
});

describe('GPU account menu', () => {
  const auth = makeAuth({
    displayName: 'Ada Lovelace',
    activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
    organisations: [
      { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
      { id: 'org-b', name: 'Difference Engines', role: 'org:member' },
    ],
  });

  it('stays closed until the header orb asks for it', () => {
    const closed = createRecordingCtx();
    drawAccountMenu(closed, makeSnapshot({ accountMenuOpen: false }, { auth }), 1280, 720);
    expect(closed.buttons).toHaveLength(0);

    const noViewer = createRecordingCtx();
    drawAccountMenu(noViewer, makeSnapshot({ accountMenuOpen: true }), 1280, 720);
    expect(noViewer.buttons).toHaveLength(0);
  });

  it('carries identity, role, the other organisations, settings and sign out', () => {
    const ctx = createRecordingCtx();
    const activated: string[] = [];
    const snapshot = makeSnapshot({ accountMenuOpen: true }, { auth });
    snapshot.onActivate = (id) => activated.push(id);

    drawAccountMenu(ctx, snapshot, 1280, 720);

    expect(ctx.metrics.visibleLabels).toContain('Ada Lovelace');
    expect(ctx.metrics.visibleLabels).toContain('OWNER');
    expect(ctx.metrics.visibleLabels).toContain('Analytical Engines');
    const ids = ctx.buttons.map((button) => button.id);
    // The ACTIVE organisation is not offered as a switch target.
    expect(ids).toContain('org.switch.org-b');
    expect(ids).not.toContain('org.switch.org-a');
    expect(ids).toContain('account.settings');
    expect(ids).toContain('auth.signOut');
    const signOut = ctx.buttons.find((button) => button.id === 'auth.signOut');
    signOut?.onActivate?.(signOut.id);
    expect(activated).toEqual(['auth.signOut']);
  });

  it('marks the platform admin and keeps the failure line', () => {
    const ctx = createRecordingCtx();
    drawAccountMenu(
      ctx,
      makeSnapshot(
        { accountMenuOpen: true },
        { auth: makeAuth({ platformAdmin: true }, { failure: true }) }
      ),
      1280,
      720
    );
    expect(ctx.metrics.visibleLabels).toContain('PLATFORM ADMIN');
    expect(ctx.metrics.visibleLabels).toContain('Account action failed');
  });

  it('stays inside a narrow viewport and hangs under the header', () => {
    const layout = accountMenuLayout(360, makeAuth({}, { failure: true }));
    expect(layout.x).toBeGreaterThanOrEqual(0);
    expect(layout.x + layout.width).toBeLessThanOrEqual(360);
    expect(layout.y).toBeGreaterThanOrEqual(GPU_LAYOUT.headerHeight);
    // Ordering is the contract: identity first, actions last.
    expect(layout.items[0]?.kind).toBe('identity');
    expect(layout.items.map((item) => item.kind)).toContain('failure');
    const kinds = layout.items.map((item) => item.kind);
    expect(kinds.indexOf('settings')).toBeLessThan(kinds.indexOf('signOut'));
  });
});

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

describe('drawSettings', () => {
  const auth = makeAuth({ displayName: 'Ada Lovelace', principalId: 'principal-9' });
  const accountModels = {
    pins: { l1: 'claude-haiku-4-5-20251001', l2: null, l3: null },
    defaults: {
      l1: 'claude-haiku-4-5-20251001',
      l2: 'claude-sonnet-5',
      l3: 'claude-opus-5',
    },
    choices: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
  };
  const organisation = {
    id: 'org-1',
    name: 'Analytical Engines',
    createdAt: '2026-08-01T10:00:00.000Z',
    viewerRole: 'org:owner',
    members: [
      {
        principalId: 'principal-9',
        displayName: 'Ada Lovelace',
        role: 'org:owner',
        joinedAt: '2026-08-01T10:00:00.000Z',
        platformAdmin: true,
        avatarUrl: null,
      },
      {
        principalId: 'principal-2',
        displayName: 'Charles Babbage',
        role: 'org:member',
        joinedAt: '2026-08-03T10:00:00.000Z',
        platformAdmin: false,
        avatarUrl: null,
      },
    ],
    projectCount: 3,
    pendingInvitations: 1,
  };

  it('offers one cell per tier per choice, plus the operator default', () => {
    const ctx = createRecordingCtx();
    drawSettings(
      ctx,
      makeSnapshot({ view: 'settings' }, { auth, accountModels, organisation }),
      1280,
      720
    );
    const ids = ctx.filterButtons.map((filter) => filter.id);
    for (const tier of [1, 2, 3]) {
      expect(ids).toContain(`settings.model.${tier}.default`);
      expect(ids).toContain(`settings.model.${tier}.0`);
      expect(ids).toContain(`settings.model.${tier}.1`);
      expect(ids).toContain(`settings.model.${tier}.2`);
    }
    // The pinned cell is the active one, and the default is active where no
    // pin exists — the two must never both read as selected on one tier.
    const active = ctx.filterButtons.filter((filter) => filter.active).map((filter) => filter.id);
    expect(active).toContain('settings.model.1.0');
    expect(active).not.toContain('settings.model.1.default');
    expect(active).toContain('settings.model.2.default');
    expect(active).toContain('settings.model.3.default');
  });

  it('stacks tier labels and keeps every model choice inside a narrow frame', () => {
    const width = 248;
    const ctx = createRecordingCtx();
    drawSettings(
      ctx,
      makeSnapshot({ view: 'settings' }, { auth, accountModels, organisation }),
      width,
      720
    );
    const frame = viewFrame(width, 720, 720);
    expect(ctx.filterButtons).toHaveLength(12);
    for (const button of ctx.filterButtons) {
      const origin = button.parent.toGlobal({ x: button.x, y: button.y });
      expect(origin.x).toBeGreaterThanOrEqual(frame.innerX);
      expect(origin.x + button.width).toBeLessThanOrEqual(frame.innerX + frame.innerWidth);
    }
    expect(ctx.scrollMax.settings).toBeGreaterThan(0);
  });

  it('shows the organisation card with members, roles and the admin chip', () => {
    const ctx = createRecordingCtx();
    drawSettings(
      ctx,
      makeSnapshot({ view: 'settings' }, { auth, accountModels, organisation }),
      1280,
      720
    );
    const labels = ctx.texts.map((text) => text.value);
    expect(labels).toContain('Analytical Engines');
    expect(labels).toContain('Ada Lovelace');
    expect(labels).toContain('Charles Babbage');
    expect(labels).toContain('PLATFORM ADMIN');
    expect(labels).toContain('org-1');
    expect(labels).toContain('3');
    // Owner/admin only: the pending count is null for a plain member and the
    // row then disappears entirely.
    expect(labels.some((label) => label.includes('PENDING INVITATIONS'))).toBe(true);
    expect(ctx.scrollMax.settings).toBeGreaterThanOrEqual(0);
  });

  it('hides the invitation count from a member and survives no org at all', () => {
    const member = createRecordingCtx();
    drawSettings(
      member,
      makeSnapshot(
        { view: 'settings' },
        {
          auth,
          accountModels,
          organisation: { ...organisation, viewerRole: 'org:member', pendingInvitations: null },
        }
      ),
      1280,
      720
    );
    expect(
      member.texts.some((text) => text.value.includes('PENDING INVITATIONS'))
    ).toBe(false);

    const bare = createRecordingCtx();
    drawSettings(bare, makeSnapshot({ view: 'settings' }, { auth }), 1280, 720);
    // No models and no organisation yet: the tier rows still render against the
    // operator defaults rather than leaving an empty page.
    expect(bare.filterButtons.length).toBeGreaterThan(0);
  });

  it('names the name source and retains one orb for the account', () => {
    const imported = createRecordingCtx();
    drawSettings(imported, makeSnapshot({ view: 'settings' }, { auth }), 1280, 720);
    expect(
      imported.texts.some((text) => text.value.includes('Imported from your provider'))
    ).toBe(true);
    expect(imported.retainedOrbs).toHaveLength(1);
    expect(imported.retainedOrbs[0]?.seed).toBe('principal-9');
    // Its OWN slot: the header claims 'header' in the same frame, and a shared
    // slot had the two orbs destroying each other on every render.
    expect(imported.retainedOrbs[0]?.slot).toBe('settings');

    const owned = createRecordingCtx();
    drawSettings(
      owned,
      makeSnapshot(
        { view: 'settings' },
        { auth: makeAuth({ displayNameSource: 'user' }) }
      ),
      1280,
      720
    );
    expect(owned.texts.some((text) => text.value.includes('Chosen here'))).toBe(true);
  });

  it('sizes the organisation panel around the rows it must hold', () => {
    // THE REGRESSION: an owner sees one extra fact (pending invitations), which
    // pushed the fact block onto a third line and the member list past a
    // hand-tuned panel height — the last row was clipped. Every offset now
    // comes from this one function, so the frame cannot be shorter than its
    // content.
    const ownerFacts = 5;
    const memberFacts = 4;
    for (const facts of [memberFacts, ownerFacts]) {
      for (const members of [1, 3, 9]) {
        const layout = organisationPanelLayout(facts, members);
        const lastRowBottom = layout.firstMemberY + members * MEMBER_ROW_HEIGHT;
        expect(layout.height, `${facts} facts / ${members} members`)
          .toBeGreaterThanOrEqual(lastRowBottom);
        // The members header must clear the fact lines it sits under.
        expect(layout.membersHeaderY).toBeGreaterThan(38 + layout.factLines * 26);
        expect(layout.firstMemberY).toBeGreaterThan(layout.membersHeaderY);
      }
    }
    // One extra fact costs exactly one line of height, not zero.
    expect(organisationPanelLayout(ownerFacts, 1).height).toBeGreaterThan(
      organisationPanelLayout(memberFacts, 1).height
    );
    expect(organisationPanelLayout(memberFacts, 2).height).toBe(
      organisationPanelLayout(memberFacts, 1).height + MEMBER_ROW_HEIGHT
    );
  });

  it('draws every panel frame behind its own content', () => {
    // The frames layer is added to the scroll pane FIRST: both panels size
    // themselves from content they can only measure after drawing it, so a
    // frame appended afterwards would paint over the rows.
    const ctx = createRecordingCtx();
    drawSettings(
      ctx,
      makeSnapshot({ view: 'settings' }, { auth, accountModels, organisation }),
      1280,
      720
    );
    // The view's own column frame is drawn straight into the root; the two
    // panels under test are the ones inside the scrolled frames layer.
    const inner = ctx.panels.filter((panel) => panel.parent !== ctx.root);
    expect(inner).toHaveLength(2);
    const framesLayer = inner[0]?.parent;
    expect(inner[1]?.parent).toBe(framesLayer);
    expect(
      inner[0]!.parent.toGlobal({ x: inner[0]!.x, y: inner[0]!.y }).x
    ).toBe(viewFrame(1280, 720, 720).innerX);
    // ...and the rows went somewhere else, which is what "behind" means here.
    const memberLabel = ctx.texts.find((text) => text.value === 'Charles Babbage');
    expect(memberLabel?.parent).not.toBe(framesLayer);
    for (const panel of ctx.panels) {
      expect(panel.height).toBeGreaterThan(0);
    }
  });

  it('keeps the GPU content clear of the DOM name form', () => {
    // The form is `position: fixed` DOM over the canvas; content that started
    // above its bottom edge would render underneath it.
    expect(settingsGpuContentTop()).toBeGreaterThan(
      SETTINGS_DOM_FORM_TOP + SETTINGS_DOM_FORM_HEIGHT
    );
    const css = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    const form = css.slice(css.indexOf('.gpu-settings-form {'));
    expect(form).toContain(`top: ${SETTINGS_DOM_FORM_TOP}px`);
    expect(form).toContain(`height: ${SETTINGS_DOM_FORM_HEIGHT}px`);
  });

  it('round-trips a model cell id and shortens model ids for the chips', () => {
    expect(parseSettingsModelId('settings.model.2.1')).toEqual({
      tier: 2,
      model: 'claude-sonnet-5',
    });
    expect(parseSettingsModelId('settings.model.3.default')).toEqual({
      tier: 3,
      model: null,
    });
    expect(parseSettingsModelId('settings.model.4.0')).toBeNull();
    expect(parseSettingsModelId('settings.model.1.9')).toBeNull();
    expect(parseSettingsModelId('nav.settings')).toBeNull();
    expect(modelChipLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelChipLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelChipLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelChipLabel('some-future-model')).toBe('some-future-model');
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
    // Pane math mirrors the view: the split views start below the header band
    // plus the standard gap, so this reads the band rather than restating it.
    const paneTop = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + 92;
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
            docs: 0,
            admin: 0,
            journal: 0,
            ledger: 0,
            sentinel: 0,
            settings: 0,
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

  it('draws the shared scrollbar thumb only when a pane overflows', () => {
    const overflowing = createRecordingCtx();
    drawRegistry(overflowing, makeSnapshot({ view: 'registry' }, data), WIDTH, HEIGHT);
    // BOTH panes overflow at this height: the tier list, and the detail pane —
    // which carries elements, parameters, provenance and the system prompt,
    // not the prompt alone.
    expect(overflowing.scrollMax.registry).toBeGreaterThan(0);
    expect(overflowing.detailScrollMax).toBeGreaterThan(0);
    expect(scrollbarThumbs(overflowing.root).length).toBe(2);

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

  it('names every section of the agent detail, not just its prompt', () => {
    // The pane rendered the system prompt as one unlabelled monospace block
    // and nothing else. Elements, parameters and provenance were payload the
    // view already had and never showed.
    const ctx = createRecordingCtx();
    drawRegistry(
      ctx,
      makeSnapshot(
        { view: 'registry', selectedRegistryAtom: 'Molecule0' },
        { registries: [REGISTRY_SUMMARY], registry: { registry: REGISTRY_SUMMARY, types: types } }
      ),
      WIDTH,
      900
    );
    const values = ctx.texts.map((text) => text.value);
    for (const heading of ['ELEMENTS', 'PARAMETERS', 'PROVENANCE', 'SYSTEM PROMPT', 'USER INSTRUCTION']) {
      expect(values, `missing ${heading}`).toContain(heading);
    }
    // The user instruction is NAMED and not shown: it is composed per call, so
    // it belongs to a run. The heading points at the run instead of inventing
    // a template nobody ever sent.
    expect(values.some((value) => value.includes('Open an LLM event in Runs'))).toBe(true);
    expect(values).toContain('You are a helper.');
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
    const paneTop = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
    expect(ctx.detailBounds!.y).toBe(paneTop);
    expect(ctx.detailBounds!.width).toBe(WIDTH - rightX - 10);
    expect(ctx.detailBounds!.height).toBe(HEIGHT - paneTop - 10);
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
            projectName: '',
            projectPrompt: '',
            projectRepository: '',
            displayName: '',
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
    const firstFilter = tall.filterButtons[0];
    expect(firstFilter).toBeTruthy();
    expect(
      firstFilter!.parent.toGlobal({ x: firstFilter!.x, y: firstFilter!.y }).x
    ).toBe(viewFrame(WIDTH, 1400).innerX);

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
          scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: 500, docs: 0, admin: 0, journal: 0, ledger: 0, sentinel: 0, settings: 0 },
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
          scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: SCROLL, docs: 0, admin: 0, journal: 0, ledger: 0, sentinel: 0, settings: 0 },
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
    const crystal = mark.container.children[0] as Container;
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

  it('keeps the header crystal inside the bar and clear of the wordmark', () => {
    // The mark is drawn at (20, 12) with its pivot at the local centre, so the
    // gem's visual centre is pinned at (34, 26) whatever the scale — only its
    // extent grows. Two neighbours bound that extent, and the box's nominal
    // half-width (14) is NOT the bound: the projected hull reaches further at
    // some turns than others, so the widest turn is what has to fit.
    let halfWidth = 0;
    let halfHeight = 0;
    for (let step = 0; step < 360; step += 1) {
      for (const point of buildAtomaMarkFrame(step * 40).silhouette) {
        halfWidth = Math.max(halfWidth, Math.abs(point.x - 14));
        halfHeight = Math.max(halfHeight, Math.abs(point.y - 14));
      }
    }
    const centreX = GPU_LAYOUT.headerMarkX + 14;
    const centreY = GPU_LAYOUT.headerHeight / 2;
    // Inside the header bar, top and bottom, so it never crosses the border
    // line the bar draws at its own height.
    expect(centreY - halfHeight * ATOMA_MARK_HEADER_SCALE).toBeGreaterThan(0);
    expect(centreY + halfHeight * ATOMA_MARK_HEADER_SCALE)
      .toBeLessThan(GPU_LAYOUT.headerHeight);
    // And clear of the wordmark by a real gap. This is the pairing that goes
    // wrong quietly: scaling the mark up eats the space beside it, and nothing
    // about the text's own position says it was ever meant to be adjacent.
    const rightEdge = centreX + halfWidth * ATOMA_MARK_HEADER_SCALE;
    expect(GPU_LAYOUT.headerWordmarkX - rightEdge).toBeGreaterThanOrEqual(8);
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

  it('returns a retainable handle: resume re-parents and re-ticks, destroy is terminal', () => {
    // The leak this pins: renderScene rebuilds the scene on every render, and
    // an attach-per-render mark leaked its render textures, geometries and
    // shader (Mesh.destroy only NULLS those references; WebGPU GC is pinned
    // off). The renderer now retains ONE handle and resumes it across
    // rebuilds, destroying it properly only when the attach key changes.
    const parent = new Container();
    const tickers: ((ticker: Ticker) => void)[] = [];
    const mark = attachAtomaMark(parent, (callback) => tickers.push(callback), 0, 0);
    expect(mark.retained).toContain(mark.container);
    expect(parent.children).toContain(mark.container);

    // A scene rebuild detaches children and clears every ticker.
    parent.removeChildren();
    const resumed: ((ticker: Ticker) => void)[] = [];
    mark.resume(parent, (callback) => resumed.push(callback));
    expect(parent.children).toContain(mark.container);
    expect(resumed).toHaveLength(1);
    // Same paint callback, not a second animation on the same crystal.
    expect(resumed[0]).toBe(tickers[0]);

    mark.destroy();
    expect(mark.container.destroyed).toBe(true);
    mark.destroy();
    mark.resume(parent, (callback) => resumed.push(callback));
    expect(resumed).toHaveLength(1);
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
// The run prompt's guidance, inside Projects
//
// There is no Launch view any more: a tab that could only DESCRIBE how to
// phrase a goal, beside a Projects tab that actually starts runs, split one
// job over two places. These tests hold the guidance to the properties the
// Launch view was measured against — measured (not estimated) layout, honest
// scroll, a backdrop drawn into a reserved z-slot — now that it renders in
// the form that owns the input.
// ---------------------------------------------------------------------------

const GUIDANCE_PROJECT_ID = '3c584a3c-933d-4488-ac44-4cdcc8e66f31';

function guidanceProject(): VizProject {
  return {
    projectId: GUIDANCE_PROJECT_ID,
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
  };
}

function drawGuidance(
  profile: LaunchProfile | null,
  selected = true,
  height = 720
): ReturnType<typeof createRecordingCtx> {
  const ctx = createRecordingCtx();
  drawProjects(
    ctx,
    makeSnapshot(
      { view: 'projects', selectedProjectId: selected ? GUIDANCE_PROJECT_ID : null },
      { projects: [guidanceProject()], profiles: profile ? [profile] : [] }
    ),
    1000,
    height
  );
  return ctx;
}

describe('the run prompt carries its own guidance', () => {
  it('renders the family help and click-to-fill examples for the selected project', () => {
    const ctx = drawGuidance(LAUNCH_PROFILE);
    expect(ctx.texts.some((text) => text.value === t('launch.help'))).toBe(true);
    expect(ctx.texts.some((text) => text.value === t('launch.examples'))).toBe(true);
    // One button per example, and the ids the activation handler slices an
    // index out of to fill the run prompt.
    expect(ctx.buttons.some((button) => button.id === 'projects.example.0')).toBe(true);
    expect(ctx.buttons.some((button) => button.id === 'projects.example.7')).toBe(true);
    expect(ctx.buttons.some((button) => button.id === 'projects.example.8')).toBe(false);
    // The project row still renders, below the guidance.
    const row = ctx.buttons.find((button) => button.id === `project.select.${GUIDANCE_PROJECT_ID}`)!;
    const firstExample = ctx.buttons.find((button) => button.id === 'projects.example.0')!;
    expect(row.y).toBeGreaterThan(firstExample.y);
  });

  it('stays silent until a project is selected, and without a family', () => {
    // The DOM form only shows the prompt textarea once a project is selected,
    // so guidance for an input that does not exist yet would be noise.
    const unselected = drawGuidance(LAUNCH_PROFILE, false);
    expect(unselected.buttons.some((button) => button.id.startsWith('projects.example.'))).toBe(false);
    expect(unselected.texts.some((text) => text.value === t('launch.help'))).toBe(false);
    // /api/profiles is supplementary copy: an empty payload must not stop the
    // project list from rendering.
    const noProfile = drawGuidance(null);
    expect(noProfile.buttons.some((button) => button.id.startsWith('projects.example.'))).toBe(false);
    expect(
      noProfile.buttons.some((button) => button.id === `project.select.${GUIDANCE_PROJECT_ID}`)
    ).toBe(true);
  });

  it('prefers a catalog override over the family English, per family id', () => {
    // `launch.help.build` exists in the catalog, so a deployment's own wording
    // wins; a family with no key falls back to what the profile carries.
    const catalogued = drawGuidance({ ...LAUNCH_PROFILE, id: 'build' });
    expect(catalogued.texts.some((text) => text.value === t('launch.help.build'))).toBe(true);
    expect(catalogued.texts.some((text) => text.value === LAUNCH_PROFILE.help)).toBe(false);

    const unknownFamily = drawGuidance({ ...LAUNCH_PROFILE, id: 'no-such-family' });
    expect(unknownFamily.texts.some((text) => text.value === LAUNCH_PROFILE.help)).toBe(true);
    // The key itself must never reach the screen.
    expect(
      unknownFamily.texts.some((text) => String(text.value).startsWith('launch.help.'))
    ).toBe(false);
  });

  it('shifts the list and scroll max by the measured wrapped help height', () => {
    const HEIGHT = 420;
    const mediumHelp = 'm'.repeat(800);
    const longHelp = 'l'.repeat(2400);
    // An id with no catalog key, so the fixture's own paragraph is what wraps.
    const draw = (help: string) =>
      drawGuidance({ ...LAUNCH_PROFILE, id: 'no-such-family', help }, true, HEIGHT);
    const medium = draw(mediumHelp);
    const long = draw(longHelp);
    const heightDelta = textStub(longHelp).height - textStub(mediumHelp).height;
    expect(heightDelta).toBeGreaterThan(0);
    expect(long.scrollMax.projects! - medium.scrollMax.projects!).toBe(heightDelta);
    const rowOf = (ctx: ReturnType<typeof createRecordingCtx>) =>
      ctx.buttons.find((button) => button.id === `project.select.${GUIDANCE_PROJECT_ID}`)!.y;
    expect(rowOf(long) - rowOf(medium)).toBe(heightDelta);
    // Examples start below the measured paragraph instead of overlapping it.
    const helpText = long.texts.find((text) => text.value === longHelp)!;
    const firstExample = long.buttons.find((button) => button.id === 'projects.example.0')!;
    expect(firstExample.y).toBeGreaterThanOrEqual(helpText.y + textStub(longHelp).height);
  });

  it('draws its backdrop into the z-slot reserved before the text', () => {
    // Same one-pass shape the Launch view used: the panel is sized by the
    // FINAL layout cursor, so it cannot be drawn before the text it sits
    // behind — a layer reserves the slot up front and the panel lands in it
    // last. Without the layer the backdrop would paint over the paragraph.
    const ctx = drawGuidance(LAUNCH_PROFILE);
    const content = ctx.texts.find((text) => text.value === t('launch.help'))!.parent;
    // The view's own column frame is a panel as well, so select by SHAPE:
    // the backdrop is the one sitting in a reserved layer under the content.
    const detached = ctx.panels.filter(
      (panel) => panel.parent !== content && panel.parent.parent === content
    );
    expect(detached).toHaveLength(1);
    const backdrop = detached[0]!;
    // The reserved layer is a child of the same content container, and it is
    // its FIRST child — everything drawn afterwards sits on top of it.
    expect(backdrop.parent.parent).toBe(content);
    expect(content.children[0]).toBe(backdrop.parent);
    // Sized by the measured cursor, spanning from the top of the content.
    expect(backdrop.y).toBe(0);
    expect(backdrop.height).toBeGreaterThan(0);
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

  it('keeps the historical 1050px window threshold for the detail pane', () => {
    const event = makeLlmEvent('selected', { role: 'execute' });
    const visible = createRecordingCtx();
    drawRuns(
      visible,
      makeSnapshot({ selectedEventId: event.id }, { run: makeRun([event]) }),
      RUNS_TWO_PANE_MIN_WIDTH,
      HEIGHT
    );
    expect(visible.detailBounds).not.toBeNull();

    const narrow = createRecordingCtx();
    drawRuns(
      narrow,
      makeSnapshot({ selectedEventId: event.id }, { run: makeRun([event]) }),
      RUNS_TWO_PANE_MIN_WIDTH - 1,
      HEIGHT
    );
    expect(narrow.detailBounds).toBeNull();
  });

  it('frames the empty state and centres its message', () => {
    const ctx = createRecordingCtx();
    drawRuns(ctx, makeSnapshot({}, { run: null }), WIDTH, HEIGHT);

    // The frame: one panel spanning the view under the header, matching the
    // shared view-frame geometry the populated single-pane layout uses.
    const frame = viewFrame(WIDTH, HEIGHT);
    const panel = ctx.panels.find(
      (candidate) =>
        candidate.width > 0 &&
        Math.abs(candidate.x - frame.x) < 0.5 &&
        Math.abs(candidate.y - frame.y) < 0.5 &&
        Math.abs(candidate.width - frame.width) < 0.5 &&
        Math.abs(candidate.height - frame.height) < 0.5
    );
    expect(panel).toBeDefined();

    // The title inside the frame, from the catalog.
    const title = ctx.texts.find(
      (candidate) => candidate.value === t('nav.runs')
    );
    expect(title).toBeDefined();
    expect(title!.y).toBeCloseTo(frame.y + VIEW_FRAME_TITLE_Y);

    // The empty message centred in the frame.
    const empty = ctx.texts.find((candidate) => candidate.value === t('runs.none'));
    expect(empty).toBeDefined();
    expect(empty!.x).toBeCloseTo(frame.x + frame.width / 2);
    expect(empty!.y).toBeCloseTo(frame.y + frame.height / 2);
    expect(empty!.node.anchor.x).toBeCloseTo(0.5);
    expect(empty!.node.anchor.y).toBeCloseTo(0.5);

    // Fail closed: nothing to scroll when no run is recorded.
    expect(ctx.scrollMax.runs).toBe(0);
  });

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
            docs: 0,
            admin: 0,
            journal: 0,
            ledger: 0,
            sentinel: 0,
            settings: 0,
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
      rendererX: 20,
      rendererY: 200,
      rendererWidth: 90,
      rendererHeight: 27,
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
