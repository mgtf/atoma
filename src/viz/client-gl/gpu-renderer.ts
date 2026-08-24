import {
  Application,
  CanvasTextMetrics,
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
  VizAccountModels,
  VizAdminInvitation,
  VizAdminOrganisation,
  VizLedgerEvent,
  VizOrganisation,
  VizPlatformEvent,
  VizSentinelSnapshot,
  VizGitHubInstallation,
  VizProject,
  VizProjectRun,
  VizRun,
} from '../client/types.js';
import {
  ATOMA_MARK_LOCAL_CENTER,
  attachAtomaMark,
  type AtomaMarkHandle,
} from './renderer/atoma-mark.js';
import { createFarField, FAR_FIELD_LABEL, type FarField } from './renderer/far-field.js';
import {
  markElapsedMs,
  markTurnDegrees,
  pinMarkElapsedMs,
  pinMarkTurnDegrees,
  markBeadVisible,
  setMarkBeadVisible,
  markClockIsPinned,
} from './renderer/mark-clock.js';
import {
  CAST_SHADOW_REACH_PX,
  type CastShadowSurface,
  surfaceDepthScale,
  ambientShadowOffset,
  castShadowOffset,
} from './renderer/cast-shadow.js';
import { softShadowLayers } from './renderer/soft-shadow.js';
import { LabelCache } from './renderer/label-cache.js';
import { NO_TINT, mixColor, multiplyTint } from './renderer/label-tint.js';
import { FPS_REFRESH_MS, formatFps, fpsColor } from './renderer/fps-readout.js';
import {
  emptyRenderMetrics,
  type GpuHitTarget,
  type GpuRenderMetrics,
} from './renderer/metrics.js';
import {
  TUNING_LABEL_WIDTH,
  TUNING_READOUT_WIDTH,
  TUNING_ROW_HEIGHT,
} from './renderer/tuning-layout.js';
import { pointerClientToRenderer, readPointerLight, movePointerLight, hidePointerLight } from './pointer-light.js';
import { packMarkCaustic, readMarkFieldCaustic } from './mark-field-light.js';
import { TooltipLayer } from './renderer/tooltip.js';
import type { GpuUiState, ViewName } from './store.js';
import { GPU_COLORS, GPU_LAYOUT, sidebarWidthForViewport } from './theme.js';
import { VIZ_VISUAL_DEPTH } from './visual-depth.js';
import type { AuthUiSnapshot } from './AuthControls.js';

export interface GpuDataSnapshot {
  auth: AuthUiSnapshot | null;
  runs: RunIndexEntry[];
  run: VizRun | null;
  registries: RegistrySummary[];
  registry: { registry: RegistrySummary; types: RegistryType[] } | null;
  skillNamespaces: SkillNamespace[];
  skillsByNamespace: Record<string, SkillSummary[]>;
  skillDetail: SkillSummary | null;
  burnin: { rows: BurninRow[]; csvPath: string } | null;
  profiles: LaunchProfile[];
  projects: VizProject[];
  projectRuns: Record<string, VizProjectRun[]>;
  githubInstallations: VizGitHubInstallation[];
  adminOrganisations: VizAdminOrganisation[];
  adminInvitation: VizAdminInvitation | null;
  adminError: string | null;
  /**
   * The platform audit journal, newest first — every page loaded so far,
   * flattened. The Journal view scrolls one continuous list, so the page
   * boundaries are the fetch's business and not the view's.
   */
  adminEvents: VizPlatformEvent[];
  /** Whether the server said there is an older page after the ones loaded. */
  adminEventsHasMore: boolean;
  /** A page is in flight: the list foot says so instead of offering it again. */
  adminEventsLoading: boolean;
  /** The product ledger's tail — a SEPARATE journal, in its own view. */
  adminLedger: VizLedgerEvent[];
  /** Rule table, live coverage and findings for the Sentinel view. */
  adminSentinel: VizSentinelSnapshot | null;
  /** The viewer's own organisation — the Settings org card. */
  organisation: VizOrganisation | null;
  /** Per-tier model pins plus the operator defaults to label them against. */
  accountModels: VizAccountModels | null;
  /** Last failed account write, already bounded by the server. */
  accountError: string | null;
  /**
   * Non-null when the gate is on and this browser holds no session: the
   * arrival gate offers these providers instead of Continue, and `notice`
   * names a login failure bounced back by the server (`?authNotice=`).
   */
  login: { providers: { id: string; label: string }[]; notice: string | null } | null;
  loading: boolean;
  error: string | null;
}

export interface FilterVisualTarget extends GpuHitTarget {
  active: boolean;
  accent: number;
  /** Screen-space geometry captured while the parent transform is live. */
  rendererX: number;
  rendererY: number;
  rendererWidth: number;
  rendererHeight: number;
}

type TuningKey = keyof VizTuning;

function formatTuningValue(key: TuningKey, value: number): string {
  const range = TUNING_RANGE[key];
  const decimals = range.step < 1 ? 2 : 0;
  return `${value.toFixed(decimals)}${range.unit}`;
}

/** Linear 0..359 mapping for the welcome turn slider. 360 wraps to 0. */
function markTurnDegreeFromTrack(localX: number, trackX: number, trackWidth: number): number {
  const t = Math.max(0, Math.min(1, (localX - trackX) / Math.max(1, trackWidth)));
  return Math.round(t * 359);
}

function trackXFromTurnDegree(degrees: number, trackX: number, trackWidth: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return trackX + wrapped / 360 * trackWidth;
}

export interface GpuRenderSnapshot {
  state: GpuUiState;
  data: GpuDataSnapshot;
  releaseVersion: string;
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
  /** Keep bounded row copy on one line, fitting against real Pixi metrics. */
  singleLine?: boolean;
  mono?: boolean;
  alpha?: number;
}

/** Diameter of the account orb in the header. */
export const HEADER_ORB_SIZE = 34;
/** Centred scale used by a hovered left-rail item. */
export const NAV_HOVER_SCALE = 1.045;

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
export {
  emptyRenderMetrics,
  type GpuHitTarget,
  type GpuRenderMetrics,
  type GpuTimelineViewport,
} from './renderer/metrics.js';
export { TUNING_ROW_HEIGHT as TUNING_PANEL_ROW_HEIGHT } from './renderer/tuning-layout.js';
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
import { readTuning, setTuningValue } from './tuning-live.js';
import {
  TUNING_IDENTITY,
  TUNING_RANGE,
  trackXFromTuningValue,
  tuningValueFromTrack,
  type VizTuning,
} from './tuning.js';
import { prefersReducedMotion } from './renderer/motion.js';
import { drawScrollbarThumb } from './renderer/scroll-pane.js';
import { drawRuns } from './renderer/views/runs.js';
import { drawRegistry } from './renderer/views/registry.js';
import { drawSkills } from './renderer/views/skills.js';
import { drawBurnin } from './renderer/views/burnin.js';
import { drawDocs } from './renderer/views/docs.js';
import { drawProjects } from './renderer/views/projects.js';
import { drawAdmin } from './renderer/views/admin.js';
import { drawJournal } from './renderer/views/journal.js';
import { drawLedger } from './renderer/views/ledger.js';
import { drawSentinel } from './renderer/views/sentinel.js';
import { drawAnnounce } from './renderer/views/announce.js';
import { drawWelcome } from './renderer/views/welcome.js';
import { drawAccountMenu } from './renderer/views/account-menu.js';
import { drawSettings } from './renderer/views/settings.js';
import { drawSidebar } from './renderer/views/sidebar.js';
import { attachAvatarOrb, type AvatarOrbHandle } from './renderer/avatar-orb.js';

export class GpuRenderer {
  app = new Application();
  readonly ambientRoot = new Container();
  /**
   * The persistent scene root: filtered by the pointer light, cleared and
   * rebuilt by every `render()`, and the thing added to the Pixi stage.
   */
  private readonly stage = new Container();
  /**
   * Where the CURRENT pass draws. Chrome (header, nav rail, overlays, account
   * menu) draws into the stage; the view pass draws into a viewport layer that
   * is ALREADY positioned beside the nav rail when the view starts drawing.
   *
   * Positioned first, not shifted afterwards, and that ordering is the whole
   * point: controls resolve their own screen geometry with `parent.toGlobal()`
   * — sometimes lazily, from a closure, on a later pointer event. Reparenting
   * a finished view left those closures holding the old ancestor, and the
   * tuning slider's drag mapped the pointer against a track 208px from where
   * it was drawn. A layer that exists before the draw has no such window.
   */
  root: Container = this.stage;
  /**
   * Crystals live HERE, not under `root`. The pointer-light filter flattens
   * `root` and its interior wash is a disc on any filled mesh — including the
   * arrival gem. Sibling, drawn after, so the header gem still sits on the
   * bar rather than under it.
   */
  readonly markRoot = new Container();
  /**
   * The one crystal, RETAINED across scene rebuilds like the far field.
   * Attaching per render leaked its render textures, geometries and shader —
   * `Mesh.destroy()` only nulls those references, and WebGPU GC is pinned
   * off. The key captures every attach parameter; a mismatch (view change,
   * resize, resolution change) destroys the old mark properly and builds a
   * new one.
   */
  private atomaMark: { key: string; handle: AtomaMarkHandle } | null = null;
  /**
   * The account orbs, retained on the same terms as the crystal above: each
   * mesh carries a shader, a geometry and a decoded avatar texture, none of
   * which should be rebuilt sixty times a second because `renderScene` tears
   * the scene down. TWO slots exist because two views draw one concurrently —
   * the header's control and the Settings profile orb — and a single slot had
   * them evicting each other every render. `avatarOrbsRetained` is per-frame
   * accounting: a slot no draw call claimed this frame (signed out, left
   * Settings) is destroyed by `sweepAvatarOrbs`, never left parked on the
   * scene.
   */
  private readonly avatarOrbs = new Map<string, { key: string; handle: AvatarOrbHandle }>();
  private avatarOrbsRetained = new Set<string>();
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
    uRadiusScale: number;
    uHueShift: number;
    uCaustic0: Float32Array;
    uCaustic1: Float32Array;
    uCaustic2: Float32Array;
    uCaustic3: Float32Array;
    uCaustic4: Float32Array;
    uCaustic5: Float32Array;
    uCausticColor: Float32Array;
  } | null = null;
  /** The cast's uniform slots, in declaration order. Built once. */
  private pointerCausticSlots: Float32Array[] = [];
  private pointerLightStrength = 0;
  /** Light position in renderer pixels, published by `updatePointerLight`. */
  private lightRendererX = 0;
  private lightRendererY = 0;
  private pointerLightBufferPinned = false;
  private farField: FarField | null = null;
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
  /**
   * The hover bubble. Its own sibling ABOVE the crystal, so no scene rebuild
   * and no view's container transform can touch it, and it draws over
   * everything including the account menu.
   */
  private tooltipLayer: TooltipLayer | null = null;
  private readonly tooltipRoot = new Container();
  private readonly labels = new LabelCache<Text>({
    detach: (label) => label.removeFromParent(),
    release: (label) => {
      label.style = {};
      label.destroy({ children: true, style: true });
    },
    isDestroyed: (label) => label.destroyed,
  });
  /**
   * Surfaces that throw a shadow from the pointer light. Rebuilt with the
   * scene — the Graphics are children of containers the next render destroys —
   * and read every frame by `updateCastShadows`.
   */
  /**
   * The live tuning drag: a KEY and a track geometry, never a display object.
   * Holding a Pixi object here is what broke the previous slider, since
   * `render()` destroys the whole scene between two pointer moves.
   */
  private tuningDrag: { key: TuningKey; trackX: number; trackWidth: number } | null = null;
  /**
   * Sibling of `tuningDrag` for the welcome turn slider. Same contract: a
   * track geometry, never a display object — `render()` wipes the scene
   * between pointer moves.
   */
  private turnDrag: { trackX: number; trackWidth: number } | null = null;
  private turnSliderBounds: Rectangle | null = null;
  private turnSliderLastTapAt = 0;

  private castShadows: {
    shadow: Graphics;
    parent: Container;
    localX: number;
    localY: number;
    width: number;
    height: number;
    depth: number;
    surface: CastShadowSurface;
    left: number;
    top: number;
  }[] = [];
  metrics: GpuRenderMetrics = emptyRenderMetrics();
  private readonly wheel = (event: WheelEvent) => {
    if (!this.snapshot) return;
    event.preventDefault();
    if (!this.snapshot.state.entered && this.turnSliderBounds) {
      const bounds = this.app.canvas.getBoundingClientRect();
      const local = pointerClientToRenderer(
        event.clientX,
        event.clientY,
        bounds,
        this.app.screen.width,
        this.app.screen.height
      );
      if (this.turnSliderBounds.contains(local.x, local.y)) {
        const step = event.shiftKey ? 10 : 1;
        const delta = event.deltaY > 0 ? step : event.deltaY < 0 ? -step : 0;
        if (delta !== 0) {
          pinMarkTurnDegrees((markTurnDegrees() + delta + 360) % 360);
        }
        return;
      }
    }
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
    // REACHED THE BOTTOM. The wheel handler is the only place that knows a
    // view's scroll maximum, so it is the only place that can say a downward
    // wheel had nowhere left to go — which is what "continuous scroll" needs
    // in order to ask for the next page. Announced through the ordinary
    // activation channel rather than a second callback; the handler makes it
    // idempotent (a fetch already in flight, or no next page, is a no-op).
    if (event.deltaY > 0 && maximum > 0 && next >= maximum) {
      this.snapshot.onActivate(`scroll.end.${view}`);
    }
  };

  /**
   * The tuning drag lives on the CANVAS, not on the row.
   *
   * A pointer that leaves the 12px thumb — which it does immediately, because
   * dragging is a horizontal gesture and the hand wanders vertically — must
   * keep driving the value. Pixi delivers moves to the object under the
   * pointer, so the row itself cannot see them. These listeners are installed
   * in `init()` and removed in `destroy()` alongside the wheel handler, rather
   * than at module import: the previous version registered window listeners as
   * an import side effect, so every renderer ever constructed left a pair
   * behind.
   */
  private readonly tuningPointerMove = (event: PointerEvent) => {
    if (!this.tuningDrag && !this.turnDrag) return;
    // A release outside the window, or a pointercancel we never saw, leaves
    // the button up with the drag still armed. Trust the event, not our state.
    if (event.buttons === 0) {
      this.tuningDrag = null;
      this.turnDrag = null;
      return;
    }
    const bounds = this.app.canvas.getBoundingClientRect();
    const local = pointerClientToRenderer(
      event.clientX,
      event.clientY,
      bounds,
      this.app.screen.width,
      this.app.screen.height
    );
    // Both coordinates in RENDERER space. The bug this replaces compared a
    // window clientX against a Pixi local position.x, which agreed only by
    // accident on an unscaled canvas sitting at the window origin.
    const tuning = this.tuningDrag;
    if (tuning) {
      setTuningValue(
        tuning.key,
        tuningValueFromTrack(tuning.key, local.x, tuning.trackX, tuning.trackWidth)
      );
    }
    const turn = this.turnDrag;
    if (turn) {
      pinMarkTurnDegrees(markTurnDegreeFromTrack(local.x, turn.trackX, turn.trackWidth));
    }
  };

  private readonly tuningPointerUp = () => {
    this.tuningDrag = null;
    this.turnDrag = null;
  };

  /**
   * Moves the hover bubble from the SAME mutable pointer sample the pointer
   * light reads, once per frame. Regions were declared in renderer pixels by
   * the last render, so the pointer is converted the same way.
   */
  private readonly updateTooltip = () => {
    const tooltip = this.tooltipLayer;
    if (!tooltip) return;
    const pointer = readPointerLight();
    const bounds = this.app.canvas.getBoundingClientRect();
    const local = pointerClientToRenderer(
      pointer.clientX,
      pointer.clientY,
      bounds,
      this.app.screen.width,
      this.app.screen.height
    );
    tooltip.update(
      { x: local.x, y: local.y, active: pointer.active },
      performance.now(),
      { width: this.app.screen.width, height: this.app.screen.height }
    );
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
    const tuning = readTuning();
    uniforms.uLightPx[0] = local.x;
    uniforms.uLightPx[1] = local.y;
    uniforms.uStrength = this.pointerLightStrength * tuning.lightIntensity;
    uniforms.uRadiusScale = tuning.lightHeight;
    uniforms.uHueShift = tuning.lightHue;
    // The crystal's cast, on the UI this filter covers. Same packer the
    // far-field mesh behind the UI uses, same renderer pixels, so one
    // diamond crosses the backdrop and the buttons as a single shape.
    const cast = packMarkCaustic(
      readMarkFieldCaustic(),
      bounds,
      this.app.screen.width,
      this.app.screen.height
    );
    for (let index = 0; index < this.pointerCausticSlots.length; index += 1) {
      const slot = this.pointerCausticSlots[index]!;
      const corner = cast?.corners[index];
      // No cast parks the slots meaninglessly; the intensity below is the
      // guard that actually turns the shape off.
      slot[0] = corner?.x ?? -1e6;
      slot[1] = corner?.y ?? -1e6;
    }
    uniforms.uCausticColor[0] = cast?.r ?? 0;
    uniforms.uCausticColor[1] = cast?.g ?? 0;
    uniforms.uCausticColor[2] = cast?.b ?? 0;
    uniforms.uCausticColor[3] = cast?.intensity ?? 0;
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
          // Live tuning, read off the ticker sample every frame. Both default
          // to the identity, so a session that never opens the panel renders
          // exactly what it rendered before these existed.
          uRadiusScale: { value: 1, type: 'f32' },
          uHueShift: { value: 0, type: 'f32' },
          // The crystal's cast. Declaration order is load-bearing: Pixi
          // derives the UBO layout from it and the WGSL struct restates the
          // same order by hand.
          uCaustic0: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCaustic1: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCaustic2: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCaustic3: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCaustic4: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCaustic5: { value: new Float32Array([-1e6, -1e6]), type: 'vec2<f32>' },
          uCausticColor: { value: new Float32Array(4), type: 'vec4<f32>' },
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
      uRadiusScale: number;
      uHueShift: number;
      uCaustic0: Float32Array;
      uCaustic1: Float32Array;
      uCaustic2: Float32Array;
      uCaustic3: Float32Array;
      uCaustic4: Float32Array;
      uCaustic5: Float32Array;
      uCausticColor: Float32Array;
    };
    this.pointerCausticSlots = [
      this.pointerLightUniforms.uCaustic0,
      this.pointerLightUniforms.uCaustic1,
      this.pointerLightUniforms.uCaustic2,
      this.pointerLightUniforms.uCaustic3,
      this.pointerLightUniforms.uCaustic4,
      this.pointerLightUniforms.uCaustic5,
    ];
    this.stage.filters = [filter];
    this.app.ticker.add(this.updatePointerLight);
    // AFTER the light: it damps `pointerLightStrength`, which the cast reads.
    this.app.ticker.add(this.updateCastShadows);
  }

  /**
   * Aurora lives on ambientRoot for the session. Scene rebuilds wipe that
   * container; skip the field mesh or the shader is compiled again every
   * render — and the welcome gem's env capture would miss the field for a
   * frame after every rebuild.
   */
  private retainFarField() {
    const keep = this.farField?.mesh;
    if (!keep || keep.destroyed) return;
    if (keep.parent !== this.ambientRoot) {
      this.ambientRoot.addChildAt(keep, 0);
      return;
    }
    if (this.ambientRoot.getChildIndex(keep) !== 0) {
      this.ambientRoot.setChildIndex(keep, 0);
    }
  }

  private readonly tickFarField = (ticker: Ticker) => {
    if (!this.farField) return;
    const canvas = this.app.canvas;
    this.farField.tick(
      ticker.deltaMS / 1000,
      this.app.screen.width,
      this.app.screen.height,
      canvas.getBoundingClientRect()
    );
  };

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
    // Pixi 8.19.0 WebGPU GC unloads uniform buffers whose cached bind groups
    // still point at them (pixijs#12080). Victims include the disabled
    // pointer-light filter AND in-use static groups (global uniforms, batcher
    // UBOs) whose values have not changed — sitting on a quiet view for ~60s
    // then drawing again submits a destroyed GPUBuffer:
    //   [Buffer (unlabeled)] used in submit while destroyed
    // The engine fix (pixijs#12147, 2026-08-19) is not in a release. Pinning
    // one filter cannot cover Pixi's own UBOs. Scene teardown already
    // destroys per-frame resources; leave GC off on WebGPU until a Pixi
    // release includes that fix. WebGL stamps last-used on every bind.
    if (this.metrics.backend === 'webgpu') {
      this.app.renderer.gc.enabled = false;
    }
    this.ambientRoot.eventMode = 'none';
    this.markRoot.eventMode = 'none';
    this.tooltipRoot.eventMode = 'none';
    this.app.stage.addChild(this.ambientRoot, this.stage, this.markRoot, this.tooltipRoot);
    this.tooltipLayer = new TooltipLayer(this.tooltipRoot);
    this.app.ticker.add(this.updateTooltip);
    this.farField = createFarField();
    if (this.farField) {
      this.ambientRoot.addChild(this.farField.mesh);
      this.app.ticker.add(this.tickFarField);
    }
    this.installPointerLightFilter();
    this.app.canvas.className = 'gpu-ui-canvas';
    this.app.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.app.canvas);
    this.app.canvas.addEventListener('wheel', this.wheel, { passive: false });
    // On window, not the canvas: a drag that wanders off the canvas must keep
    // tracking, and its release must disarm wherever it happens. Tuning and
    // the welcome turn slider share these listeners — both hold a KEY (or a
    // track geometry), never a display object.
    window.addEventListener('pointermove', this.tuningPointerMove);
    window.addEventListener('pointerup', this.tuningPointerUp);
    window.addEventListener('pointercancel', this.tuningPointerUp);
    window.addEventListener('blur', this.tuningPointerUp);
    // Diagnostics handle, INERT unless explicitly asked for with ?atomaDiag=1.
    // GPU lifetime defects (Pixi's GC unloading a buffer whose bind group is
    // still cached) are invisible to mocked tests and to the WebGL fallback,
    // so the only honest regression test drives the real renderer — and it
    // needs to reach the GC to force a collection instead of passing because
    // nothing ever happened. Read-only EXCEPT the mark inspect setters, which
    // the mark-turn capture script and the welcome slider use to hold a pose
    // without waiting on the wall. Nothing in the product reads this handle back.
    if (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).has('atomaDiag')
    ) {
      (window as unknown as { __ATOMA_GPU__?: unknown }).__ATOMA_GPU__ = {
        app: this.app,
        // Capture script (`npm run viz:mark-turn`) steps a full crystal
        // rotation at 250 ms without waiting on the wall. Null returns the
        // clock to performance.now(). Inert unless this handle exists.
        pinMarkElapsedMs,
        pinMarkTurnDegrees,
        markElapsedMs,
        markTurnDegrees,
        markBeadVisible,
        setMarkBeadVisible,
        movePointerLight,
        hidePointerLight,
        pointerLightFilter: () => this.pointerLightFilter,
        // Where the controls are, and what the live tuning holds. A drag is
        // only observable on a real renderer — the mocked suite has no stage
        // to hit-test against — so the smoke needs both to prove a drag
        // survived the render that used to destroy it.
        hitTargets: () => this.metrics.hitTargets,
        tuning: () => ({ ...readTuning() }),
        // How displaced the animated filter layer currently is. The anchor
        // smoke reads it to prove its scenario ARMED: a zero drift only means
        // something if the layer was actually mid-flight when sampled.
        collapseOffset: () => this.metrics.runCollapseOffset,
        // Worst distance between where a cast shadow was anchored and where
        // its surface actually sits now. Anything beyond rounding means some
        // animation moved a layer without re-anchoring — the shadows under it
        // are aiming at a surface that is not there. Only observable on a
        // real renderer: the mocked suite has no stage transforms to drift.
        castShadowAnchorDrift: () => {
          let drift = 0;
          for (const entry of this.castShadows) {
            if (entry.shadow.destroyed || !entry.parent.parent) continue;
            const origin = entry.parent.toGlobal({ x: entry.localX, y: entry.localY });
            drift = Math.max(
              drift,
              Math.abs(origin.x - entry.left),
              Math.abs(origin.y - entry.top)
            );
          }
          return drift;
        },
      };
    }
    this.initialized = true;
  }

  destroy() {
    if (!this.initialized) return;
    this.app.ticker.remove(this.updateTooltip);
    this.tooltipLayer?.destroy();
    this.tooltipLayer = null;
    this.app.ticker.remove(this.updatePointerLight);
    this.app.ticker.remove(this.updateCastShadows);
    this.app.ticker.remove(this.tickFarField);
    this.farField = null;
    this.castShadows = [];
    this.stage.filters = null;
    this.stage.filterArea = undefined;
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
    this.atomaMark?.handle.destroy();
    this.atomaMark = null;
    this.labels.clear();
    this.textStyles.clear();
    this.app.canvas.removeEventListener('wheel', this.wheel);
    window.removeEventListener('pointermove', this.tuningPointerMove);
    window.removeEventListener('pointerup', this.tuningPointerUp);
    window.removeEventListener('pointercancel', this.tuningPointerUp);
    window.removeEventListener('blur', this.tuningPointerUp);
    this.tuningDrag = null;
    this.turnDrag = null;
    this.turnSliderBounds = null;
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
    const keepFarField = this.farField?.mesh ?? null;
    for (const child of this.ambientRoot.removeChildren()) {
      if (child === keepFarField || child.label === FAR_FIELD_LABEL) continue;
      child.destroy({ children: true });
    }
    this.retainFarField();
    this.root = this.stage;
    for (const child of this.stage.removeChildren()) child.destroy({ children: true });
    // The crystal steps out like the far field: its render textures, shader
    // and geometries survive the rebuild; `retainAtomaMark` re-adds or
    // replaces it.
    const keepMark = new Set<Container>(this.atomaMark?.handle.retained ?? []);
    // The account orbs step out with the crystal. Without this they were
    // destroyed by every rebuild, and `retainAvatarOrb`'s key-match path then
    // resumed a dead mesh into nothing — the header avatar vanished on the
    // first same-key rebuild, i.e. on every tab change.
    for (const orb of this.avatarOrbs.values()) keepMark.add(orb.handle.container);
    for (const child of this.markRoot.removeChildren()) {
      if (keepMark.has(child)) continue;
      child.destroy({ children: true });
    }
    this.avatarOrbsRetained = new Set<string>();
    this.tooltipLayer?.beginRender();
    this.metrics.visibleLabels = [];
    this.metrics.hitTargets = [];
    this.metrics.runCollapseOffset = 0;
    delete this.metrics.timelineViewport;
    this.currentFilterBounds = new Map();
    this.handledExitIds = new Set();
    this.currentEventIds = new Set();
    this.runPickerBounds = null;
    this.runPickerScrollMax = 0;
    this.turnSliderBounds = null;
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
    this.stage.filterArea = new Rectangle(0, 0, width, height);
    if (!snapshot.state.entered) {
      drawWelcome(this, snapshot, width, height);
      this.previousView = null;
      this.previousFilterBounds = this.currentFilterBounds;
      this.roleRowTransition = null;
      this.previousEventIds = this.currentEventIds;
      this.sweepAvatarOrbs();
      this.labels.endRender();
      this.anchorCastShadows();
      this.updateCastShadows();
      this.metrics.objectCount =
        this.countObjects(this.ambientRoot) +
        this.countObjects(this.stage) +
        this.countObjects(this.markRoot);
      return;
    }
    this.drawAmbientGrid(this.ambientRoot, width, height);
    this.drawHeader(snapshot, width);
    // Views draw in their OWN viewport space, from x = 0, exactly as they did
    // when they owned the full width. The rail narrows before it can shove the
    // view beyond the window; CSS mirrors this exact clamp for DOM overlays.
    const contentLeft = sidebarWidthForViewport(width);
    const contentWidth = Math.max(0, width - contentLeft);
    drawSidebar(this, snapshot, height, contentLeft);
    const viewport = new Container();
    viewport.x = contentLeft;
    this.stage.addChild(viewport);
    this.root = viewport;
    try {
      if (snapshot.data.loading) {
        this.text(this.root, snapshot.t('common.loading'), 24, 84, { size: 16 });
      } else if (snapshot.data.error) {
        this.text(this.root, snapshot.data.error, 24, 84, {
          size: 14,
          color: GPU_COLORS.error,
          width: contentWidth - 48,
        });
      } else {
        switch (snapshot.state.view) {
          case 'projects':
            drawProjects(this, snapshot, contentWidth, height);
            break;
          case 'admin':
            drawAdmin(this, snapshot, contentWidth, height);
            break;
          case 'journal':
            drawJournal(this, snapshot, contentWidth, height);
            break;
          case 'ledger':
            drawLedger(this, snapshot, contentWidth, height);
            break;
          case 'sentinel':
            drawSentinel(this, snapshot, contentWidth, height);
            break;
          case 'announce':
            drawAnnounce(this, snapshot, contentWidth, height);
            break;
          case 'runs':
            drawRuns(this, snapshot, contentWidth, height);
            break;
          case 'registry':
            drawRegistry(this, snapshot, contentWidth, height);
            break;
          case 'skills':
            drawSkills(this, snapshot, contentWidth, height);
            break;
          case 'burnin':
            drawBurnin(this, snapshot, contentWidth, height);
            break;
          case 'docs':
            drawDocs(this, snapshot, contentWidth, height);
            break;
          case 'settings':
            drawSettings(this, snapshot, contentWidth, height);
            break;
        }
      }
    } finally {
      // Chrome draws into the stage again — including on the throw path, or
      // one failed view would leave every later overlay inside the viewport.
      this.root = this.stage;
    }
    this.translateViewBounds(contentLeft);
    this.drawOverlays(snapshot, width, height);
    drawAccountMenu(this, snapshot, width, height);
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
    this.sweepAvatarOrbs();
    // Labels this render did not draw go idle, and idle keys are released.
    // `countObjects` walks the live scene, and a retained label that was not
    // re-attached is not in it, so retention never inflates objectCount.
    this.labels.endRender();
    // Anchors resolve only now: the containers are attached and positioned.
    this.anchorCastShadows();
    this.updateCastShadows();
    this.metrics.objectCount =
      this.countObjects(this.ambientRoot) +
      this.countObjects(this.stage) +
      this.countObjects(this.markRoot);
  }

  /**
   * Record one interactive target in renderer coordinates.
   *
   * Views draw through nested viewport, scroll-pane and animation containers.
   * Raw widget coordinates therefore stop being screen coordinates as soon as
   * any parent moves. Project through the LIVE Pixi ancestry at the call site;
   * this is also why the viewport must exist before a view starts drawing.
   */
  recordHitTarget(parent: Container, target: GpuHitTarget): GpuHitTarget {
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
    this.metrics.hitTargets.push(projected);
    return projected;
  }

  /**
   * Declare a hoverable region that shows `text` in the shared bubble.
   *
   * Coordinates are LOCAL to `parent`, like `recordHitTarget`'s, and are
   * projected here while the parent transform is still live — a view drawn
   * into the offset content viewport must not have to know its own offset.
   */
  tooltip(
    parent: Container,
    region: { x: number; y: number; width: number; height: number; text: string }
  ): void {
    const layer = this.tooltipLayer;
    if (!layer) return;
    const start = parent.toGlobal({ x: region.x, y: region.y });
    const end = parent.toGlobal({
      x: region.x + region.width,
      y: region.y + region.height,
    });
    layer.register({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      text: region.text,
    });
  }

  /** Detail bounds are a plain Rectangle, so project the view's x offset once. */
  private translateViewBounds(offsetX: number) {
    if (this.detailBounds) {
      this.detailBounds = new Rectangle(
        this.detailBounds.x + offsetX,
        this.detailBounds.y,
        this.detailBounds.width,
        this.detailBounds.height
      );
    }
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
        elevation / 2,
        'column'
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
        elevation * 0.28,
        'column'
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

  /**
   * The frame that groups a row of controls — filters, roles, branches, atom
   * lanes.
   *
   * It used to be a bare stroked outline drawn straight into the parent at
   * absolute coordinates, so it sat exactly ON the page: no surface, nothing
   * for the pointer light to catch, no shadow. It is now a shallow SURFACE —
   * its own container at the block's position, geometry at the local origin,
   * with a cast shadow at a fraction of a card's depth. Enough lift to read as
   * a group standing off the background; not so much that a container of
   * buttons competes with the buttons.
   *
   * The local-origin move is what makes the shadow possible at all: the cast
   * system moves a shadow by POSITION every frame, which requires the geometry
   * not to have the offset baked into its path.
   */
  filterBlockFrame(
    parent: Container,
    block: Pick<FilterBlockLayout, 'x' | 'y' | 'width' | 'height'>
  ) {
    const container = new Container();
    container.position.set(block.x, block.y);
    container.eventMode = 'none';
    this.addSurfaceShadow(container, block.width, block.height, 10, 0.56, 0.8, 'frame');
    const graphics = new Graphics();
    graphics.roundRect(0, 0, block.width, block.height, 10);
    // OPAQUE, not a tint. A surface that stands off the page and casts a
    // shadow cannot also let the page — and its own shadow — show through it:
    // that is what put a dark step across the frame's interior. Being solid is
    // what makes it a surface rather than a wash of colour over the column.
    graphics.fill({ color: GPU_COLORS.panelRaised });
    graphics.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.72 });
    graphics.eventMode = 'none';
    container.addChild(graphics);
    parent.addChild(container);
    return graphics;
  }

  /**
   * One tuning row: label, track, draggable thumb, live readout.
   *
   * Deliberately NOT a stateful `Slider` object. The previous one extended
   * `Container` and was held across frames by a module-level `activeSlider`,
   * but `render()` wipes the scene (`root.removeChildren()` + recursive
   * destroy) — so the very first re-render during a drag destroyed the object
   * the drag was holding, and the pointer kept moving against a corpse. That
   * is the whole reason the slider "stopped sliding while the button was
   * still down".
   *
   * Here the drag holds a KEY and a track geometry, never a display object,
   * and the thumb is moved by a ticker that reads the live sample — the same
   * contract the cast shadows and the pointer light already follow, so a drag
   * costs zero scene rebuilds.
   */
  tuningRow(
    parent: Container,
    key: TuningKey,
    x: number,
    y: number,
    width: number
  ) {
    const range = TUNING_RANGE[key];
    const trackLocalX = x + TUNING_LABEL_WIDTH;
    const trackWidth = Math.max(
      40,
      width - TUNING_LABEL_WIDTH - TUNING_READOUT_WIDTH - 16
    );

    this.text(parent, range.label, x, y + 4, {
      size: 9,
      color: GPU_COLORS.muted,
      weight: '600',
      width: TUNING_LABEL_WIDTH - 8,
    });

    const track = new Graphics();
    track.roundRect(trackLocalX, y + TUNING_ROW_HEIGHT / 2 - 2, trackWidth, 4, 2);
    track.fill({ color: 0x1f2937, alpha: 0.75 });
    // The identity notch: where this knob sits when it is asking the renderer
    // for nothing. Without it a panel of six sliders cannot tell you which
    // ones you have actually moved away from the shipped look.
    const identityX = trackXFromTuningValue(
      key,
      TUNING_IDENTITY[key],
      trackLocalX,
      trackWidth
    );
    track.rect(identityX - 0.5, y + TUNING_ROW_HEIGHT / 2 - 6, 1, 12);
    track.fill({ color: GPU_COLORS.border, alpha: 0.9 });
    track.eventMode = 'none';
    parent.addChild(track);

    // Geometry at the local origin, moved by POSITION — the same rule the cast
    // shadows follow, so the per-frame update never re-tessellates a path.
    const thumb = new Graphics();
    thumb.roundRect(-6, -7, 12, 14, 3);
    thumb.fill({ color: GPU_COLORS.primary, alpha: 0.95 });
    thumb.stroke({ color: GPU_COLORS.text, width: 1, alpha: 0.55 });
    thumb.eventMode = 'none';
    thumb.label = `tuning-thumb:${key}`;
    parent.addChild(thumb);

    const { style } = this.textStyle({
      size: 9,
      color: GPU_COLORS.text,
      mono: true,
      weight: '600',
    });
    // A LIVE label, outside the retained pool on purpose: its text changes on
    // every drag step, and a pool keyed on `key\0value` would allocate a new
    // entry per step. Same reason `drawFpsReadout` owns its own Text.
    const readout = new Text({ text: '', style });
    readout.anchor.set(1, 0.5);
    readout.position.set(x + width, y + TUNING_ROW_HEIGHT / 2);
    readout.eventMode = 'none';
    readout.label = `tuning-readout:${key}`;
    parent.addChild(readout);

    const hit = new Graphics();
    hit.rect(trackLocalX - 8, y, trackWidth + 16, TUNING_ROW_HEIGHT);
    hit.fill({ color: 0xffffff, alpha: 0.0001 });
    hit.eventMode = 'static';
    hit.cursor = 'ew-resize';
    parent.addChild(hit);
    // Registered like every other control, so the DOM a11y bridge and the
    // hit-target metrics can see it. A control invisible to both is invisible
    // to every observer this project has.
    this.recordHitTarget(parent, {
      id: `tuning:${key}`,
      role: 'slider',
      label: range.label,
      x: trackLocalX,
      y,
      width: trackWidth,
      height: TUNING_ROW_HEIGHT,
    });

    const trackOrigin = () => {
      const origin = parent.toGlobal({ x: trackLocalX, y });
      return { x: origin.x, width: trackWidth };
    };
    hit.on('pointerdown', (event: { global: { x: number } }) => {
      const geometry = trackOrigin();
      this.tuningDrag = { key, trackX: geometry.x, trackWidth: geometry.width };
      setTuningValue(key, tuningValueFromTrack(key, event.global.x, geometry.x, geometry.width));
    });
    // Re-anchored on every render while a drag is live: the pane can scroll or
    // the window resize mid-drag, and a cached track origin would silently
    // start mapping the pointer to the wrong value.
    if (this.tuningDrag?.key === key) {
      const geometry = trackOrigin();
      this.tuningDrag.trackX = geometry.x;
      this.tuningDrag.trackWidth = geometry.width;
    }

    let lastRevision = -1;
    this.addTicker(() => {
      if (thumb.destroyed || readout.destroyed) return;
      const tuning = readTuning();
      if (tuning.revision === lastRevision) return;
      lastRevision = tuning.revision;
      thumb.position.set(
        trackXFromTuningValue(key, tuning[key], trackLocalX, trackWidth),
        y + TUNING_ROW_HEIGHT / 2
      );
      const next = formatTuningValue(key, tuning[key]);
      // Assigning the same string still re-rasterises in Pixi; guard it.
      if (next !== readout.text) readout.text = next;
      readout.tint =
        tuning[key] === TUNING_IDENTITY[key]
          ? multiplyTint(GPU_COLORS.text, GPU_COLORS.muted)
          : NO_TINT;
    });
    // The ticker only runs on the NEXT frame, and it early-outs when the
    // revision has not moved — so paint the initial state here or a freshly
    // built row shows an empty readout and a thumb at the origin.
    thumb.position.set(
      trackXFromTuningValue(key, readTuning()[key], trackLocalX, trackWidth),
      y + TUNING_ROW_HEIGHT / 2
    );
    readout.text = formatTuningValue(key, readTuning()[key]);
    return { trackLocalX, trackWidth };
  }

  /**
   * Welcome turn slider: label, track, thumb, live degree readout, Live to
   * unpin. Same contract as `tuningRow` — the drag holds track geometry, never
   * a display object, and the thumb is moved by a ticker that reads the clock.
   *
   * Drag or wheel (±1°, shift ±10°) pins the mark. Pointer-up KEEPS the pin
   * so a pose can be inspected. Double-click the track, or click Live, returns
   * the clock to the wall.
   */
  turnSlider(
    parent: Container,
    x: number,
    y: number,
    width: number,
    label: string,
    liveLabel: string
  ) {
    const rowHeight = 28;
    const labelWidth = 72;
    const readoutWidth = 46;
    const liveWidth = 40;
    const trackLocalX = x + labelWidth;
    const trackWidth = Math.max(
      40,
      width - labelWidth - readoutWidth - liveWidth
    );
    const liveX = x + width - liveWidth;

    this.text(parent, label, x, y + 7, {
      size: 10,
      color: GPU_COLORS.muted,
      weight: '600',
      width: labelWidth - 6,
    });

    const track = new Graphics();
    track.roundRect(trackLocalX, y + rowHeight / 2 - 2, trackWidth, 4, 2);
    track.fill({ color: 0x1f2937, alpha: 0.75 });
    track.eventMode = 'none';
    parent.addChild(track);

    const thumb = new Graphics();
    thumb.roundRect(-6, -7, 12, 14, 3);
    thumb.fill({ color: GPU_COLORS.primary, alpha: 0.95 });
    thumb.stroke({ color: GPU_COLORS.text, width: 1, alpha: 0.55 });
    thumb.eventMode = 'none';
    thumb.label = 'welcome-turn-thumb';
    parent.addChild(thumb);

    const { style } = this.textStyle({
      size: 10,
      color: GPU_COLORS.text,
      mono: true,
      weight: '600',
    });
    // LIVE label, outside the retained pool: the degree string ticks with
    // the mark clock / drag. Same reason `tuningRow` owns its own Text.
    const readout = new Text({ text: '', style });
    readout.anchor.set(1, 0.5);
    readout.position.set(liveX - 6, y + rowHeight / 2);
    readout.eventMode = 'none';
    readout.label = 'welcome-turn-readout';
    parent.addChild(readout);

    const liveText = this.text(parent, liveLabel, liveX, y + 7, {
      size: 10,
      color: GPU_COLORS.primary,
      weight: '700',
      width: liveWidth,
    });

    const hit = new Graphics();
    hit.rect(trackLocalX - 8, y, trackWidth + 16, rowHeight);
    hit.fill({ color: 0xffffff, alpha: 0.0001 });
    hit.eventMode = 'static';
    hit.cursor = 'ew-resize';
    parent.addChild(hit);

    const liveHit = new Graphics();
    liveHit.rect(liveX, y, liveWidth, rowHeight);
    liveHit.fill({ color: 0xffffff, alpha: 0.0001 });
    liveHit.eventMode = 'static';
    liveHit.cursor = 'pointer';
    parent.addChild(liveHit);

    this.recordHitTarget(parent, {
      id: 'welcome.turn',
      role: 'slider',
      label,
      x: trackLocalX,
      y,
      width: trackWidth,
      height: rowHeight,
    });
    this.recordHitTarget(parent, {
      id: 'welcome.turnLive',
      role: 'button',
      label: liveLabel,
      x: liveX,
      y,
      width: liveWidth,
      height: rowHeight,
    });
    this.turnSliderBounds = new Rectangle(x, y, width, rowHeight);

    const trackOrigin = () => {
      const origin = parent.toGlobal({ x: trackLocalX, y });
      return { x: origin.x, width: trackWidth };
    };
    hit.on('pointerdown', (event: { global: { x: number } }) => {
      const geometry = trackOrigin();
      this.turnDrag = { trackX: geometry.x, trackWidth: geometry.width };
      pinMarkTurnDegrees(
        markTurnDegreeFromTrack(event.global.x, geometry.x, geometry.width)
      );
    });
    hit.on('pointertap', () => {
      const now = performance.now();
      if (now - this.turnSliderLastTapAt < 400 && markClockIsPinned()) {
        pinMarkElapsedMs(null);
        this.turnSliderLastTapAt = 0;
        return;
      }
      this.turnSliderLastTapAt = now;
    });
    liveHit.on('pointertap', () => {
      pinMarkElapsedMs(null);
    });
    if (this.turnDrag) {
      const geometry = trackOrigin();
      this.turnDrag.trackX = geometry.x;
      this.turnDrag.trackWidth = geometry.width;
    }

    const paint = () => {
      if (thumb.destroyed || readout.destroyed || liveText.destroyed) return;
      const degrees = markTurnDegrees();
      thumb.position.set(
        trackXFromTurnDegree(degrees, trackLocalX, trackWidth),
        y + rowHeight / 2
      );
      const next = `${degrees}°`;
      if (next !== readout.text) readout.text = next;
      const pinned = markClockIsPinned();
      readout.tint = pinned
        ? NO_TINT
        : multiplyTint(GPU_COLORS.text, GPU_COLORS.muted);
      liveText.alpha = pinned ? 1 : 0.4;
    };
    this.addTicker(paint);
    paint();
  }

  /**
   * Welcome inspect checkbox: show or hide the interior bead. Toggles a
   * module flag the mark ticker reads — no scene rebuild on click.
   */
  markBeadCheck(
    parent: Container,
    id: string,
    x: number,
    y: number,
    width: number,
    label: string
  ) {
    const rowHeight = 28;
    const boxSize = 14;
    const boxX = x;
    const boxY = y + (rowHeight - boxSize) / 2;

    const box = new Graphics();
    box.roundRect(boxX, boxY, boxSize, boxSize, 3);
    box.stroke({ color: GPU_COLORS.border, width: 1.2, alpha: 0.9 });
    box.fill({ color: 0x1f2937, alpha: 0.55 });
    box.eventMode = 'none';
    parent.addChild(box);

    const fill = new Graphics();
    fill.roundRect(boxX + 3, boxY + 3, boxSize - 6, boxSize - 6, 2);
    fill.fill({ color: GPU_COLORS.primary, alpha: 0.95 });
    fill.eventMode = 'none';
    fill.label = 'welcome-bead-check';
    parent.addChild(fill);

    this.text(parent, label, boxX + boxSize + 8, y + 7, {
      size: 10,
      color: GPU_COLORS.muted,
      weight: '600',
      width: Math.max(24, width - boxSize - 10),
    });

    const hit = new Graphics();
    hit.rect(x, y, width, rowHeight);
    hit.fill({ color: 0xffffff, alpha: 0.0001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    parent.addChild(hit);
    this.recordHitTarget(parent, {
      id,
      role: 'checkbox',
      label,
      x,
      y,
      width,
      height: rowHeight,
    });

    const paint = () => {
      if (fill.destroyed) return;
      fill.visible = markBeadVisible();
    };
    hit.on('pointertap', () => {
      setMarkBeadVisible(!markBeadVisible());
      paint();
    });
    this.addTicker(paint);
    paint();
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
    const key = `${size}|${weight}|${color}|${mono ? 'm' : 's'}|${options.width ?? ''}|${
      options.singleLine ? '1' : 'w'
    }`;
    let style = this.textStyles.get(key);
    if (!style) {
      style = new TextStyle({
        fill: color,
        fontFamily: mono
          ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
          : '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        fontSize: size,
        fontWeight: weight,
        wordWrap: options.width !== undefined && !options.singleLine,
        wordWrapWidth: options.width ?? 0,
        breakWords: true,
        lineHeight: size * 1.35,
      });
      this.textStyles.set(key, style);
    }
    return { style, key };
  }

  /**
   * The rendered width of a string, WITHOUT drawing it — for a view that must
   * size a column to the copy it is about to put in it. Measured through the
   * same shared `TextStyle` the draw will use, so the number describes the
   * real glyphs: a character count cannot, and every fixed column in this app
   * that guessed instead either clipped its own text or stole width from the
   * label beside it.
   *
   * `CanvasTextMetrics` is Pixi's own measurement path (it is what `Text` uses
   * to lay itself out) and it caches per font, so this is a map lookup after
   * the first call rather than a rasterisation.
   */
  measureText(value: string, options: TextOptions = {}): number {
    const { style } = this.textStyle(options);
    return CanvasTextMetrics.measureText(value, style).width;
  }

  /**
   * The longest prefix of `value` that FITS `maxWidth`, ellipsised if it had
   * to give anything up. Measured, then binary-searched — the alternative in
   * this file was `Math.floor(width / 6.2)`, a fixed average advance that is
   * wrong in both directions on a proportional face: it truncated `Build an
   * expense tracker…` while the button still had room to spare, and let a run
   * of wide glyphs overflow the same button.
   *
   * Returns '' rather than a bare ellipsis when not even one character fits,
   * so a collapsed column draws nothing instead of a row of lone dots.
   */
  fitText(value: string, maxWidth: number, options: TextOptions = {}): string {
    if (maxWidth <= 0) return '';
    if (this.measureText(value, options) <= maxWidth) return value;
    const ellipsis = '…';
    if (this.measureText(ellipsis, options) > maxWidth) return '';
    // Longest prefix whose text + ellipsis still fits. Monotonic in length, so
    // a binary search is exact and costs ~log2(len) cached measurements.
    let low = 0;
    let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.measureText(`${value.slice(0, mid)}${ellipsis}`, options) <= maxWidth) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low === 0 ? ellipsis : `${value.slice(0, low)}${ellipsis}`;
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
    // Same reason, and the same class of defect: `anchor` and `rotation` are
    // per-instance too, and callers set both (centred button labels, the
    // spinning refresh glyph). A pooled label handed to the next caller with
    // a stale anchor draws in the wrong place for no visible reason.
    label.anchor.set(0, 0);
    label.scale.set(1);
    label.rotation = 0;
    // Character-count truncation is only a copy bound; proportional glyphs
    // can still be wider than its estimate (`mmmm` is the adversarial case).
    // Measure the real Pixi label after rasterisation and fit only its x-axis,
    // so a bounded row can neither wrap into the next line nor cross its
    // allotted column. Resetting scale above is mandatory for pooled labels.
    if (
      options.singleLine &&
      options.width !== undefined &&
      label.width > Math.max(0, options.width)
    ) {
      label.scale.x = Math.max(0, options.width) / label.width;
    }
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
    alpha = 0.44,
    /** How far the surface stands off the page; scales offset AND reach. */
    depth = 1,
    surface: CastShadowSurface = 'card'
  ) {
    const shadow = new Graphics();
    // Geometry at the local origin, offset by POSITION — the offset is what
    // the pointer light moves each frame, and baking it into the path would
    // mean re-tessellating every shadow on every pointer move. The penumbra
    // is stacked geometry for the same reason: still one object, one position.
    for (const layer of softShadowLayers(width, height, radius, alpha, depth)) {
      shadow.roundRect(layer.x, layer.y, layer.width, layer.height, layer.radius);
      shadow.fill({ color: 0x01040a, alpha: layer.alpha });
    }
    shadow.eventMode = 'none';
    parent.addChild(shadow);
    this.registerCastShadow(shadow, parent, 0, 0, width, height, depth, surface);
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

    // 'card': an inset shadow belongs to the control it is carved into, and is
    // not one of the three stacks the tuning panel lifts.
    this.registerCastShadow(shadow, parent, 0, 0, width, height, depth, 'card');
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
    depth = 1,
    /**
     * Which stack this surface belongs to, so the live tuning can lift buttons
     * without lifting the column they sit on. Carried on the ENTRY rather than
     * baked into `depth` at build time: `updateCastShadows` runs on the ticker
     * and multiplies it there, which is what lets a drag change the scene
     * without rebuilding it.
     */
    surface: CastShadowSurface = 'card'
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
      surface,
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
      // Top-left only: the scene translates but never scales beyond the ±3.5%
      // hover/press pulse on chips, so the local width/height carry over to
      // stage coordinates within a couple of pixels — and only while the
      // pointer sits ON that chip, where the lit centroid is its centre and
      // the rect barely matters.
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
    const tuning = readTuning();
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
        depth: entry.depth * surfaceDepthScale(entry.surface, tuning),
        lightHeight: tuning.lightHeight,
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
    centerLabel = false,
    /** Spin the glyph: real feedback that a request is actually in flight. */
    spinning = false
  ) {
    const container = new Container();
    container.position.set(x, y);
    this.addSurfaceShadow(container, width, height, 7, 0.4, 1, 'button');
    const graphics = new Graphics();
    graphics.roundRect(0, 0, width, height, 7);
    graphics.fill({
      color: active ? accent : GPU_COLORS.panelRaised,
      alpha: active ? 0.32 : 0.9,
    });
    graphics.stroke({ color: active ? accent : GPU_COLORS.border, width: active ? 1.5 : 1 });
    container.addChild(graphics);
    // MEASURED against the real glyphs, not `width / 6.2`. That average advance
    // clipped ordinary Latin copy well short of the button's edge — a run goal
    // lost a third of its words to space the button was not using — while a
    // string of wide glyphs still overflowed it. A left-aligned label starts at
    // 10 and needs the same breathing room on the right.
    const labelStyle = {
      size: 11,
      color: active ? GPU_COLORS.text : GPU_COLORS.muted,
      weight: active ? '700' : '600',
    } as const;
    const labelText = this.text(
      container,
      this.fitText(label, Math.max(0, width - 20), labelStyle),
      centerLabel ? width / 2 : 10,
      Math.max(5, (height - 16) / 2),
      labelStyle
    );
    if (centerLabel) labelText.anchor.x = 0.5;
    labelText.eventMode = 'none';
    if (spinning) {
      // Rotation needs the glyph centred on BOTH axes, so the label moves to
      // the button's middle for the duration. `rotation` is a per-instance
      // transform — nothing shared is touched, and `text()` resets it.
      labelText.anchor.set(0.5, 0.5);
      labelText.position.set(width / 2, height / 2);
      if (prefersReducedMotion()) {
        // No spin to watch: mark the in-flight state statically instead.
        labelText.alpha = 0.55;
      } else {
        this.addTicker((ticker) => {
          if (labelText.destroyed) return;
          labelText.rotation += ticker.deltaMS * 0.006;
        });
      }
    }
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
    this.recordHitTarget(parent, { id, role, label, x, y, width, height });
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
    accent: number = GPU_COLORS.primary
  ) {
    const localTarget = {
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
    const projected = this.recordHitTarget(parent, localTarget);
    const target: FilterVisualTarget = {
      ...localTarget,
      rendererX: projected.x,
      rendererY: projected.y,
      rendererWidth: projected.width,
      rendererHeight: projected.height,
    };
    const wasVisible = this.previousFilterBounds.has(id);
    const appearanceDelay = this.currentFilterBounds.size * 14;
    this.currentFilterBounds.set(id, target);
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
      // At rest the border carries a THIRD of the family colour. Enough that
      // five chips read as five categories at a glance; not so much that a
      // row of unselected filters looks like a row of alerts.
      color: active ? accent : mixColor(0x30405d, accent, 0.34),
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
      .stroke({ color: accent, width: 1.2, alpha: active ? 0.9 : 0.45 });
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
    // The idle label carries a little of the family colour too, so a chip is
    // identifiable without being selected and without being loud.
    const idleTint = multiplyTint(GPU_COLORS.text, mixColor(BUTTON_LABEL_IDLE, accent, 0.42));
    let currentLabelTint = active ? NO_TINT : idleTint;
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
      const nextLabelTint = pressed || hovered || active ? NO_TINT : idleTint;
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

  /** Public because the nav rail (`renderer/views/sidebar.ts`) draws with it. */
  navButton(
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
      const targetScale = pressed ? 0.95 : hovered ? NAV_HOVER_SCALE : 1;
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
    this.recordHitTarget(parent, { id, role: 'tab', label, x, y, width, height });
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
    this.recordHitTarget(parent, { id, role: 'button', label, x, y, width, height });
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
    this.recordHitTarget(parent, {
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
          // Same borrowed-label rule as the view transition below: this exit
          // animation outlives its render, so its cache-owned label must be
          // handed back before the container is destroyed recursively.
          group.label.removeFromParent();
          group.container.removeFromParent();
          group.container.destroy({ children: true });
        }
      }
      const collapseProgress = applyCollapse();
      // Same contract as the enter animation: the layer is moving between
      // renders, so the shadows it carries re-anchor per tick. This path
      // self-heals through the completion re-render below, but a 390ms
      // animation with misaimed shadows is still 390ms of wrong.
      this.anchorCastShadows();
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
      // The render anchored every cast shadow while this layer sat at
      // -distance, and pointer moves never re-render by design — so without
      // re-anchoring as the layer travels, every shadow under it would stay
      // aimed at a surface ~40px above the real one until some unrelated
      // render, and a pointer ON a frame would throw its shadow as if the
      // frame were somewhere else. After the final apply this also leaves the
      // settled anchors behind.
      this.anchorCastShadows();
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
      // The effect is chrome-level and outlives the view pass, so it draws on
      // `stage`. Filter layout itself stays view-local for collapse/enter
      // animations; use the screen projection captured when the filter was
      // drawn rather than replaying those local numbers in the wrong space.
      const centerX = target.rendererX + target.rendererWidth / 2;
      const centerY = target.rendererY + target.rendererHeight / 2;
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
        // The label is BORROWED from the retained-label cache, and this
        // teardown outlives the render that borrowed it — `renderScene`'s
        // `beginRender()` detach has long since run. Destroying the layer
        // recursively would walk straight through the label and destroy it
        // behind the cache's back; the pool would then hand the corpse to a
        // later render, which dies on `position.set` of null. Hand it back
        // first. (This is the RUNS↔SKILLS crash, reproducible once a
        // transition completes its 560ms before the next one begins.)
        label.removeFromParent();
        layer.removeFromParent();
        layer.destroy({ children: true });
      }
    };
    this.addTicker(animate);
  }

  /**
   * The Pixi renderer, for the ONE view that needs an off-screen pass of its
   * own: the arrival gate's crystal renders its interior into a texture so the
   * front glass can refract it. Exposed as a getter rather than by widening the
   * views' access to the Application.
   */
  get pixiRenderer() {
    return this.app.renderer;
  }

  private drawAtomaMark(x: number, y: number) {
    this.retainAtomaMark(x, y);
  }

  /**
   * Attach-or-reuse for the crystal. When every attach parameter matches the
   * retained mark, the existing subtree is re-parented and its paint ticker
   * re-registered (renderScene cleared all tickers); otherwise the old mark
   * releases its GPU resources and a fresh one is built.
   */
  retainAtomaMark(
    x: number,
    y: number,
    visualScale?: number,
    options?: { bobPx?: number; bobPeriodMs?: number }
  ) {
    const key = [
      x,
      y,
      visualScale ?? '',
      options?.bobPx ?? '',
      options?.bobPeriodMs ?? '',
      this.app.renderer.resolution,
    ].join('|');
    if (this.atomaMark?.key === key) {
      this.atomaMark.handle.resume(this.markRoot, (callback) => this.addTicker(callback));
      return;
    }
    this.atomaMark?.handle.destroy();
    this.atomaMark = {
      key,
      handle: attachAtomaMark(
        this.markRoot,
        (callback) => this.addTicker(callback),
        x,
        y,
        visualScale,
        this.app.renderer,
        options
      ),
    };
  }

  /**
   * Attach-or-reuse for one account orb SLOT ('header', 'settings'). Same
   * contract as `retainAtomaMark`: when every parameter matches, the existing
   * mesh is re-parented and its paint ticker re-registered; otherwise the old
   * one releases its GPU resources first. A destroyed mesh under a matching
   * key is a miss, not a resume — resuming it would attach nothing and the
   * orb would silently vanish. The avatar TEXTURE is cached by URL inside the
   * orb module, so even a rebuild does not re-download a picture.
   */
  retainAvatarOrb(
    slot: string,
    x: number,
    y: number,
    size: number,
    photoUrl: string | null,
    seed: string,
    interactive: boolean
  ) {
    this.avatarOrbsRetained.add(slot);
    const active = interactive && this.snapshot?.state.accountMenuOpen === true;
    // Orbs are retained on `markRoot`, which the content viewport does not
    // cover, so a view's own coordinates have to be resolved to screen space
    // HERE — and the retention key must be built from the resolved pair, or a
    // view drawing at a stable local x would re-key on every layout change.
    const origin = this.root.toGlobal({ x, y });
    x = origin.x;
    y = origin.y;
    const key = [x, y, size, photoUrl ?? '', seed, active ? '1' : '0'].join('|');
    const existing = this.avatarOrbs.get(slot);
    if (existing?.key === key && !existing.handle.container.destroyed) {
      existing.handle.resume(this.markRoot, (callback) => this.addTicker(callback));
      return;
    }
    existing?.handle.destroy();
    this.avatarOrbs.set(slot, {
      key,
      handle: attachAvatarOrb(this.markRoot, (callback) => this.addTicker(callback), {
        x,
        y,
        size,
        photoUrl,
        seed,
        active,
        pointerAt: () => this.pointerScreenPosition(),
      }),
    });
  }

  /**
   * Destroy every orb slot no draw call claimed this frame. Runs at the end
   * of `renderScene` (both exits): the welcome gate, a sign-out and leaving
   * Settings all stop claiming a slot, and the kept-out-of-teardown mesh must
   * then be released rather than left parented to markRoot forever.
   */
  private sweepAvatarOrbs() {
    for (const [slot, orb] of this.avatarOrbs) {
      if (this.avatarOrbsRetained.has(slot)) continue;
      orb.handle.destroy();
      this.avatarOrbs.delete(slot);
    }
  }

  /**
   * The pointer in renderer screen pixels, or null when it is off-canvas. The
   * conversion the wheel handlers do inline, in one place, because the orb's
   * light parallax needs the same mapping without a Pixi event.
   */
  private pointerScreenPosition(): { x: number; y: number } | null {
    const pointer = readPointerLight();
    if (!pointer.active) return null;
    const bounds = this.app.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return pointerClientToRenderer(
      pointer.clientX,
      pointer.clientY,
      bounds,
      this.app.screen.width,
      this.app.screen.height
    );
  }

  private drawHeader(snapshot: GpuRenderSnapshot, width: number) {
    // Wash, not an opaque bar. A 0.94 panel hid the far field — and the
    // lantern the crystal throws onto it — behind the wordmark. Nav buttons
    // keep their own surfaces; the gem sits on the wall that faces the camera.
    const bar = new Graphics();
    bar.rect(0, 0, width, GPU_LAYOUT.headerHeight);
    bar.fill({ color: 0x0b111e, alpha: 0.42 });
    bar.moveTo(0, GPU_LAYOUT.headerHeight);
    bar.lineTo(width, GPU_LAYOUT.headerHeight);
    bar.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.55 });
    bar.eventMode = 'none';
    this.root.addChild(bar);
    // ONE vertical centre for everything in the band. These offsets used to be
    // absolute numbers that happened to centre in a 52px bar, so changing the
    // bar's height would have left its contents sitting high in it.
    const midY = GPU_LAYOUT.headerHeight / 2;
    this.drawAtomaMark(GPU_LAYOUT.headerMarkX, midY - ATOMA_MARK_LOCAL_CENTER);
    this.text(this.root, 'Atoma', GPU_LAYOUT.headerWordmarkX + 1, midY - 8.5, {
      size: 16,
      color: 0x263f68,
      weight: '700',
      alpha: 0.72,
    });
    this.text(this.root, 'Atoma', GPU_LAYOUT.headerWordmarkX, midY - 10, {
      size: 16,
      color: GPU_COLORS.text,
      weight: '700',
    });

    // The nav is a LEFT RAIL, not a tab strip: `renderer/views/sidebar.ts`
    // draws it from `render()`. `visibleViews` remains the one definition of
    // which tabs exist — the rail reads it, the DOM tablist reads it, and the
    // header now carries identity and locale only.

    // The account orb owns the far right when there is an account; the rest of
    // the header controls shift left by its width plus a gap.
    const auth = snapshot.data.auth;
    const accountReserve = auth ? HEADER_ORB_SIZE + 16 : 0;
    this.drawFpsReadout(width - 64 - accountReserve, midY);
    this.button(
      this.root,
      'locale.toggle',
      'button',
      snapshot.state.locale === 'en' ? 'EN' : 'FR',
      width - 54 - accountReserve,
      midY - 16,
      42,
      32,
      false,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
    if (auth) {
      const orbX = width - HEADER_ORB_SIZE - 12;
      const orbY = (GPU_LAYOUT.headerHeight - HEADER_ORB_SIZE) / 2;
      this.retainAvatarOrb(
        'header',
        orbX,
        orbY,
        HEADER_ORB_SIZE,
        auth.viewer.avatarUrl,
        auth.viewer.principalId,
        true
      );
      // The CONTROL is this rect, not the mesh. `markRoot` is
      // `eventMode = 'none'` so the brand crystal cannot eat pointer events,
      // and that verdict covers every child of the layer the orb is retained
      // on — including the orb. So the interactive layer carries an invisible
      // rect over it, rebuilt with the scene like every other control, and
      // forwards hover into the retained mesh.
      const orbHit = new Graphics();
      orbHit.rect(0, 0, HEADER_ORB_SIZE, HEADER_ORB_SIZE);
      // Not alpha 0: a fully transparent fill is still hit-tested by Pixi, but
      // a visible-to-the-engine surface is what keeps that true if the
      // rendering path ever culls empty geometry.
      orbHit.fill({ color: 0xffffff, alpha: 0.001 });
      orbHit.position.set(orbX, orbY);
      orbHit.eventMode = 'static';
      orbHit.cursor = 'pointer';
      orbHit.hitArea = new Rectangle(0, 0, HEADER_ORB_SIZE, HEADER_ORB_SIZE);
      orbHit.on('pointertap', () => snapshot.onActivate('account.menu.toggle'));
      orbHit.on('pointerover', () => this.avatarOrbs.get('header')?.handle.setHover(true));
      orbHit.on('pointerout', () => this.avatarOrbs.get('header')?.handle.setHover(false));
      this.root.addChild(orbHit);
      this.recordHitTarget(this.root, {
        id: 'account.menu.toggle',
        role: 'button',
        label: snapshot.t('auth.openMenu'),
        x: orbX,
        y: orbY,
        width: HEADER_ORB_SIZE,
        height: HEADER_ORB_SIZE,
      });
    }
    // Signed out: the header claims no slot this frame and `sweepAvatarOrbs`
    // releases the mesh at the end of the render.
  }

  /**
   * Live frame rate, right-aligned just left of the locale toggle.
   *
   * Deliberately NOT drawn through `text()`. That cache keys on the string
   * itself, so a counter would mint a fresh pooled label for every value it
   * ever displayed and never reuse one — the opposite of what the cache is
   * for. This label is owned by the scene, destroyed with it, and mutated in
   * place by a ticker at `FPS_REFRESH_MS`.
   *
   * `ticker.FPS` is Pixi's own smoothed rate, so the number does not flicker
   * between two values the way a per-frame `1000/deltaMS` does.
   */
  private drawFpsReadout(right: number, y: number) {
    const { style } = this.textStyle({ size: 10, color: GPU_COLORS.text, mono: true, weight: '600' });
    const readout = new Text({ text: formatFps(this.app.ticker.FPS), style });
    readout.anchor.set(1, 0.5);
    readout.position.set(right, y);
    readout.eventMode = 'none';
    readout.tint = multiplyTint(GPU_COLORS.text, fpsColor(this.app.ticker.FPS));
    readout.label = 'fps-readout';
    this.root.addChild(readout);

    let sinceRefresh = 0;
    this.addTicker((ticker) => {
      sinceRefresh += ticker.deltaMS;
      if (sinceRefresh < FPS_REFRESH_MS || readout.destroyed) return;
      sinceRefresh = 0;
      const fps = this.app.ticker.FPS;
      const next = formatFps(fps);
      // Assigning the same string still re-rasterises in Pixi; guard it.
      if (next !== readout.text) readout.text = next;
      readout.tint = multiplyTint(GPU_COLORS.text, fpsColor(fps));
    });
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
          `${run.projectSlug ? `${run.projectSlug} · ` : ''}${run.label.replace(/^(?:build-app|baseline):\s*/i, '')}`,
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
  | 'markRoot'
  | 'text'
  | 'measureText'
  | 'fitText'
  | 'panel'
  | 'recordHitTarget'
  | 'tooltip'
  | 'button'
  | 'navButton'
  | 'filterButton'
  | 'statCard'
  | 'atomButton'
  | 'eventCard'
  | 'collapseCaret'
  | 'filterBlockFrame'
  | 'tuningRow'
  | 'turnSlider'
  | 'markBeadCheck'
  | 'detailMask'
  | 'addTicker'
  | 'retainAtomaMark'
  | 'retainAvatarOrb'
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
  | 'pixiRenderer'
>;
