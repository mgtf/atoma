import { GPU_COLORS } from '../theme.js';

/**
 * The frame-rate readout's pure part: how often it refreshes, and what colour
 * a given rate deserves.
 *
 * Kept out of the renderer class for the reason the rest of `renderer/` exists
 * — thresholds and cadence are decisions worth testing without a GPU.
 *
 * WHY IT REFRESHES SLOWLY. The readout is a `Text`, and changing a `Text`'s
 * string re-rasterises it and uploads a new texture. At 60Hz that would make
 * the FPS counter one of the most expensive objects on screen, which is a
 * comic way to measure performance. Four updates a second is legible and
 * costs ~4 rasterisations of a five-character string per second.
 */
export const FPS_REFRESH_MS = 250;

/**
 * Colour bands. Dim while healthy so the readout stays furniture; it only
 * earns attention when the number is worth reading. 50 is the first rate at
 * which motion is visibly not smooth on a 60Hz panel; below 30 the UI is
 * failing rather than struggling.
 */
export function fpsColor(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return GPU_COLORS.muted;
  if (fps < 30) return GPU_COLORS.error;
  if (fps < 50) return GPU_COLORS.warning;
  return GPU_COLORS.muted;
}

/** `59.6` → `60 FPS`. Rounded: a jittering decimal reads as instability. */
export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '— FPS';
  return `${Math.round(fps)} FPS`;
}
