import {
  Application,
  Container,
  Filter,
  Graphics,
  Rectangle,
  RendererType,
  Text,
  TextStyle,
  Ticker,
} from 'pixi.js';
import { matchesSearchQuery, runSearchText } from '../client/search.js';
import type {
  BurninRow,
  LaunchProfile,
  RegistrySummary,
  RegistryType,
  RunIndexEntry,
  SkillNamespace,
  SkillSummary,
  VizRun,
} from '../client/types.js';
import {
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_CORE_RADIUS_PULSE,
  ATOMA_MARK_CORE_STROKE_WIDTH,
  buildAtomaMarkFrame,
  type AtomaMarkPoint,
} from './brand-mark.js';
import {
  CAST_SHADOW_REACH_PX,
  ambientShadowOffset,
  castShadowOffset,
} from './renderer/cast-shadow.js';
import { LabelCache } from './renderer/label-cache.js';
import { NO_TINT, multiplyTint } from './renderer/label-tint.js';
import { pointerClientToRenderer, readPointerLight } from './pointer-light.js';
import type { GpuUiState, ViewName } from './store.js';
import { GPU_COLORS, GPU_LAYOUT } from './theme.js';
import { VIZ_VISUAL_DEPTH } from './visual-depth.js';

export interface GpuDataSnapshot {
  runs: RunIndexEntry[];
  run: VizRun | null;
  registries: RegistrySummary[];
  registry: { registry: RegistrySummary; types: RegistryType[] } | null;
  skillNamespaces: SkillNamespace[];
  skillsByNamespace: Record<string, SkillSummary[]>;
  skillDetail: SkillSummary | null;
  burnin: { rows: BurninRow[]; csvPath: string } | null;
  profiles: LaunchProfile[];
  loading: boolean;
  error: string | null;
}

export interface GpuHitTarget {
  id: string;
  role: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FilterVisualTarget extends GpuHitTarget {
  active: boolean;
  accent: number;
}

export interface GpuTimelineViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  railBaseX: number;
  laneSpacing: number;
  cardBaseX: number;
  cardBaseWidth: number;
  branchCardOffset: number;
  contentTopPadding: number;
  contentBottomPadding: number;
  rowHeight: number;
  totalHeight: number;
  scrollY: number;
  /**
   * Display rows the view inserts above the first EVENT row (its "run ended"
   * bookend). Overlays project `layout` rows onto this grid, so they must
   * add it — the layout knows nothing about the view's bookends.
   */
  rowOffset: number;
}

export interface GpuRenderMetrics {
  backend: 'webgpu' | 'webgl' | 'unknown';
  objectCount: number;
  runCollapseOffset: number;
  visibleLabels: string[];
  hitTargets: GpuHitTarget[];
  timelineViewport?: GpuTimelineViewport;
  /**
   * Wall time of the last `render()` — the scene REBUILD, not the frame. The
   * two are measured separately on purpose: an rAF interval saturates at
   * vsync, so it detects dropped frames but can never show the margin a
   * rebuild eats. This is the number that moves when a wheel tick gets
   * cheaper.
   */
  renderMs: number;
  /** Labels built from scratch in the last render — see `LabelCache.created`. */
  labelsCreated: number;
  /** Labels served from the retention pool in the last render. */
  labelsReused: number;
}

/**
 * THE zero state for render metrics. The renderer, the app shell and the view
 * tests all need one before a first render has happened; three hand-written
 * literals meant every new counter had to be added in three places.
 */
export function emptyRenderMetrics(): GpuRenderMetrics {
  return {
    backend: 'unknown',
    objectCount: 0,
    runCollapseOffset: 0,
    visibleLabels: [],
    hitTargets: [],
    renderMs: 0,
    labelsCreated: 0,
    labelsReused: 0,
  };
}

export interface GpuRenderSnapshot {
  state: GpuUiState;
  data: GpuDataSnapshot;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate: (id: string) => void;
  onScroll: (view: ViewName, delta: number) => void;
  onRunPickerScroll: (delta: number) => void;
}

interface TextOptions {
  size?: number;
  color?: number;
  weight?: '400' | '500' | '600' | '700';
  width?: number;
  mono?: boolean;
  alpha?: number;
}

const NAV_HOVER_GAP = 20;

// Decomposed modules (2026-08-15): pure layout, copy, shaders, motion and the
// shared scroll pane live under ./renderer/. This file keeps the stateful
// renderer class. Re-exports preserve the public import surface.
/**
 * A button label at rest. Buttons are now BUILT at `GPU_COLORS.text` and
 * tinted down to this, rather than built dim and re-coloured on hover: hover
 * used to assign `style.fill`, and that style is shared across every label
 * with the same size/weight, so one rollover lit up all of them.
 */
const BUTTON_LABEL_IDLE = 0xa9b5ca;
const BUTTON_LABEL_IDLE_TINT = multiplyTint(GPU_COLORS.text, BUTTON_LABEL_IDLE);

export * from './renderer/chip-layout.js';
export * from './renderer/shaders.js';
export { gpuEventCardCopy, type GpuEventCardCopy, type GpuTranslate } from './renderer/copy.js';
import { type FilterBlockLayout } from './renderer/chip-layout.js';
import { truncate } from './renderer/copy.js';
import {
  CARD_FILTER_GLSL,
  CARD_FILTER_GLSL_VERTEX,
  CARD_FILTER_WGSL,
  POINTER_LIGHT_GLSL,
  POINTER_LIGHT_GLSL_VERTEX,
  POINTER_LIGHT_WGSL,
} from './renderer/shaders.js';
import { prefersReducedMotion } from './renderer/motion.js';
import { drawScrollbarThumb } from './renderer/scroll-pane.js';
import { drawRuns } from './renderer/views/runs.js';
import { drawRegistry } from './renderer/views/registry.js';
import { drawSkills } from './renderer/views/skills.js';
import { drawBurnin } from './renderer/views/burnin.js';
import { drawLaunch } from './renderer/views/launch.js';

export class GpuRenderer {
  app = new Application();
  readonly ambientRoot = new Container();
  readonly root = new Container();
  private host: HTMLElement | null = null;
  private initialized = false;
  private snapshot: GpuRenderSnapshot | null = null;
  readonly scrollMax: Partial<Record<ViewName, number>> = {};
  private readonly tickerCallbacks = new Set<(ticker: Ticker) => void>();
  private readonly frameFilters = new Set<Filter>();
  private pointerLightFilter: Filter | null = null;
  private pointerLightUniforms: {
    uLightPx: Float32Array;
    uStrength: number;
  } | null = null;
  private pointerLightStrength = 0;
  /** Light position in renderer pixels, published by `updatePointerLight`. */
  private lightRendererX = 0;
  private lightRendererY = 0;
  private pointerLightBufferPinned = false;
  previousFilterBounds = new Map<string, FilterVisualTarget>();
  private currentFilterBounds = new Map<string, FilterVisualTarget>();
  private handledExitIds = new Set<string>();
  roleRowTransition: {
    phase: 'exit' | 'enter';
    targets: FilterVisualTarget[];
    distance: number;
    startedAt: number;
  } | null = null;
  readonly seenAnimatedControls = new Set<string>();
  private previousView: ViewName | null = null;
  private activeViewTransition: {
    from: ViewName;
    to: ViewName;
    startedAt: number;
  } | null = null;
  private previousEventIds = new Set<string>();
  private currentEventIds = new Set<string>();
  private runPickerBounds: Rectangle | null = null;
  private runPickerScrollMax = 0;
  detailBounds: Rectangle | null = null;
  detailScrollY = 0;
  detailScrollMax = 0;
  private detailKey: string | null = null;
  /** Shared immutable styles, keyed by visual style — see `textStyle()`. */
  private readonly textStyles = new Map<string, TextStyle>();
  /**
   * Labels retained across the scene teardown in `render()`. `release` swaps
   * in a throwaway style BEFORE destroying: Pixi's `AbstractText.destroy()`
   * never unsubscribes from its style's `update` event, so an evicted label
   * would otherwise leave a listener on the shared style holding it alive.
   * The style setter does unsubscribe, which is why this goes through it.
   */
  private readonly labels = new LabelCache<Text>({
    detach: (label) => label.removeFromParent(),
    release: (label) => {
      label.style = {};
      label.destroy({ children: true, style: true });
    },
  });
  /**
   * Surfaces that throw a shadow from the pointer light. Rebuilt with the
   * scene — the Graphics are children of containers the next render destroys —
   * and read every frame by `updateCastShadows`.
   */
  private castShadows: {
    shadow: Graphics;
    parent: Container;
    localX: number;
    localY: number;
    width: number;
    height: number;
    depth: number;
    left: number;
    top: number;
  }[] = [];
  metrics: GpuRenderMetrics = emptyRenderMetrics();
  private readonly wheel = (event: WheelEvent) => {
    if (!this.snapshot) return;
    event.preventDefault();
    if (
      this.snapshot.state.focusedInput === 'run' &&
      this.runPickerBounds
    ) {
      const bounds = this.app.canvas.getBoundingClientRect();
      const localX =
        (event.clientX - bounds.left) * this.app.screen.width / Math.max(1, bounds.width);
      const localY =
        (event.clientY - bounds.top) * this.app.screen.height / Math.max(1, bounds.height);
      if (this.runPickerBounds.contains(localX, localY)) {
        const current = this.snapshot.state.runPickerScrollY;
        const next = Math.max(
          0,
          Math.min(this.runPickerScrollMax, current + event.deltaY)
        );
        this.snapshot.onRunPickerScroll(next - current);
        return;
      }
    }
    if (this.detailBounds) {
      const bounds = this.app.canvas.getBoundingClientRect();
      const localX =
        (event.clientX - bounds.left) * this.app.screen.width / Math.max(1, bounds.width);
      const localY =
        (event.clientY - bounds.top) * this.app.screen.height / Math.max(1, bounds.height);
      if (this.detailBounds.contains(localX, localY)) {
        const next = Math.max(
          0,
          Math.min(this.detailScrollMax, this.detailScrollY + event.deltaY)
        );
        if (next !== this.detailScrollY) {
          this.detailScrollY = next;
          this.render(this.snapshot);
        }
        return;
      }
    }
    const view = this.snapshot.state.view;
    const current = this.snapshot.state.scrollY[view];
    // Fail closed: a view that declared no scrollable content does not
    // scroll. Every draw sets its own max (Infinity here let Registry and
    // Skills wheel into the void — 2026-08-14 review).
    const maximum = this.scrollMax[view] ?? 0;
    const next = Math.max(0, Math.min(maximum, current + event.deltaY));
    this.snapshot.onScroll(view, next - current);
  };

  private readonly updatePointerLight = (ticker: Ticker) => {
    const filter = this.pointerLightFilter;
    const uniforms = this.pointerLightUniforms;
    if (!filter || !uniforms) return;
    if (!this.pointerLightBufferPinned) {
      // PIN THIS BUFFER AGAINST PIXI'S GC. Pixi SKIPS a disabled filter, so
      // nothing calls getGPUBuffer() on its uniform buffer and `_gcLastUsed`
      // stops advancing (BindGroup._touch refreshes the UniformGroup, not the
      // Buffer under it). After gcMaxUnusedTime (60s idle) GCSystem unloads it
      // and calls GPUBuffer.destroy() — but BindGroupSystem._hash is keyed on
      // the UniformGroup's unchanged `_resourceId` and nothing sets
      // BindGroup._dirty, so the cached GPUBindGroup keeps pointing at the
      // dead buffer. Re-enabling the filter then makes EVERY queue.submit a
      // validation error, forever ("[Buffer] used in submit while destroyed").
      // Reproduced on Metal WebGPU: leave the window with the pointer away,
      // come back, ~120 errors/s until reload. This filter lives for the whole
      // session, so its buffer must survive idle periods.
      // Written here, not at install time: Pixi creates `uniformGroup.buffer`
      // lazily on the first sync.
      const group = filter.resources['pointerLight'] as unknown as {
        buffer?: { autoGarbageCollect: boolean };
      };
      if (group.buffer) {
        group.buffer.autoGarbageCollect = false;
        this.pointerLightBufferPinned = true;
      }
    }
    const pointer = readPointerLight();
    const target = pointer.active ? 1 : 0;
    // Reduced motion: the light still follows the pointer (user-driven), but
    // without the trailing ease that reads as autonomous drift.
    const response = prefersReducedMotion()
      ? 1
      : 1 - Math.exp(-Math.max(0, ticker.deltaMS) * 0.018);
    this.pointerLightStrength += (target - this.pointerLightStrength) * response;
    if (!pointer.active && this.pointerLightStrength < 0.002) {
      this.pointerLightStrength = 0;
      uniforms.uStrength = 0;
      filter.enabled = false;
      return;
    }

    const bounds = this.app.canvas.getBoundingClientRect();
    const local = pointerClientToRenderer(
      pointer.clientX,
      pointer.clientY,
      bounds,
      this.app.screen.width,
      this.app.screen.height
    );
    uniforms.uLightPx[0] = local.x;
    uniforms.uLightPx[1] = local.y;
    uniforms.uStrength = this.pointerLightStrength;
    filter.enabled = true;
    // Published for the shadow cast, which runs right after on the same
    // ticker. Recomputing it there would mean a SECOND
    // getBoundingClientRect() per frame, and each one flushes layout.
    this.lightRendererX = local.x;
    this.lightRendererY = local.y;
  };

  private installPointerLightFilter() {
    const filter = Filter.from({
      gl: {
        vertex: POINTER_LIGHT_GLSL_VERTEX,
        fragment: POINTER_LIGHT_GLSL,
      },
      gpu: {
        vertex: {
          source: POINTER_LIGHT_WGSL,
          entryPoint: 'mainVertex',
        },
        fragment: {
          source: POINTER_LIGHT_WGSL,
          entryPoint: 'mainFragment',
        },
      },
      resources: {
        pointerLight: {
          uLightPx: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uStrength: { value: 0, type: 'f32' },
        },
      },
      padding: 0,
      resolution: 'inherit',
      antialias: 'inherit',
    });
    filter.enabled = false;
    this.pointerLightFilter = filter;
    this.pointerLightUniforms = filter.resources['pointerLight'].uniforms as {
      uLightPx: Float32Array;
      uStrength: number;
    };
    this.root.filters = [filter];
    this.app.ticker.add(this.updatePointerLight);
    // AFTER the light: it damps `pointerLightStrength`, which the cast reads.
    this.app.ticker.add(this.updateCastShadows);
  }

  async init(host: HTMLElement) {
    this.host = host;
    const forceWebGl = new URLSearchParams(location.search).get('renderer') === 'webgl';
    try {
      await this.app.init({
        resizeTo: host,
        preference: forceWebGl ? ['webgl'] : ['webgpu', 'webgl'],
        antialias: true,
        autoDensity: true,
        resolution: Math.min(devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.warn('[viz:gpu] WebGPU init failed; retrying WebGL', error);
      this.app.destroy();
      this.app = new Application();
      await this.app.init({
        resizeTo: host,
        preference: ['webgl'],
        antialias: true,
        autoDensity: true,
        resolution: Math.min(devicePixelRatio || 1, 2),
        backgroundAlpha: 0,
      });
    }
    const rendererType = Number(this.app.renderer.type);
    this.metrics.backend =
      rendererType === Number(RendererType.WEBGPU)
        ? 'webgpu'
        : rendererType === Number(RendererType.WEBGL)
          ? 'webgl'
          : 'unknown';
    this.ambientRoot.eventMode = 'none';
    this.app.stage.addChild(this.ambientRoot, this.root);
    this.installPointerLightFilter();
    this.app.canvas.className = 'gpu-ui-canvas';
    this.app.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.app.canvas);
    this.app.canvas.addEventListener('wheel', this.wheel, { passive: false });
    // Diagnostics handle, INERT unless explicitly asked for with ?atomaDiag=1.
    // GPU lifetime defects (Pixi's GC unloading a buffer whose bind group is
    // still cached) are invisible to mocked tests and to the WebGL fallback,
    // so the only honest regression test drives the real renderer — and it
    // needs to reach the GC to force a collection instead of passing because
    // nothing ever happened. Read-only by convention; nothing in the product
    // reads it back.
    if (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).has('atomaDiag')
    ) {
      (window as unknown as { __ATOMA_GPU__?: unknown }).__ATOMA_GPU__ = {
        app: this.app,
        pointerLightFilter: () => this.pointerLightFilter,
      };
    }
    this.initialized = true;
  }

  destroy() {
    if (!this.initialized) return;
    this.app.ticker.remove(this.updatePointerLight);
    this.app.ticker.remove(this.updateCastShadows);
    this.castShadows = [];
    this.root.filters = null;
    this.root.filterArea = undefined;
    this.pointerLightFilter?.destroy();
    this.pointerLightFilter = null;
    this.pointerLightUniforms = null;
    this.pointerLightStrength = 0;
    // A re-initialised renderer builds a NEW filter with a new buffer.
    this.pointerLightBufferPinned = false;
    for (const filter of this.frameFilters) filter.destroy();
    this.frameFilters.clear();
    // Detach-then-destroy, BEFORE the app tears the stage down: a retained
    // label still parented would otherwise be destroyed twice.
    this.labels.clear();
    this.textStyles.clear();
    this.app.canvas.removeEventListener('wheel', this.wheel);
    this.app.destroy(true, { children: true });
    this.initialized = false;
    this.host = null;
  }

  getMetrics() {
    return this.metrics;
  }

  /**
   * Timed wrapper over the scene rebuild. `renderMs` is what a wheel tick
   * actually costs, and it is the metric the smoke budgets — the rAF interval
   * it also samples saturates at vsync and cannot show this.
   */
  render(snapshot: GpuRenderSnapshot) {
    const startedAt = performance.now();
    try {
      this.renderScene(snapshot);
    } finally {
      this.metrics.renderMs = performance.now() - startedAt;
      this.metrics.labelsCreated = this.labels.created;
      this.metrics.labelsReused = this.labels.reused;
    }
  }

  private renderScene(snapshot: GpuRenderSnapshot) {
    this.snapshot = snapshot;
    for (const callback of this.tickerCallbacks) this.app.ticker.remove(callback);
    this.tickerCallbacks.clear();
    for (const filter of this.frameFilters) filter.destroy();
    this.frameFilters.clear();
    // Retained labels step out of the scene BEFORE it is torn down, so the
    // recursive destroy below walks past them instead of through them.
    this.labels.beginRender();
    // Dropped with the scene that owns them; the ticker must not be left
    // holding Graphics that are about to be destroyed.
    this.castShadows = [];
    for (const child of this.ambientRoot.removeChildren()) child.destroy({ children: true });
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.metrics.visibleLabels = [];
    this.metrics.hitTargets = [];
    this.metrics.runCollapseOffset = 0;
    delete this.metrics.timelineViewport;
    this.currentFilterBounds = new Map();
    this.handledExitIds = new Set();
    this.currentEventIds = new Set();
    this.runPickerBounds = null;
    this.runPickerScrollMax = 0;
    const nextDetailKey =
      snapshot.state.view === 'runs'
        ? snapshot.state.selectedEventId
          ? `event:${snapshot.state.selectedEventId}`
          : snapshot.state.selectedAtomName
            ? `agent:${snapshot.state.selectedAtomName}`
            : null
        : snapshot.state.view === 'registry'
          ? `registry:${snapshot.state.selectedRegistryAtom ?? ''}`
          : snapshot.state.view === 'skills'
            ? `skill:${snapshot.state.selectedSkill?.l1Name ?? ''}::${snapshot.state.selectedSkill?.id ?? ''}`
            : null;
    if (nextDetailKey !== this.detailKey) this.detailScrollY = 0;
    this.detailKey = nextDetailKey;
    this.detailBounds = null;
    this.detailScrollMax = 0;
    this.scrollMax[snapshot.state.view] = 0;

    const hostWidth = this.host?.clientWidth ?? this.app.screen.width;
    const hostHeight = this.host?.clientHeight ?? this.app.screen.height;
    if (
      Math.abs(this.app.screen.width - hostWidth) > 1 ||
      Math.abs(this.app.screen.height - hostHeight) > 1
    ) {
      this.app.renderer.resize(hostWidth, hostHeight);
    }
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    this.root.filterArea = new Rectangle(0, 0, width, height);
    this.drawAmbientGrid(this.ambientRoot, width, height);
    this.drawHeader(snapshot, width);

    if (snapshot.data.loading) {
      this.text(this.root, snapshot.t('common.loading'), 24, 84, { size: 16 });
    } else if (snapshot.data.error) {
      this.text(this.root, snapshot.data.error, 24, 84, {
        size: 14,
        color: GPU_COLORS.error,
        width: width - 48,
      });
    } else {
      switch (snapshot.state.view) {
        case 'runs':
          drawRuns(this, snapshot, width, height);
          break;
        case 'registry':
          drawRegistry(this, snapshot, width, height);
          break;
        case 'skills':
          drawSkills(this, snapshot, width, height);
          break;
        case 'burnin':
          drawBurnin(this, snapshot, width, height);
          break;
        case 'launch':
          drawLaunch(this, snapshot, width, height);
          break;
      }
    }
    this.drawOverlays(snapshot, width, height);
    this.drawRemovedFilterEffects();
    if (this.previousView && this.previousView !== snapshot.state.view) {
      this.activeViewTransition = {
        from: this.previousView,
        to: snapshot.state.view,
        startedAt: performance.now(),
      };
    }
    this.previousView = snapshot.state.view;
    this.drawViewTransition(width, height);
    this.previousFilterBounds = this.currentFilterBounds;
    if (snapshot.state.view !== 'runs') this.roleRowTransition = null;
    this.previousEventIds = this.currentEventIds;
    // Labels this render did not draw go idle, and idle keys are released.
    // `countObjects` walks the live scene, and a retained label that was not
    // re-attached is not in it, so retention never inflates objectCount.
    this.labels.endRender();
    // Anchors resolve only now: the containers are attached and positioned.
    this.anchorCastShadows();
    this.updateCastShadows();
    this.metrics.objectCount =
      this.countObjects(this.ambientRoot) + this.countObjects(this.root);
  }

  private countObjects(container: Container): number {
    let count = 1;
    for (const child of container.children) {
      count += child instanceof Container ? this.countObjects(child) : 1;
    }
    return count;
  }

  private drawAmbientGrid(parent: Container, width: number, height: number) {
    const graphics = new Graphics();
    graphics.alpha = 0.12;
    for (let x = 0; x < width; x += 40) {
      graphics.moveTo(x, GPU_LAYOUT.headerHeight).lineTo(x, height);
    }
    for (let y = GPU_LAYOUT.headerHeight; y < height; y += 40) {
      graphics.moveTo(0, y).lineTo(width, y);
    }
    graphics.stroke({ color: 0x26334a, width: 1, alpha: 0.18 });
    parent.addChild(graphics);
  }

  panel(
    parent: Container,
    x: number,
    y: number,
    width: number,
    height: number,
    fill: number = GPU_COLORS.panel,
    border: number = GPU_COLORS.border,
    radius: number = GPU_LAYOUT.radius,
    elevation: 0 | 1 | 2 = 1
  ) {
    const safeWidth = Math.max(0, width);
    const safeHeight = Math.max(0, height);
    if (elevation > 0) {
      // Both layers draw at the panel's own rect and are OFFSET BY POSITION,
      // so the pointer light can swing them. The deep layer carries the larger
      // depth, so the two separate as the light moves instead of travelling
      // as one hard smear.
      const deepShadow = new Graphics();
      deepShadow.roundRect(x, y, safeWidth, safeHeight, radius);
      deepShadow.fill({ color: 0x01040a, alpha: 0.2 + elevation * 0.08 });
      deepShadow.eventMode = 'none';
      parent.addChild(deepShadow);
      this.registerCastShadow(
        deepShadow,
        parent,
        x,
        y,
        safeWidth,
        safeHeight,
        elevation / 2
      );

      const nearShadow = new Graphics();
      nearShadow.roundRect(x, y, safeWidth, safeHeight, radius);
      nearShadow.fill({ color: 0x07101d, alpha: 0.3 + elevation * 0.05 });
      nearShadow.eventMode = 'none';
      this.registerCastShadow(
        nearShadow,
        parent,
        x,
        y,
        safeWidth,
        safeHeight,
        elevation * 0.28
      );
      parent.addChild(nearShadow);
    }

    const graphics = new Graphics();
    graphics.roundRect(x, y, safeWidth, safeHeight, radius);
    graphics.fill({
      color: fill,
      alpha: elevation === 0
        ? 0.84
        : VIZ_VISUAL_DEPTH.near.panelAlpha - (2 - elevation) * 0.04,
    });
    if (border !== fill) graphics.stroke({ color: border, width: 1, alpha: 0.9 });
    graphics.eventMode = 'none';
    parent.addChild(graphics);

    if (elevation > 0 && safeWidth > 8) {
      const rim = new Graphics();
      rim
        .moveTo(x + Math.max(3, radius), y + 0.7)
        .lineTo(x + safeWidth - Math.max(3, radius), y + 0.7)
        .stroke({
          color: 0xc7e2ff,
          width: 0.8,
          alpha: 0.07 + elevation * 0.055,
        });
      rim.eventMode = 'none';
      parent.addChild(rim);
    }
    return graphics;
  }

  filterBlockFrame(
    parent: Container,
    block: Pick<FilterBlockLayout, 'x' | 'y' | 'width' | 'height'>
  ) {
    const graphics = new Graphics();
    graphics.roundRect(block.x, block.y, block.width, block.height, 10);
    graphics.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.72 });
    graphics.eventMode = 'none';
    parent.addChild(graphics);
    return graphics;
  }

  collapseCaret(
    parent: Container,
    right: number,
    top: number,
    expanded: boolean,
    color: number
  ) {
    const size = 12;
    const graphics = new Graphics();
    if (expanded) {
      graphics.poly([0, 2, size, 2, size / 2, size]);
    } else {
      graphics.poly([2, 0, size, size / 2, 2, size]);
    }
    graphics.fill({ color, alpha: 0.95 });
    graphics.eventMode = 'none';
    graphics.position.set(right - size, top);
    parent.addChild(graphics);
    return graphics;
  }

  /**
   * A SHARED `TextStyle` per visual style, never one per label. Pixi keys its
   * text-texture cache on `${text}:${style.uid}-${style._tick}:${resolution}`
   * — instance identity, not content — so a per-label style makes every key
   * unique and the cache dead on arrival. Styles here are immutable once
   * built: mutating one would invalidate every label drawn with it.
   */
  private textStyle(options: TextOptions): { style: TextStyle; key: string } {
    const size = options.size ?? 12;
    const weight = options.weight ?? '400';
    const color = options.color ?? GPU_COLORS.text;
    const mono = options.mono ?? false;
    const key = `${size}|${weight}|${color}|${mono ? 'm' : 's'}|${options.width ?? ''}`;
    let style = this.textStyles.get(key);
    if (!style) {
      style = new TextStyle({
        fill: color,
        fontFamily: mono
          ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
          : '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        fontSize: size,
        fontWeight: weight,
        wordWrap: options.width !== undefined,
        wordWrapWidth: options.width ?? 0,
        breakWords: true,
        lineHeight: size * 1.35,
      });
      this.textStyles.set(key, style);
    }
    return { style, key };
  }

  text(parent: Container, value: string, x: number, y: number, options: TextOptions = {}) {
    const { style, key } = this.textStyle(options);
    // Retained across renders: a scroll tick rebuilds the scene, and
    // re-rasterising every label was the cost that made it expensive.
    const label = this.labels.acquire(`${key}\u0000${value}`, () =>
      new Text({ text: value, style })
    );
    label.position.set(x, y);
    label.alpha = options.alpha ?? 1;
    // A POOLED label arrives carrying whatever the last caller left on it.
    // Position and alpha are reset above for exactly that reason, and tint is
    // now a live per-label channel too (see renderer/label-tint.ts) — so a
    // dimmed button label must not hand its dimming to the next thing drawn
    // under the same key.
    label.tint = NO_TINT;
    label.eventMode = 'none';
    parent.addChild(label);
    this.metrics.visibleLabels.push(value);
    return label;
  }

  private addSurfaceShadow(
    parent: Container,
    width: number,
    height: number,
    radius = 8,
    alpha = 0.44
  ) {
    const shadow = new Graphics();
    // Geometry at the local origin, offset by POSITION — the offset is what
    // the pointer light moves each frame, and baking it into the path would
    // mean re-tessellating every shadow on every pointer move.
    shadow.roundRect(0, 0, width, height, radius);
    shadow.fill({ color: 0x01040a, alpha });
    shadow.eventMode = 'none';
    parent.addChild(shadow);
    this.registerCastShadow(shadow, parent, 0, 0, width, height);
    return shadow;
  }

  /**
   * The shadow a RECESSED surface casts into itself — what a pressed button
   * looks like, and the inverse of `addSurfaceShadow`.
   *
   * The geometry is a large dark rectangle with the button's own rounded rect
   * CUT OUT of it, masked back down to that same rounded rect. What survives
   * is the sliver of the mask the hole does not cover, so moving the object
   * moves the hole and the dark band lands on the opposite side. The cast
   * offset therefore needs no inversion: it already points away from the
   * light, which pushes the hole away and leaves the shadow banked against the
   * inner wall NEAREST the light — where a real cavity is dark.
   *
   * Everything is built once at the local origin and only `position` moves per
   * frame, the same contract `addSurfaceShadow` follows: re-cutting the hole
   * on every pointer move would re-tessellate the path each frame.
   *
   * `visible` is toggled rather than left at `alpha = 0`, because a mask costs
   * a stencil pass whether or not the thing it masks is transparent, and a
   * button is unpressed almost always.
   */
  private addInsetShadow(
    parent: Container,
    width: number,
    height: number,
    radius = 8,
    alpha = 0.55,
    depth = 0.55
  ) {
    // Wide enough that the cut-out never slides off the mask at full reach,
    // and — required by `GraphicsContext.cut` — that the hole stays entirely
    // inside the shape it is cut from.
    const pad = CAST_SHADOW_REACH_PX * 3;
    const shadow = new Graphics();
    shadow.rect(-pad, -pad, width + pad * 2, height + pad * 2);
    shadow.fill({ color: 0x01040a, alpha });
    shadow.roundRect(0, 0, width, height, radius);
    shadow.cut();
    shadow.eventMode = 'none';
    shadow.visible = false;

    const mask = new Graphics();
    mask.roundRect(0, 0, width, height, radius).fill({ color: 0xffffff });
    mask.eventMode = 'none';
    parent.addChild(mask);
    parent.addChild(shadow);
    shadow.mask = mask;

    this.registerCastShadow(shadow, parent, 0, 0, width, height, depth);
    return shadow;
  }

  /**
   * Hand a shadow to the pointer light. `localX`/`localY` are the SURFACE's
   * position inside `parent` — the light needs to know where the thing casting
   * is, which is not where the shadow lands. The shadow's own geometry must
   * sit at its local origin so only `position` moves per frame.
   */
  private registerCastShadow(
    shadow: Graphics,
    parent: Container,
    localX: number,
    localY: number,
    width: number,
    height: number,
    depth = 1
  ) {
    // Named so the smoke can find them: where a shadow lands is only
    // observable on a real renderer with a real pointer.
    shadow.label = 'cast-shadow';
    const rest = ambientShadowOffset(depth);
    shadow.position.set(rest.x, rest.y);
    // Anchored after the scene is built: `parent` is not on the stage yet, so
    // its global transform is not knowable here.
    this.castShadows.push({
      shadow,
      parent,
      localX,
      localY,
      width,
      height,
      depth,
      left: 0,
      top: 0,
    });
  }

  /**
   * Resolve each registered shadow's surface centre in stage coordinates,
   * ONCE per render rather than per frame. The scene is static between
   * renders — scrolling rebuilds it — so these stay valid until the next one.
   */
  private anchorCastShadows() {
    for (const entry of this.castShadows) {
      if (entry.shadow.destroyed || !entry.parent.parent) continue;
      // Top-left only: the scene translates but never scales, so the local
      // width/height carry over to stage coordinates unchanged.
      const origin = entry.parent.toGlobal({ x: entry.localX, y: entry.localY });
      entry.left = origin.x;
      entry.top = origin.y;
    }
  }

  /**
   * The scene's one movable light throws every registered shadow. Runs on the
   * ticker and touches only `position`, so pointer motion never rebuilds the
   * scene — the same contract the pointer-light filter follows.
   */
  private readonly updateCastShadows = () => {
    if (this.castShadows.length === 0) return;
    const strength = prefersReducedMotion() ? 0 : this.pointerLightStrength;
    // Read, never recomputed — see `updatePointerLight`. When the light is
    // off, strength is 0 and the cast returns the ambient offset whatever
    // these hold, so a stale position cannot be observed.
    const lightX = this.lightRendererX;
    const lightY = this.lightRendererY;
    for (const entry of this.castShadows) {
      if (entry.shadow.destroyed) continue;
      const offset = castShadowOffset({
        left: entry.left,
        top: entry.top,
        width: entry.width,
        height: entry.height,
        lightX,
        lightY,
        strength,
        depth: entry.depth,
      });
      entry.shadow.position.set(offset.x, offset.y);
    }
  };

  button(
    parent: Container,
    id: string,
    role: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void,
    accent: number = GPU_COLORS.primary,
    centerLabel = false
  ) {
    const container = new Container();
    container.position.set(x, y);
    this.addSurfaceShadow(container, width, height, 7, 0.4);
    const graphics = new Graphics();
    graphics.roundRect(0, 0, width, height, 7);
    graphics.fill({
      color: active ? accent : GPU_COLORS.panelRaised,
      alpha: active ? 0.32 : 0.9,
    });
    graphics.stroke({ color: active ? accent : GPU_COLORS.border, width: active ? 1.5 : 1 });
    container.addChild(graphics);
    const labelText = this.text(
      container,
      truncate(label, Math.max(1, Math.floor((width - 16) / 6.2))),
      centerLabel ? width / 2 : 10,
      Math.max(5, (height - 16) / 2),
      {
        size: 11,
        color: active ? GPU_COLORS.text : GPU_COLORS.muted,
        weight: active ? '700' : '600',
      }
    );
    if (centerLabel) labelText.anchor.x = 0.5;
    labelText.eventMode = 'none';
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    container.on('pointertap', () => onActivate(id));
    container.on('pointerover', () => {
      graphics.tint = 0xbfd6ff;
    });
    container.on('pointerout', () => {
      graphics.tint = 0xffffff;
    });
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role, label, x, y, width, height });
    return container;
  }

  addTicker(callback: (ticker: Ticker) => void) {
    this.tickerCallbacks.add(callback);
    this.app.ticker.add(callback);
  }

  filterButton(
    parent: Container,
    id: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void,
    accent = GPU_COLORS.primary
  ) {
    const target: FilterVisualTarget = {
      id,
      role: 'button',
      label,
      x,
      y,
      width,
      height,
      active,
      accent,
    };
    const wasVisible = this.previousFilterBounds.has(id);
    const appearanceDelay = this.currentFilterBounds.size * 14;
    this.currentFilterBounds.set(id, target);
    this.metrics.hitTargets.push(target);

    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const dropShadow = this.addSurfaceShadow(container, width, height, 8, 0.42);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2.5, alpha: 0.8 });
    aura.alpha = active ? 0.32 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({
      color: active ? accent : 0x111b2c,
      alpha: active ? 0.3 : 0.94,
    });
    base.stroke({
      color: active ? accent : 0x30405d,
      width: active ? 1.8 : 1,
      alpha: active ? 1 : 0.85,
    });
    container.addChild(base);
    const insetShadow = this.addInsetShadow(container, width, height, 8);

    const inner = new Graphics();
    inner.roundRect(3, 3, width - 6, height - 6, 6);
    inner.stroke({ color: active ? 0xd9e8ff : 0x6f86ad, width: 0.7, alpha: active ? 0.35 : 0.12 });
    container.addChild(inner);

    const scanline = new Graphics();
    scanline.rect(0, 3, 2, height - 6).fill({ color: 0xffffff, alpha: 0.7 });
    scanline.alpha = active ? 0.15 : 0.035;
    container.addChild(scanline);

    const corner = new Graphics();
    corner
      .moveTo(4, 9)
      .lineTo(4, 4)
      .lineTo(9, 4)
      .moveTo(width - 9, height - 4)
      .lineTo(width - 4, height - 4)
      .lineTo(width - 4, height - 9)
      .stroke({ color: accent, width: 1.2, alpha: active ? 0.9 : 0.25 });
    container.addChild(corner);

    const sparkles = Array.from({ length: 4 }, (_, index) => {
      const sparkle = new Graphics();
      sparkle.circle(0, 0, index % 2 === 0 ? 1.4 : 1).fill({
        color: index % 2 === 0 ? accent : 0xffffff,
      });
      sparkle.alpha = active ? 0.55 : 0;
      container.addChild(sparkle);
      return sparkle;
    });

    const labelText = this.text(container, label, width / 2, Math.max(5, (height - 16) / 2), {
      // Built BRIGHT and tinted down, never re-coloured through the style —
      // the style is shared, so `style.fill = …` recolours every label using it.
      size: 11,
      color: GPU_COLORS.text,
      weight: active ? '700' : '600',
    });
    labelText.anchor.x = 0.5;
    labelText.eventMode = 'none';

    let hovered = false;
    let pressed = false;
    let insetDepth = active ? 1 : 0;
    let elapsed = wasVisible || prefersReducedMotion() ? performance.now() : -appearanceDelay;
    let currentLabelTint = active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
    labelText.tint = currentLabelTint;
    container.alpha = wasVisible || prefersReducedMotion() ? 1 : 0;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 260));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.955 : hovered ? 1.035 : 1;
      const scale = easedEntrance * targetScale;
      container.alpha = easedEntrance;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.5 : 0)
      );
      const pulse = 0.5 + 0.5 * Math.sin(elapsed / 170);
      aura.alpha = active
        ? 0.2 + pulse * 0.22
        : hovered
          ? 0.12 + pulse * 0.16
          : 0;
      scanline.x = 4 + (Math.max(0, elapsed) * (hovered ? 0.12 : 0.045)) % Math.max(8, width - 10);
      scanline.alpha = active ? 0.12 + pulse * 0.12 : hovered ? 0.08 + pulse * 0.1 : 0.025;
      base.tint = pressed ? 0xb8d7ff : hovered ? 0xd6e7ff : 0xffffff;
      // A pressed or selected surface is RECESSED: its drop shadow gives way
      // to the one it casts into itself. The inner shadow stays registered
      // with the pointer light, so moving the mouse over a sunk button moves
      // the shadow around INSIDE it. Reduced motion jumps rather than damps.
      insetDepth += ((pressed || active ? 1 : 0) - insetDepth) *
        (prefersReducedMotion() ? 1 : 0.3);
      insetShadow.alpha = insetDepth;
      insetShadow.visible = insetDepth > 0.02;
      dropShadow.alpha = 1 - insetDepth;
      const nextLabelTint = pressed || hovered || active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
      if (nextLabelTint !== currentLabelTint) {
        currentLabelTint = nextLabelTint;
        labelText.tint = nextLabelTint;
      }
      sparkles.forEach((sparkle, index) => {
        const phase = elapsed / 430 + index * Math.PI / 2;
        sparkle.position.set(
          width / 2 + Math.cos(phase) * (width / 2 - 8),
          height / 2 + Math.sin(phase * 1.35) * (height / 2 - 5)
        );
        sparkle.alpha = active
          ? 0.28 + pulse * 0.42
          : hovered
            ? 0.18 + pulse * 0.35
            : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => {
      hovered = true;
    });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => {
      pressed = true;
    });
    container.on('pointerup', () => {
      pressed = false;
    });
    container.on('pointerupoutside', () => {
      pressed = false;
    });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    return container;
  }

  private navButton(
    parent: Container,
    id: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void
  ) {
    const firstAppearance = !prefersReducedMotion() && !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const dropShadow = this.addSurfaceShadow(container, width, height, 8, 0.48);

    const glow = new Graphics();
    glow.roundRect(-4, -3, width + 8, height + 6, 11);
    glow.stroke({ color: GPU_COLORS.primary, width: 2.5, alpha: 0.85 });
    glow.alpha = active ? 0.28 : 0;
    container.addChild(glow);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({
      color: active ? 0x183259 : 0x111b2c,
      alpha: VIZ_VISUAL_DEPTH.near.navAlpha,
    });
    base.stroke({
      color: active ? GPU_COLORS.primary : 0x2d3d59,
      width: active ? 1.6 : 1,
    });
    container.addChild(base);
    const insetShadow = this.addInsetShadow(container, width, height, 8);

    const scanline = new Graphics();
    scanline.rect(0, 3, 2, height - 6).fill({ color: 0xffffff, alpha: 0.7 });
    scanline.alpha = active ? 0.12 : 0.025;
    container.addChild(scanline);

    const underline = new Graphics();
    underline.roundRect(0, 0, Math.max(12, width - 18), 2.2, 1.1);
    underline.fill(GPU_COLORS.primary);
    underline.position.set(9, height - 4);
    underline.alpha = active ? 0.9 : 0;
    container.addChild(underline);

    const labelText = this.text(container, label, width / 2, Math.max(5, (height - 16) / 2), {
      size: 11,
      // Built BRIGHT and tinted down — see the sibling button factory.
      color: GPU_COLORS.text,
      weight: active ? '700' : '600',
    });
    labelText.anchor.x = 0.5;

    const sparks = Array.from({ length: 3 }, (_, index) => {
      const spark = new Graphics();
      spark.circle(0, 0, 1.2 - index * 0.18).fill(index === 1 ? 0xffffff : GPU_COLORS.primary);
      spark.alpha = active ? 0.5 : 0;
      container.addChild(spark);
      return spark;
    });

    let hovered = false;
    let pressed = false;
    let insetDepth = active ? 1 : 0;
    let elapsed = firstAppearance ? -Math.max(0, x - 112) * 0.35 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    let currentLabelTint = active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
    labelText.tint = currentLabelTint;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 280));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.95 : hovered ? 1.045 : 1;
      const scale = easedEntrance * targetScale;
      container.alpha = easedEntrance;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.5 : hovered ? -1 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 155) * 0.5;
      glow.alpha = active
        ? 0.18 + pulse * 0.22
        : hovered
          ? 0.1 + pulse * 0.18
          : 0;
      scanline.x = 4 + (Math.max(0, elapsed) * (hovered ? 0.16 : 0.05)) % Math.max(8, width - 10);
      scanline.alpha = active ? 0.11 + pulse * 0.08 : hovered ? 0.09 : 0.02;
      // The selected tab's rail is a stable positional anchor. Surrounding
      // glow/sparks can move, but the bar itself must not breathe or drift.
      underline.alpha = active ? 0.95 : hovered ? 0.42 : 0;
      underline.scale.x = active ? 1 : hovered ? 0.65 + pulse * 0.15 : 0.2;
      base.tint = pressed ? 0xafd1ff : hovered ? 0xd7e8ff : 0xffffff;
      // A pressed or selected surface is RECESSED: its drop shadow gives way
      // to the one it casts into itself. The inner shadow stays registered
      // with the pointer light, so moving the mouse over a sunk button moves
      // the shadow around INSIDE it. Reduced motion jumps rather than damps.
      insetDepth += ((pressed || active ? 1 : 0) - insetDepth) *
        (prefersReducedMotion() ? 1 : 0.3);
      insetShadow.alpha = insetDepth;
      insetShadow.visible = insetDepth > 0.02;
      dropShadow.alpha = 1 - insetDepth;
      const nextLabelTint = pressed || hovered || active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
      if (nextLabelTint !== currentLabelTint) {
        currentLabelTint = nextLabelTint;
        labelText.tint = nextLabelTint;
      }
      sparks.forEach((spark, index) => {
        const phase = elapsed / 350 + index * 2.1;
        spark.position.set(10 + (Math.sin(phase) * 0.5 + 0.5) * (width - 20), height - 3 - Math.abs(Math.cos(phase)) * 4);
        spark.alpha = active ? 0.25 + pulse * 0.5 : hovered ? 0.18 + pulse * 0.3 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role: 'tab', label, x, y, width, height });
    return container;
  }

  statCard(
    parent: Container,
    id: string,
    label: string,
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number
  ) {
    const firstAppearance = !prefersReducedMotion() && !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    this.addSurfaceShadow(container, width, height, 8, 0.4);

    const glow = new Graphics();
    glow.roundRect(-2, -2, width + 4, height + 4, 10);
    glow.stroke({ color: accent, width: 1.8, alpha: 0.7 });
    glow.alpha = 0.12;
    container.addChild(glow);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: 0x111a2b, alpha: 0.92 });
    base.stroke({ color: 0x293956, width: 1, alpha: 0.88 });
    container.addChild(base);

    const topRail = new Graphics();
    topRail.roundRect(8, 0, width - 16, 1.6, 0.8).fill(accent);
    topRail.alpha = 0.48;
    container.addChild(topRail);

    const scanline = new Graphics();
    scanline.rect(5, 0, width - 10, 1).fill({ color: accent, alpha: 0.55 });
    scanline.alpha = 0.05;
    container.addChild(scanline);

    const labelText = this.text(container, label, 10, 7, {
      size: 9,
      color: GPU_COLORS.muted,
      weight: '500',
    });
    const valueText = this.text(container, value, 10, 25, {
      size: 14,
      color: GPU_COLORS.text,
      weight: '700',
    });

    const telemetry = Array.from({ length: 9 }, (_, index) => {
      const bar = new Graphics();
      bar.roundRect(0, 0, 2.2, 4, 1).fill(accent);
      bar.position.set(width - 38 + index * 3.5, height - 8);
      bar.alpha = 0.22;
      container.addChild(bar);
      return bar;
    });

    let elapsed = firstAppearance ? -Number(id.replace(/\D/g, '').slice(-1) || 0) * 35 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 320));
      const eased = 1 - (1 - entrance) ** 3;
      container.alpha = eased;
      container.position.y = y + (1 - eased) * 7;
      const pulse = 0.5 + Math.sin(elapsed / 330) * 0.5;
      glow.alpha = 0.06 + pulse * 0.11;
      topRail.alpha = 0.34 + pulse * 0.28;
      scanline.y = 4 + (Math.max(0, elapsed) * 0.025) % Math.max(8, height - 8);
      scanline.alpha = 0.025 + pulse * 0.045;
      valueText.alpha = 0.9 + pulse * 0.1;
      labelText.alpha = 0.72 + pulse * 0.18;
      telemetry.forEach((bar, index) => {
        const level = 2 + (Math.sin(elapsed / 210 + index * 1.37) * 0.5 + 0.5) * 7;
        bar.height = level;
        bar.y = height - 5 - level;
        bar.alpha = 0.13 + level / 12;
      });
    };
    this.addTicker(animate);
    parent.addChild(container);
    return container;
  }

  atomButton(
    parent: Container,
    id: string,
    label: string,
    tier: 1 | 2 | 3,
    x: number,
    y: number,
    width: number,
    height: number,
    active: boolean,
    onActivate: (id: string) => void
  ) {
    const accent = GPU_COLORS.tiers[tier];
    const particleCenterX = 16;
    const firstAppearance = !prefersReducedMotion() && !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const dropShadow = this.addSurfaceShadow(container, width, height, 8, 0.42);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2, alpha: 0.75 });
    aura.alpha = active ? 0.28 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({ color: active ? accent : 0x121c2d, alpha: active ? 0.26 : 0.94 });
    base.stroke({ color: active ? accent : 0x30405d, width: active ? 1.5 : 1 });
    container.addChild(base);
    const insetShadow = this.addInsetShadow(container, width, height, 8);

    const nucleus = new Graphics();
    nucleus.circle(particleCenterX, height / 2, active ? 3 : 2.3).fill(accent);
    nucleus.alpha = active ? 0.95 : 0.5;
    container.addChild(nucleus);

    const orbit = new Graphics();
    orbit
      .ellipse(0, 0, 7, 4)
      .stroke({ color: accent, width: 0.8, alpha: 0.35 });
    orbit.position.set(particleCenterX, height / 2);
    container.addChild(orbit);

    const electrons = Array.from({ length: tier }, (_, index) => {
      const electron = new Graphics();
      electron.circle(0, 0, 1.1).fill(index % 2 ? 0xffffff : accent);
      electron.alpha = active ? 0.7 : 0;
      container.addChild(electron);
      return electron;
    });

    this.text(
      container,
      truncate(label, Math.max(1, Math.floor((width - 44) / 6.2))),
      34,
      Math.max(5, (height - 16) / 2),
      {
        size: 10,
        color: active ? GPU_COLORS.text : 0xa9b5ca,
        weight: active ? '700' : '600',
      }
    );

    let hovered = false;
    let pressed = false;
    let insetDepth = active ? 1 : 0;
    let elapsed = firstAppearance ? -(x % 120) * 1.2 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 300));
      const eased = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.95 : hovered ? 1.04 : 1;
      const scale = eased * targetScale;
      container.alpha = eased;
      container.scale.set(scale);
      container.position.set(
        x + width * (1 - scale) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1 : hovered ? -1 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 180) * 0.5;
      aura.alpha = active
        ? 0.16 + pulse * 0.25
        : hovered
          ? 0.08 + pulse * 0.16
          : 0;
      base.tint = pressed ? 0xbad9ff : hovered ? 0xdcecff : 0xffffff;
      // A pressed or selected surface is RECESSED: its drop shadow gives way
      // to the one it casts into itself. The inner shadow stays registered
      // with the pointer light, so moving the mouse over a sunk button moves
      // the shadow around INSIDE it. Reduced motion jumps rather than damps.
      insetDepth += ((pressed || active ? 1 : 0) - insetDepth) *
        (prefersReducedMotion() ? 1 : 0.3);
      insetShadow.alpha = insetDepth;
      insetShadow.visible = insetDepth > 0.02;
      dropShadow.alpha = 1 - insetDepth;
      nucleus.scale.set(active ? 1 + pulse * 0.25 : hovered ? 1.15 : 1);
      orbit.rotation = elapsed * (tier % 2 ? 0.0012 : -0.001);
      orbit.alpha = active ? 0.75 : hovered ? 0.5 : 0.28;
      electrons.forEach((electron, index) => {
        const phase =
          elapsed / (370 + tier * 45) +
          index * Math.PI * 2 / Math.max(1, tier);
        electron.position.set(
          particleCenterX + Math.cos(phase) * 7,
          height / 2 + Math.sin(phase) * 4
        );
        electron.alpha = active ? 0.5 + pulse * 0.4 : hovered ? 0.55 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(id));
    parent.addChild(container);
    this.metrics.hitTargets.push({ id, role: 'button', label, x, y, width, height });
    return container;
  }

  private createCardFilter(mode: number) {
    const filter = Filter.from({
      gl: {
        vertex: CARD_FILTER_GLSL_VERTEX,
        fragment: CARD_FILTER_GLSL,
      },
      gpu: {
        vertex: {
          source: CARD_FILTER_WGSL,
          entryPoint: 'mainVertex',
        },
        fragment: {
          source: CARD_FILTER_WGSL,
          entryPoint: 'mainFragment',
        },
      },
      resources: {
        cardUniforms: {
          uTime: { value: 0, type: 'f32' },
          uMode: { value: mode, type: 'f32' },
          uHover: { value: 0, type: 'f32' },
          uSelected: { value: 0, type: 'f32' },
        },
      },
      padding: 12,
      resolution: 'inherit',
      antialias: 'inherit',
    });
    this.frameFilters.add(filter);
    return {
      filter,
      uniforms: filter.resources['cardUniforms'].uniforms as {
        uTime: number;
        uMode: number;
        uHover: number;
        uSelected: number;
      },
    };
  }

  eventCard(
    parent: Container,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number,
    shaderMode: number,
    selected: boolean,
    onActivate: (id: string) => void,
    zDepth = 0
  ) {
    const wasVisible = this.previousEventIds.has(id);
    const entranceDelay = this.currentEventIds.size * 18;
    this.currentEventIds.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.skew.x = -zDepth * 0.007;
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const cardShader = this.createCardFilter(shaderMode);
    container.filters = [cardShader.filter];

    const extrusion = new Graphics();
    const extrusionX = 5 + zDepth * 7;
    const extrusionY = 5 + zDepth * 5;
    extrusion.roundRect(extrusionX, extrusionY, width, height, 8);
    extrusion.fill({ color: 0x02050b, alpha: 0.44 + zDepth * 0.16 });
    extrusion.stroke({
      color: accent,
      width: 1,
      alpha: 0.14 + zDepth * 0.16,
    });
    container.addChild(extrusion);

    const middleExtrusion = new Graphics();
    middleExtrusion.roundRect(
      extrusionX * 0.52,
      extrusionY * 0.52,
      width,
      height,
      8
    );
    middleExtrusion.fill({ color: 0x08111f, alpha: 0.4 + zDepth * 0.12 });
    middleExtrusion.stroke({
      color: accent,
      width: 0.8,
      alpha: 0.1 + zDepth * 0.13,
    });
    container.addChild(middleExtrusion);

    const aura = new Graphics();
    aura.roundRect(-3, -3, width + 6, height + 6, 10);
    aura.stroke({ color: accent, width: 2.4, alpha: 0.72 });
    aura.alpha = selected ? 0.28 : 0;
    container.addChild(aura);

    const base = new Graphics();
    base.roundRect(0, 0, width, height, 8);
    base.fill({
      color: selected ? 0x172a49 : 0x111a2b,
      alpha: VIZ_VISUAL_DEPTH.near.cardAlpha,
    });
    base.stroke({ color: selected ? GPU_COLORS.primary : accent, width: selected ? 1.7 : 1.05, alpha: 0.9 });
    container.addChild(base);

    const depth = new Graphics();
    depth.roundRect(4, 4, width - 8, height - 8, 6);
    depth.stroke({ color: 0x9cb8e8, width: 0.65, alpha: selected ? 0.22 : 0.08 });
    container.addChild(depth);

    const rail = new Graphics();
    rail.roundRect(0, 7, 2.5, height - 14, 1.2).fill(accent);
    rail.alpha = 0.72;
    container.addChild(rail);

    const scan = new Graphics();
    scan.rect(5, 0, width - 10, 1.4).fill({ color: accent, alpha: 0.65 });
    scan.alpha = selected ? 0.15 : 0.035;
    container.addChild(scan);

    const content = new Container();
    container.addChild(content);

    const sparks = Array.from({ length: 3 }, (_, index) => {
      const spark = new Graphics();
      spark.circle(0, 0, 1.25 - index * 0.15).fill(index === 1 ? 0xffffff : accent);
      spark.alpha = selected ? 0.4 : 0;
      container.addChild(spark);
      return spark;
    });

    let hovered = false;
    let pressed = false;
    let shaderHover = 0;
    let shaderSelected = selected ? 1 : 0;
    let elapsed = wasVisible || prefersReducedMotion() ? performance.now() : -entranceDelay;
    container.alpha = wasVisible || prefersReducedMotion() ? 1 : 0;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 300));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.992 : hovered ? 1.008 : 1;
      const scale = easedEntrance * targetScale;
      const depthScaleX = 1 - zDepth * 0.018;
      container.alpha = easedEntrance;
      container.scale.set(scale * depthScaleX, scale);
      container.position.set(
        x + width * (1 - scale * depthScaleX) / 2,
        y + height * (1 - scale) / 2 + (pressed ? 1.4 : hovered ? -1.2 : 0)
      );
      const pulse = 0.5 + Math.sin(elapsed / 190) * 0.5;
      const shaderLerp = prefersReducedMotion() ? 1 : Math.min(1, ticker.deltaMS * 0.014);
      shaderHover += ((hovered ? 1 : 0) - shaderHover) * shaderLerp;
      shaderSelected += ((selected ? 1 : 0) - shaderSelected) * shaderLerp;
      cardShader.uniforms.uTime = elapsed / 1000;
      cardShader.uniforms.uHover = shaderHover;
      cardShader.uniforms.uSelected = shaderSelected;
      aura.alpha = selected
        ? 0.16 + pulse * 0.22
        : hovered
          ? 0.08 + pulse * 0.15
          : 0;
      base.tint = pressed ? 0xb8d8ff : hovered ? 0xd8e9ff : 0xffffff;
      depth.alpha = hovered || selected ? 1 : 0.65;
      extrusion.alpha = hovered ? 0.82 : selected ? 0.75 : 0.58;
      middleExtrusion.alpha = hovered ? 0.92 : selected ? 0.82 : 0.66;
      rail.alpha = selected ? 0.72 + pulse * 0.25 : hovered ? 0.9 : 0.62;
      scan.y = 5 + (Math.max(0, elapsed) * (hovered ? 0.075 : 0.025)) % Math.max(8, height - 10);
      scan.alpha = selected ? 0.08 + pulse * 0.12 : hovered ? 0.09 : 0.025;
      sparks.forEach((spark, index) => {
        const phase = elapsed / 460 + index * 2.1;
        spark.position.set(
          8 + (Math.sin(phase) * 0.5 + 0.5) * (width - 16),
          5 + (Math.cos(phase * 1.4) * 0.5 + 0.5) * (height - 10)
        );
        spark.alpha = selected ? 0.18 + pulse * 0.42 : hovered ? 0.12 + pulse * 0.28 : 0;
      });
    };
    this.addTicker(animate);

    container.on('pointerover', () => { hovered = true; });
    container.on('pointerout', () => {
      hovered = false;
      pressed = false;
    });
    container.on('pointerdown', () => { pressed = true; });
    container.on('pointerup', () => { pressed = false; });
    container.on('pointerupoutside', () => { pressed = false; });
    container.on('pointertap', () => onActivate(`event.${id}`));
    parent.addChild(container);
    this.metrics.hitTargets.push({
      id: `event.${id}`,
      role: 'button',
      label: '',
      x,
      y,
      width,
      height,
    });
    return content;
  }

  private easeOutBack(progress: number, overshoot = 1.35) {
    const shifted = Math.min(1, Math.max(0, progress)) - 1;
    return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
  }

  drawExitingFilterButtons(
    targets: FilterVisualTarget[],
    collapsingLayer: Container,
    collapseDistance: number,
    startedAt = performance.now()
  ) {
    if (!targets.length) return;
    if (prefersReducedMotion()) {
      // Jump to the final layout: no dissolving copies, no collapse slide.
      for (const target of targets) this.handledExitIds.add(target.id);
      collapsingLayer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const snapshotAtStart = this.snapshot;
    const exitDuration = 460 + (targets.length - 1) * 18;
    const collapseDuration = 390;
    let elapsed = Math.max(0, performance.now() - startedAt);
    let completed = elapsed >= exitDuration + collapseDuration;
    let groupsRemoved = elapsed >= exitDuration;
    collapsingLayer.y = groupsRemoved
      ? collapseDistance * (1 - this.easeOutBack((elapsed - exitDuration) / collapseDuration))
      : collapseDistance;
    this.metrics.runCollapseOffset = collapsingLayer.y;
    if (completed) {
      collapsingLayer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const groups = groupsRemoved
      ? []
      : targets.map((target, targetIndex) => {
      this.handledExitIds.add(target.id);
      const container = new Container();
      container.position.set(target.x, target.y);

      const aura = new Graphics();
      aura.roundRect(-3, -3, target.width + 6, target.height + 6, 10);
      aura.stroke({ color: target.accent, width: 2, alpha: 0.75 });
      aura.alpha = target.active ? 0.32 : 0.12;
      container.addChild(aura);

      const base = new Graphics();
      base.roundRect(0, 0, target.width, target.height, 8);
      base.fill({
        color: target.active ? target.accent : 0x111b2c,
        alpha: target.active ? 0.27 : 0.9,
      });
      base.stroke({
        color: target.active ? target.accent : 0x30405d,
        width: target.active ? 1.8 : 1,
      });
      container.addChild(base);

      const label = this.text(
        container,
        target.label,
        target.width / 2,
        Math.max(5, (target.height - 16) / 2),
        {
          size: 11,
          color: target.active ? GPU_COLORS.text : 0xa9b5ca,
          weight: target.active ? '700' : '600',
        }
      );
      label.anchor.x = 0.5;

      const fragments = Array.from({ length: 10 }, (_, index) => {
        const fragment = new Graphics();
        const column = index % 5;
        const row = Math.floor(index / 5);
        fragment.rect(0, 0, 2 + index % 2, 1.4).fill({
          color: index % 3 === 0 ? 0xffffff : target.accent,
        });
        fragment.position.set(
          7 + column / 4 * (target.width - 14),
          6 + row * (target.height - 12)
        );
        fragment.alpha = 0;
        container.addChild(fragment);
        return {
          fragment,
          originX: fragment.x,
          originY: fragment.y,
          vx: (column - 2) * 0.035 + Math.sin(index * 4.1) * 0.02,
          vy: (row ? 1 : -1) * 0.045 - index * 0.001,
        };
      });
      this.root.addChild(container);
      return { container, aura, base, label, fragments, delay: targetIndex * 18 };
    });
    for (const id of targets.map((target) => target.id)) this.handledExitIds.add(id);

    const applyDissolve = (deltaMS: number) => {
      if (groupsRemoved) return;
      for (const group of groups) {
        const local = Math.max(0, elapsed - group.delay);
        const progress = Math.min(1, local / 460);
        const dissolveProgress = Math.max(0, (progress - 0.16) / 0.84);
        group.container.alpha = 1 - dissolveProgress ** 1.45;
        const scale = 1 - dissolveProgress * 0.12;
        group.container.scale.set(scale);
        group.container.position.set(
          group.container.position.x,
          group.container.position.y - deltaMS * 0.008 * dissolveProgress
        );
        group.aura.alpha = (0.18 + Math.sin(local / 55) * 0.12) * (1 - dissolveProgress);
        group.base.tint = 0xffffff - Math.floor(dissolveProgress * 0x202000);
        group.label.alpha = 1 - dissolveProgress * 1.25;
        for (const fragment of group.fragments) {
          fragment.fragment.alpha = Math.sin(Math.PI * dissolveProgress) * 0.9;
          fragment.fragment.x =
            fragment.originX + fragment.vx * local * dissolveProgress;
          fragment.fragment.y =
            fragment.originY + fragment.vy * local * dissolveProgress;
          fragment.fragment.rotation += deltaMS * 0.004;
        }
      }
    };

    const applyCollapse = () => {
      const collapseProgress = Math.max(
        0,
        Math.min(1, (elapsed - exitDuration) / collapseDuration)
      );
      if (collapseProgress > 0) {
        collapsingLayer.y = collapseDistance * (1 - this.easeOutBack(collapseProgress));
        this.metrics.runCollapseOffset = collapsingLayer.y;
      }
      return collapseProgress;
    };

    applyDissolve(0);
    applyCollapse();

    const dissolve = (ticker: Ticker) => {
      elapsed = Math.max(0, performance.now() - startedAt);
      applyDissolve(ticker.deltaMS);
      if (!groupsRemoved && elapsed >= exitDuration) {
        groupsRemoved = true;
        for (const group of groups) {
          group.container.removeFromParent();
          group.container.destroy({ children: true });
        }
      }
      const collapseProgress = applyCollapse();
      if (!completed && collapseProgress >= 1) {
        completed = true;
        collapsingLayer.y = 0;
        this.metrics.runCollapseOffset = 0;
        this.roleRowTransition = null;
        this.app.ticker.remove(dissolve);
        this.tickerCallbacks.delete(dissolve);
        requestAnimationFrame(() => {
          if (snapshotAtStart && this.snapshot === snapshotAtStart) {
            this.render(snapshotAtStart);
          }
        });
      }
    };
    this.addTicker(dissolve);
  }

  animateEnteringFilterSpace(
    layer: Container,
    distance: number,
    startedAt = performance.now()
  ) {
    if (distance <= 0) return;
    if (prefersReducedMotion()) {
      layer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const duration = 390;
    const apply = (elapsed: number) => {
      const progress = Math.min(1, elapsed / duration);
      layer.y = -distance * (1 - this.easeOutBack(progress));
      this.metrics.runCollapseOffset = layer.y;
      return progress;
    };
    if (apply(Math.max(0, performance.now() - startedAt)) >= 1) {
      layer.y = 0;
      this.metrics.runCollapseOffset = 0;
      this.roleRowTransition = null;
      return;
    }
    const expand = () => {
      const progress = apply(Math.max(0, performance.now() - startedAt));
      if (progress >= 1) {
        layer.y = 0;
        this.metrics.runCollapseOffset = 0;
        this.roleRowTransition = null;
        this.app.ticker.remove(expand);
        this.tickerCallbacks.delete(expand);
      }
    };
    this.addTicker(expand);
  }

  private drawRemovedFilterEffects() {
    for (const [id, target] of this.previousFilterBounds) {
      if (this.currentFilterBounds.has(id)) continue;
      if (this.handledExitIds.has(id)) continue;
      if (prefersReducedMotion()) {
        // Decorative exit particles: under reduced motion the control simply
        // disappears — never schedule a ticker that would outlive its cause.
        this.handledExitIds.add(id);
        continue;
      }
      const particles = new Container();
      const centerX = target.x + target.width / 2;
      const centerY = target.y + target.height / 2;
      const sprites = Array.from({ length: 14 }, (_, index) => {
        const particle = new Graphics();
        const angle = index / 14 * Math.PI * 2;
        const color = index % 3 === 0 ? 0xffffff : GPU_COLORS.primary;
        particle.circle(0, 0, index % 2 === 0 ? 1.8 : 1.1).fill(color);
        particle.position.set(centerX, centerY);
        particles.addChild(particle);
        return {
          particle,
          vx: Math.cos(angle) * (0.045 + index % 4 * 0.012),
          vy: Math.sin(angle) * (0.035 + index % 3 * 0.014) - 0.018,
        };
      });
      this.root.addChild(particles);
      let elapsed = 0;
      const dissolve = (ticker: Ticker) => {
        elapsed += ticker.deltaMS;
        const progress = Math.min(1, elapsed / 420);
        for (const sprite of sprites) {
          sprite.particle.x += sprite.vx * ticker.deltaMS;
          sprite.particle.y += sprite.vy * ticker.deltaMS;
          sprite.particle.alpha = (1 - progress) ** 1.7;
          sprite.particle.scale.set(1 + progress * 0.8);
        }
        if (progress >= 1) {
          this.app.ticker.remove(dissolve);
          this.tickerCallbacks.delete(dissolve);
          particles.removeFromParent();
          particles.destroy({ children: true });
        }
      };
      this.addTicker(dissolve);
    }
  }

  private drawViewTransition(width: number, height: number) {
    const transition = this.activeViewTransition;
    if (!transition) return;
    const initialElapsed = performance.now() - transition.startedAt;
    if (initialElapsed >= 560 || prefersReducedMotion()) {
      this.activeViewTransition = null;
      return;
    }
    const layer = new Container();
    layer.eventMode = 'none';
    const bars = Array.from({ length: 16 }, (_, index) => {
      const bar = new Graphics();
      const barWidth = 42;
      bar.poly([
        0, 0,
        barWidth, 0,
        barWidth - 80, height,
        -80, height,
      ]);
      bar.fill({
        color:
          index % 3 === 0
            ? GPU_COLORS.primary
            : index % 3 === 1
              ? GPU_COLORS.tiers[3]
              : GPU_COLORS.cyan,
        alpha: 0.075,
      });
      layer.addChild(bar);
      return bar;
    });
    const beam = new Graphics();
    beam.rect(0, 0, 3, height).fill({ color: 0xd9ecff, alpha: 0.9 });
    layer.addChild(beam);
    const particles = Array.from({ length: 22 }, (_, index) => {
      const particle = new Graphics();
      particle.circle(0, 0, 1 + index % 3 * 0.4).fill(
        index % 2 ? GPU_COLORS.primary : GPU_COLORS.cyan
      );
      layer.addChild(particle);
      return particle;
    });
    const label = this.text(
      layer,
      transition.to.toUpperCase(),
      0,
      height * 0.18,
      { size: 11, color: 0xd9ecff, weight: '700' }
    );
    this.root.addChild(layer);

    let elapsed = initialElapsed;
    const animate = (ticker: Ticker) => {
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const progress = Math.min(1, elapsed / 560);
      const eased = 1 - (1 - progress) ** 3;
      const sweepX = -width * 0.42 + eased * width * 1.55;
      bars.forEach((bar, index) => {
        bar.position.set(sweepX + index * 34, 0);
        bar.alpha = Math.sin(Math.PI * progress) * (0.34 - index * 0.008);
      });
      beam.position.x = sweepX + 15 * 34;
      beam.alpha = Math.sin(Math.PI * progress) * 0.65;
      label.position.set(beam.x - 84, height * 0.18);
      label.alpha = Math.sin(Math.PI * progress) * 0.75;
      particles.forEach((particle, index) => {
        const phase = index * 1.71 + elapsed / 190;
        particle.position.set(
          beam.x - 20 - Math.abs(Math.sin(phase)) * 110,
          index / particles.length * height + Math.sin(phase * 1.4) * 24
        );
        particle.alpha = Math.sin(Math.PI * progress) * (0.2 + index % 3 * 0.12);
      });
      if (progress >= 1) {
        this.activeViewTransition = null;
        this.app.ticker.remove(animate);
        this.tickerCallbacks.delete(animate);
        layer.removeFromParent();
        layer.destroy({ children: true });
      }
    };
    this.addTicker(animate);
  }

  private drawAtomaMark(x: number, y: number) {
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'none';
    const crystal = new Container();
    crystal.position.set(14, 14);
    crystal.pivot.set(14, 14);
    const aura = new Graphics();
    const shadow = new Graphics();
    const faceGlow = new Graphics();
    const facets = new Graphics();
    const clearcoat = new Graphics();
    const core = new Graphics();
    crystal.addChild(aura, shadow, faceGlow, facets, clearcoat, core);
    container.addChild(crystal);

    const traceFace = (
      graphics: Graphics,
      points: readonly [AtomaMarkPoint, AtomaMarkPoint, AtomaMarkPoint]
    ) => graphics
      .moveTo(points[0].x, points[0].y)
      .lineTo(points[1].x, points[1].y)
      .lineTo(points[2].x, points[2].y)
      .closePath();

    const paint = (elapsedMs: number) => {
      const frame = buildAtomaMarkFrame(elapsedMs);
      crystal.scale.set(frame.scale * 1.12);
      aura
        .clear()
        .circle(14, 14, 12.6 + frame.pulse * 0.65)
        .fill({ color: 0x4169e1, alpha: 0.018 + frame.pulse * 0.014 })
        .circle(14, 14, 9.6 + frame.pulse * 0.4)
        .fill({ color: GPU_COLORS.cyan, alpha: 0.018 + frame.pulse * 0.012 });
      shadow
        .clear()
        .ellipse(14.4, 25.2, 6.6, 1.35)
        .fill({ color: 0x020817, alpha: 0.34 });
      faceGlow.clear();
      facets.clear();
      clearcoat.clear();

      for (const face of frame.faces) {
        traceFace(faceGlow, face.points).stroke({
          color: face.edgeColor,
          width: 2.4,
          alpha: face.glowAlpha,
        });
        traceFace(facets, face.points)
          .fill({ color: face.fillColor, alpha: 0.985 })
          .stroke({
            color: face.edgeColor,
            width: 0.82,
            alpha: 0.48 + face.sheenAlpha * 0.9,
          });

        const inset = face.points.map((point) => ({
          x: point.x + (face.centroid.x - point.x) * 0.22,
          y: point.y + (face.centroid.y - point.y) * 0.22,
        })) as [AtomaMarkPoint, AtomaMarkPoint, AtomaMarkPoint];
        traceFace(clearcoat, inset).fill({
          color: 0xffffff,
          alpha: face.sheenAlpha,
        });
        const highPoint = face.points.reduce((highest, point) =>
          point.y < highest.y ? point : highest
        );
        clearcoat
          .moveTo(highPoint.x, highPoint.y)
          .lineTo(
            highPoint.x + (face.centroid.x - highPoint.x) * 0.58,
            highPoint.y + (face.centroid.y - highPoint.y) * 0.58
          )
          .stroke({ color: 0xffffff, width: 0.72, alpha: face.sheenAlpha * 1.25 });
      }

      const { x: coreX, y: coreY } = frame.corePosition;
      core.clear();
      core
        .circle(coreX, coreY, 4.4 + frame.pulse * 0.55)
        .fill({ color: GPU_COLORS.cyan, alpha: 0.035 + frame.pulse * 0.025 })
        .circle(coreX, coreY, 2.8 + frame.pulse * 0.2)
        .fill({ color: 0x6ea8ff, alpha: 0.09 + frame.pulse * 0.055 })
        .circle(
          coreX,
          coreY,
          ATOMA_MARK_CORE_RADIUS + frame.pulse * ATOMA_MARK_CORE_RADIUS_PULSE
        )
        .fill({ color: 0xf8fbff, alpha: 0.98 })
        .stroke({
          color: GPU_COLORS.cyan,
          width: ATOMA_MARK_CORE_STROKE_WIDTH,
          alpha: 0.96,
        })
        .circle(coreX - 0.45, coreY - 0.5, 0.45)
        .fill({ color: 0xffffff, alpha: 0.96 });
    };

    const reducedMotion = prefersReducedMotion();
    paint(reducedMotion ? 0 : performance.now());
    if (!reducedMotion) {
      this.addTicker(() => {
        paint(performance.now());
      });
    }
    this.root.addChild(container);
  }

  private drawHeader(snapshot: GpuRenderSnapshot, width: number) {
    this.panel(
      this.root,
      0,
      0,
      width,
      GPU_LAYOUT.headerHeight,
      0x0b111e,
      GPU_COLORS.border,
      0,
      2
    );
    this.drawAtomaMark(10, 12);
    this.text(this.root, 'Atoma', 49, 17.5, {
      size: 16,
      color: 0x263f68,
      weight: '700',
      alpha: 0.72,
    });
    this.text(this.root, 'Atoma', 48, 16, {
      size: 16,
      color: GPU_COLORS.text,
      weight: '700',
    });

    const views: ViewName[] = ['runs', 'registry', 'skills', 'burnin', 'launch'];
    let x = 160;
    for (const view of views) {
      const label = snapshot.t(`nav.${view}`).toUpperCase();
      this.navButton(
        this.root,
        `nav.${view}`,
        label,
        x,
        10,
        Math.max(66, label.length * 7 + 22),
        32,
        snapshot.state.view === view,
        snapshot.onActivate
      );
      x += Math.max(66, label.length * 7 + 22) + NAV_HOVER_GAP;
    }

    this.button(
      this.root,
      'locale.toggle',
      'button',
      snapshot.state.locale === 'en' ? 'EN' : 'FR',
      width - 104,
      10,
      42,
      32,
      false,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
    this.button(
      this.root,
      'refresh',
      'button',
      '↻',
      width - 54,
      10,
      42,
      32,
      false,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
  }

  private drawOverlays(snapshot: GpuRenderSnapshot, width: number, height: number) {
    if (snapshot.state.view !== 'runs' || snapshot.state.focusedInput !== 'run') return;
    const x = Math.max(480, width * 0.42);
    const popupWidth = Math.max(260, width - x - 120);
    const popupY = GPU_LAYOUT.headerHeight - 2;
    const rowHeight = 43;
    const headerHeight = 30;
    const query = snapshot.state.search.run;
    const matching = snapshot.data.runs
      .filter((run) => matchesSearchQuery(runSearchText(run), query));
    const maximumPopupHeight = Math.min(500, height - popupY - 10);
    const listViewportHeight = Math.max(
      rowHeight,
      maximumPopupHeight - headerHeight - 7
    );
    const contentHeight = matching.length * rowHeight;
    this.runPickerScrollMax = Math.max(0, contentHeight - listViewportHeight);
    const scrollY = Math.max(
      0,
      Math.min(this.runPickerScrollMax, snapshot.state.runPickerScrollY)
    );
    const visibleListHeight = Math.min(listViewportHeight, Math.max(rowHeight, contentHeight));
    const popupHeight = headerHeight + visibleListHeight + 7;
    this.runPickerBounds = new Rectangle(x, popupY, popupWidth, popupHeight);
    this.panel(
      this.root,
      x,
      popupY,
      popupWidth,
      popupHeight,
      0x0c1321,
      GPU_COLORS.primary,
      GPU_LAYOUT.radius,
      2
    );
    this.text(
      this.root,
      `${matching.length} / ${snapshot.data.runs.length} RUNS`,
      x + 12,
      popupY + 8,
      { size: 9, color: GPU_COLORS.muted, weight: '700' }
    );

    const listY = popupY + headerHeight;
    const listMask = new Graphics();
    listMask
      .rect(x + 4, listY, popupWidth - 8, visibleListHeight)
      .fill(0xffffff);
    this.root.addChild(listMask);
    const listLayer = new Container();
    listLayer.mask = listMask;
    this.root.addChild(listLayer);

    const start = Math.max(0, Math.floor(scrollY / rowHeight));
    const visibleCount = Math.ceil(visibleListHeight / rowHeight) + 2;
    matching.slice(start, start + visibleCount).forEach((run, visibleIndex) => {
      const index = start + visibleIndex;
      const rowY = listY + index * rowHeight - scrollY;
      const keyboardActive = index === snapshot.state.runPickerActiveIndex;
      const selected = snapshot.state.selectedRunId === run.id;
      const status = run.cancelled
        ? '✕'
        : run.hasError
          ? '!'
          : run.inFlight
            ? '●'
            : selected
              ? '◆'
              : '';
      this.button(
        listLayer,
        `run.select.${run.id}`,
        'option',
        `${status ? `${status} ` : ''}${truncate(
          run.label.replace(/^(?:build-app|baseline):\s*/i, ''),
          82
        )}`,
        x + 5,
        rowY + 2,
        popupWidth - 18,
        38,
        keyboardActive,
        snapshot.onActivate,
        run.hasError
          ? GPU_COLORS.error
          : run.inFlight
            ? GPU_COLORS.success
            : selected
              ? GPU_COLORS.tiers[3]
              : GPU_COLORS.primary
      );
    });

    // ONE scrollbar-thumb definition (renderer/scroll-pane.ts) — the popup
    // keeps its 4px-inset track but shares geometry/styling with every other
    // scrollable region. No-ops when runPickerScrollMax is 0.
    drawScrollbarThumb(this.root, {
      x,
      y: listY + 4,
      width: popupWidth,
      height: visibleListHeight - 8,
      scrollY,
      maxScroll: this.runPickerScrollMax,
    });
    if (!matching.length) {
      this.text(this.root, snapshot.t('runs.none'), x + 14, listY + 12, {
        size: 11,
        color: GPU_COLORS.muted,
      });
    }
  }

  detailMask(x: number, y: number, width: number, height: number) {
    const mask = new Graphics();
    mask.rect(x, y, width, height).fill(0xffffff);
    mask.eventMode = 'none';
    this.root.addChild(mask);
    return mask;
  }

}

// Pixi owns an imperative object graph whose instances survive React Fast
// Refresh. Replacing this class in place can leave an old instance calling a
// newly-added prototype method, so renderer edits deliberately trigger one
// clean reload instead of attempting stateful HMR.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

/**
 * The narrow surface views draw against. Views are free functions over this
 * context: the renderer class implements it, and behavior tests implement a
 * recording double without any GPU. Derived with Pick so the class stays the
 * single source of member signatures.
 */
export type RendererCtx = Pick<
  GpuRenderer,
  | 'root'
  | 'text'
  | 'panel'
  | 'button'
  | 'filterButton'
  | 'statCard'
  | 'atomButton'
  | 'eventCard'
  | 'collapseCaret'
  | 'filterBlockFrame'
  | 'detailMask'
  | 'addTicker'
  | 'drawExitingFilterButtons'
  | 'animateEnteringFilterSpace'
  | 'metrics'
  | 'scrollMax'
  | 'detailScrollY'
  | 'detailScrollMax'
  | 'detailBounds'
  | 'roleRowTransition'
  | 'seenAnimatedControls'
  | 'previousFilterBounds'
>;
