/**
 * The penumbra of a cast shadow, as pure geometry.
 *
 * Every shadow in this scene used to be ONE rounded rect at a flat alpha,
 * offset from its surface. At a hard edge that does not read as a shadow — it
 * reads as a second copy of the shape sitting behind the first, which is
 * exactly what the control-group frames looked like: a duplicate outline
 * rather than a group standing off the column. The frames made it worst
 * because their fill is translucent, so the flat black slab showed THROUGH the
 * frame and put a hard step across its interior.
 *
 * The fix is a stack of concentric rounded rects, growing outward and fading,
 * whose accumulated alpha approximates a blur. Deliberately NOT a Pixi
 * `BlurFilter`:
 *
 *  - it stays ONE `Graphics` with one `position`, so `cast-shadow.ts` keeps
 *    moving shadows by position alone and nothing re-tessellates per frame;
 *  - it is pure geometry, so it behaves identically on WebGPU and the WebGL
 *    fallback, and it is testable with no device at all;
 *  - it adds no filter lifetime to the scene. AGENTS.md records what a filter
 *    that outlives one `render()` costs (the pointer-light uniform buffer
 *    against Pixi's GC); the scene does not need a second one for a shadow.
 *
 * Softness scales with depth on purpose: a surface held further off the page
 * throws a wider, weaker penumbra. That is the same physical fact the light
 * height already encodes, so a lifted surface softens instead of just sliding.
 */

export interface SoftShadowLayer {
  /** Offset from the surface rect's own origin; negative, the layer grows out. */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  alpha: number;
}

/** One material response for every shadowed surface in the GPU scene. */
export const SCENE_SHADOW_COLORS = {
  core: 0x071224,
  penumbra: 0x0d1c32,
} as const;

/** Layers past this buy nothing visible and cost tessellation. */
const MAX_LAYERS = 5;

/** How far the penumbra spreads at depth 1, in renderer pixels. */
const PENUMBRA_PX = 5;

/**
 * Layers ordered OUTERMOST FIRST, so a caller can fill them in order and let
 * the alphas accumulate toward the core — the same order a painter would use.
 *
 * `alpha` is the peak the stack reaches at the centre, not the value of any
 * one layer: the layers are weighted so their accumulated coverage lands on
 * `alpha` there and falls off to nearly nothing at the outer edge. That keeps
 * this a drop-in for the flat fill it replaces, so existing shadow alphas keep
 * meaning what they meant.
 */
export function softShadowLayers(
  width: number,
  height: number,
  radius: number,
  alpha: number,
  depth = 1
): SoftShadowLayer[] {
  const peak = Math.min(1, Math.max(0, alpha));
  // A degenerate rect has no interior to shade, and a transparent shadow has
  // nothing to say; both collapse to no geometry rather than to a stack of
  // invisible layers the renderer would still have to tessellate.
  if (peak === 0 || !(width > 0) || !(height > 0)) return [];

  const spread = PENUMBRA_PX * Math.max(0, depth);
  // With no spread there is no penumbra to build: one crisp layer IS the
  // correct answer, and it keeps `depth: 0` an exact no-op.
  if (spread === 0) {
    return [{ x: 0, y: 0, width, height, radius, alpha: peak }];
  }

  // Each layer contributes `per` and they composite as 1-(1-per)^n, so solving
  // for the stack's peak keeps the centre on `peak` however many layers exist.
  const per = 1 - Math.pow(1 - peak, 1 / MAX_LAYERS);
  const layers: SoftShadowLayer[] = [];
  for (let i = MAX_LAYERS - 1; i >= 0; i -= 1) {
    // i = 0 is the core (no growth); i = MAX_LAYERS-1 is the outer edge.
    const grow = (spread * i) / (MAX_LAYERS - 1);
    // `-grow` at grow === 0 is -0, which the core layer would then carry into
    // its position; keep the core's origin an honest 0.
    const offset = grow > 0 ? -grow : 0;
    layers.push({
      x: offset,
      y: offset,
      width: width + grow * 2,
      height: height + grow * 2,
      radius: radius + grow,
      alpha: per,
    });
  }
  return layers;
}

/**
 * What the stack actually reaches at the centre, for tests and for anyone
 * checking a shadow got dimmer rather than merely wider.
 */
export function softShadowPeakAlpha(layers: readonly SoftShadowLayer[]): number {
  return layers.reduce((acc, layer) => acc + (1 - acc) * layer.alpha, 0);
}
