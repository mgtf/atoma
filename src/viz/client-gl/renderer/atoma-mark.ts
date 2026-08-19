import {
  Container,
  Graphics,
  RenderTexture,
  type Renderer,
  type Ticker,
} from 'pixi.js';
import {
  ATOMA_MARK_CORE_LIGHT_RADIUS,
  ATOMA_MARK_LOCAL_SIZE,
  ATOMA_MARK_CORE_RADIUS,
  buildAtomaMarkFrame,
  coreLightFalloff,
  mixColor,
  type AtomaMarkPoint,
} from '../brand-mark.js';
import { createMarkShell } from './mark-shell.js';
import { prefersReducedMotion } from './motion.js';
import { GPU_COLORS } from '../theme.js';

/**
 * Local crystal origin. The mark is authored in a 28×28 box with its pivot
 * here; callers that want the visual centre at a screen point pass
 * `(cx - ATOMA_MARK_LOCAL_CENTER, cy - ATOMA_MARK_LOCAL_CENTER)`.
 */
export const ATOMA_MARK_LOCAL_CENTER = 14;

/** Header size: a few pixels larger than the local box so the bar mark holds. */
export const ATOMA_MARK_HEADER_SCALE = 1.24;


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
const CORE_BLOOM_REACH = 2.6;
const CORE_BLOOM_PEAK_ALPHA = 0.42;
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
    target.circle(0, 0, outer).fill({ color, alpha: delta * peakAlpha });
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
      .circle(0, 0, ATOMA_MARK_CORE_RADIUS * (1 - t * 0.55))
      .fill({
        color: mixColor(CORE_RIM_COLOR, CORE_HOT_COLOR, smoothstep(Math.min(1, t / 0.6))),
        alpha: smoothstep(t),
      });
  }
  // The filament: a light has a point you cannot look at.
  body
    .circle(0, 0, ATOMA_MARK_CORE_RADIUS * CORE_FILAMENT_FRACTION)
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

/**
 * One Pixi crystal, driven by `buildAtomaMarkFrame`. Shared by the header
 * wordmark and the arrival gate — never a second R3F logo.
 *
 * The shell is a MESH: a thick-shell regular octahedron shaded by its own
 * WGSL/GLSL program, split into the facets behind the bead and the facets in
 * front of it. Layer order is the whole illusion — far shell, then the bead and
 * its bloom CLIPPED to the projected silhouette, then the near shell as glass
 * over it. The bead is therefore inside the crystal at every frame: it cannot be
 * painted outside the outline it lights, and the near facets pass over it.
 */
export function attachAtomaMark(
  parent: Container,
  addTicker: (callback: (ticker: Ticker) => void) => void,
  x: number,
  y: number,
  visualScale = ATOMA_MARK_HEADER_SCALE,
  renderer?: Renderer
): Container {
  const container = new Container();
  container.position.set(x, y);
  container.eventMode = 'none';
  const crystal = new Container();
  crystal.position.set(ATOMA_MARK_LOCAL_CENTER, ATOMA_MARK_LOCAL_CENTER);
  crystal.pivot.set(ATOMA_MARK_LOCAL_CENTER, ATOMA_MARK_LOCAL_CENTER);
  const aura = new Graphics();
  const shadow = new Graphics();

  const shell = createMarkShell();
  // Placeholders, so the layer order is one structure whether or not a shader
  // could be built: the meshes drop into these.
  const shellBack = new Container();
  shellBack.label = 'mark-shell-back-layer';
  const shellFront = new Container();
  shellFront.label = 'mark-shell-front-layer';
  if (shell) {
    shellBack.addChild(shell.back);
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
  /**
   * The interior, as its own subtree so it can be rendered TWICE: once into the
   * backdrop texture the front glass refracts, and once into the scene where it
   * composites normally. Grouping it is what makes the extra pass one call
   * instead of a reshuffle of the display list every frame.
   */
  const behind = new Container();
  behind.label = 'mark-behind-glass';
  behind.addChild(shellBack, interior);

  crystal.addChild(
    aura,
    shadow,
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
   * fixed 28x28 local square, so a header mark at 1.24x needs a 35px texture
   * while the arrival gate needs a few hundred. Sizing to the viewport would
   * spend megabytes to refract a 35px logo.
   *
   * Skipped entirely without a renderer. The mark must keep working in the
   * headless view tests and anywhere the caller has no renderer to lend, and
   * the shell's own default — an empty texture with a zero texel size — makes
   * the sampling inert rather than wrong when this never runs.
   */
  const backdropPass = ((): ((elapsedMs: number) => void) | null => {
    if (!renderer || !shell) return null;
    const resolution = renderer.resolution;
    const sizePx = Math.max(
      1,
      Math.ceil(ATOMA_MARK_LOCAL_CENTER * 2 * visualScale * resolution)
    );
    /**
     * TWO textures, alternating. WebGPU forbids a texture being bound for
     * sampling and used as a render attachment inside the same synchronisation
     * scope — and that is exactly what one texture would be here, since the
     * shell samples the backdrop in the very frame it is written. It is not a
     * warning: the command buffer is rejected and the mark stops drawing.
     *
     * So the shell always samples the texture written LAST frame while this
     * frame renders into the other. The cost is a one-frame-old interior behind
     * the glass, which at 60fps is 16ms of lag on a refraction — invisible, and
     * the crystal turns once every 15 seconds.
     */
    const textures = [
      RenderTexture.create({ width: sizePx, height: sizePx, resolution: 1 }),
      RenderTexture.create({ width: sizePx, height: sizePx, resolution: 1 }),
    ];
    let writeIndex = 0;
    shell.setBackdrop(textures[1]!, sizePx, sizePx);
    /**
     * `behind` ALONE is rendered, never the whole crystal.
     *
     * Rendering the crystal meant the aura and the drop shadow went into the
     * texture as well — and, because the front glass composites its own sampled
     * result back into the scene, the mark fed on its own output frame after
     * frame. It built up as staircase artefacts and flat saturated colour, which
     * is what a feedback loop looks like, not what a strong effect looks like.
     * The subtree that must be in there is exactly the one the glass is in front
     * of: the far facets and the bead.
     */
    const scale = ATOMA_MARK_LOCAL_SIZE > 0 ? sizePx / ATOMA_MARK_LOCAL_SIZE : 1;
    return () => {
      // Rendered in ISOLATION, so the transform maps the 28x28 local box onto
      // the texture rather than onto wherever the mark sits on screen.
      behind.position.set(0, 0);
      behind.scale.set(scale);
      const target = textures[writeIndex]!;
      // Refraction OFF for the pass: the back facets share the front's shader.
      shell.setRefracting(false);
      renderer.render({ container: behind, target, clear: true });
      shell.setRefracting(true);
      behind.position.set(0, 0);
      behind.scale.set(1);
      // Hand the shell what we just wrote; next frame writes to the other one,
      // so nothing is ever sampled and rendered into at the same time.
      shell.setBackdrop(target, sizePx, sizePx);
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

  const paint = (elapsedMs: number) => {
    const frame = buildAtomaMarkFrame(elapsedMs);
    crystal.scale.set(frame.scale * visualScale);
    shell?.update(frame);
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
    traceSilhouette(interiorMask, frame.silhouette);
    traceSilhouette(glassMask, frame.silhouette);

    const { x: coreX, y: coreY } = frame.corePosition;
    core.position.set(coreX, coreY);
    core.scale.set(frame.coreScale * (1 + frame.pulse * 0.035));
    bloom.alpha = 0.76 + frame.pulse * 0.24;
    // Light that made it through the near glass. It grows as the bead comes
    // forward, which is the only depth cue a 6% perspective cannot give.
    const forward = 0.55 + (frame.coreDepth + 1) * 0.225;
    transmittedPool.position.set(coreX, coreY);
    transmittedPool.alpha = forward * (0.85 + frame.pulse * 0.15);
    transmittedCore.position.set(coreX, coreY);
    transmittedCore.scale.set(frame.coreScale);
    transmittedCore.alpha = forward * (0.88 + frame.pulse * 0.12);
    // Last, so the texture holds THIS frame's interior: the front glass is
    // about to be drawn by the scene and will sample what we leave here.
    backdropPass?.(elapsedMs);
  };

  const reducedMotion = prefersReducedMotion();
  paint(reducedMotion ? 0 : performance.now());
  if (!reducedMotion) {
    addTicker(() => {
      paint(performance.now());
    });
  }
  parent.addChild(container);
  return container;
}
