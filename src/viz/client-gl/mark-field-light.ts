/**
 * Stained light the brand mark throws onto the FAR field.
 *
 * The bead is a lantern inside the crystal. Light that leaves through a rear
 * face lands on the Pixi aurora mesh — the plane that faces the camera,
 * behind the UI. A disc painted under the gem still reads as a floor, so
 * this sample is what the field shader reads, not a second Pixi sprite.
 *
 * Same contract as the pointer light: a mutable sample, written by the mark,
 * read once per frame by the field tick.
 */
import {
  pointerClientToRenderer,
  type PointerLightBounds,
} from './pointer-light.js';

export const MARK_FIELD_LIGHT_MAX = 4;

/**
 * The mark's CAUSTIC: the gem's silhouette projected onto the wall behind,
 * deformed by the pointer lamp's position. One sample, written when the
 * pointer couples into the glass, read by every surface the cast lands on —
 * the far-field aurora behind the UI and the pointer-light filter over it.
 *
 * Corners are VIEWPORT CSS PIXELS, the same space the pools are reported in,
 * so both readers convert them through the one mapping in `packMarkCaustic`.
 */
export const MARK_CAUSTIC_MAX_POINTS = 6;

export interface MarkFieldCaustic {
  /** Convex polygon corners, viewport CSS pixels, in hull order. */
  points: readonly { x: number; y: number }[];
  /**
   * 0..1 brightness at the wall: the entry coupling already dimmed by how far
   * the cast was thrown. Readers scale it for their own surface; none of them
   * re-derives it.
   */
  intensity: number;
  r: number;
  g: number;
  b: number;
}

export interface MarkFieldLightSpill {
  /**
   * Viewport CSS pixels, same space as the pointer light's clientX/clientY,
   * so the backdrop can reuse `pointerClientToUv`.
   */
  clientX: number;
  clientY: number;
  /** Halo radius in CSS pixels. */
  radiusPx: number;
  r: number;
  g: number;
  b: number;
  /** 0..1, material-weighted from the face that stained this light. */
  intensity: number;
}

type FieldLightRoot = typeof globalThis & {
  __ATOMA_MARK_FIELD_LIGHT__?: MarkFieldLightSpill[];
  __ATOMA_MARK_CAUSTIC__?: MarkFieldCaustic | null;
};

function spills(): MarkFieldLightSpill[] {
  const root = globalThis as FieldLightRoot;
  if (!root.__ATOMA_MARK_FIELD_LIGHT__) root.__ATOMA_MARK_FIELD_LIGHT__ = [];
  return root.__ATOMA_MARK_FIELD_LIGHT__;
}

function caustic(): MarkFieldCaustic | null {
  return (globalThis as FieldLightRoot).__ATOMA_MARK_CAUSTIC__ ?? null;
}

export function writeMarkFieldLight(next: readonly MarkFieldLightSpill[]): void {
  const target = spills();
  target.length = 0;
  const ranked = [...next].sort((left, right) => right.intensity - left.intensity);
  for (const spill of ranked.slice(0, MARK_FIELD_LIGHT_MAX)) {
    target.push({
      clientX: spill.clientX,
      clientY: spill.clientY,
      radiusPx: spill.radiusPx,
      r: spill.r,
      g: spill.g,
      b: spill.b,
      intensity: spill.intensity,
    });
  }
}

export function clearMarkFieldLight(): void {
  spills().length = 0;
  (globalThis as FieldLightRoot).__ATOMA_MARK_CAUSTIC__ = null;
}

export function readMarkFieldLight(): readonly MarkFieldLightSpill[] {
  return spills();
}

/**
 * Publishes the cast. The polygon is clamped to MARK_CAUSTIC_MAX_POINTS
 * corners by taking the FIRST N of the convex outline (it is already in
 * hull order); fewer than three cannot be a shape and clear instead.
 */
export function writeMarkFieldCaustic(next: MarkFieldCaustic | null): void {
  const root = globalThis as FieldLightRoot;
  if (!next || next.points.length < 3) {
    root.__ATOMA_MARK_CAUSTIC__ = null;
    return;
  }
  root.__ATOMA_MARK_CAUSTIC__ = {
    points: next.points.slice(0, MARK_CAUSTIC_MAX_POINTS),
    intensity: next.intensity,
    r: next.r,
    g: next.g,
    b: next.b,
  };
}

export function readMarkFieldCaustic(): MarkFieldCaustic | null {
  return caustic();
}

export interface MarkCausticUniforms {
  /**
   * Exactly MARK_CAUSTIC_MAX_POINTS corners in RENDERER pixels, wound
   * POSITIVE, with unused slots repeating the last real corner so the
   * closing edge stays real and every padding edge collapses to zero length.
   */
  corners: readonly { x: number; y: number }[];
  intensity: number;
  r: number;
  g: number;
  b: number;
}

/**
 * THE conversion from the published cast to shader uniforms. Both readers use
 * it: the far-field mesh behind the UI and the pointer-light filter over it
 * must resolve the same polygon in the same pixels, or the diamond drawn on
 * the backdrop would not line up with the one drawn on the buttons.
 *
 * Winding is FORCED positive here rather than trusted from the hull order:
 * screen y runs opposite to the mark's local y, so hull order alone flips it.
 * The shaders' single inward-normal rule depends on this.
 */
export function packMarkCaustic(
  cast: MarkFieldCaustic | null,
  bounds: PointerLightBounds,
  rendererWidth: number,
  rendererHeight: number
): MarkCausticUniforms | null {
  if (!cast || cast.points.length < 3) return null;
  const corners = cast.points
    .slice(0, MARK_CAUSTIC_MAX_POINTS)
    .map((point) =>
      pointerClientToRenderer(point.x, point.y, bounds, rendererWidth, rendererHeight)
    );
  let area = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) corners.reverse();
  const last = corners[corners.length - 1]!;
  while (corners.length < MARK_CAUSTIC_MAX_POINTS) {
    corners.push({ x: last.x, y: last.y });
  }
  return {
    corners,
    intensity: cast.intensity,
    r: cast.r,
    g: cast.g,
    b: cast.b,
  };
}

export function markColorToRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16 & 0xff) / 255,
    g: (color >> 8 & 0xff) / 255,
    b: (color & 0xff) / 255,
  };
}
