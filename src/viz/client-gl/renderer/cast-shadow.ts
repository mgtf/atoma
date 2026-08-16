import { POINTER_LIGHT_RADIUS_PX, pointerLightFalloff } from '../pointer-light.js';
import { VIZ_VISUAL_DEPTH } from '../visual-depth.js';

/**
 * Where a surface throws its shadow, given where the light is.
 *
 * The scene has one movable light — the pointer — sitting UNDER the cursor, so
 * a surface near it should throw away from it, and a surface out of its reach
 * should fall back to the ambient offset (a fixed light from above). Blending
 * on `pointerLightFalloff` means the shadow's reach IS the light's reach: one
 * radius governs both, and retuning the light drags the shadows with it
 * instead of leaving them pointing at a pool that no longer exists.
 *
 * Pure and frame-independent: the caller owns the damped `strength` and calls
 * this once per shadow per frame. Nothing here reads a clock.
 */

/** How far a fully-lit surface pushes its shadow, in renderer pixels. */
export const CAST_SHADOW_REACH_PX = 13;

/**
 * How far the light must travel off the lit region's centroid before that
 * surface throws its full shadow. Below it the shadow is short and lands more
 * or less underneath, which is what "the light is overhead" looks like.
 */
export const CAST_SHADOW_RAMP_PX = 45;

export interface CastShadowInput {
  /** Surface rect in stage coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Light position, renderer pixels. */
  lightX: number;
  lightY: number;
  /** Damped pointer presence, 0..1. At 0 the result is the ambient offset. */
  strength: number;
  /**
   * Scales both the ambient offset and the cast reach. A panel stacks two
   * layers at different depths; the deeper one travels further, which is what
   * separates them into a soft shadow instead of one hard smear.
   */
  depth?: number;
  /**
   * How high the light floats, 1 being the shipped height. A lifted lamp
   * spreads its pool WIDER and throws SHORTER shadows, so one number scales
   * the falloff radius up and the reach down. Both here rather than split
   * across two call sites, because this module's whole premise is that the
   * light's reach and its shadows' reach are the same fact.
   */
  lightHeight?: number;
}

export interface CastShadowOffset {
  x: number;
  y: number;
}

/**
 * Midpoint of the overlap between a surface's span on one axis and the
 * light's span, i.e. the lit region's centre along that axis. With no
 * overlap, the nearest end of the surface — the limit the overlap shrinks
 * to, so the value stays continuous as the light leaves the surface behind.
 */
function litSpanCentre(min: number, max: number, light: number, radius: number): number {
  const lo = Math.max(min, light - radius);
  const hi = Math.min(max, light + radius);
  if (lo > hi) return light < min ? min : max;
  return (lo + hi) / 2;
}

/** The ambient offset: a fixed key light from above, used when unlit. */
export function ambientShadowOffset(depth = 1): CastShadowOffset {
  return {
    x: VIZ_VISUAL_DEPTH.near.shadowX * depth,
    y: VIZ_VISUAL_DEPTH.near.shadowY * depth,
  };
}

export function castShadowOffset(input: CastShadowInput): CastShadowOffset {
  const depth = Number.isFinite(input.depth ?? 1) ? input.depth ?? 1 : 1;
  const rest = ambientShadowOffset(depth);
  // NaN anywhere would otherwise ride through every formula below and land as
  // a (NaN, NaN) position — and the caller's damped strength, once NaN, stays
  // NaN, so the shadow would never recover. `lightHeight` already guards
  // itself; the rest of the inputs deserve the same manners. Ambient is the
  // honest answer to a light we cannot place.
  if (
    !Number.isFinite(input.strength) ||
    !Number.isFinite(input.lightX) ||
    !Number.isFinite(input.lightY) ||
    !Number.isFinite(input.left) ||
    !Number.isFinite(input.top)
  ) {
    return rest;
  }
  const strength = Math.min(1, Math.max(0, input.strength));
  if (strength === 0) return rest;

  const { left, top, width, height, lightX, lightY } = input;
  // Reach is measured to the NEAREST EDGE, not the centre. A panel 900px wide
  // has its centre 450px from a cursor sitting right on it, so a centre
  // measurement put every wide surface outside the light and nothing ever
  // moved. Zero when the light is over the surface.
  const gapX = Math.max(left - lightX, 0, lightX - (left + width));
  const gapY = Math.max(top - lightY, 0, lightY - (top + height));
  const gap = Math.hypot(gapX, gapY);

  // The light's own falloff, so a surface beyond its reach is simply unlit
  // rather than throwing a long shadow from a light it cannot see.
  const lightHeight =
    input.lightHeight && input.lightHeight > 0 ? input.lightHeight : 1;
  const radius = POINTER_LIGHT_RADIUS_PX * lightHeight;
  const blend = strength * pointerLightFalloff(gap, radius);

  // The shadow throws away from the light toward the centroid of the LIT
  // REGION — the part of the surface inside the light's radius — not toward
  // the surface's geometric centre. The pointer light is local: on a 900px
  // control frame it lights a patch, and the only shadow the eye can see is
  // that patch's, right where the light has brightened the page. Aiming at
  // the geometric centre made a pointer sitting below such a frame throw the
  // shadow SIDEWAYS at a centre 300px away instead of up, and that error was
  // invisible on buttons, which fit inside the light entirely (there the lit
  // centroid IS the centre, so small surfaces keep the exact behaviour that
  // was verified on them).
  //
  // The centroid is per-axis: the lit span is the overlap of the surface with
  // the light's square, and its midpoint moves continuously with the light —
  // no edge crossing ever snaps the direction. An empty overlap collapses to
  // the nearest edge; the falloff has mostly extinguished the blend out
  // there, so only continuity matters, not the exact aim.
  const litX = litSpanCentre(left, left + width, lightX, radius);
  const litY = litSpanCentre(top, top + height, lightY, radius);
  const dx = litX - lightX;
  const dy = litY - lightY;

  // Offset grows with the light's travel off the lit centroid and saturates at
  // full reach. The ramp is an ABSOLUTE distance, deliberately NOT the
  // surface's own size: a lit plate's shadow shifts with the light's lateral
  // distance and the plate's own thickness, and it does not care how broad
  // the plate is. (Normalizing by the half-diagonal — a previous version —
  // gave a wide frame a ~450px ramp, so the ambient offset outweighed the
  // cast and the frame's shadow fell downward, toward the light below it.)
  // Directly overhead both components are zero and the shadow sits
  // underneath; no degenerate-direction guard is needed because nothing here
  // normalizes a vector.
  const reach = CAST_SHADOW_REACH_PX * depth / lightHeight;
  const rawX = (dx / CAST_SHADOW_RAMP_PX) * reach;
  const rawY = (dy / CAST_SHADOW_RAMP_PX) * reach;
  const rawLength = Math.hypot(rawX, rawY);
  const scale = rawLength > reach ? reach / rawLength : 1;
  const castX = rawX * scale;
  const castY = rawY * scale;
  return {
    x: rest.x + (castX - rest.x) * blend,
    y: rest.y + (castY - rest.y) * blend,
  };
}

/**
 * Which stack a surface belongs to. The tuning panel lifts these
 * independently — a button rises off the frame that groups it, that frame
 * rises off the column, the column rises off the page — so a shadow has to
 * declare which of the three it is. `card` is everything else and is left
 * alone by the panel, because cards already carry their own elevation.
 */
export type CastShadowSurface = 'button' | 'frame' | 'column' | 'card';

/** The live multiplier for a surface class. Identity tuning returns 1 flat. */
export function surfaceDepthScale(
  surface: CastShadowSurface,
  tuning: {
    buttonDepth: number;
    controlFrameDepth: number;
    columnDepth: number;
  }
): number {
  // Ratios against the shipped depth, so a slider sitting at the identity is
  // exactly a no-op no matter what the build-time depth happened to be.
  if (surface === 'button') return tuning.buttonDepth / TUNING_IDENTITY_BUTTON;
  if (surface === 'frame') return tuning.controlFrameDepth / TUNING_IDENTITY_FRAME;
  if (surface === 'column') return tuning.columnDepth / TUNING_IDENTITY_COLUMN;
  return 1;
}

/**
 * The shipped depths these knobs are ratios against. Declared here beside the
 * consumer and asserted against `TUNING_IDENTITY` by a test, so the two cannot
 * drift into a panel whose "default" silently restyles the app — which is
 * exactly what the first version of this panel did.
 */
const TUNING_IDENTITY_BUTTON = 1;
const TUNING_IDENTITY_FRAME = 0.8;
const TUNING_IDENTITY_COLUMN = 1;

export const CAST_SHADOW_IDENTITY_DEPTH = {
  button: TUNING_IDENTITY_BUTTON,
  frame: TUNING_IDENTITY_FRAME,
  column: TUNING_IDENTITY_COLUMN,
} as const;
