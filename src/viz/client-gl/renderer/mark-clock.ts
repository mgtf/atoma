/**
 * The brand mark's inspect state: the clock the crystal reads, and whether
 * the interior bead is drawn.
 *
 * Live the clock is `performance.now()`. Pinned it is a value the welcome
 * slider or the diagnostics handle sets so a pose can be held without
 * waiting on the wall. The bead flag lets a lighting judgement look at the
 * glass without the blob sitting on it — shader lighting of the facets is
 * unchanged; only the CPU-drawn sphere (and its refraction copy) hide.
 *
 * Continue unpins and restores the bead so the header mark is not left in
 * a diagnostic state after enter. `?atomaDiag=1` exposes the same setters
 * on `__ATOMA_GPU__` for capture scripts.
 */

import {
  markElapsedMsFromTurnDegrees,
  markTurnDegreesRounded,
} from '../brand-mark.js';

let pinnedMs: number | null = null;
let beadVisible = true;

/** Elapsed ms the mark and its welcome float should read. */
export function markElapsedMs(): number {
  if (pinnedMs !== null) return pinnedMs;
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** `null` returns the clock to the wall. Non-finite values are treated as null. */
export function pinMarkElapsedMs(ms: number | null): void {
  if (ms === null || !Number.isFinite(ms)) {
    pinnedMs = null;
    return;
  }
  pinnedMs = Math.max(0, ms);
}

/** True while a capture, the welcome slider, or a test owns the clock. */
export function markClockIsPinned(): boolean {
  return pinnedMs !== null;
}

/** Integer 0..359 of the authored turn at the current clock. */
export function markTurnDegrees(): number {
  return markTurnDegreesRounded(markElapsedMs());
}

/**
 * Pin the clock at a turn angle. `null` (or non-finite) returns it to the wall.
 * 0° is the rest pose; 360 wraps to 0.
 */
export function pinMarkTurnDegrees(degrees: number | null): void {
  if (degrees === null || !Number.isFinite(degrees)) {
    pinMarkElapsedMs(null);
    return;
  }
  pinMarkElapsedMs(markElapsedMsFromTurnDegrees(degrees));
}

/** Whether the interior bead is drawn. Default on; inspect may hide it. */
export function markBeadVisible(): boolean {
  return beadVisible;
}

export function setMarkBeadVisible(visible: boolean): void {
  beadVisible = visible;
}
