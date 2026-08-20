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

export const MARK_FIELD_LIGHT_MAX = 4;

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
};

function spills(): MarkFieldLightSpill[] {
  const root = globalThis as FieldLightRoot;
  if (!root.__ATOMA_MARK_FIELD_LIGHT__) root.__ATOMA_MARK_FIELD_LIGHT__ = [];
  return root.__ATOMA_MARK_FIELD_LIGHT__;
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
}

export function readMarkFieldLight(): readonly MarkFieldLightSpill[] {
  return spills();
}

export function markColorToRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16 & 0xff) / 255,
    g: (color >> 8 & 0xff) / 255,
    b: (color & 0xff) / 255,
  };
}
