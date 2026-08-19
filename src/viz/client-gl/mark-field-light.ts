/**
 * Stained light the brand mark throws onto the FAR field.
 *
 * The bead is a lantern inside the crystal. Light that leaves through a rear
 * face has to land on the Three.js backdrop — the plane that faces the camera,
 * behind the Pixi UI. Pixi cannot light that plane: the two GPU contexts do
 * not share a scene, and a disc painted under the gem reads as a floor.
 *
 * Same contract as the pointer light: a mutable sample, written by the mark,
 * read once per frame by the backdrop. Stored on globalThis so the dynamically
 * imported renderer chunk and the lazy Three backdrop cannot each hold an
 * empty copy of the array — that split is why the field stayed dark.
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
