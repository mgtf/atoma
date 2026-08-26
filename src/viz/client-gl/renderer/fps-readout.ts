import { GPU_COLORS } from '../theme.js';

/**
 * The frame-rate readout's pure part: how often it refreshes, how frame
 * intervals are aggregated, and what colour a given rate deserves.
 *
 * Kept out of the renderer class for the reason the rest of `renderer/` exists
 * — thresholds and cadence are decisions worth testing without a GPU.
 *
 * WHY IT REFRESHES SLOWLY. A quarter-second window is long enough to describe
 * motion rather than one unlucky frame and short enough to remain useful.
 * The renderer uses BitmapText, so publishing the result only rebuilds a few
 * glyph quads; it never rasterises and uploads a fresh canvas-text texture.
 */
export const FPS_REFRESH_MS = 250;

export interface FpsSampleWindow {
  elapsedMs: number;
  frames: number;
}

export function createFpsSampleWindow(): FpsSampleWindow {
  return { elapsedMs: 0, frames: 0 };
}

/**
 * Add one real frame interval and publish the completed window's mean rate.
 *
 * Pixi's `Ticker.FPS` is `1000 / elapsedMS` for the LAST frame, not a
 * smoothed rate. Sampling that value made one missed 120Hz frame read as
 * exactly 60 FPS; changing the canvas-text label to say so then caused
 * another missed frame. Accumulating the same ticker intervals describes the
 * whole refresh window and cannot amplify one frame into the next sample.
 */
export function sampleFpsWindow(
  sample: FpsSampleWindow,
  elapsedMs: number
): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  sample.elapsedMs += elapsedMs;
  sample.frames += 1;
  if (sample.elapsedMs < FPS_REFRESH_MS) return null;
  const fps = sample.frames * 1000 / sample.elapsedMs;
  sample.elapsedMs = 0;
  sample.frames = 0;
  return fps;
}

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
