import {
  Application,
  BitmapFont,
  BitmapText,
  Cache,
  CanvasTextMetrics,
  Container,
  Filter,
  Graphics,
  Rectangle,
  RendererType,
  Sprite,
  Text,
  TextStyle,
  Ticker,
  type Texture,
  UPDATE_PRIORITY,
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
  VizNotification,
  VizPlatformEvent,
  VizPreviewSummary,
  VizSentinelSnapshot,
  VizGitHubInstallation,
  VizProject,
  VizProjectRun,
  VizRun,
} from '../client/types.js';
import {
  ATOMA_MARK_ENV_MIN_SCALE,
  ATOMA_MARK_HEADER_SCALE,
  ATOMA_MARK_LOCAL_CENTER,
  attachAtomaMark,
  interpolateAtomaMarkPlacement,
  type AtomaMarkHandle,
  type AtomaMarkPlacement,
} from './renderer/atoma-mark.js';
import {
  createFarField,
  FAR_FIELD_LABEL,
  shouldShowFarField,
  type FarField,
} from './renderer/far-field.js';
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
import {
  SCENE_SHADOW_COLORS,
  softShadowLayers,
} from './renderer/soft-shadow.js';
import { LabelCache } from './renderer/label-cache.js';
import {
  advanceNavIconSpin,
  drawNavIcon,
  drawRepositoryIcon,
  loadNavIconMeshes,
  NAV_ICON_OUTSIDE_GAP,
  NAV_ICON_RENDER_SIZE,
  navIconLighting,
  navIconKind,
  queueNavIconSpin,
  type NavIconMeshes,
  type NavIconSpinState,
} from './renderer/nav-icons.js';
import { NO_TINT, mixColor, multiplyTint, tintColor } from './renderer/label-tint.js';
import {
  createFpsSampleWindow,
  formatFps,
  fpsColor,
  sampleFpsWindow,
} from './renderer/fps-readout.js';
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
import {
  pointerClientToRenderer,
  readPointerLight,
  movePointerLight,
  hidePointerLight,
} from './pointer-light.js';
import { TooltipLayer } from './renderer/tooltip.js';
import { viewFrameGutterRects } from './renderer/view-frame.js';
import type { GpuUiState, ViewName } from './store.js';
import { GPU_COLORS, GPU_LAYOUT, gpuTextRasterOptions, sidebarWidthForViewport } from './theme.js';
import { VIZ_VISUAL_DEPTH } from './visual-depth.js';
import type { AuthUiSnapshot } from './AuthControls.js';
import {
  buildSceneCameraFrame,
  clientToRendererPoint,
  rendererToClientPoint,
  sceneCameraEase,
  sceneCameraIsMoving,
  sceneCameraForMode,
  sceneCameraTransitionDuration,
  sceneCameraViewport,
  subscribeSceneCameraFrames,
  visibleSceneLayoutHeight,
  type SceneCameraMode,
  type SceneCameraViewport,
} from './scene-camera.js';

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
  /**
   * The viewer's own notification tray, newest first — every page loaded so
   * far, flattened, with the same three paging facts as the journal above.
   * Its query error stays HERE rather than in the global `error`: a failed
   * tray read shows inside the open menu, not as a banner over the view.
   */
  notifications: VizNotification[];
  notificationsHasMore: boolean;
  notificationsLoading: boolean;
  notificationsError: boolean;
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
   * Preview state for the SELECTED run, or null when this deployment serves no
   * preview for it. Server data, not UI state: it is the manager's state
   * machine read back, and the client never invents a transition of its own.
   */
  preview: VizPreviewSummary | null;
  /**
   * Non-null when the gate is on and this browser holds no session: the
   * arrival gate offers these providers instead of Continue, and `notice`
   * names a login failure bounced back by the server (`?authNotice=`).
   */
  login: {
    providers: { id: string; label: string }[];
    notice: string | null;
    /** Provider whose OAuth redirect is in flight; that button shows a spinner. */
    pendingProvider?: string | null;
  } | null;
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

/** Diameter of the account orb in the overview header. */
export const HEADER_ORB_SIZE = 34;
/** Width of the notification bell control beside it. */
export const HEADER_BELL_WIDTH = 36;
/** Centred scale used by a hovered left-rail item. */
export const NAV_HOVER_SCALE = 1.045;

// Decomposed modules (2026-08-15): pure layout, copy, shaders, motion and the
// shared scroll pane live under ./renderer/. This file keeps the stateful
// renderer class. Re-exports preserve the public import surface.
/**
 * Left inset of a button's label inside its frame. EXPORTED because a view
 * that stacks a line UNDER a button has to start it on the same vertical, and
 * the two numbers were written independently: the run rows' second line sat at
 * the button's border while the label above it sat 10px in, so an error read
 * as hanging out of the row it belonged to.
 */
export const BUTTON_LABEL_INSET = 10;
/**
 * A button label at rest. Buttons are now BUILT at `GPU_COLORS.text` and
 * tinted down to this, rather than built dim and re-coloured on hover: hover
 * used to assign `style.fill`, and that style is shared across every label
 * with the same size/weight, so one rollover lit up all of them.
 */
const BUTTON_LABEL_IDLE = 0xa9b5ca;
const BUTTON_LABEL_IDLE_TINT = multiplyTint(GPU_COLORS.text, BUTTON_LABEL_IDLE);
const FPS_BITMAP_FONT_NAME = 'AtomaFps';
const FPS_BITMAP_FONT_CACHE_KEY = `${FPS_BITMAP_FONT_NAME}-bitmap`;
const FPS_BITMAP_STYLE = new TextStyle({
  fontFamily: FPS_BITMAP_FONT_NAME,
  fontSize: 10,
  fontWeight: '600',
  fill: GPU_COLORS.text,
});

function ensureFpsBitmapFont(resolution: number): void {
  if (Cache.has(FPS_BITMAP_FONT_CACHE_KEY)) return;
  BitmapFont.install({
    name: FPS_BITMAP_FONT_NAME,
    style: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 10,
      fontWeight: '600',
      fill: GPU_COLORS.text,
    },
    chars: '— 0123456789FPS',
    resolution,
    skipKerning: true,
  });
}

interface SurfaceShadowOptions {
  /** Surface origin inside its parent. Most widgets use a positioned container. */
  x?: number;
  y?: number;
  radius?: number;
  alpha?: number;
  /** Physical elevation: controls vary this, never the shadow algorithm. */
  depth?: number;
  surface?: CastShadowSurface;
}

interface CastShadowEntry {
  shadow: Graphics | Container;
  parent: Container;
  localX: number;
  localY: number;
  width: number;
  height: number;
  depth: number;
  surface: CastShadowSurface;
  left: number;
  top: number;
}

interface CameraFramePanel {
  readonly surface: Graphics;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fill: number;
  readonly fillAlpha: number;
  readonly border: number;
  readonly radius: number;
  currentHeight: number;
}

function paintPanelSurface(
  graphics: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number,
  fillAlpha: number,
  border: number,
  radius: number
): void {
  graphics.roundRect(x, y, width, height, radius);
  graphics.fill({ color: fill, alpha: fillAlpha });
  if (border !== fill) graphics.stroke({ color: border, width: 1, alpha: 0.9 });
}

function paintPanelShadow(
  graphics: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  alpha: number,
  depth: number
): void {
  const layers = softShadowLayers(width, height, radius, alpha, depth);
  for (const [index, layer] of layers.entries()) {
    const towardCore = layers.length > 1 ? index / (layers.length - 1) : 1;
    graphics.roundRect(x + layer.x, y + layer.y, layer.width, layer.height, layer.radius);
    graphics.fill({
      color: mixColor(
        SCENE_SHADOW_COLORS.penumbra,
        SCENE_SHADOW_COLORS.core,
        towardCore
      ),
      alpha: layer.alpha,
    });
  }
}

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
import { drawRuns, runsPaneLayout, runsPickerControlLayout } from './renderer/views/runs.js';
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
import { drawLocaleMenu, type LocaleMenuAnchor } from './renderer/views/locale-menu.js';
import {
  drawNotificationsBell,
  drawNotificationsMenu,
  type NotificationsMenuAnchor,
} from './renderer/views/notifications-menu.js';
import {
  overlayMenuClip,
  publishOverlayMenuClip,
} from './renderer/overlay-menu-clip.js';
import { drawSettings } from './renderer/views/settings.js';
import {
  drawSidebar,
  FOCUS_RAIL_FPS_SCALE,
  focusRailChromeLayout,
  overviewRailChromeLayout,
  utilityDockOpacity,
  type FocusRailChromeLayout,
  type FocusRailRect,
  type OverviewRailChromeLayout,
} from './renderer/views/sidebar.js';
import { attachAvatarOrb, type AvatarOrbHandle } from './renderer/avatar-orb.js';
import {
  loadTimelineCardMaterial,
  type TimelineCardMaterial,
} from './renderer/timeline-card-material.js';

export class GpuRenderer {
  app = new Application();
  /**
   * Hero scenery. ITS OWN RENDER GROUP, like `markRoot` and `tooltipRoot`
   * below and every `animatedLayer()`: a subtree that changes every frame
   * must not share a Pixi render group with the product surfaces, or it drags
   * them through a full re-batch and re-upload each frame (see `animatedLayer`).
   */
  readonly ambientRoot = new Container({ isRenderGroup: true });
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
  readonly markRoot = new Container({ isRenderGroup: true });
  /**
   * The one crystal, RETAINED across scene rebuilds like the far field.
   * Attaching per render leaked its render textures, geometries and shader —
   * `Mesh.destroy()` only nulls those references, and WebGPU GC is pinned
   * off. Navigation position and scale are mutable on that retained handle;
   * the resource key changes only when shader/capture ownership really does
   * (welcome mode, reflection class, resolution).
   */
  private atomaMark: {
    key: string;
    resourceKey: string;
    handle: AtomaMarkHandle;
    placement: AtomaMarkPlacement;
  } | null = null;
  private atomaMarkMotion: {
    from: AtomaMarkPlacement;
    to: AtomaMarkPlacement;
    startedAt: number;
    duration: number;
  } | null = null;
  private previousSceneCameraMode: SceneCameraMode | null = null;
  private utilityDockTransition: {
    from: SceneCameraMode;
    to: SceneCameraMode;
    startedAt: number;
    duration: number;
  } | null = null;
  /**
   * The account orbs, retained on the same terms as the crystal above: each
   * mesh carries a shader, a geometry and a decoded avatar texture, none of
   * which should be rebuilt sixty times a second because `renderScene` tears
   * the scene down. TWO slots exist because two views draw one concurrently —
   * the global account control and the Settings profile orb — and a single
   * slot had them evicting each other every render. `avatarOrbsRetained` is per-frame
   * accounting: a slot no draw call claimed this frame (signed out, left
   * Settings) is destroyed by `sweepAvatarOrbs`, never left parked on the
   * scene.
   */
  private readonly avatarOrbs = new Map<string, { key: string; handle: AvatarOrbHandle }>();
  private avatarOrbsRetained = new Set<string>();
  private host: HTMLElement | null = null;
  private initialized = false;
  private snapshot: GpuRenderSnapshot | null = null;
  /** The current bounded timeline window; dropped before scene teardown. */
  runsScroll: { origin: number; min: number; max: number; move: (offset: number) => void } | null = null;
  private runsScrollWidth = 0;
  private runsScrollHeight = 0;

  readonly scrollMax: Partial<Record<ViewName, number>> = {};
  private readonly tickerCallbacks = new Set<(ticker: Ticker) => void>();
  /**
   * The animated bands, RETAINED across scene rebuilds — see `animatedLayer`.
   * Keyed by label, plus a `#n` suffix when one render asks for a label twice.
   */
  private readonly animatedLayers = new Map<string, Container>();
  /**
   * Survives scene rebuilds so wheel-driven redraws cannot keep resetting the
   * 250ms measurement window or flash the header back to its placeholder.
   */
  private readonly fpsSample = createFpsSampleWindow();
  private lastFps = 0;
  /** One retained diffuse + normal mesh shared by every visible RUNS card. */
  private timelineCardMaterial: TimelineCardMaterial | null = null;
  /** One coherent, preloaded GLB mesh set for the nav rail. */
  private navIconMeshes: NavIconMeshes | null = null;
  /** Click spins survive the scene rebuild caused by activating a nav tab. */
  private readonly navIconSpins = new Map<string, NavIconSpinState>();
  private pointerLightFilter: Filter | null = null;
  private pointerLightUniforms: {
    uLightPx: Float32Array;
    uStrength: number;
    uRadiusScale: number;
    uHueShift: number;
  } | null = null;
  private pointerLightStrength = 0;
  /** Light position in renderer pixels, published by `updatePointerLight`. */
  private lightRendererX = 0;
  private lightRendererY = 0;
  private pointerLightBufferPinned = false;
  private farField: FarField | null = null;
  private farFieldTickerActive = false;
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
  /**
   * The open notification tray's panel rect and scroll ceiling, for the wheel
   * router. The OFFSET is renderer-owned like `detailScrollY` — an overlay's
   * scroll is not identity, and a store write per wheel tick would rebuild
   * React for motion only this class needs to see.
   */
  private notificationsBounds: Rectangle | null = null;
  private notificationsScrollMax = 0;
  private notificationsScrollY = 0;
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
  private readonly tooltipRoot = new Container({ isRenderGroup: true });
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

  private castShadows: CastShadowEntry[] = [];
  private lastCastShadowFrame = {
    strength: Number.NaN,
    lightX: Number.NaN,
    lightY: Number.NaN,
    tuningRevision: -1,
  };
  /**
   * Outer view panels are authored once at the largest transition height.
   * Camera frames then resize only these retained Graphics and their mask;
   * the full view is rebuilt once at settle to commit scroll geometry.
   */
  private cameraFramePanels: CameraFramePanel[] = [];
  private cameraFrameLayer: Container | null = null;
  private cameraViewportMask: Graphics | null = null;
  private cameraViewportMaskHeight = 0;
  private activeViewLayoutHeight: number | null = null;
  private cameraFrameUnsubscribe: (() => void) | null = null;
  metrics: GpuRenderMetrics = emptyRenderMetrics();

  /** Client coordinates on the projected image -> the original Pixi plane. */
  private clientToRendererPosition(clientX: number, clientY: number): { x: number; y: number } {
    const viewport = sceneCameraViewport(this.app.canvas);
    if (viewport) {
      return clientToRendererPoint(
        { x: clientX, y: clientY },
        this.app.screen.width,
        this.app.screen.height,
        viewport
      );
    }
    return pointerClientToRenderer(
      clientX,
      clientY,
      this.app.canvas.getBoundingClientRect(),
      this.app.screen.width,
      this.app.screen.height
    );
  }

  /** Pixi renderer coordinates -> client coordinates on the projected image. */
  private rendererToClientPosition(rendererX: number, rendererY: number): { x: number; y: number } {
    const viewport = sceneCameraViewport(this.app.canvas);
    if (viewport) {
      return rendererToClientPoint(
        { x: rendererX, y: rendererY },
        this.app.screen.width,
        this.app.screen.height,
        viewport
      );
    }
    const bounds = this.app.canvas.getBoundingClientRect();
    return {
      x: bounds.left + rendererX * bounds.width / Math.max(1, this.app.screen.width),
      y: bounds.top + rendererY * bounds.height / Math.max(1, this.app.screen.height),
    };
  }

  private readonly wheel = (event: WheelEvent) => {
    if (!this.snapshot) return;
    event.preventDefault();
    if (!this.snapshot.state.entered && this.turnSliderBounds) {
      const local = this.clientToRendererPosition(event.clientX, event.clientY);
      if (this.turnSliderBounds.contains(local.x, local.y)) {
        const step = event.shiftKey ? 10 : 1;
        const delta = event.deltaY > 0 ? step : event.deltaY < 0 ? -step : 0;
        if (delta !== 0) {
          pinMarkTurnDegrees((markTurnDegrees() + delta + 360) % 360);
        }
        return;
      }
    }
    if (this.snapshot.state.notificationsMenuOpen && this.notificationsBounds) {
      const { x: localX, y: localY } = this.clientToRendererPosition(
        event.clientX,
        event.clientY
      );
      if (this.notificationsBounds.contains(localX, localY)) {
        const next = Math.max(
          0,
          Math.min(this.notificationsScrollMax, this.notificationsScrollY + event.deltaY)
        );
        if (next !== this.notificationsScrollY) {
          this.notificationsScrollY = next;
          this.render(this.snapshot);
        }
        // The bottom of the tray asks for the older page, exactly the
        // journal's gesture: announced through the activation channel, where
        // the handler is idempotent against a fetch already in flight.
        if (event.deltaY > 0 && next >= this.notificationsScrollMax) {
          this.snapshot.onActivate('notifications.more');
        }
        return;
      }
    }
    if (
      this.snapshot.state.focusedInput === 'run' &&
      this.runPickerBounds
    ) {
      const { x: localX, y: localY } = this.clientToRendererPosition(
        event.clientX,
        event.clientY
      );
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
      const { x: localX, y: localY } = this.clientToRendererPosition(
        event.clientX,
        event.clientY
      );
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
    const local = this.clientToRendererPosition(event.clientX, event.clientY);
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
    const local = this.clientToRendererPosition(pointer.clientX, pointer.clientY);
    tooltip.update(
      { x: local.x, y: local.y, active: pointer.trackingActive },
      performance.now(),
      { width: this.app.screen.width, height: this.app.screen.height }
    );
  };

  /** Flushes all animated card faces once, immediately before Pixi renders. */
  private readonly flushTimelineCardMaterial = () => {
    this.timelineCardMaterial?.flush();
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
    if (pointer.active && this.pointerLightStrength > 0.998) {
      this.pointerLightStrength = 1;
    }
    if (!pointer.active && this.pointerLightStrength < 0.002) {
      this.pointerLightStrength = 0;
      uniforms.uStrength = 0;
      this.timelineCardMaterial?.updateLight(
        this.lightRendererX,
        this.lightRendererY,
        0
      );
      filter.enabled = false;
      return;
    }

    const local = this.clientToRendererPosition(pointer.clientX, pointer.clientY);
    const tuning = readTuning();
    uniforms.uLightPx[0] = local.x;
    uniforms.uLightPx[1] = local.y;
    uniforms.uStrength = this.pointerLightStrength * tuning.lightIntensity;
    this.timelineCardMaterial?.updateLight(local.x, local.y, uniforms.uStrength);
    uniforms.uRadiusScale = tuning.lightHeight;
    uniforms.uHueShift = tuning.lightHue;
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
    };
    this.stage.filters = [filter];
    this.app.ticker.add(this.updatePointerLight);
    // AFTER the light: it damps `pointerLightStrength`, which shadows read.
    this.app.ticker.add(this.updateCastShadows);
  }

  /** Keep the compiled hero field across welcome rebuilds without drawing it in the app. */
  private retainFarField() {
    const keep = this.farField?.mesh;
    if (!this.farFieldTickerActive || !keep || keep.destroyed) return;
    if (keep.parent !== this.ambientRoot) {
      this.ambientRoot.addChildAt(keep, 0);
      return;
    }
    if (this.ambientRoot.getChildIndex(keep) !== 0) {
      this.ambientRoot.setChildIndex(keep, 0);
    }
  }

  /**
   * A hidden fullscreen mesh is still needless ticker and scene work. Detach
   * both together; reactivation reuses the compiled shader and geometry.
   */
  private setFarFieldActive(active: boolean) {
    const field = this.farField;
    if (!field || active === this.farFieldTickerActive) return;
    this.farFieldTickerActive = active;
    field.mesh.visible = active;
    if (active) {
      this.retainFarField();
      this.app.ticker.add(this.tickFarField);
    } else {
      this.app.ticker.remove(this.tickFarField);
      field.mesh.removeFromParent();
    }
  }

  private readonly tickFarField = (ticker: Ticker) => {
    if (!this.farField) return;
    const canvas = this.app.canvas;
    const bounds = canvas.getBoundingClientRect();
    const viewport = sceneCameraViewport(canvas);
    const mapClientToRenderer = viewport
      ? (x: number, y: number) => clientToRendererPoint(
          { x, y },
          this.app.screen.width,
          this.app.screen.height,
          viewport
        )
      : (x: number, y: number) => pointerClientToRenderer(
          x,
          y,
          bounds,
          this.app.screen.width,
          this.app.screen.height
        );
    this.farField.tick(
      ticker.deltaMS / 1000,
      this.app.screen.width,
      this.app.screen.height,
      bounds,
      mapClientToRenderer
    );
  };

  /**
   * Keep the visible column foot on the exact camera ray without rebuilding
   * the Pixi scene. A transition owns at most a few outer panels, so this is
   * bounded geometry work while labels, hit areas, tickers and card buffers
   * remain untouched.
   */
  private readonly updateCameraFrameGeometry = (frame: SceneCameraViewport) => {
    const rendererHeight = this.app.screen.height;
    const visibleHeight = visibleSceneLayoutHeight(frame) *
      rendererHeight / Math.max(1, frame.height);
    const frameBottom = Math.max(0, visibleHeight - GPU_LAYOUT.gap);
    const mask = this.cameraViewportMask;
    if (mask && !mask.destroyed && this.cameraViewportMaskHeight > 0) {
      // One extra pixel keeps the frame's centred 1px stroke whole. The
      // frame itself lives on the unmasked backing layer, while this stops a
      // timeline card or scrollbar from leaking into the bottom gutter.
      mask.scale.y = (frameBottom + 1) / this.cameraViewportMaskHeight;
    }
    for (const panel of this.cameraFramePanels) {
      if (panel.surface.destroyed) continue;
      const nextHeight = Math.max(0, frameBottom - panel.y);
      if (Math.abs(nextHeight - panel.currentHeight) < 0.01) continue;
      panel.currentHeight = nextHeight;
      panel.surface.clear();
      paintPanelSurface(
        panel.surface,
        panel.x,
        panel.y,
        panel.width,
        nextHeight,
        panel.fill,
        panel.fillAlpha,
        panel.border,
        panel.radius
      );
    }
  };

  async init(host: HTMLElement) {
    this.host = host;
    const params = new URLSearchParams(location.search);
    const forceWebGl = params.get('renderer') === 'webgl';
    // MSAA is the single largest cost of a frame on an integrated GPU: the
    // 4-sample colour and stencil targets at 2560×1600 cost 2.5–3× the rest of
    // the frame put together, whatever the view draws (measured 2026-09-06,
    // docs/incidents/gpu-frame-cost-2026-09-06.md). `?atomaQuality=performance`
    // trades edge antialiasing for that headroom for ONE session — a
    // diagnostic switch beside `?renderer=webgl`, never the default.
    const antialias = params.get('atomaQuality') !== 'performance';
    try {
      await this.app.init({
        resizeTo: host,
        preference: forceWebGl ? ['webgl'] : ['webgpu', 'webgl'],
        antialias,
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
        antialias,
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
    // Pixi's stock mapper treats the transformed canvas' axis-aligned
    // bounding box as if it were still a rectangle. A perspective plane is a
    // quadrilateral, so that approximation visibly misses controls. Feed the
    // event boundary the camera-ray/plane intersection instead.
    this.app.renderer.events.mapPositionToPoint = (point, clientX, clientY) => {
      const mapped = this.clientToRendererPosition(clientX, clientY);
      point.x = mapped.x;
      point.y = mapped.y;
    };
    // The counter mutates glyph geometry only. Pre-install exactly the small
    // alphabet it can display so the first rate change cannot grow an atlas in
    // the middle of a frame.
    ensureFpsBitmapFont(Math.min(devicePixelRatio || 1, 2));
    [this.timelineCardMaterial, this.navIconMeshes] = await Promise.all([
      loadTimelineCardMaterial(),
      loadNavIconMeshes(this.app.renderer),
    ]);
    // Application rendering runs at LOW. Every event-card animation runs at
    // the default NORMAL priority, so LOW + 1 combines all changed faces into
    // exactly one buffer upload before the shared mesh is drawn.
    this.app.ticker.add(
      this.flushTimelineCardMaterial,
      undefined,
      UPDATE_PRIORITY.LOW + 1
    );
    this.ambientRoot.eventMode = 'none';
    this.markRoot.eventMode = 'none';
    this.tooltipRoot.eventMode = 'none';
    this.app.stage.addChild(this.ambientRoot, this.stage, this.markRoot, this.tooltipRoot);
    this.tooltipLayer = new TooltipLayer(this.tooltipRoot);
    this.app.ticker.add(this.updateTooltip);
    this.farField = createFarField();
    if (this.farField) {
      this.ambientRoot.addChild(this.farField.mesh);
      this.farFieldTickerActive = true;
      this.app.ticker.add(this.tickFarField);
    }
    this.installPointerLightFilter();
    this.app.canvas.className = 'gpu-ui-canvas';
    this.app.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.app.canvas);
    this.cameraFrameUnsubscribe = subscribeSceneCameraFrames(
      this.app.canvas,
      this.updateCameraFrameGeometry
    );
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
        projectRendererPoint: (x: number, y: number) =>
          this.rendererToClientPosition(x, y),
        tooltip: () => this.tooltipLayer?.diagnostics() ?? {
          visible: false,
          text: null,
          regionCount: 0,
        },
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
    // BREAK THE IDENTITY GUARD FIRST. Two end-of-transition callbacks re-render
    // from a `requestAnimationFrame` guarded only by `this.snapshot ===
    // <the snapshot they started with>` — a guard `destroy()` did not touch,
    // so a frame scheduled just before teardown ran `renderScene` on a
    // destroyed Application (2026-08-27, 3.14). One frame wide, and reachable
    // every HMR reload. Nulling it here is what makes those guards false.
    this.snapshot = null;
    this.runsScroll = null;
    this.cameraFrameUnsubscribe?.();
    this.cameraFrameUnsubscribe = null;
    this.cameraFramePanels = [];
    this.cameraFrameLayer = null;
    this.cameraViewportMask = null;
    this.cameraViewportMaskHeight = 0;
    this.activeViewLayoutHeight = null;
    this.app.ticker.remove(this.flushTimelineCardMaterial);
    this.app.ticker.remove(this.updateTooltip);
    this.tooltipLayer?.destroy();
    this.tooltipLayer = null;
    this.app.ticker.remove(this.updatePointerLight);
    this.app.ticker.remove(this.updateCastShadows);
    this.app.ticker.remove(this.tickFarField);
    this.farFieldTickerActive = false;
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
    // The mesh is retained across scene rebuilds, so release its geometry,
    // buffers and shared shader explicitly before the stage walks children.
    this.timelineCardMaterial?.destroy();
    this.timelineCardMaterial = null;
    const navIconMeshes = this.navIconMeshes;
    this.navIconMeshes = null;
    this.navIconSpins.clear();
    // Detach-then-destroy, BEFORE the app tears the stage down: a retained
    // label still parented would otherwise be destroyed twice.
    this.atomaMark?.handle.destroy();
    this.atomaMark = null;
    this.atomaMarkMotion = null;
    this.previousSceneCameraMode = null;
    this.utilityDockTransition = null;
    this.labels.clear();
    this.textStyles.clear();
    // Retained bands die with the renderer, not with a scene: detach first so
    // the app's own stage walk below cannot destroy them a second time.
    for (const layer of this.animatedLayers.values()) {
      if (layer.destroyed) continue;
      layer.removeFromParent();
      layer.destroy({ children: true, context: true });
    }
    this.animatedLayers.clear();
    this.app.canvas.removeEventListener('wheel', this.wheel);
    window.removeEventListener('pointermove', this.tuningPointerMove);
    window.removeEventListener('pointerup', this.tuningPointerUp);
    window.removeEventListener('pointercancel', this.tuningPointerUp);
    window.removeEventListener('blur', this.tuningPointerUp);
    this.tuningDrag = null;
    this.turnDrag = null;
    this.turnSliderBounds = null;
    this.fpsSample.elapsedMs = 0;
    this.fpsSample.frames = 0;
    this.lastFps = 0;
    this.app.destroy(true, { children: true, context: true });
    navIconMeshes?.destroy();
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
  render(snapshot: GpuRenderSnapshot, forceRebuild = false) {
    const startedAt = performance.now();
    try {
      if (forceRebuild || !this.tryScrollRuns(snapshot)) this.renderScene(snapshot);
    } finally {
      this.metrics.renderMs = performance.now() - startedAt;
      this.metrics.labelsCreated = this.labels.created;
      this.metrics.labelsReused = this.labels.reused;
    }
  }

  private tryScrollRuns(snapshot: GpuRenderSnapshot): boolean {
    const previous = this.snapshot;
    const window = this.runsScroll;
    if (!previous || !window || snapshot.state.view !== 'runs' ||
        this.roleRowTransition || sceneCameraIsMoving(this.app.canvas) ||
        (this.host && (Math.abs(this.host.clientWidth - this.runsScrollWidth) > 1 ||
          Math.abs(this.host.clientHeight - this.runsScrollHeight) > 1)) ||
        snapshot.state.scrollY.runs === previous.state.scrollY.runs ||
        this.app.screen.width !== this.runsScrollWidth ||
        this.app.screen.height !== this.runsScrollHeight) return false;
    // A scroll-only update may reuse geometry. Any data, selection, filter,
    // camera, locale or overlay change still takes the ordinary rebuild.
    for (const key of Object.keys(snapshot.state) as (keyof GpuRenderSnapshot['state'])[]) {
      if (key !== 'scrollY' && snapshot.state[key] !== previous.state[key]) return false;
    }
    for (const key of Object.keys(snapshot.data) as (keyof GpuDataSnapshot)[]) {
      if (snapshot.data[key] !== previous.data[key]) return false;
    }
    if (snapshot.t !== previous.t || snapshot.onActivate !== previous.onActivate ||
        snapshot.releaseVersion !== previous.releaseVersion) return false;
    const offset = Math.max(0, Math.min(this.scrollMax.runs ?? 0, snapshot.state.scrollY.runs));
    if (offset < window.min || offset > window.max ||
        ((offset === 0 || offset === this.scrollMax.runs) && offset !== window.origin)) return false;
    window.move(offset);
    this.snapshot = snapshot;
    this.anchorCastShadows();
    this.updateCastShadows();
    return true;
  }

  private renderScene(snapshot: GpuRenderSnapshot) {
    this.runsScroll = null;
    this.runsScrollWidth = this.app.screen.width;
    this.runsScrollHeight = this.app.screen.height;
    this.snapshot = snapshot;
    this.setFarFieldActive(shouldShowFarField(
      snapshot.state.entered,
      this.atomaMark?.placement.visualScale
    ));
    // Drop camera handles BEFORE their scene-owned Graphics are destroyed.
    // A camera rAF can publish again only after this synchronous pass returns.
    this.cameraFramePanels = [];
    this.cameraFrameLayer = null;
    this.cameraViewportMask = null;
    this.cameraViewportMaskHeight = 0;
    this.activeViewLayoutHeight = null;
    for (const callback of this.tickerCallbacks) this.app.ticker.remove(callback);
    this.tickerCallbacks.clear();
    // Detach the retained material mesh before the recursive scene teardown.
    // Its scene-owned underlay/overlay stack may then be destroyed normally.
    this.timelineCardMaterial?.beginRender();
    // Retained labels step out of the scene BEFORE it is torn down, so the
    // recursive destroy below walks past them instead of through them.
    this.labels.beginRender();
    // Dropped with the scene that owns them; the ticker must not be left
    // holding Graphics that are about to be destroyed.
    this.castShadows = [];
    const keepFarField = this.farField?.mesh ?? null;
    for (const child of this.ambientRoot.removeChildren()) {
      if (child === keepFarField || child.label === FAR_FIELD_LABEL) continue;
      child.destroy({ children: true, context: true });
    }
    this.retainFarField();
    // Bands step out AFTER the labels did and BEFORE the stage is walked, so
    // neither the retained labels inside them nor the bands themselves are
    // destroyed with the scene.
    this.releaseAnimatedLayers();
    this.root = this.stage;
    for (const child of this.stage.removeChildren()) {
      // Pixi Graphics owns a GraphicsContext, but passing ANY options object
      // stops Graphics.destroy() from releasing it unless context is explicit.
      // Without this bit every wheel rebuild left hundreds of GPU contexts in
      // GraphicsContextSystem._managedContexts while WebGPU GC was pinned off.
      child.destroy({ children: true, context: true });
    }
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
      child.destroy({ children: true, context: true });
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
    this.notificationsBounds = null;
    this.notificationsScrollMax = 0;
    // A closed tray forgets its place: reopening starts at the newest rows.
    if (!snapshot.state.notificationsMenuOpen) this.notificationsScrollY = 0;
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
    const cameraMode = snapshot.state.sceneCameraMode;
    const focused = cameraMode === 'focus';
    const now = performance.now();
    if (
      this.previousSceneCameraMode !== null &&
      this.previousSceneCameraMode !== cameraMode
    ) {
      this.utilityDockTransition = prefersReducedMotion()
        ? null
        : {
            from: this.previousSceneCameraMode,
            to: cameraMode,
            startedAt: now,
            duration: sceneCameraTransitionDuration(cameraMode),
          };
    }
    this.previousSceneCameraMode = cameraMode;
    let utilityTransition = this.utilityDockTransition;
    const utilityProgress = () => utilityTransition
      ? Math.max(0, Math.min(1, (performance.now() - utilityTransition.startedAt) /
          Math.max(1, utilityTransition.duration)))
      : 1;
    if (utilityTransition && utilityProgress() >= 1) {
      this.utilityDockTransition = null;
      utilityTransition = null;
    }
    this.drawHeader(snapshot, width);
    // Views draw in their OWN viewport space, from x = 0, exactly as they did
    // when they owned the full width. The rail narrows before it can shove the
    // view beyond the window; CSS mirrors this exact clamp for DOM overlays.
    const contentLeft = sidebarWidthForViewport(width);
    const contentWidth = Math.max(0, width - contentLeft);
    // During camera travel the view is authored once at its largest height.
    // `updateCameraFrameGeometry` then follows the exact published camera ray
    // by resizing only the outer panels and viewport mask. The complete scene
    // therefore remains available behind the mask for DEZOOM, while the one
    // settle rebuild commits scroll masks and bottom-anchored controls.
    const cameraFrame = sceneCameraViewport(this.app.canvas);
    const visibleLayoutHeight = cameraFrame
      ? visibleSceneLayoutHeight(cameraFrame) * height / Math.max(1, cameraFrame.height)
      : height;
    const layoutHeight = sceneCameraIsMoving(this.app.canvas)
      ? height
      : visibleLayoutHeight;
    // The compact rail is endpoint chrome: retain its established final
    // geometry during approach while the central column itself grows/shrinks.
    const focusLayoutHeight = visibleSceneLayoutHeight(buildSceneCameraFrame(
      sceneCameraForMode('focus', width, height),
      width,
      height
    ));
    const focusRail = focused
      ? focusRailChromeLayout(contentLeft, focusLayoutHeight, snapshot.data.auth !== null)
      : null;
    const overviewRail = focused ? null : overviewRailChromeLayout(contentLeft);
    drawSidebar(
      this,
      snapshot,
      height,
      contentLeft,
      focusRail?.navigationBottom ?? layoutHeight,
      focusRail?.navigationTop ?? overviewRail?.navigationTop ?? GPU_LAYOUT.headerHeight
    );
    if (focusRail) {
      this.drawFocusRailChrome(snapshot, focusRail);
    } else if (overviewRail) {
      this.drawOverviewRailChrome(snapshot, overviewRail);
    }
    const viewportMaskHeight = Math.max(0, layoutHeight - GPU_LAYOUT.gap + 1);
    const viewportMask = new Graphics();
    viewportMask.rect(0, 0, contentWidth, viewportMaskHeight).fill(0xffffff);
    viewportMask.position.x = contentLeft;
    viewportMask.eventMode = 'none';
    viewportMask.label = 'camera-view-mask';
    this.cameraViewportMask = viewportMask;
    this.cameraViewportMaskHeight = viewportMaskHeight;
    const frameLayer = new Container();
    frameLayer.x = contentLeft;
    frameLayer.eventMode = 'none';
    frameLayer.label = 'camera-view-frames';
    this.cameraFrameLayer = frameLayer;
    const viewport = new Container();
    viewport.x = contentLeft;
    viewport.mask = viewportMask;
    this.stage.addChild(frameLayer, viewport, viewportMask);
    // The view frame begins one standard gap inside this viewport. Leaving
    // that gutter on the ambient field exposes the header/rail seam around
    // the frame's rounded corner, where it reads as a second frame underneath
    // the real one. Continue the shared chrome wash only through that gutter;
    // the retained frame still owns the actual surface, border and radius.
    // Focus has no horizontal header seam, so the geometry helper returns no
    // wash there and the ambient field stays clean around the rounded corner.
    const gutterRects = viewFrameGutterRects(focused, contentWidth, layoutHeight);
    if (gutterRects.length > 0) {
      const gutter = new Graphics();
      gutter.label = 'camera-view-gutter';
      for (const rect of gutterRects) {
        gutter.rect(rect.x, rect.y, rect.width, rect.height);
      }
      gutter.fill({ color: 0x0b111e, alpha: 0.42 });
      gutter.eventMode = 'none';
      viewport.addChild(gutter);
    }
    this.root = viewport;
    this.activeViewLayoutHeight = layoutHeight;
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
            drawProjects(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'admin':
            drawAdmin(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'journal':
            drawJournal(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'ledger':
            drawLedger(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'sentinel':
            drawSentinel(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'announce':
            drawAnnounce(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'runs':
            drawRuns(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'registry':
            drawRegistry(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'skills':
            drawSkills(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'burnin':
            drawBurnin(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'docs':
            drawDocs(this, snapshot, contentWidth, layoutHeight);
            break;
          case 'settings':
            drawSettings(this, snapshot, contentWidth, layoutHeight);
            break;
        }
      }
    } finally {
      // Chrome draws into the stage again — including on the throw path, or
      // one failed view would leave every later overlay inside the viewport.
      this.activeViewLayoutHeight = null;
      this.root = this.stage;
    }
    this.translateViewBounds(contentLeft);
    this.drawOverlays(snapshot, width, layoutHeight);
    const enteringFocus = utilityTransition?.from === 'overview' &&
      utilityTransition.to === 'focus';
    const leavingFocus = utilityTransition?.from === 'focus' &&
      utilityTransition.to === 'overview';
    const easedUtilityProgress = utilityTransition
      ? sceneCameraEase(utilityProgress())
      : 1;
    const opacitySetters: {
      set: (opacity: number) => void;
      direction: 'enter' | 'leave';
    }[] = [];
    // Keep BOTH copies alive during camera travel. Otherwise the utility dock
    // teleports between the overview header and the foot of the focused rail,
    // which is especially abrupt for the retained 3D profile orb.
    if (!focused || enteringFocus) {
      opacitySetters.push({
        set: this.drawHeaderUtilityDock(
          snapshot,
          width,
          enteringFocus ? utilityDockOpacity('leave', easedUtilityProgress) : leavingFocus
            ? utilityDockOpacity('enter', easedUtilityProgress)
            : 1,
          utilityTransition === null
        ),
        direction: enteringFocus ? 'leave' : 'enter',
      });
    }
    if (focused || leavingFocus) {
      const dockLayout = focusRail ?? focusRailChromeLayout(
        contentLeft,
        focusLayoutHeight,
        snapshot.data.auth !== null
      );
      opacitySetters.push({
        set: this.drawFocusRailDock(
          snapshot,
          dockLayout,
          enteringFocus ? utilityDockOpacity('enter', easedUtilityProgress) : leavingFocus
            ? utilityDockOpacity('leave', easedUtilityProgress)
            : 1,
          utilityTransition === null
        ),
        direction: leavingFocus ? 'leave' : 'enter',
      });
    }
    if (utilityTransition && opacitySetters.length > 0) {
      const transition = utilityTransition;
      let completed = false;
      const animateUtilityDocks = () => {
        if (this.utilityDockTransition !== transition) return;
        const progress = utilityProgress();
        const eased = sceneCameraEase(progress);
        for (const entry of opacitySetters) {
          entry.set(utilityDockOpacity(entry.direction, eased));
        }
        if (completed || progress < 1) return;
        completed = true;
        this.utilityDockTransition = null;
        requestAnimationFrame(() => {
          if (this.snapshot === snapshot) this.render(snapshot);
        });
      };
      animateUtilityDocks();
      this.addTicker(animateUtilityDocks);
    }
    drawAccountMenu(this, snapshot, width, layoutHeight, focusRail?.profile ?? undefined);
    const accountReserve = snapshot.data.auth ? HEADER_ORB_SIZE + 16 : 0;
    const bellReserve = snapshot.data.auth ? HEADER_BELL_WIDTH + 8 : 0;
    const localeAnchor: LocaleMenuAnchor = snapshot.state.sceneCameraMode === 'focus' && focusRail
      ? focusRail.locale
      : {
          x: width - 54 - accountReserve - bellReserve,
          y: GPU_LAYOUT.headerHeight / 2 - 16,
          width: 42,
          height: 32,
        };
    drawLocaleMenu(this, snapshot, width, layoutHeight, localeAnchor);
    // The tray anchors to the bell wherever the bell currently lives; the
    // anchor exists only with an account, exactly like the control.
    const notificationsAnchor: NotificationsMenuAnchor | undefined = snapshot.data.auth
      ? snapshot.state.sceneCameraMode === 'focus' && focusRail
        ? focusRail.bell ?? undefined
        : {
            x: width - accountReserve - HEADER_BELL_WIDTH - 4,
            y: GPU_LAYOUT.headerHeight / 2 - 16,
            width: HEADER_BELL_WIDTH,
            height: 32,
          }
      : undefined;
    if (notificationsAnchor) {
      const tray = drawNotificationsMenu(
        this,
        snapshot,
        width,
        layoutHeight,
        notificationsAnchor,
        this.notificationsScrollY
      );
      if (tray) {
        this.notificationsBounds = tray.bounds;
        this.notificationsScrollMax = tray.scrollMax;
        // The clamp the draw applied is the offset the wheel adds to.
        this.notificationsScrollY = Math.min(this.notificationsScrollY, tray.scrollMax);
      }
    }
    publishOverlayMenuClip(
      overlayMenuClip(
        snapshot,
        width,
        layoutHeight,
        {
          account: focusRail?.profile ?? undefined,
          locale: localeAnchor,
          notifications: notificationsAnchor,
        },
        (value, options) => this.measureText(value, options)
      )
    );
    this.drawRemovedFilterEffects();
    if (this.previousView && this.previousView !== snapshot.state.view) {
      this.activeViewTransition = {
        from: this.previousView,
        to: snapshot.state.view,
        startedAt: performance.now(),
      };
    }
    this.previousView = snapshot.state.view;
    this.drawViewTransition(width, layoutHeight);
    this.previousFilterBounds = this.currentFilterBounds;
    if (snapshot.state.view !== 'runs') this.roleRowTransition = null;
    this.previousEventIds = this.currentEventIds;
    this.sweepAvatarOrbs();
    // Labels this render did not draw go idle, and idle keys are released.
    // `countObjects` walks the live scene, and a retained label that was not
    // re-attached is not in it, so retention never inflates objectCount.
    this.labels.endRender();
    if (cameraFrame) this.updateCameraFrameGeometry(cameraFrame);
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
    const viewLayoutHeight = this.activeViewLayoutHeight;
    const frameLayer = this.cameraFrameLayer;
    const isCameraFramePanel =
      elevation === 2 &&
      viewLayoutHeight !== null &&
      parent === this.root &&
      frameLayer !== null &&
      Math.abs(y + safeHeight - (viewLayoutHeight - GPU_LAYOUT.gap)) < 0.01;
    const shadowAlpha = 0.42 + elevation * 0.06;
    const shadowDepth = 0.55 + elevation * 0.35;
    // A full-panel cast shadow reads as a second rounded frame once the outer
    // surface is retained outside the camera mask. Keep depth on cards and
    // controls, but let the column's own border/rim define its silhouette.
    if (elevation > 0 && !isCameraFramePanel) {
      this.addSurfaceShadow(parent, safeWidth, safeHeight, {
        x,
        y,
        radius,
        alpha: shadowAlpha,
        depth: shadowDepth,
        surface: 'column',
      });
    }

    const graphics = new Graphics();
    const fillAlpha = elevation === 0
      ? 0.84
      : VIZ_VISUAL_DEPTH.near.panelAlpha - (2 - elevation) * 0.04;
    paintPanelSurface(
      graphics,
      x,
      y,
      safeWidth,
      safeHeight,
      fill,
      fillAlpha,
      border,
      radius
    );
    graphics.eventMode = 'none';
    parent.addChild(graphics);

    if (isCameraFramePanel) {
      this.cameraFramePanels.push({
        surface: graphics,
        x,
        y,
        width: safeWidth,
        fill,
        fillAlpha,
        border,
        radius,
        currentHeight: safeHeight,
      });
    }

    let rim: Graphics | null = null;
    if (elevation > 0 && safeWidth > 8) {
      rim = new Graphics();
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
    if (isCameraFramePanel && frameLayer) {
      // The content mask must stop cards at the moving frame bottom without
      // clipping the frame's own border. Both layers share the same view-local
      // coordinate system, so reparenting changes no geometry.
      frameLayer.addChild(graphics);
      if (rim) frameLayer.addChild(rim);
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
    this.addSurfaceShadow(container, block.width, block.height, {
      radius: 10,
      alpha: 0.46,
      depth: 0.8,
      surface: 'frame',
    });
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
    const label = this.snapshot?.t(range.labelKey) ?? range.labelKey;
    const trackLocalX = x + TUNING_LABEL_WIDTH;
    const trackWidth = Math.max(
      40,
      width - TUNING_LABEL_WIDTH - TUNING_READOUT_WIDTH - 16
    );

    this.text(parent, label, x, y + 4, {
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
    // entry per step. The FPS readout solves the same live-string problem with
    // BitmapText because its glyph set is tiny and fixed.
    const readout = new Text({ text: '', style, ...gpuTextRasterOptions() });
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
      label,
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
    const readout = new Text({ text: '', style, ...gpuTextRasterOptions() });
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
      new Text({ text: value, style, ...gpuTextRasterOptions() })
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

  /** Prefix a repository name with the shared, rasterised GitHub GLB mesh. */
  repositoryIcon(parent: Container, x: number, y: number, size: number) {
    const meshes = this.navIconMeshes;
    if (!meshes) return null;
    this.addSilhouetteShadow(parent, meshes.github.shadowTexture, size, size, {
      x,
      y,
      radius: Math.max(2, size * 0.22),
      alpha: 0.3,
      depth: 0.45,
      surface: 'button',
    });
    return drawRepositoryIcon(parent, meshes, x, y, size);
  }

  /** Small neutral lock paired with a private repository visibility label. */
  privateRepositoryIcon(parent: Container, x: number, y: number, size: number) {
    const root = new Container();
    root.position.set(x, y);
    root.label = 'repository-private-lock';
    root.eventMode = 'none';
    const lock = new Graphics();
    const stroke = Math.max(1.2, size * 0.12);
    lock
      .moveTo(size * 0.28, size * 0.48)
      .lineTo(size * 0.28, size * 0.35)
      .bezierCurveTo(
        size * 0.28,
        size * 0.08,
        size * 0.72,
        size * 0.08,
        size * 0.72,
        size * 0.35
      )
      .lineTo(size * 0.72, size * 0.48)
      .stroke({ color: GPU_COLORS.muted, width: stroke, alpha: 0.8 });
    lock
      .roundRect(size * 0.16, size * 0.43, size * 0.68, size * 0.5, size * 0.1)
      .fill({ color: GPU_COLORS.muted, alpha: 0.72 });
    root.addChild(lock);
    parent.addChild(root);
    return root;
  }

  /** Transparent interactive region for inline links drawn by a view. */
  linkRegion(
    parent: Container,
    id: string,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    onActivate: (id: string) => void
  ) {
    const region = new Container();
    region.position.set(x, y);
    region.label = id;
    region.eventMode = 'static';
    region.cursor = 'pointer';
    region.hitArea = new Rectangle(0, 0, width, height);
    region.on('pointertap', () => onActivate(id));
    parent.addChild(region);
    this.recordHitTarget(parent, { id, role: 'link', label, x, y, width, height });
    return region;
  }

  private addSurfaceShadow(
    parent: Container,
    width: number,
    height: number,
    options: SurfaceShadowOptions = {}
  ) {
    const { x = 0, y = 0 } = options;
    return this.addCastShadow(parent, width, height, options, () => {
      const shadow = new Graphics();
      paintPanelShadow(
        shadow,
        x,
        y,
        width,
        height,
        options.radius ?? 8,
        options.alpha ?? 0.44,
        options.depth ?? 1
      );
      return shadow;
    });
  }

  /** The shared scene shadow material clipped to a texture's alpha silhouette. */
  private addSilhouetteShadow(
    parent: Container,
    texture: Texture,
    width: number,
    height: number,
    options: SurfaceShadowOptions = {}
  ) {
    const { x = 0, y = 0 } = options;
    const silhouette = new Container();
    silhouette.pivot.set(width / 2, height / 2);
    silhouette.position.set(x + width / 2, y + height / 2);
    const shadow = this.addCastShadow(parent, width, height, options, (layers) => {
      const shadow = new Container();
      for (const [index, layer] of layers.entries()) {
        const towardCore = layers.length > 1 ? index / (layers.length - 1) : 1;
        const sprite = new Sprite(texture);
        sprite.position.set(layer.x, layer.y);
        sprite.width = layer.width;
        sprite.height = layer.height;
        sprite.tint = mixColor(
          SCENE_SHADOW_COLORS.penumbra,
          SCENE_SHADOW_COLORS.core,
          towardCore
        );
        sprite.alpha = layer.alpha;
        sprite.eventMode = 'none';
        silhouette.addChild(sprite);
      }
      shadow.addChild(silhouette);
      return shadow;
    });
    return { shadow, silhouette };
  }

  /**
   * One painter owns every outward shadow: the same penumbra, palette, cast
   * offset, light height and elevation. Callers provide only the geometry
   * that receives that material (rounded rect or alpha silhouette).
   */
  private addCastShadow<T extends Graphics | Container>(
    parent: Container,
    width: number,
    height: number,
    options: SurfaceShadowOptions,
    paint: (layers: ReturnType<typeof softShadowLayers>) => T
  ): T {
    const {
      x = 0,
      y = 0,
      radius = 8,
      alpha = 0.44,
      depth = 1,
      surface = 'card',
    } = options;
    // Geometry stays fixed at the declared surface origin and the cast offset
    // lives in POSITION — pointer motion therefore never re-tessellates it.
    const shadow = paint(softShadowLayers(width, height, radius, alpha, depth));
    shadow.eventMode = 'none';
    parent.addChild(shadow);
    this.registerCastShadow(shadow, parent, x, y, width, height, depth, surface);
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
    shadow.fill({ color: SCENE_SHADOW_COLORS.core, alpha });
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
    shadow: Graphics | Container,
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
    this.lastCastShadowFrame.strength = Number.NaN;
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
    if (
      strength === this.lastCastShadowFrame.strength &&
      lightX === this.lastCastShadowFrame.lightX &&
      lightY === this.lastCastShadowFrame.lightY &&
      tuning.revision === this.lastCastShadowFrame.tuningRevision
    ) {
      return;
    }
    this.lastCastShadowFrame = {
      strength,
      lightX,
      lightY,
      tuningRevision: tuning.revision,
    };
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
    spinning = false,
    /** Optional visual label column; the hit target keeps the full accessible label. */
    labelMaxWidth?: number,
    /** Optional top offset for compound buttons that draw secondary copy. */
    labelY?: number,
    /** Accessible name when the visual label is a spinner glyph. */
    accessibleLabel?: string
  ) {
    const container = new Container();
    container.position.set(x, y);
    this.addSurfaceShadow(container, width, height, {
      radius: 7,
      alpha: 0.4,
      surface: 'button',
    });
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
      this.fitText(
        label,
        Math.max(0, Math.min(width - 20, labelMaxWidth ?? Number.POSITIVE_INFINITY)),
        labelStyle
      ),
      centerLabel ? width / 2 : BUTTON_LABEL_INSET,
      labelY ?? Math.max(5, (height - 16) / 2),
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
    container.cursor = spinning ? 'wait' : 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    container.on('pointertap', () => {
      if (spinning) return;
      onActivate(id);
    });
    container.on('pointerover', () => {
      graphics.tint = 0xbfd6ff;
    });
    container.on('pointerout', () => {
      graphics.tint = 0xffffff;
    });
    parent.addChild(container);
    this.recordHitTarget(parent, {
      id,
      role,
      label: accessibleLabel ?? label,
      x,
      y,
      width,
      height,
    });
    return container;
  }

  addTicker(callback: (ticker: Ticker) => void) {
    this.tickerCallbacks.add(callback);
    this.app.ticker.add(callback);
  }

  /**
   * THE HOME OF EVERY PER-FRAME ANIMATION. A subtree whose ticker mutates it
   * every frame — a pulsing chip, a nav button's scanline and sparks, a
   * spinning icon, a redrawn mask — draws into its own Pixi render group.
   *
   * Pixi 8 keeps ONE batch geometry per render group and re-uploads the WHOLE
   * buffer whenever any element in it moves (`Batcher.dirty` →
   * `BatcherPipe.upload`), and a redrawn batchable `Graphics` sets
   * `structureDidChange`, which rebuilds the whole group's instruction set.
   * With everything in the root group, one active chip's pulse re-uploaded
   * every card, label and panel of the Runs view on every frame (287KB/frame
   * on an 80-event trace, ~1 instruction rebuild per frame; measured
   * 2026-09-06 on the compiled client) and the crystal's silhouette masks did
   * the same on every view. Each layer here costs one batch break in its
   * parent, so ANIMATED CONTROLS SHARE ONE LAYER PER BAND (the rail, a chip
   * row, a tile grid) rather than taking one each.
   *
   * The layer sits at the parent's origin and has no transform of its own, so
   * `recordHitTarget` projections, wheel routing and `toGlobal()` closures are
   * unchanged. Static chrome behind the controls (frames, headings) stays in
   * the parent: the layer is for what MOVES.
   */
  animatedLayer(parent: Container, label: string): Container {
    // RETAINED, like the labels and the card material. A render group owns a
    // batcher whose attribute and index buffers live in Pixi's BatcherPipe,
    // keyed by the group's instruction set; destroying the container with the
    // scene drops the group but not those buffers, and WebGPU GC is pinned
    // off, so every wheel tick leaked two GPU buffers per band (603 → 923
    // over one 32-tick smoke cycle, 2026-09-06). Reusing the same container
    // keeps the same group, the same instruction set and the same buffers.
    let key = label;
    let ordinal = 1;
    while (this.animatedLayers.get(key)?.parent) key = `${label}#${++ordinal}`;
    let layer = this.animatedLayers.get(key);
    if (!layer || layer.destroyed) {
      layer = new Container({ isRenderGroup: true });
      layer.label = label;
      this.animatedLayers.set(key, layer);
    }
    parent.addChild(layer);
    return layer;
  }

  /**
   * Step the retained bands out of the scene before it is torn down, and
   * destroy what they drew: the widgets are per-render, the band is not.
   * Labels have already been detached by `labels.beginRender()`, so the
   * recursive destroy here walks past them exactly as the stage teardown does.
   */
  private releaseAnimatedLayers() {
    for (const layer of this.animatedLayers.values()) {
      if (layer.destroyed) continue;
      layer.removeFromParent();
      for (const child of layer.removeChildren()) {
        child.destroy({ children: true, context: true });
      }
    }
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
    accent: number = GPU_COLORS.primary,
    labelSize: number = 11
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
    const dropShadow = this.addSurfaceShadow(container, width, height, {
      radius: 8,
      alpha: 0.4,
      surface: 'button',
    });

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

    // The label box tracks the face: 11px renders ~16px tall, so centre on
    // labelSize + 5 rather than a constant tied to the default face.
    const labelBox = labelSize + 5;
    const labelText = this.text(container, label, width / 2, Math.max(3, (height - labelBox) / 2), {
      // Built BRIGHT and tinted down, never re-coloured through the style —
      // the style is shared, so `style.fill = …` recolours every label using it.
      size: labelSize,
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
    let settled = false;
    let lastReduced = prefersReducedMotion();
    const animate = (ticker: Ticker) => {
      const reduced = prefersReducedMotion();
      if (settled && !hovered && !pressed && !active && reduced === lastReduced) return;
      lastReduced = reduced;
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = reduced ? 1 : Math.max(0, Math.min(1, elapsed / 260));
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
      if (!active && !pressed && insetDepth < 0.001) insetDepth = 0;
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
      settled = entrance >= 1 && !active && !hovered && !pressed && insetDepth === 0;
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
    onActivate: (id: string) => void,
    options: { readonly iconOnly?: boolean; readonly tooltip?: string } = {}
  ) {
    const iconOnly = options.iconOnly === true;
    const firstAppearance = !prefersReducedMotion() && !this.seenAnimatedControls.has(id);
    this.seenAnimatedControls.add(id);
    const container = new Container();
    container.position.set(x, y);
    container.eventMode = 'static';
    container.cursor = 'pointer';
    const iconGutter = iconOnly ? 0 : NAV_ICON_RENDER_SIZE + NAV_ICON_OUTSIDE_GAP;
    container.hitArea = new Rectangle(-iconGutter, 0, width + iconGutter, height);
    const dropShadow = this.addSurfaceShadow(container, width, height, {
      radius: 8,
      alpha: 0.48,
    });

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

    const labelStyle = {
      size: 11,
      // Built BRIGHT and tinted down — see the sibling button factory.
      color: GPU_COLORS.text,
      weight: active ? '700' : '600',
    } as const;
    const iconWidth = iconOnly
      ? Math.min(NAV_ICON_RENDER_SIZE, Math.max(12, height))
      : NAV_ICON_RENDER_SIZE;
    const horizontalPad = 12;
    const fittedLabel = this.fitText(
      label,
      Math.max(0, width - horizontalPad * 2),
      labelStyle
    );
    const iconKind = navIconKind(id);
    const iconMesh = iconKind && this.navIconMeshes
      ? this.navIconMeshes.icons[iconKind]
      : null;
    const iconX = iconOnly ? (width - iconWidth) / 2 : -iconGutter;
    const iconY = (height - iconWidth) / 2;
    if (iconMesh) {
      this.addSilhouetteShadow(container, iconMesh.shadowTexture, iconWidth, iconWidth, {
        x: iconX,
        y: iconY,
        radius: 8,
        alpha: 0.48,
        depth: 1,
        surface: 'button',
      });
    }
    const icon = this.navIconMeshes
      ? drawNavIcon(
          container,
          id,
          this.navIconMeshes,
          iconX,
          iconY,
          active,
          iconWidth
        )
      : null;
    const labelText = iconOnly
      ? null
      : this.text(
          container,
          fittedLabel,
          horizontalPad,
          Math.max(5, (height - 16) / 2),
          labelStyle
        );

    const sparks = Array.from({ length: 3 }, (_, index) => {
      const spark = new Graphics();
      spark.circle(0, 0, 1.2 - index * 0.18).fill(index === 1 ? 0xffffff : GPU_COLORS.primary);
      spark.alpha = active ? 0.5 : 0;
      container.addChild(spark);
      return spark;
    });

    let hovered = false;
    let pressed = false;
    let iconSpin = this.navIconSpins.get(id) ?? { rotation: 0, target: 0 };
    let insetDepth = active ? 1 : 0;
    let elapsed = firstAppearance ? -Math.max(0, x - 112) * 0.35 : performance.now();
    container.alpha = firstAppearance ? 0 : 1;
    let currentLabelTint = active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
    if (labelText) labelText.tint = currentLabelTint;
    let settled = false;
    let lastReduced = prefersReducedMotion();
    const animate = (ticker: Ticker) => {
      const reduced = prefersReducedMotion();
      if (icon) {
        iconSpin = advanceNavIconSpin(
          iconSpin,
          ticker.deltaMS,
          prefersReducedMotion()
        );
        this.navIconSpins.set(id, iconSpin);
        const iconCenterX = x + iconX + iconWidth / 2;
        const iconCenterY = y + height / 2;
        const fromLightX = iconCenterX - this.lightRendererX;
        const fromLightY = iconCenterY - this.lightRendererY;
        const lightStrength = Math.max(0, this.pointerLightUniforms?.uStrength ?? 0);
        const lighting = navIconLighting(fromLightX, fromLightY, lightStrength);
        icon.mesh.render(
          iconSpin.rotation % (Math.PI * 2),
          lighting,
          performance.now(),
          iconSpin.rotation < iconSpin.target
        );
      }
      if (settled && !hovered && !pressed && !active && reduced === lastReduced) return;
      lastReduced = reduced;
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = reduced ? 1 : Math.max(0, Math.min(1, elapsed / 280));
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
      base.tint = pressed ? 0xafd1ff : hovered ? 0xd7e8ff : 0xffffff;
      // A pressed or selected surface is RECESSED: its drop shadow gives way
      // to the one it casts into itself. The inner shadow stays registered
      // with the pointer light, so moving the mouse over a sunk button moves
      // the shadow around INSIDE it. Reduced motion jumps rather than damps.
      insetDepth += ((pressed || active ? 1 : 0) - insetDepth) *
        (prefersReducedMotion() ? 1 : 0.3);
      if (!active && !pressed && insetDepth < 0.001) insetDepth = 0;
      insetShadow.alpha = insetDepth;
      insetShadow.visible = insetDepth > 0.02;
      dropShadow.alpha = 1 - insetDepth;
      const nextLabelTint = pressed || hovered || active ? NO_TINT : BUTTON_LABEL_IDLE_TINT;
      if (labelText && nextLabelTint !== currentLabelTint) {
        currentLabelTint = nextLabelTint;
        labelText.tint = nextLabelTint;
      }
      if (icon) icon.root.alpha = active || hovered || pressed ? 1 : 0.88;
      sparks.forEach((spark, index) => {
        const phase = elapsed / 350 + index * 2.1;
        spark.position.set(10 + (Math.sin(phase) * 0.5 + 0.5) * (width - 20), height - 3 - Math.abs(Math.cos(phase)) * 4);
        spark.alpha = active ? 0.25 + pulse * 0.5 : hovered ? 0.18 + pulse * 0.3 : 0;
      });
      settled = entrance >= 1 && !active && !hovered && !pressed && insetDepth === 0;
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
    container.on('pointertap', () => {
      if (icon) {
        iconSpin = queueNavIconSpin(iconSpin, prefersReducedMotion());
        this.navIconSpins.set(id, iconSpin);
      }
      onActivate(id);
    });
    parent.addChild(container);
    const hitTarget = {
      id,
      role: 'tab',
      label,
      x: x - iconGutter,
      y,
      width: width + iconGutter,
      height,
    } as const;
    this.recordHitTarget(parent, hitTarget);
    if (options.tooltip) {
      this.tooltip(parent, {
        x: hitTarget.x,
        y: hitTarget.y,
        width: hitTarget.width,
        height: hitTarget.height,
        text: options.tooltip,
      });
    }
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
    this.addSurfaceShadow(container, width, height, { radius: 8, alpha: 0.4 });

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
    const dropShadow = this.addSurfaceShadow(container, width, height, {
      radius: 8,
      alpha: 0.42,
    });

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
    let settled = false;
    let lastReduced = prefersReducedMotion();
    const animate = (ticker: Ticker) => {
      const reduced = prefersReducedMotion();
      if (settled && !hovered && !pressed && !active && reduced === lastReduced) return;
      lastReduced = reduced;
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = reduced ? 1 : Math.max(0, Math.min(1, elapsed / 300));
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
      if (!active && !pressed && insetDepth < 0.001) insetDepth = 0;
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
      settled = entrance >= 1 && !active && !hovered && !pressed && insetDepth === 0;
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

  eventCard(
    parent: Container,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    accent: number,
    selected: boolean,
    onActivate: (id: string) => void,
    zDepth = 0
  ) {
    const wasVisible = this.previousEventIds.has(id);
    const entranceDelay = this.currentEventIds.size * 18;
    this.currentEventIds.add(id);
    const material = this.timelineCardMaterial;
    if (!material) {
      throw new Error('timeline card material was not loaded before rendering');
    }
    const layers = material.layersFor(parent);
    const underlayContainer = new Container();
    underlayContainer.label = `timeline-card-underlay:${id}`;
    underlayContainer.position.set(x, y);
    underlayContainer.skew.x = -zDepth * 0.007;
    underlayContainer.eventMode = 'none';
    layers.underlay.addChild(underlayContainer);
    const container = new Container();
    container.label = `timeline-card:${id}`;
    container.position.set(x, y);
    container.skew.x = -zDepth * 0.007;
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.hitArea = new Rectangle(0, 0, width, height);
    const chamfer = Math.min(7, height * 0.16);
    const extrusionX = 3.5 + zDepth * 3.5;
    const extrusionY = 4 + zDepth * 3.5;
    const facePoints = [
      chamfer, 0,
      width - chamfer, 0,
      width, chamfer,
      width, height - chamfer,
      width - chamfer, height,
      chamfer, height,
      0, height - chamfer,
      0, chamfer,
    ];
    layers.overlay.addChild(container);

    // The card is a raised object above the timeline cartouche. This shadow is
    // outside the grain face so its texture cannot turn the shadow into
    // another outline; the pointer light moves it across the cartouche like
    // every other elevation-bearing surface.
    const shadowHost = new Container();
    shadowHost.position.set(x, y);
    layers.underlay.addChild(shadowHost);
    const castShadow = this.addSurfaceShadow(shadowHost, width, height, {
      radius: chamfer,
      alpha: 0.58,
      // The solid extrusion already occupies 4–7px. The cast must spread
      // beyond that wall or it is physically present but visually buried.
      depth: 1.35 + zDepth * 0.85,
      surface: 'card',
    });

    const back = new Graphics();
    back.poly(facePoints.map((value, index) => value + (index % 2 === 0 ? extrusionX : extrusionY)));
    back.fill({ color: mixColor(0x10243b, accent, 0.18), alpha: 0.98 });
    underlayContainer.addChild(back);

    // Solid right and lower walls connect the rear slab to the face. Their
    // unequal values provide depth without repeating neon contours.
    const rightWall = new Graphics();
    rightWall.poly([
      width, chamfer,
      width + extrusionX, chamfer + extrusionY,
      width + extrusionX, height - chamfer + extrusionY,
      width, height - chamfer,
    ]);
    rightWall.fill({ color: mixColor(0x0d2035, accent, 0.14), alpha: 0.98 });
    underlayContainer.addChild(rightWall);

    const lowerWall = new Graphics();
    lowerWall.poly([
      chamfer, height,
      width - chamfer, height,
      width - chamfer + extrusionX, height + extrusionY,
      chamfer + extrusionX, height + extrusionY,
    ]);
    lowerWall.fill({ color: mixColor(0x0a1a2c, accent, 0.1), alpha: 0.98 });
    underlayContainer.addChild(lowerWall);

    const aura = new Graphics();
    aura.poly([
      chamfer, -3,
      width - chamfer, -3,
      width + 3, chamfer,
      width + 3, height - chamfer,
      width - chamfer, height + 3,
      chamfer, height + 3,
      -3, height - chamfer,
      -3, chamfer,
    ]);
    aura.stroke({ color: accent, width: 2.4, alpha: 0.72 });
    aura.alpha = selected ? 0.28 : 0;
    underlayContainer.addChild(aura);

    const faceColor = mixColor(
      selected ? 0x203b61 : 0x192a43,
      accent,
      selected ? 0.23 : 0.13
    );
    const faceAlpha = Math.max(0.96, VIZ_VISUAL_DEPTH.near.cardAlpha);
    const initiallyVisible = wasVisible || prefersReducedMotion();
    const materialFace = material.createFace({
      id,
      width,
      height,
      chamfer,
      color: faceColor,
      alpha: initiallyVisible ? faceAlpha : 0,
      x,
      y,
      skewX: container.skew.x,
    });

    // Stroke stays regular Graphics so interaction colour and antialiasing
    // remain cheap while the bitmap body is one shared direct mesh.
    const border = new Graphics();
    border.label = `timeline-card-face:${id}`;
    border.poly(facePoints);
    border.stroke({
      color: selected ? GPU_COLORS.primary : accent,
      width: selected ? 1.35 : 0.75,
      alpha: selected ? 0.82 : 0.42,
    });
    container.addChild(border);

    const topBevel = new Graphics();
    topBevel.poly([
      chamfer, 0,
      width - chamfer, 0,
      width - chamfer - 3, 2.5,
      chamfer + 3, 2.5,
    ]);
    topBevel.fill({ color: mixColor(accent, 0xffffff, 0.48), alpha: selected ? 0.32 : 0.2 });
    container.addChild(topBevel);

    const lowerBevel = new Graphics();
    lowerBevel.poly([
      chamfer, height,
      width - chamfer, height,
      width - chamfer - 3, height - 2.5,
      chamfer + 3, height - 2.5,
    ]);
    lowerBevel.fill({ color: 0x07111d, alpha: 0.42 });
    container.addChild(lowerBevel);

    const rail = new Graphics();
    rail.roundRect(0, 7, 2.5, height - 14, 1.2).fill(accent);
    rail.alpha = 0.72;
    container.addChild(rail);

    const content = new Container();
    container.addChild(content);

    let hovered = false;
    let pressed = false;
    let settled = false;
    let elapsed = initiallyVisible ? performance.now() : -entranceDelay;
    container.alpha = initiallyVisible ? 1 : 0;
    underlayContainer.alpha = container.alpha;
    castShadow.alpha = initiallyVisible ? (selected ? 0.92 : 0.86) : 0;
    const animate = (ticker: Ticker) => {
      // Once its entrance/interaction has settled, an idle card is immutable.
      // Keep the callback so pointerover can wake it, but do not dirty this
      // container and every child transform 120 times a second.
      if (settled && !hovered && !pressed) return;
      if (!prefersReducedMotion()) elapsed += ticker.deltaMS;
      const entrance = Math.max(0, Math.min(1, elapsed / 300));
      const easedEntrance = 1 - (1 - entrance) ** 3;
      const targetScale = pressed ? 0.992 : hovered ? 1.008 : 1;
      const scale = easedEntrance * targetScale;
      const depthScaleX = 1 - zDepth * 0.018;
      const scaleX = scale * depthScaleX;
      const positionX = x + width * (1 - scaleX) / 2;
      const positionY =
        y + height * (1 - scale) / 2 + (pressed ? 1.4 : hovered ? -1.2 : 0);
      container.alpha = easedEntrance;
      underlayContainer.alpha = easedEntrance;
      container.scale.set(scaleX, scale);
      underlayContainer.scale.set(scaleX, scale);
      container.position.set(positionX, positionY);
      underlayContainer.position.set(positionX, positionY);
      aura.alpha = selected
        ? 0.3
        : hovered
          ? 0.16
          : 0;
      const interactionTint = pressed
        ? 0xb8d8ff
        : hovered
          ? 0xd8e9ff
          : 0xffffff;
      border.tint = interactionTint;
      materialFace.update(
        positionX,
        positionY,
        scaleX,
        scale,
        container.skew.x,
        tintColor(faceColor, interactionTint),
        faceAlpha * easedEntrance
      );
      castShadow.alpha = easedEntrance * (hovered ? 0.96 : selected ? 0.92 : 0.86);
      rail.alpha = selected ? 0.92 : hovered ? 0.84 : 0.68;
      settled = entrance >= 1 && !hovered && !pressed;
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
          group.container.destroy({ children: true, context: true });
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
          particles.destroy({ children: true, context: true });
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
        layer.destroy({ children: true, context: true });
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

  private drawAtomaMark(x: number, y: number, visualScale?: number) {
    this.retainAtomaMark(x, y, visualScale);
  }

  /**
   * Attach-or-reuse for the crystal. Navigation placements share one retained
   * subtree and travel with the scene camera; resource-shape changes (the
   * large bobbing welcome mark, reflection mode, renderer resolution) still
   * release the old GPU resources and build the required shape once.
   */
  retainAtomaMark(
    x: number,
    y: number,
    visualScale?: number,
    options?: { bobPx?: number; bobPeriodMs?: number }
  ) {
    const resolvedScale = visualScale ?? ATOMA_MARK_HEADER_SCALE;
    this.setFarFieldActive(shouldShowFarField(
      this.snapshot?.state.entered ?? false,
      resolvedScale
    ));
    const placement: AtomaMarkPlacement = {
      x,
      y,
      visualScale: resolvedScale,
    };
    const resourceKey = [
      options?.bobPx ?? '',
      options?.bobPeriodMs ?? '',
      resolvedScale >= ATOMA_MARK_ENV_MIN_SCALE ? 'environment' : 'chrome',
      this.app.renderer.resolution,
    ].join('|');
    const key = [
      resourceKey,
      placement.x,
      placement.y,
      placement.visualScale,
    ].join('|');
    const current = this.atomaMark;
    const now = performance.now();
    const sampleMotion = (motion: NonNullable<typeof this.atomaMarkMotion>) => {
      const progress = Math.max(0, Math.min(1, (performance.now() - motion.startedAt) /
        Math.max(1, motion.duration)));
      return {
        progress,
        placement: interpolateAtomaMarkPlacement(
          motion.from,
          motion.to,
          sceneCameraEase(progress)
        ),
      };
    };

    if (
      current &&
      current.resourceKey === resourceKey &&
      options?.bobPx === undefined
    ) {
      if (current.key !== key) {
        const from = this.atomaMarkMotion
          ? sampleMotion(this.atomaMarkMotion).placement
          : current.placement;
        current.key = key;
        current.placement = from;
        this.atomaMarkMotion = prefersReducedMotion()
          ? null
          : {
              from,
              to: placement,
              startedAt: now,
              duration: sceneCameraTransitionDuration(
                this.snapshot?.state.sceneCameraMode ?? 'overview'
              ),
            };
      }
      current.handle.resume(this.markRoot, (callback) => this.addTicker(callback));
      const motion = this.atomaMarkMotion;
      if (!motion) {
        current.placement = placement;
        current.handle.setPlacement(
          placement.x,
          placement.y,
          placement.visualScale
        );
        return;
      }
      const animatePlacement = () => {
        if (this.atomaMark !== current || this.atomaMarkMotion !== motion) return;
        const sample = sampleMotion(motion);
        current.placement = sample.placement;
        current.handle.setPlacement(
          sample.placement.x,
          sample.placement.y,
          sample.placement.visualScale
        );
        if (sample.progress >= 1) this.atomaMarkMotion = null;
      };
      animatePlacement();
      this.addTicker(animatePlacement);
      return;
    }
    current?.handle.destroy();
    this.atomaMarkMotion = null;
    this.atomaMark = {
      key,
      resourceKey,
      handle: attachAtomaMark(
        this.markRoot,
        (callback) => this.addTicker(callback),
        x,
        y,
        resolvedScale,
        this.app.renderer,
        options
      ),
      placement,
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
    const handle = attachAvatarOrb(this.markRoot, (callback) => this.addTicker(callback), {
      x,
      y,
      size,
      photoUrl,
      seed,
      active,
      pointerAt: () => this.pointerScreenPosition(),
    });
    this.avatarOrbs.set(slot, {
      key,
      handle,
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
    if (this.app.screen.width <= 0 || this.app.screen.height <= 0) return null;
    return this.clientToRendererPosition(pointer.clientX, pointer.clientY);
  }

  private drawHeader(snapshot: GpuRenderSnapshot, width: number) {
    // Focus owns one self-contained vertical rail. Leaving even a transparent
    // header control here would preserve the old horizontal composition and
    // compete with the dock below, so the complete overview header steps out.
    if (snapshot.state.sceneCameraMode === 'focus') return;
    // Wash, not an opaque bar. Identity now belongs to the full-width brand
    // slot in the rail; this shorter band carries only global utilities.
    const bar = new Graphics();
    bar.label = 'header-band';
    bar.rect(0, 0, width, GPU_LAYOUT.headerHeight);
    bar.fill({ color: 0x0b111e, alpha: 0.42 });
    bar.eventMode = 'none';
    this.root.addChild(bar);
  }

  /** Global utilities occupy the overview header and cross-fade into focus. */
  private drawHeaderUtilityDock(
    snapshot: GpuRenderSnapshot,
    width: number,
    opacity = 1,
    interactive = true
  ): (opacity: number) => void {
    // ONE vertical centre for every utility in the band.
    const midY = GPU_LAYOUT.headerHeight / 2;

    // The nav is a LEFT RAIL, not a tab strip: `renderer/views/sidebar.ts`
    // draws it from `render()`. `visibleViews` remains the one definition of
    // which tabs exist — the rail reads it and the DOM tablist mirrors it.

    // The account orb owns the far right when there is an account; the bell
    // sits between it and the locale control, and everything to the left
    // shifts by the widths it reserves.
    const auth = snapshot.data.auth;
    const accountReserve = auth ? HEADER_ORB_SIZE + 16 : 0;
    // Notifications exist exactly where an account does: the tray is the
    // journal projected onto a principal, and the ungated path has neither.
    const bellReserve = auth ? HEADER_BELL_WIDTH + 8 : 0;
    const opacityTargets: { alpha: number }[] = [];
    opacityTargets.push(this.drawFpsReadout(width - 64 - accountReserve - bellReserve, midY));
    const locale = this.button(
      this.root,
      'locale.menu.toggle',
      'button',
      snapshot.state.locale.toUpperCase(),
      width - 54 - accountReserve - bellReserve,
      midY - 16,
      42,
      32,
      snapshot.state.localeMenuOpen,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
    locale.eventMode = interactive ? 'static' : 'none';
    opacityTargets.push(locale);
    if (auth) {
      const bell = drawNotificationsBell(
        this,
        snapshot,
        width - accountReserve - HEADER_BELL_WIDTH - 4,
        midY - 16,
        HEADER_BELL_WIDTH,
        32
      );
      bell.eventMode = interactive ? 'static' : 'none';
      opacityTargets.push(bell);
    }
    if (auth) {
      const orbX = width - HEADER_ORB_SIZE - 12;
      const orbY = (GPU_LAYOUT.headerHeight - HEADER_ORB_SIZE) / 2;
      opacityTargets.push(...this.drawAccountControl(
        snapshot,
        orbX,
        orbY,
        HEADER_ORB_SIZE,
        'overview-header',
        interactive
      ));
    }
    // Signed out: no account slot is claimed this frame and
    // `sweepAvatarOrbs` releases the mesh at the end of the render.
    const setOpacity = (next: number) => {
      const resolved = Math.max(0, Math.min(1, next));
      for (const target of opacityTargets) target.alpha = resolved;
    };
    setOpacity(opacity);
    return setOpacity;
  }

  /** Overview identity spans the rail and leaves the utility band uncluttered. */
  private drawOverviewRailChrome(
    snapshot: GpuRenderSnapshot,
    layout: OverviewRailChromeLayout
  ) {
    this.drawAtomaMark(
      layout.crystal.x + layout.crystal.width / 2 - ATOMA_MARK_LOCAL_CENTER,
      layout.crystal.y + layout.crystal.height / 2 - ATOMA_MARK_LOCAL_CENTER,
      layout.crystalScale
    );
    this.drawAtomaMarkControl(snapshot, layout.crystal, layout.crystalScale);
  }

  /** Focus chrome lives entirely inside the compact rail, never in a bar. */
  private drawFocusRailChrome(
    snapshot: GpuRenderSnapshot,
    layout: FocusRailChromeLayout
  ) {
    const markSize = ATOMA_MARK_LOCAL_CENTER * 2;
    this.drawAtomaMark(
      layout.crystal.x + (layout.crystal.width - markSize) / 2,
      layout.crystal.y + (layout.crystal.height - markSize) / 2
    );
    this.drawAtomaMarkControl(snapshot, layout.crystal, ATOMA_MARK_HEADER_SCALE);
  }

  /** The retained GPU mark cannot own events, so mirror its visual footprint. */
  private drawAtomaMarkControl(
    snapshot: GpuRenderSnapshot,
    slot: FocusRailRect,
    visualScale: number
  ) {
    const size = ATOMA_MARK_LOCAL_CENTER * 2 * visualScale;
    const x = slot.x + (slot.width - size) / 2;
    const y = slot.y + (slot.height - size) / 2;
    const control = new Graphics();
    control.rect(0, 0, size, size);
    control.fill({ color: 0xffffff, alpha: 0.001 });
    control.position.set(x, y);
    control.eventMode = 'static';
    control.cursor = 'pointer';
    control.hitArea = new Rectangle(0, 0, size, size);
    control.on('pointertap', () => snapshot.onActivate('brand.crystal'));
    this.root.addChild(control);
    this.recordHitTarget(this.root, {
      id: 'brand.crystal',
      role: 'button',
      label: snapshot.t(snapshot.state.sceneCameraMode === 'focus'
        ? 'nav.crystalExpand'
        : 'nav.crystalWelcome'),
      x,
      y,
      width: size,
      height: size,
    });
  }

  /** FPS, locale and profile share one opacity curve at the foot of focus. */
  private drawFocusRailDock(
    snapshot: GpuRenderSnapshot,
    layout: FocusRailChromeLayout,
    opacity = 1,
    interactive = true
  ): (opacity: number) => void {
    const opacityTargets: { alpha: number }[] = [];
    if (layout.profile) {
      opacityTargets.push(...this.drawAccountControl(
        snapshot,
        layout.profile.x,
        layout.profile.y,
        layout.profile.width,
        'focus-rail',
        interactive
      ));
    }
    if (layout.bell) {
      const bell = drawNotificationsBell(
        this,
        snapshot,
        layout.bell.x,
        layout.bell.y,
        layout.bell.width,
        layout.bell.height
      );
      bell.eventMode = interactive ? 'static' : 'none';
      opacityTargets.push(bell);
    }
    const locale = this.button(
      this.root,
      'locale.menu.toggle',
      'button',
      snapshot.state.locale.toUpperCase(),
      layout.locale.x,
      layout.locale.y,
      layout.locale.width,
      layout.locale.height,
      snapshot.state.localeMenuOpen,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true
    );
    locale.eventMode = interactive ? 'static' : 'none';
    opacityTargets.push(locale);
    opacityTargets.push(this.drawFpsReadout(
      layout.fps.x + layout.fps.width - 5,
      layout.fps.y + layout.fps.height / 2,
      FOCUS_RAIL_FPS_SCALE
    ));
    const setOpacity = (next: number) => {
      const resolved = Math.max(0, Math.min(1, next));
      for (const target of opacityTargets) target.alpha = resolved;
    };
    setOpacity(opacity);
    return setOpacity;
  }

  /** One retained profile orb, with its real interactive control above it. */
  private drawAccountControl(
    snapshot: GpuRenderSnapshot,
    x: number,
    y: number,
    size: number,
    slot = 'overview-header',
    interactive = true
  ): { alpha: number }[] {
    const auth = snapshot.data.auth;
    if (!auth) return [];
    this.retainAvatarOrb(
      slot,
      x,
      y,
      size,
      auth.viewer.avatarUrl,
      auth.viewer.principalId,
      interactive
    );
    const orb = this.avatarOrbs.get(slot)?.handle;
    if (!orb) return [];
    // `markRoot` is non-interactive so the retained mesh cannot own events.
    // This nearly transparent stage control forwards activation and hover.
    const orbHit = new Graphics();
    orbHit.rect(0, 0, size, size);
    orbHit.fill({ color: 0xffffff, alpha: 0.001 });
    orbHit.position.set(x, y);
    orbHit.eventMode = interactive ? 'static' : 'none';
    orbHit.cursor = interactive ? 'pointer' : 'default';
    orbHit.hitArea = new Rectangle(0, 0, size, size);
    orbHit.on('pointertap', () => snapshot.onActivate('account.menu.toggle'));
    orbHit.on('pointerover', () => this.avatarOrbs.get(slot)?.handle.setHover(true));
    orbHit.on('pointerout', () => this.avatarOrbs.get(slot)?.handle.setHover(false));
    this.root.addChild(orbHit);
    if (interactive) {
      this.recordHitTarget(this.root, {
        id: 'account.menu.toggle',
        role: 'button',
        label: snapshot.t('auth.openMenu'),
        x,
        y,
        width: size,
        height: size,
      });
    }
    return [orb.container, orbHit];
  }

  /**
   * Live frame rate: full-size in the overview header, miniature at the foot
   * of the focused rail.
   *
   * Deliberately NOT drawn through `text()`. That cache keys on the string,
   * while Canvas Text rasterises and uploads every new value. BitmapText owns
   * a tiny pre-installed glyph atlas instead: a rate change only rebuilds its
   * quads and cannot become an observer-induced dropped frame.
   *
   * Pixi's `ticker.FPS` is only `1000 / elapsedMS` for the last frame. The
   * renderer-owned sample window averages every real interval over 250ms, so
   * one missed 120Hz vsync reads as ~116 FPS rather than an alarming 60 FPS.
   * It intentionally survives scene rebuilds caused by wheel input.
   */
  private drawFpsReadout(right: number, y: number, visualScale = 1): BitmapText {
    const readout = new BitmapText({
      text: formatFps(this.lastFps),
      style: FPS_BITMAP_STYLE,
    });
    readout.anchor.set(1, 0.5);
    readout.position.set(right, y);
    readout.scale.set(visualScale);
    readout.eventMode = 'none';
    readout.tint = multiplyTint(GPU_COLORS.text, fpsColor(this.lastFps));
    readout.label = 'fps-readout';
    // Its glyph quads change four times a second; keep that out of the root
    // group's batch (see `animatedLayer`).
    this.animatedLayer(this.root, 'fps-readout-layer').addChild(readout);

    this.addTicker((ticker) => {
      if (readout.destroyed) return;
      const fps = sampleFpsWindow(this.fpsSample, ticker.elapsedMS);
      if (fps === null) return;
      this.lastFps = fps;
      const next = formatFps(fps);
      // Even quad layout is needless when the rounded value did not move.
      if (next !== readout.text) readout.text = next;
      readout.tint = multiplyTint(GPU_COLORS.text, fpsColor(fps));
    });
    return readout;
  }

  private drawOverlays(snapshot: GpuRenderSnapshot, width: number, height: number) {
    if (snapshot.state.view !== 'runs' || snapshot.state.focusedInput !== 'run') return;
    const contentLeft = sidebarWidthForViewport(width);
    const contentWidth = Math.max(0, width - contentLeft);
    const picker = runsPickerControlLayout(contentWidth);
    const pane = runsPaneLayout(contentWidth);
    const x = contentLeft + picker.x;
    const popupWidth = Math.max(0, pane.leftWidth - 28);
    const popupY = picker.y + picker.height + 4;
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
  | 'repositoryIcon'
  | 'privateRepositoryIcon'
  | 'linkRegion'
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
  | 'animatedLayer'
  | 'retainAtomaMark'
  | 'retainAvatarOrb'
  | 'drawExitingFilterButtons'
  | 'animateEnteringFilterSpace'
  | 'metrics'
  | 'scrollMax'
  | 'runsScroll'
  | 'detailScrollY'
  | 'detailScrollMax'
  | 'detailBounds'
  | 'roleRowTransition'
  | 'seenAnimatedControls'
  | 'previousFilterBounds'
  | 'pixiRenderer'
>;
