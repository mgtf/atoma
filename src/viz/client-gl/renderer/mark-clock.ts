/**
 * The brand mark's clock. Live it is `performance.now()`; pinned it is a value
 * the diagnostics handle sets so a capture script can step a full turn at
 * 250 ms without waiting on the wall.
 *
 * Pinning is inert unless something calls `pinMarkElapsedMs`. The product
 * never does: only `?atomaDiag=1` exposes the setter on `__ATOMA_GPU__`.
 */

let pinnedMs: number | null = null;

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

/** True while a capture (or a test) owns the clock. */
export function markClockIsPinned(): boolean {
  return pinnedMs !== null;
}
