import { pointerLightFalloff } from '../pointer-light.js';
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

/** Below this, the surface sits on the light and direction is meaningless. */
const DEGENERATE_DISTANCE_PX = 0.5;

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
}

export interface CastShadowOffset {
  x: number;
  y: number;
}

/** The ambient offset: a fixed key light from above, used when unlit. */
export function ambientShadowOffset(depth = 1): CastShadowOffset {
  return {
    x: VIZ_VISUAL_DEPTH.near.shadowX * depth,
    y: VIZ_VISUAL_DEPTH.near.shadowY * depth,
  };
}

export function castShadowOffset(input: CastShadowInput): CastShadowOffset {
  const depth = input.depth ?? 1;
  const rest = ambientShadowOffset(depth);
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

  // Direction is still from the light to the CENTRE: that is what the surface
  // pivots around, so the shadow swings rather than snapping at the edges.
  const dx = left + width / 2 - lightX;
  const dy = top + height / 2 - lightY;
  const spread = Math.hypot(dx, dy);
  if (spread < DEGENERATE_DISTANCE_PX) return rest;

  // The light's own falloff, so a surface beyond its reach is simply unlit
  // rather than throwing a long shadow from a light it cannot see.
  const blend = strength * pointerLightFalloff(gap);
  const reach = CAST_SHADOW_REACH_PX * depth;
  const castX = dx / spread * reach;
  const castY = dy / spread * reach;
  return {
    x: rest.x + (castX - rest.x) * blend,
    y: rest.y + (castY - rest.y) * blend,
  };
}
