/**
 * "A handheld device" is ONE question asked in ONE place, the way reduced
 * motion is (`renderer/motion.ts`). The arrival gate, the store and the DOM
 * mirror all consult this helper; none of them reaches for `matchMedia`,
 * `navigator.userAgent` or a viewport width on its own.
 *
 * The predicate is pointer CAPABILITY, not screen size: a phone held sideways
 * is still a phone, and a narrow desktop window is still a desktop. A device
 * whose every pointer is coarse and none of them can hover is a phone or a
 * tablet without a trackpad; a touch laptop keeps its mouse and passes.
 *
 * Used for mobile layout only; authentication and entry are shared with desktop.
 * `?atomaHandheld=1` lets a desktop rehearse the mobile layout.
 */

const HANDHELD_QUERY = '(any-pointer: coarse) and (any-hover: none)';

let overrideForTests: boolean | null = null;
/** Cached once: MediaQueryList.matches stays live, so repeated reads are cheap. */
let mediaQuery: MediaQueryList | null | undefined;

/**
 * Force the answer in tests (true/false); null returns to the media query and
 * drops the cached list so a stubbed `matchMedia` is consulted afresh.
 */
export function setHandheldOverrideForTests(value: boolean | null): void {
  overrideForTests = value;
  mediaQuery = undefined;
}

/** The live media query, for a caller that wants to subscribe to its changes. */
export function handheldMediaQuery(): MediaQueryList | null {
  if (mediaQuery === undefined) {
    mediaQuery =
      typeof matchMedia === 'undefined' ? null : matchMedia(HANDHELD_QUERY);
  }
  return mediaQuery;
}

/** `?atomaHandheld=1` (or `true`): rehearse the handheld gate on a desktop. */
export function handheldQueryOverride(
  search = typeof location === 'undefined' ? '' : location.search
): boolean {
  const value = new URLSearchParams(search).get('atomaHandheld');
  return value === '1' || value?.trim().toLowerCase() === 'true';
}

export function isHandheldDevice(): boolean {
  if (overrideForTests !== null) return overrideForTests;
  if (handheldQueryOverride()) return true;
  return handheldMediaQuery()?.matches ?? false;
}
