/**
 * The bead's SURGE: how far the crystal's interior light has been pushed past
 * its resting brightness, 0 at rest and 1 at full flare. The handheld gate
 * drives it from one requestAnimationFrame loop; the mark's paint reads it
 * ONCE per frame, the same mutable-sample contract the pointer light and the
 * inspect clock follow, so a surge never rebuilds the Pixi scene.
 *
 * The paint also PUBLISHES where the bead is on screen while it surges, so a
 * DOM flood can grow from the light's real centre rather than from the
 * viewport's — the bead wanders inside the crystal and the hero bobs.
 */

let surge = 0;

/** 0..1. Non-finite writes are ignored so a broken clock cannot blind the gem. */
export function setMarkCoreSurge(value: number): void {
  if (!Number.isFinite(value)) return;
  surge = Math.max(0, Math.min(1, value));
}

export function markCoreSurge(): number {
  return surge;
}

export interface MarkCoreScreenSample {
  /** Viewport CSS pixels, the pointer light's space. */
  clientX: number;
  clientY: number;
  /** The bead's drawn radius in CSS pixels. */
  radiusPx: number;
}

let coreScreen: MarkCoreScreenSample | null = null;

export function writeMarkCoreScreen(sample: MarkCoreScreenSample | null): void {
  coreScreen = sample;
}

export function readMarkCoreScreen(): MarkCoreScreenSample | null {
  return coreScreen;
}

/**
 * How much of the surge each lit part receives, as the factor `1 + surge × k`.
 * The bead itself swells and its bloom saturates first; the walls the shader
 * lights follow; the far-field spill behind the crystal is last and widest,
 * so the flood reads as light leaving the gem rather than a brighter sticker.
 */
export const MARK_SURGE = {
  coreScale: 1.9,
  bloomAlpha: 1.6,
  glassGlow: 2.4,
  shellIntensity: 2.6,
  fieldIntensity: 3.2,
  fieldRadius: 1.4,
} as const;

/** `1 + surge × factor`, the one shape every surge multiplier takes. */
export function markSurgeGain(value: number, factor: number): number {
  return 1 + Math.max(0, Math.min(1, value)) * factor;
}
