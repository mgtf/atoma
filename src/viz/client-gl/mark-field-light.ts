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
 * The mark's CAUSTIC: four facet ray bundles projected onto the wall behind.
 * One sample, written when the pointer couples into the glass and read by the
 * far-field aurora behind the UI. The UI itself occludes this receiver plane;
 * projecting the same cast through filled controls would imply two incompatible
 * depths and would duplicate the fragment cost.
 *
 * Corners are VIEWPORT CSS PIXELS, the same space the pools are reported in,
 * so the field reader converts them through `packMarkCaustic`.
 */
export const MARK_CAUSTIC_MAX_POINTS = 12;

/**
 * Per-corner spectral HALF-SEPARATION, the same twelve corners again: red sits
 * at corner + delta, blue at corner − delta, in the SAME viewport CSS pixels.
 * The camera mapping is projective, so `packMarkCaustic` maps the corner and
 * its endpoint before subtracting them; it never applies one global scale to
 * every delta. Null when the active material does not disperse: the consumer's
 * band gate stays closed rather than drawing a zero-width fringe it cannot see.
 */
export const MARK_CAUSTIC_MAX_SPECTRAL = 12;
export const MARK_CAUSTIC_MAX_BUNDLES = 4;
export const MARK_CAUSTIC_SECONDARY_POINTS = 3;

export interface MarkFieldCausticOptics {
  r: number;
  g: number;
  b: number;
  intensity: number;
}

export interface MarkFieldCausticSecondary {
  points: readonly { x: number; y: number }[];
  spectral: readonly { x: number; y: number }[] | null;
  optics: MarkFieldCausticOptics;
}

export interface MarkFieldCaustic {
  /** Four consecutive three-point ray bundles, in viewport CSS pixels. */
  points: readonly { x: number; y: number }[];
  /** Per-corner signed half-separation, or null when the glass does not disperse. */
  spectral: readonly { x: number; y: number }[] | null;
  /** Four transport-derived coating transmissions and Fresnel energies. */
  optics: readonly MarkFieldCausticOptics[];
  /** At most one bounded partial-reflection branch. */
  secondary: MarkFieldCausticSecondary | null;
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
 * Publishes the cast. A valid sample is exactly four triangular ray bundles.
 */
export function writeMarkFieldCaustic(next: MarkFieldCaustic | null): void {
  const root = globalThis as FieldLightRoot;
  if (!next || next.points.length < MARK_CAUSTIC_MAX_POINTS ||
      next.optics.length < MARK_CAUSTIC_MAX_BUNDLES) {
    root.__ATOMA_MARK_CAUSTIC__ = null;
    return;
  }
  root.__ATOMA_MARK_CAUSTIC__ = {
    points: next.points.slice(0, MARK_CAUSTIC_MAX_POINTS),
    spectral: next.spectral && next.spectral.length >= MARK_CAUSTIC_MAX_SPECTRAL
      ? next.spectral.slice(0, MARK_CAUSTIC_MAX_SPECTRAL)
      : null,
    optics: next.optics.slice(0, MARK_CAUSTIC_MAX_BUNDLES).map((optical) => ({
      ...optical,
    })),
    secondary: next.secondary &&
      next.secondary.points.length >= MARK_CAUSTIC_SECONDARY_POINTS
      ? {
          points: next.secondary.points.slice(0, MARK_CAUSTIC_SECONDARY_POINTS),
          spectral: next.secondary.spectral &&
            next.secondary.spectral.length >= MARK_CAUSTIC_SECONDARY_POINTS
            ? next.secondary.spectral.slice(0, MARK_CAUSTIC_SECONDARY_POINTS)
            : null,
          optics: { ...next.secondary.optics },
        }
      : null,
  };
}

export function readMarkFieldCaustic(): MarkFieldCaustic | null {
  return caustic();
}

export interface MarkCausticUniforms {
  /**
   * Exactly four triangles in RENDERER pixels, each wound POSITIVE.
   */
  corners: readonly { x: number; y: number }[];
  /**
   * The SAME twelve corners as signed half-separations, in renderer pixels:
   * red at corner + delta, blue at corner − delta. Null when no band was
   * traced. Winding reorders each delta together with the corner it belongs to.
   */
  spectral: readonly { x: number; y: number }[] | null;
  optics: readonly MarkFieldCausticOptics[];
  secondary: {
    corners: readonly { x: number; y: number }[];
    spectral: readonly { x: number; y: number }[] | null;
    optics: MarkFieldCausticOptics;
  } | null;
}

/**
 * THE conversion from the published cast to far-field shader uniforms.
 *
 * Winding is FORCED positive here rather than trusted from the hull order:
 * screen y runs opposite to the mark's local y, so hull order alone flips it.
 * The shaders' single inward-normal rule depends on this.
 */
export function packMarkCaustic(
  cast: MarkFieldCaustic | null,
  bounds: PointerLightBounds,
  rendererWidth: number,
  rendererHeight: number,
  mapClientToRenderer: (x: number, y: number) => { x: number; y: number } =
    (x, y) => pointerClientToRenderer(x, y, bounds, rendererWidth, rendererHeight)
): MarkCausticUniforms | null {
  if (!cast || cast.points.length < MARK_CAUSTIC_MAX_POINTS ||
      cast.optics.length < MARK_CAUSTIC_MAX_BUNDLES) return null;
  const corners = cast.points
    .slice(0, MARK_CAUSTIC_MAX_POINTS)
    .map((point) => mapClientToRenderer(point.x, point.y));
  const spectral = cast.spectral && cast.spectral.length >= MARK_CAUSTIC_MAX_SPECTRAL
    ? cast.spectral
        .slice(0, MARK_CAUSTIC_MAX_SPECTRAL)
        .map((delta, index) => {
          const point = cast.points[index]!;
          const corner = corners[index]!;
          const endpoint = mapClientToRenderer(point.x + delta.x, point.y + delta.y);
          return { x: endpoint.x - corner.x, y: endpoint.y - corner.y };
        })
    : null;
  const orientTriangle = (
    triangle: { x: number; y: number }[],
    band: { x: number; y: number }[] | null,
    start: number
  ) => {
    const a = triangle[start]!;
    const b = triangle[start + 1]!;
    const c = triangle[start + 2]!;
    const area = a.x * b.y + b.x * c.y + c.x * a.y -
      b.x * a.y - c.x * b.y - a.x * c.y;
    if (area < 0) {
      [triangle[start + 1], triangle[start + 2]] = [c, b];
      if (band) {
        [band[start + 1], band[start + 2]] = [
          band[start + 2]!,
          band[start + 1]!,
        ];
      }
    }
  };
  for (const start of [0, 3, 6, 9]) {
    orientTriangle(corners, spectral, start);
  }
  const secondaryCorners = cast.secondary?.points
    .slice(0, MARK_CAUSTIC_SECONDARY_POINTS)
    .map((point) => mapClientToRenderer(point.x, point.y)) ?? null;
  const secondarySpectral = cast.secondary?.spectral && secondaryCorners
    ? cast.secondary.spectral
        .slice(0, MARK_CAUSTIC_SECONDARY_POINTS)
        .map((delta, index) => {
          const point = cast.secondary!.points[index]!;
          const corner = secondaryCorners[index]!;
          const endpoint = mapClientToRenderer(point.x + delta.x, point.y + delta.y);
          return { x: endpoint.x - corner.x, y: endpoint.y - corner.y };
        })
    : null;
  if (secondaryCorners?.length === MARK_CAUSTIC_SECONDARY_POINTS) {
    orientTriangle(secondaryCorners, secondarySpectral, 0);
  }
  return {
    corners,
    spectral,
    optics: cast.optics.slice(0, MARK_CAUSTIC_MAX_BUNDLES),
    secondary: cast.secondary &&
      secondaryCorners?.length === MARK_CAUSTIC_SECONDARY_POINTS
      ? {
          corners: secondaryCorners,
          spectral: secondarySpectral,
          optics: cast.secondary.optics,
        }
      : null,
  };
}

export function markColorToRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16 & 0xff) / 255,
    g: (color >> 8 & 0xff) / 255,
    b: (color & 0xff) / 255,
  };
}
