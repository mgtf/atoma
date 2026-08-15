/**
 * Reduced-motion is one question asked in one place. Every animation system
 * in the GPU client — entrance tweens, dissolves, view transitions,
 * pointer-light smoothing, shader time, chart sweeps — must consult this
 * helper instead of reaching for matchMedia itself: the 2026-08-14 review
 * found exactly one of eight systems honoring the preference.
 *
 * Under reduced motion an animation does not slow down or shrink — it jumps
 * to its final state. The information (what appeared, what left, what is
 * selected) must survive; only the motion goes.
 */

let overrideForTests: boolean | null = null;
/** Cached once: MediaQueryList.matches stays live, so per-frame reads are cheap. */
let mediaQuery: MediaQueryList | null | undefined;

/** Force the preference in tests (true/false); null returns to the media query. */
export function setReducedMotionOverrideForTests(value: boolean | null): void {
  overrideForTests = value;
}

export function prefersReducedMotion(): boolean {
  if (overrideForTests !== null) return overrideForTests;
  if (mediaQuery === undefined) {
    mediaQuery =
      typeof matchMedia === 'undefined'
        ? null
        : matchMedia('(prefers-reduced-motion: reduce)');
  }
  return mediaQuery?.matches ?? false;
}
