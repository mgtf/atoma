import {
  Container,
  Graphics,
  Matrix,
  RenderTexture,
  type Renderer,
  type Ticker,
} from 'pixi.js';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_CORE_RADIUS,
  ATOMA_MARK_LAMP_Z,
  ATOMA_MARK_LOCAL_SIZE,
  ATOMA_MARK_REAR_LIGHT_RADIUS,
  buildAtomaMarkFrame,
  collectPointerFieldSpills,
  coreLightFalloff,
  mergeFieldSpills,
  mixColor,
  pointerLampForLocal,
  projectMarkCaustic,
  type AtomaMarkPoint,
  type AtomaMarkRearSpill,
} from '../brand-mark.js';
import {
  clearMarkFieldLight,
  markColorToRgb,
  writeMarkFieldCaustic,
  writeMarkFieldLight,
} from '../mark-field-light.js';
import {
  readPointerLight,
  type PointerLightSnapshot,
} from '../pointer-light.js';
import { markBeadVisible, markClockIsPinned, markElapsedMs } from './mark-clock.js';
import { createMarkShell } from './mark-shell.js';
import { prefersReducedMotion } from './motion.js';
import { VIZ_VISUAL_DEPTH } from '../visual-depth.js';
import { ATOMA_CURSOR_HOTSPOT, atomaCursorPoints } from '../pointer-cursor.js';
import {
  clientToRendererPoint,
  rendererToClientPoint,
  sceneCameraViewport,
} from '../scene-camera.js';

/**
 * Local crystal origin. The mark is authored in a 28×28 box with its pivot
 * here; callers that want the visual centre at a screen point pass
 * `(cx - ATOMA_MARK_LOCAL_CENTER, cy - ATOMA_MARK_LOCAL_CENTER)`.
 */
export const ATOMA_MARK_LOCAL_CENTER = 14;

/** Compact scale used by the focused icon rail. */
export const ATOMA_MARK_HEADER_SCALE = 1.8;

/** Prominent overview-rail scale; still below the hero reflection threshold. */
export const ATOMA_MARK_OVERVIEW_RAIL_SCALE = 3.2;

/**
 * Below this visual scale the gem is navigation chrome: too small to read a
 * reflected card, and recapturing the whole Pixi stage would redraw every
 * filtered card. The arrival gate is >= 6.
 */
export const ATOMA_MARK_ENV_MIN_SCALE = 4;

export interface AtomaMarkPlacement {
  readonly x: number;
  readonly y: number;
  readonly visualScale: number;
}

/** Pure placement interpolation; the camera supplies its own eased progress. */
export function interpolateAtomaMarkPlacement(
  from: AtomaMarkPlacement,
  to: AtomaMarkPlacement,
  progress: number
): AtomaMarkPlacement {
  const t = Math.max(0, Math.min(1, progress));
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    visualScale: from.visualScale + (to.visualScale - from.visualScale) * t,
  };
}

/** Physical-pixel ceilings keep the hero's two ping-pong pairs bounded at high DPR. */
export const ATOMA_MARK_BACKDROP_MAX_PX = 512;
export const ATOMA_MARK_ENV_MAX_PX = 256;

/** Offscreen work runs below display refresh; input transitions still invalidate immediately. */
export const ATOMA_MARK_BACKDROP_UPDATE_INTERVAL_MS = 1_000 / 30;
export const ATOMA_MARK_ENV_UPDATE_INTERVAL_MS = 1_000 / 12;

/** The CPU ray bundle follows the backdrop cadence instead of a 120/144 Hz display. */
export const ATOMA_MARK_CAUSTIC_UPDATE_INTERVAL_MS = 1_000 / 30;


/** Colour of everything the bead emits: its own body rim and its glow. */
const LIGHT_COLOR = 0xdff1ff;
const CORE_RIM_COLOR = 0x35b8f0;
const CORE_HOT_COLOR = 0xffffff;

/**
 * Hand-stepped radial gradients for the parts the CPU still paints: the bead
 * itself and the glow it throws onto the near glass. Pixi's `FillGradient` needs
 * a canvas, which the headless view tests do not have, and building one per
 * frame would churn a texture every 16ms — nested discs are built ONCE.
 *
 * Step counts are BANDING budgets, not detail knobs: one step of the steepest
 * part of a curve must land under an 8-bit level, or the seam reads as a ring
 * drawn around the bead. Blown up to the arrival gate a glow spans hundreds of
 * pixels, so the counts are high and the geometry is still static.
 */
const CORE_BODY_STEPS = 30;
const CORE_BLOOM_STEPS = 80;
/**
 * Pixi tessellates `circle()` from the LOCAL radius. The bead is authored at
 * less than one unit and later enlarged ~17× on the welcome gate, so the
 * automatic low-detail circle exposes polygon corners there. An explicit
 * 64-gon keeps the radial error below a tenth of a physical pixel at hero size.
 */
export const ATOMA_MARK_CORE_DISC_SEGMENTS = 64;
const CORE_BLOOM_REACH = 2.6;
const CORE_BLOOM_PEAK_ALPHA = 0.28;
const CORE_FILAMENT_FRACTION = 0.5;

/**
 * What the near glass does with a light behind it. Tinted glass turns a
 * white-hot bead into a pale disc of the facet's own hue — correct, and it is
 * what puts the bead INSIDE the crystal — so the bead's hot centre reaches the
 * viewer the way a real one does: as glow ON the glass, additive and soft
 * edged, never as a hard marble pasted over the shell.
 */
const TRANSMITTED_CORE_REACH = 1.85;
const TRANSMITTED_CORE_STEPS = 96;
const TRANSMITTED_CORE_PLATEAU = 0.34;
const TRANSMITTED_CORE_PEAK_ALPHA = 0.26;
const TRANSMITTED_POOL_STEPS = 140;
const TRANSMITTED_POOL_PEAK_ALPHA = 0.15;

/**
 * No facet outlines. A stroke around each triangle reads as a wireframe — a
 * border drawn ON the crystal rather than a property of the glass. The facet
 * boundaries stay legible through shading alone: flat normals give each face
 * its own tone, and the shader's specular and grazing terms catch the ridges.
 */
function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

/**
 * Nested discs whose ADDITIVE alphas sum to `profile` at every radius: each disc
 * contributes only the step its own edge adds, so the stack reproduces the curve
 * instead of banding.
 */
function paintFalloffDiscs(
  target: Graphics,
  radius: number,
  color: number,
  peakAlpha: number,
  steps: number,
  profile: (distance: number) => number
) {
  let previous = 0;
  for (let step = 0; step < steps; step += 1) {
    const outer = radius * (1 - step / steps);
    const level = profile(outer);
    const delta = level - previous;
    previous = level;
    if (delta <= 0) continue;
    target
      .regularPoly(0, 0, outer, ATOMA_MARK_CORE_DISC_SEGMENTS)
      .fill({ color, alpha: delta * peakAlpha });
  }
}

/** Smoothstep 1→0 over `reach`, for the bead's own bloom. */
function bloomFalloff(distance: number, reach: number) {
  if (distance <= 0) return 1;
  if (distance >= reach) return 0;
  return smoothstep(1 - distance / reach);
}

/** Flat to `plateau`, then smoothstep to 0 at `reach`: a glowing disc, not a dot. */
function plateauFalloff(distance: number, reach: number, plateau: number) {
  const inner = reach * plateau;
  if (distance <= inner) return 1;
  return bloomFalloff(distance - inner, reach - inner);
}

/**
 * The bead: a LIGHT, not a marble. No hard ring and no specular dot — those read
 * as a sticker pasted on the front facet — just a hot centre bleeding out to a
 * cool rim, plus its own bloom, both clipped to the crystal by the caller. The
 * light it casts on the shell is not drawn here at all: the shell's shader does
 * that per pixel, from this bead's position.
 */
function buildCore(): { core: Container; bloom: Graphics } {
  const core = new Container();
  core.label = 'mark-core';
  const bloom = new Graphics();
  bloom.blendMode = 'add';
  const bloomReach = ATOMA_MARK_CORE_RADIUS * CORE_BLOOM_REACH;
  paintFalloffDiscs(
    bloom,
    bloomReach,
    LIGHT_COLOR,
    CORE_BLOOM_PEAK_ALPHA,
    CORE_BLOOM_STEPS,
    (distance) => bloomFalloff(distance, bloomReach)
  );
  const body = new Graphics();
  // t: 0 at the rim, 1 at the centre. The fade spans the bead's whole outer
  // half on purpose: ramping to opaque in the first few steps — whatever the
  // curve — leaves a hard edge a couple of pixels wide, and a light with an
  // outline is a marble again.
  for (let step = 0; step < CORE_BODY_STEPS; step += 1) {
    const t = step / (CORE_BODY_STEPS - 1);
    body
      .regularPoly(
        0,
        0,
        ATOMA_MARK_CORE_RADIUS * (1 - t * 0.55),
        ATOMA_MARK_CORE_DISC_SEGMENTS
      )
      .fill({
        color: mixColor(CORE_RIM_COLOR, CORE_HOT_COLOR, smoothstep(Math.min(1, t / 0.6))),
        alpha: smoothstep(t),
      });
  }
  // The filament: a light has a point you cannot look at.
  body
    .regularPoly(
      0,
      0,
      ATOMA_MARK_CORE_RADIUS * CORE_FILAMENT_FRACTION,
      ATOMA_MARK_CORE_DISC_SEGMENTS
    )
    .fill({ color: CORE_HOT_COLOR, alpha: 1 });
  core.addChild(bloom, body);
  return { core, bloom };
}

/** The bead's hot centre as it survives the near glass: additive, soft edged. */
function buildTransmittedCore(): Graphics {
  const glow = new Graphics();
  glow.label = 'mark-transmitted-core';
  glow.blendMode = 'add';
  const reach = ATOMA_MARK_CORE_RADIUS * TRANSMITTED_CORE_REACH;
  paintFalloffDiscs(
    glow,
    reach,
    LIGHT_COLOR,
    TRANSMITTED_CORE_PEAK_ALPHA,
    TRANSMITTED_CORE_STEPS,
    (distance) => plateauFalloff(distance, reach, TRANSMITTED_CORE_PLATEAU)
  );
  return glow;
}

/** The wider spill across the near glass, at the light's own declared reach. */
function buildTransmittedPool(): Graphics {
  const pool = new Graphics();
  pool.label = 'mark-transmitted-light';
  pool.blendMode = 'add';
  paintFalloffDiscs(
    pool,
    ATOMA_MARK_CORE_LIGHT_RADIUS,
    LIGHT_COLOR,
    TRANSMITTED_POOL_PEAK_ALPHA,
    TRANSMITTED_POOL_STEPS,
    coreLightFalloff
  );
  return pool;
}

function markStageToClient(
  renderer: Renderer,
  stageX: number,
  stageY: number
): { clientX: number; clientY: number; pixelScale: number } {
  const canvas = renderer.canvas;
  const screen = renderer.screen;
  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    canvas instanceof HTMLCanvasElement &&
    screen.width > 0 &&
    screen.height > 0
  ) {
    const viewport = sceneCameraViewport(canvas);
    if (viewport) {
      const client = rendererToClientPoint(
        { x: stageX, y: stageY },
        screen.width,
        screen.height,
        viewport
      );
      return {
        clientX: client.x,
        clientY: client.y,
        // Radius and spectral widths return to renderer space before they are
        // drawn, so this is the layout-to-renderer scale, not the camera's
        // position-dependent magnification.
        pixelScale: viewport.width / screen.width,
      };
    }
    const bounds = canvas.getBoundingClientRect();
    return {
      clientX: bounds.left + stageX * bounds.width / screen.width,
      clientY: bounds.top + stageY * bounds.height / screen.height,
      pixelScale: bounds.width / screen.width,
    };
  }
  return { clientX: stageX, clientY: stageY, pixelScale: 1 };
}

function markClientToStage(
  renderer: Renderer,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const canvas = renderer.canvas;
  const screen = renderer.screen;
  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    canvas instanceof HTMLCanvasElement &&
    screen.width > 0 &&
    screen.height > 0
  ) {
    const viewport = sceneCameraViewport(canvas);
    if (viewport) {
      return clientToRendererPoint(
        { x: clientX, y: clientY },
        screen.width,
        screen.height,
        viewport
      );
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) {
      return {
        x: (clientX - bounds.left) * screen.width / bounds.width,
        y: (clientY - bounds.top) * screen.height / bounds.height,
      };
    }
  }
  return { x: clientX, y: clientY };
}

function markClientToLocal(
  renderer: Renderer,
  container: { x: number; y: number },
  scale: number,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const stage = markClientToStage(renderer, clientX, clientY);
  const safeScale = scale === 0 ? 1 : scale;
  return {
    x: (stage.x - container.x - ATOMA_MARK_LOCAL_CENTER) / safeScale + ATOMA_MARK_LOCAL_CENTER,
    y: (stage.y - container.y - ATOMA_MARK_LOCAL_CENTER) / safeScale + ATOMA_MARK_LOCAL_CENTER,
  };
}

function paintCursorEcho(graphics: Graphics) {
  const points = atomaCursorPoints();
  const first = points[0];
  if (!first) return;
  const trace = (dx: number, dy: number) => {
    graphics.moveTo(first.x + dx, first.y + dy);
    for (const point of points.slice(1)) graphics.lineTo(point.x + dx, point.y + dy);
    graphics.closePath();
  };
  graphics.clear();
  // Cyan rim first, then the extruded body, then the white-edged face — the
  // same stack as the HTML cursor, so the glass sees the pointer the user sees.
  trace(0, 0);
  graphics.stroke({ color: 0x65c9ff, width: 8, alpha: 0.5, join: 'round', cap: 'round' });
  trace(1.35, 1.6);
  graphics.fill({ color: 0x111c2c }).stroke({ color: 0x7796bd, width: 2.35, join: 'round' });
  trace(0, 0);
  graphics.fill({ color: 0x010308 }).stroke({
    color: 0xffffff,
    width: 2.7,
    join: 'round',
    cap: 'round',
  });
}

function fieldSpillsToSample(
  spills: readonly AtomaMarkRearSpill[],
  container: { x: number; y: number },
  scale: number,
  radiusPx: number,
  renderer: Renderer
) {
  return spills.map((spill) => {
    const rgb = markColorToRgb(spill.color);
    const stageX = container.x + ATOMA_MARK_LOCAL_CENTER +
      (spill.x - ATOMA_MARK_LOCAL_CENTER) * scale;
    const stageY = container.y + ATOMA_MARK_LOCAL_CENTER +
      (spill.y - ATOMA_MARK_LOCAL_CENTER) * scale;
    const client = markStageToClient(renderer, stageX, stageY);
    return {
      clientX: client.clientX,
      clientY: client.clientY,
      radiusPx: radiusPx * client.pixelScale,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      intensity: spill.intensity,
    };
  });
}

/**
 * What `attachAtomaMark` hands back so the renderer can RETAIN the mark
 * across scene rebuilds instead of leaking it. `renderScene` rebuilds the
 * scene on every render (wheel tick, hover, live poll) and `Mesh.destroy()`
 * does not release render textures, geometries or the shader — with WebGPU
 * GC pinned off, an attach-per-render mark grows VRAM without bound.
 */
export interface AtomaMarkHandle {
  container: Container;
  /**
   * Every display object the mark owns on the parent — the mark container
   * plus the cursor echo the env pass parks NEXT TO it (the echo must stay
   * visible while the mark hides for its own capture, so it cannot live
   * inside `container`). A retaining teardown must skip these.
   */
  retained: readonly Container[];
  /** Moves and resizes the retained crystal without rebuilding its GPU resources. */
  setPlacement(x: number, y: number, visualScale: number): void;
  /** Re-adds the retained objects and re-registers the paint ticker after a scene rebuild. */
  resume(parent: Container, addTicker: (callback: (ticker: Ticker) => void) => void): void;
  /** Releases render textures, shader, geometries and the display subtree. Idempotent. */
  destroy(): void;
}

/**
 * One Pixi crystal, driven by `buildAtomaMarkFrame`. Shared by the navigation
 * rail and the arrival gate — never a second R3F logo.
 *
 * The shell is a MESH: a thick-shell regular octahedron shaded by its own
 * WGSL/GLSL program, split into the far cavity, the bead, the near cavity
 * walls, then the camera-facing outer hull as glass over them. The front glass
 * is every outer face that points at the camera — never "whatever the bead
 * has not overtaken", because hiding the backdrop after the refraction pass
 * would delete those faces from the scene. The bead is inside the crystal at
 * every frame: it cannot be painted outside the outline it lights, and the
 * near facets pass over it.
 */
export function attachAtomaMark(
  parent: Container,
  addTicker: (callback: (ticker: Ticker) => void) => void,
  x: number,
  y: number,
  initialVisualScale = ATOMA_MARK_HEADER_SCALE,
  renderer?: Renderer,
  options?: { bobPx?: number; bobPeriodMs?: number }
): AtomaMarkHandle {
  let markX = x;
  let markY = y;
  let visualScale = initialVisualScale;
  let frameScale = 1;
  /** Render textures alive right now; resize swaps entries, destroy drains it. */
  const ownedTextures = new Set<RenderTexture>();
  let cursorEcho: Graphics | null = null;
  const container = new Container();
  container.label = 'atoma-mark';
  container.position.set(markX, markY);
  container.eventMode = 'none';
  const crystal = new Container();
  crystal.position.set(ATOMA_MARK_LOCAL_CENTER, ATOMA_MARK_LOCAL_CENTER);
  crystal.pivot.set(ATOMA_MARK_LOCAL_CENTER, ATOMA_MARK_LOCAL_CENTER);

  const shell = createMarkShell();
  // Placeholders, so the layer order is one structure whether or not a shader
  // could be built: the meshes drop into these.
  const shellBack = new Container();
  shellBack.label = 'mark-shell-back-layer';
  const shellMid = new Container();
  shellMid.label = 'mark-shell-mid-layer';
  const shellFront = new Container();
  shellFront.label = 'mark-shell-front-layer';
  if (shell) {
    shellBack.addChild(shell.back);
    shellMid.addChild(shell.mid);
    shellFront.addChild(shell.front);
  }

  const interior = new Container();
  interior.label = 'mark-interior';
  const { core, bloom } = buildCore();
  interior.addChild(core);
  const interiorMask = new Graphics();

  const glassGlow = new Container();
  glassGlow.label = 'mark-glass-glow';
  const transmittedPool = buildTransmittedPool();
  const transmittedCore = buildTransmittedCore();
  glassGlow.addChild(transmittedPool, transmittedCore);
  const glassMask = new Graphics();

  interior.mask = interiorMask;
  glassGlow.mask = glassMask;
  // The front glass already DRAWS the transmitted interior. An additive disc
  // composited after it is a sticker on the outside of the crystal — which is
  // what the turn film showed at every pose. Keep the layer for the no-shader
  // fallback (headless tests, missing canvas); hide it the moment a mesh can
  // do the job.
  if (shell) glassGlow.visible = false;
  /**
   * The interior, as its own subtree so it can be rendered TWICE: once into the
   * backdrop texture the front glass refracts, and once into the scene where it
   * composites normally. Grouping it is what makes the extra pass one call
   * instead of a reshuffle of the display list every frame.
   */
  const behind = new Container();
  behind.label = 'mark-behind-glass';
  behind.addChild(shellBack, interior, shellMid);

  crystal.addChild(
    behind,
    shellFront,
    glassGlow,
    interiorMask,
    glassMask
  );
  container.addChild(crystal);

  /**
   * The refraction pass. The front glass needs to know what is behind it at each
   * pixel, and nothing else in the pipeline carries that — so the interior is
   * drawn into a texture first, and the shell samples it three times per pixel.
   *
   * Sized from the mark's own box rather than the screen: the crystal occupies a
   * fixed 28x28 local square, so compact chrome at 1.8x needs a 51px texture
   * while the arrival gate grows only to the physical-pixel ceiling. Sizing
   * to the viewport would spend megabytes to refract a 51px logo.
   *
   * Skipped entirely without a renderer. The mark must keep working in the
   * headless view tests and anywhere the caller has no renderer to lend, and
   * the shell's own default — an empty texture with a zero texel size — makes
   * the sampling inert rather than wrong when this never runs.
   */
  const backdropPass = ((): (() => void) | null => {
    if (!renderer || !shell) return null;
    const resolution = renderer.resolution;
    // Navigation animates between 1.8x and 3.2x. Allocate its two ping-pong
    // textures once at the larger endpoint: swapping a texture that is still
    // bound by WebGPU invalidates the bind group, and per-frame resize would
    // churn two GPU textures for every scale sample anyway.
    const backdropVisualScale = initialVisualScale < ATOMA_MARK_ENV_MIN_SCALE
      ? Math.max(initialVisualScale, ATOMA_MARK_OVERVIEW_RAIL_SCALE)
      : initialVisualScale;
    const sizePx = Math.min(
      ATOMA_MARK_BACKDROP_MAX_PX,
      Math.max(
        1,
        Math.ceil(ATOMA_MARK_LOCAL_CENTER * 2 * backdropVisualScale * resolution)
      )
    );
    /**
     * TWO textures, alternating. WebGPU forbids a texture being bound for
     * sampling and used as a render attachment inside the same synchronisation
     * scope — and that is exactly what one texture would be here, since the
     * shell samples the backdrop in the very frame it is written. It is not a
     * warning: the command buffer is rejected and the mark stops drawing.
     *
     * So the shell samples the last capture while the next cadence slot renders
     * into the other texture. At 30 Hz the refracted interior can trail by at
     * most one capture interval; the crystal turns once every 15 seconds.
     */
    const textures = [
      RenderTexture.create({ width: sizePx, height: sizePx, resolution: 1 }),
      RenderTexture.create({ width: sizePx, height: sizePx, resolution: 1 }),
    ];
    for (const texture of textures) ownedTextures.add(texture);
    let writeIndex = 0;
    shell.setBackdrop(textures[1]!, sizePx, sizePx);
    /**
     * `behind` ALONE is rendered, never the whole crystal.
     *
     * Rendering the crystal meant extra layers went into the
     * texture as well — and, because the front glass composites its own sampled
     * result back into the scene, the mark fed on its own output frame after
     * frame. It built up as staircase artefacts and flat saturated colour, which
     * is what a feedback loop looks like, not what a strong effect looks like.
     * The subtree that must be in there is exactly the one the glass is in front
     * of: the far facets and the bead.
    */
    return () => {
      // Rendered in ISOLATION, so the transform maps the 28x28 local box onto
      // the texture rather than onto wherever the mark sits on screen.
      behind.position.set(0, 0);
      behind.scale.set(ATOMA_MARK_LOCAL_SIZE > 0
        ? sizePx / ATOMA_MARK_LOCAL_SIZE
        : 1);
      const target = textures[writeIndex]!;
      // Refraction OFF for the pass: the back facets share the front's shader.
      shell.setRefracting(false);
      try {
        renderer.render({ container: behind, target, clear: true });
      } finally {
        shell.setRefracting(true);
        behind.position.set(0, 0);
        behind.scale.set(1);
      }
      // Hand the shell what we just wrote; next frame writes to the other one,
      // so nothing is ever sampled and rendered into at the same time.
      shell.setBackdrop(target, sizePx, sizePx);
      writeIndex = 1 - writeIndex;
    };
  })();

  /**
   * Screen-space env of the Pixi scene, WITHOUT the gem. The aurora field
   * sits on ambientRoot so this capture includes it. Cards on in-app views
   * are skipped with navigation chrome (see ATOMA_MARK_ENV_MIN_SCALE).
   *
   * The HTML cursor is a DOM overlay, so it is not in the stage. A Pixi
   * echo of the same silhouette is shown only for this pass — otherwise the
   * glass would reflect the field and the Continue control but never the
   * pointer that is lighting them.
   *
   * Ping-pong: same WebGPU rule as the interior backdrop. Hide the gem so the
   * capture cannot feed on its own output. The scheduler below samples this
   * broad pass at 12 Hz and invalidates it immediately on resize or rebuild.
   */
  const envPass = ((): ((pointer: PointerLightSnapshot) => void) | null => {
    if (!renderer || !shell) return null;
    if (visualScale < ATOMA_MARK_ENV_MIN_SCALE) return null;
    const stage = parent.parent;
    if (!stage) return null;
    const echo = new Graphics();
    echo.label = 'mark-cursor-echo';
    echo.eventMode = 'none';
    echo.visible = false;
    paintCursorEcho(echo);
    parent.addChild(echo);
    cursorEcho = echo;
    const transform = new Matrix();
    let textures: RenderTexture[] | null = null;
    const retiredTextures: RenderTexture[] = [];
    let writeIndex = 0;
    let envW = 0;
    let envH = 0;
    const ensureTextures = (widthPx: number, heightPx: number) => {
      if (textures && widthPx === envW && heightPx === envH) return;
      // Keep the pair currently bound by the shell alive until a capture into
      // the replacement pair succeeds and setEnv swaps the resource. Destroying
      // a still-bound WebGPU texture during resize can poison its cached group.
      retiredTextures.push(...(textures ?? []));
      envW = widthPx;
      envH = heightPx;
      textures = [
        RenderTexture.create({ width: envW, height: envH, resolution: 1 }),
        RenderTexture.create({ width: envW, height: envH, resolution: 1 }),
      ];
      for (const texture of textures) ownedTextures.add(texture);
      writeIndex = 0;
    };
    return (pointer) => {
      const screenW = Math.max(1, renderer.screen.width);
      const screenH = Math.max(1, renderer.screen.height);
      const fit = Math.min(1, ATOMA_MARK_ENV_MAX_PX / Math.max(screenW, screenH));
      ensureTextures(
        Math.max(1, Math.ceil(screenW * fit)),
        Math.max(1, Math.ceil(screenH * fit))
      );
      transform.set(envW / screenW, 0, 0, envH / screenH, 0, 0);
      if (pointer.active) {
        const stagePos = markClientToStage(
          renderer,
          pointer.clientX,
          pointer.clientY
        );
        echo.position.set(
          stagePos.x - ATOMA_CURSOR_HOTSPOT.x,
          stagePos.y - ATOMA_CURSOR_HOTSPOT.y
        );
        echo.visible = true;
      } else {
        echo.visible = false;
      }
      const target = textures![writeIndex]!;
      container.visible = false;
      try {
        renderer.render({ container: stage, target, transform, clear: true });
      } finally {
        container.visible = true;
        echo.visible = false;
      }
      shell.setEnv(target, true);
      for (const texture of retiredTextures.splice(0)) {
        ownedTextures.delete(texture);
        texture.destroy(true);
      }
      writeIndex = 1 - writeIndex;
    };
  })();

  const traceSilhouette = (
    graphics: Graphics,
    outline: readonly AtomaMarkPoint[]
  ) => {
    graphics.clear();
    const first = outline[0];
    if (!first) return;
    graphics.moveTo(first.x, first.y);
    for (const point of outline.slice(1)) graphics.lineTo(point.x, point.y);
    graphics.closePath().fill({ color: 0xffffff, alpha: 1 });
  };

  const reducedMotion = prefersReducedMotion();
  /**
   * Offscreen passes and CPU optics own their clocks. A 120/144 Hz display
   * should make the shell and pointer glint smoother, not multiply texture
   * captures or ray tracing. Rare state transitions invalidate immediately;
   * continuous pose and pointer motion are coalesced to each pass' cadence.
   * Reduced motion has no periodic work: it renders only on invalidation.
   */
  let renderClockMs = 0;
  let backdropDirty = true;
  let envDirty = true;
  let envInvalidated = true;
  let backdropLastCaptureMs = Number.NEGATIVE_INFINITY;
  let envLastCaptureMs = Number.NEGATIVE_INFINITY;
  let causticDirty = true;
  let causticLastUpdateMs = Number.NEGATIVE_INFINITY;
  let causticWasCoupled: boolean | null = null;
  let observedElapsedMs = Number.NaN;
  let observedBeadVisible: boolean | null = null;
  let observedPointerRevision = -1;
  let observedMarkX = Number.NaN;
  let observedMarkY = Number.NaN;
  let observedVisualScale = Number.NaN;
  let observedScreenW = Number.NaN;
  let observedScreenH = Number.NaN;
  let observedPinned: boolean | null = null;
  let urgentPointerActive: boolean | null = null;
  let urgentBeadVisible: boolean | null = null;
  let urgentPinned: boolean | null = null;
  let urgentScreenW = Number.NaN;
  let urgentScreenH = Number.NaN;

  const paint = (elapsedMs: number, nowMs: number) => {
    // Bob lives HERE, before the pointer sample, so a parked mouse still
    // sees the lamp XY drift as the gem floats. A second ticker after paint
    // left the glint one frame behind — and, worse, glued it to the cursor
    // in UV because the lamp never learned the gem had moved.
    const bobPx = options?.bobPx ?? 0;
    const bobPeriodMs = options?.bobPeriodMs ?? 1800;
    container.x = markX;
    if (bobPx !== 0 && !markClockIsPinned() && !reducedMotion) {
      container.y = markY + Math.sin(markElapsedMs() / bobPeriodMs) * bobPx;
    } else {
      container.y = markY;
    }
    const frame = buildAtomaMarkFrame(elapsedMs);
    frameScale = frame.scale;
    crystal.scale.set(frame.scale * visualScale);
    const beadVisible = markBeadVisible();
    const scale = visualScale * frame.scale;
    const pointer = renderer ? readPointerLight() : null;
    let pointerSpills: AtomaMarkRearSpill[] = [];
    let lamp: {
      position: readonly [number, number, number];
      uv: readonly [number, number];
      on: number;
    } = {
      position: [0, 0, ATOMA_MARK_LAMP_Z],
      uv: [0.5, 0.5],
      on: 0,
    };
    let pointerClip: {
      uv: readonly [number, number];
      on: number;
    } = { uv: [0, 0], on: 0 };
    /** The pointer's local position when it couples into the glass, else null. */
    let coupledLocal: { x: number; y: number } | null = null;
    if (renderer && pointer) {
      if (pointer.active) {
        const local = markClientToLocal(
          renderer,
          container,
          scale,
          pointer.clientX,
          pointer.clientY
        );
        pointerSpills = collectPointerFieldSpills(frame, local.x, local.y);
        lamp = pointerLampForLocal(local.x, local.y);
        coupledLocal = local;
        const stagePos = markClientToStage(
          renderer,
          pointer.clientX,
          pointer.clientY
        );
        const screenW = Math.max(1, renderer.screen.width);
        const screenH = Math.max(1, renderer.screen.height);
        pointerClip = {
          uv: [stagePos.x / screenW, stagePos.y / screenH],
          on: 1,
        };
      }
    }
    const pointerActive = pointer?.active ?? false;
    const pointerRevision = pointer?.revision ?? -1;
    const screenW = renderer ? Math.max(1, renderer.screen.width) : 1;
    const screenH = renderer ? Math.max(1, renderer.screen.height) : 1;
    const pinned = markClockIsPinned();
    const pointerChanged = pointerRevision !== observedPointerRevision;
    const screenChanged = screenW !== observedScreenW || screenH !== observedScreenH;
    const backdropInputChanged =
      elapsedMs !== observedElapsedMs ||
      beadVisible !== observedBeadVisible ||
      pointerChanged ||
      markX !== observedMarkX ||
      markY !== observedMarkY ||
      visualScale !== observedVisualScale ||
      screenChanged ||
      pinned !== observedPinned;
    if (backdropInputChanged) {
      backdropDirty = true;
      causticDirty = true;
    }
    if (!reducedMotion || pointerChanged || screenChanged || envInvalidated) {
      // The wider stage may have its own animation, so normal motion samples
      // it at the bounded cadence even if the pointer has not moved.
      envDirty = true;
    }
    const backdropUrgent =
      urgentPointerActive === null ||
      pointerActive !== urgentPointerActive ||
      beadVisible !== urgentBeadVisible ||
      pinned !== urgentPinned ||
      screenW !== urgentScreenW ||
      screenH !== urgentScreenH;
    const envUrgent =
      envInvalidated ||
      urgentPointerActive === null ||
      pointerActive !== urgentPointerActive ||
      screenW !== urgentScreenW ||
      screenH !== urgentScreenH;
    observedElapsedMs = elapsedMs;
    observedBeadVisible = beadVisible;
    observedPointerRevision = pointerRevision;
    observedMarkX = markX;
    observedMarkY = markY;
    observedVisualScale = visualScale;
    observedScreenW = screenW;
    observedScreenH = screenH;
    observedPinned = pinned;
    urgentPointerActive = pointerActive;
    urgentBeadVisible = beadVisible;
    urgentPinned = pinned;
    urgentScreenW = screenW;
    urgentScreenH = screenH;
    envInvalidated = false;
    shell?.update(frame, { beadVisible, lamp, pointerClip });
    // Lantern light belongs on the far-field mesh. The bead throws from
    // inside; the pointer lamp sits in front and has to go THROUGH the glass
    // to reach the same wall — same rear windows, stained by the faces.
    if (!renderer) {
      clearMarkFieldLight();
    } else {
      const localRadius = Math.max(
        ATOMA_MARK_REAR_LIGHT_RADIUS * scale * VIZ_VISUAL_DEPTH.far.markHaloSpread,
        VIZ_VISUAL_DEPTH.far.markHaloMinPx
      );
      const merged = mergeFieldSpills(
        beadVisible ? frame.rearSpills : [],
        pointerSpills
      );
      if (merged.length === 0) {
        // Clear only the halo lane. The caustic has its own 30 Hz clock below;
        // clearing both here would make its cached sample blink between ticks.
        writeMarkFieldLight([]);
      } else {
        writeMarkFieldLight(
          fieldSpillsToSample(merged, container, scale, localRadius, renderer)
        );
      }
      // The CAST is CPU ray traced. Its published sample stays live between
      // updates; entering/leaving is immediate, continuous motion is 30 Hz.
      // The rear spill uses the same entry-coupling threshold as the trace,
      // so it cheaply distinguishes an active pointer from one over the gem.
      const causticCoupled = coupledLocal !== null && pointerSpills.length > 0;
      const enteringCaustic = causticCoupled && causticWasCoupled !== true;
      const updateCaustic = causticCoupled && causticDirty && (
        enteringCaustic ||
        screenChanged ||
        reducedMotion ||
        nowMs - causticLastUpdateMs >= ATOMA_MARK_CAUSTIC_UPDATE_INTERVAL_MS
      );
      if (coupledLocal && updateCaustic) {
        const cast = projectMarkCaustic(frame, coupledLocal.x, coupledLocal.y);
        const rgb = cast ? markColorToRgb(cast.color) : null;
        if (!cast || !rgb) {
          writeMarkFieldCaustic(null);
        } else {
          const points: { x: number; y: number }[] = [];
          const spectral: { x: number; y: number }[] | null = cast.spectral ? [] : null;
          for (let index = 0; index < cast.points.length; index += 1) {
            const corner = cast.points[index]!;
            const stageX = container.x + ATOMA_MARK_LOCAL_CENTER +
              (corner.x - ATOMA_MARK_LOCAL_CENTER) * scale;
            const stageY = container.y + ATOMA_MARK_LOCAL_CENTER +
              (corner.y - ATOMA_MARK_LOCAL_CENTER) * scale;
            const client = markStageToClient(renderer, stageX, stageY);
            points.push({ x: client.clientX, y: client.clientY });
            const delta = cast.spectral?.[index];
            if (spectral && delta) {
              const endpoint = markStageToClient(
                renderer,
                stageX + delta.x * scale,
                stageY + delta.y * scale
              );
              spectral.push({
                x: endpoint.clientX - client.clientX,
                y: endpoint.clientY - client.clientY,
              });
            }
          }
          writeMarkFieldCaustic({
            points,
            spectral,
            intensity: cast.intensity,
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
          });
        }
        causticDirty = false;
        causticLastUpdateMs = nowMs;
      } else if (!causticCoupled && causticWasCoupled !== false) {
        writeMarkFieldCaustic(null);
      }
      causticWasCoupled = causticCoupled;
    }
    const { x: coreX, y: coreY } = frame.corePosition;
    traceSilhouette(interiorMask, frame.silhouette);
    traceSilhouette(glassMask, frame.silhouette);
    core.position.set(coreX, coreY);
    core.scale.set(frame.coreScale * (1 + frame.pulse * 0.035));
    core.visible = beadVisible;
    bloom.alpha = 0.76 + frame.pulse * 0.24;
    const forward = 0.55 + (frame.coreDepth + 1) * 0.225;
    transmittedPool.position.set(coreX, coreY);
    transmittedPool.alpha = forward * (0.85 + frame.pulse * 0.15);
    transmittedPool.visible = beadVisible;
    transmittedCore.position.set(coreX, coreY);
    transmittedCore.scale.set(frame.coreScale);
    transmittedCore.alpha = forward * (0.88 + frame.pulse * 0.12);
    transmittedCore.visible = beadVisible;
    // Last, so the texture holds THIS frame's interior: the front glass is
    // about to be drawn by the scene and will sample what we leave here.
    //
    // The same subtree must NOT also sit in the scene. It is the undistorted
    // bead and far walls; leaving it on stage under the front glass is how a
    // circular sticker survived every pose of the turn film. The front mesh
    // already paints coverage 1 and draws that interior bent. Toggle around
    // the pass: Pixi skips a hidden container even when it is the render target.
    const captureBackdrop = backdropPass && backdropDirty && (
      backdropUrgent ||
      reducedMotion ||
      nowMs - backdropLastCaptureMs >= ATOMA_MARK_BACKDROP_UPDATE_INTERVAL_MS
    );
    if (captureBackdrop) {
      behind.visible = true;
      try {
        backdropPass();
      } finally {
        behind.visible = false;
      }
      backdropDirty = false;
      backdropLastCaptureMs = nowMs;
    }
    const captureEnv = envPass && envDirty && (
      envUrgent ||
      reducedMotion ||
      nowMs - envLastCaptureMs >= ATOMA_MARK_ENV_UPDATE_INTERVAL_MS
    );
    if (captureEnv && pointer) {
      envPass(pointer);
      envDirty = false;
      envLastCaptureMs = nowMs;
    }
  };

  // Always tick: reduced motion still has to honour a pinned pose and the
  // bead checkbox. Unpinned + reduced freezes at t=0 rather than skipping
  // the ticker — skipping would leave both inspect knobs dead.
  const elapsedForPaint = () =>
    reducedMotion && !markClockIsPinned() ? 0 : markElapsedMs();
  const tick = (ticker: Ticker) => {
    const deltaMs = Number.isFinite(ticker?.deltaMS)
      ? Math.max(0, ticker.deltaMS)
      : 1_000 / 60;
    renderClockMs += deltaMs;
    paint(elapsedForPaint(), renderClockMs);
  };
  paint(elapsedForPaint(), renderClockMs);
  addTicker(tick);
  parent.addChild(container);

  // The echo BEFORE the container, mirroring the attach order above, so a
  // resume rebuilds the same z-order the first attach produced.
  const retained: readonly Container[] = cursorEcho ? [cursorEcho, container] : [container];
  let destroyed = false;
  return {
    container,
    retained,
    setPlacement(nextX, nextY, nextVisualScale) {
      if (destroyed) return;
      markX = nextX;
      markY = nextY;
      visualScale = nextVisualScale;
      container.position.set(markX, markY);
      crystal.scale.set(frameScale * visualScale);
      if (reducedMotion) backdropDirty = true;
    },
    resume(nextParent, nextAddTicker) {
      if (destroyed) return;
      for (const child of retained) nextParent.addChild(child);
      // A scene rebuild may replace every reflected card while retaining the
      // crystal resource. Refresh the environment on the next paint.
      envInvalidated = true;
      nextAddTicker(tick);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      writeMarkFieldCaustic(null);
      // Display subtree first (meshes detach from geometry/shader), then the
      // shell's GPU resources, then the textures the passes ping-pong.
      cursorEcho?.destroy();
      container.destroy({ children: true, context: true });
      shell?.destroy();
      for (const texture of ownedTextures) texture.destroy(true);
      ownedTextures.clear();
    },
  };
}
