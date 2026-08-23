export const GPU_COLORS = {
  background: 0x070b13,
  panel: 0x111827,
  panelRaised: 0x162033,
  panelHover: 0x1c2940,
  border: 0x26334a,
  text: 0xe6edf7,
  muted: 0x8a96ae,
  primary: 0x6ea8ff,
  success: 0x4ade80,
  warning: 0xfbbf24,
  error: 0xf87171,
  cyan: 0x22d3ee,
  magenta: 0xe879f9,
  tiers: {
    1: 0x2dd4bf,
    2: 0xfbbf24,
    3: 0xc084fc,
  },
} as const;

export const GPU_LAYOUT = {
  /**
   * The identity band. 54, not 52: the brand crystal is 48px tall at
   * ATOMA_MARK_HEADER_SCALE and a 52px bar left it 2px of air top and bottom,
   * which read as glued to the top of the screen. Everything the header draws
   * is placed against headerHeight / 2, so this is the one number to move.
   */
  headerHeight: 54,
  /** Left inset of the brand crystal's local box in the header band. */
  headerMarkX: 20,
  /**
   * Where the wordmark starts. The crystal's hull reaches ~24.6px either side
   * of its centre at ATOMA_MARK_HEADER_SCALE, so its right edge sits near
   * x = 58.6 — this leaves it a real gap instead of the 3px the two used to
   * share. A test holds that clearance, because the gap closes silently
   * whenever the mark is scaled up and nothing moves the text.
   */
  headerWordmarkX: 70,
  /**
   * The nav rail's width. Views draw in their own viewport space starting at
   * 0; `render()` places that space at this offset. Hit targets project
   * through their live parents in `recordHitTarget`; only plain bounds need
   * an explicit translation.
   */
  sidebarWidth: 208,
  /** Narrowest the rail may become before its labels stop being legible. */
  sidebarMinWidth: 112,
  /** Preserve this much view space by shrinking the rail on narrow windows. */
  contentMinWidth: 320,
  gap: 10,
  radius: 8,
  leftMinWidth: 520,
  rightWidth: 500,
  pagePadding: 12,
  rowHeight: 46,
} as const;

/**
 * The rail gives space back before a view is pushed off-screen. This exact
 * clamp is mirrored by `--gpu-sidebar` for DOM overlays.
 */
export function sidebarWidthForViewport(viewportWidth: number): number {
  return Math.max(
    0,
    Math.min(
      viewportWidth,
      GPU_LAYOUT.sidebarWidth,
      Math.max(GPU_LAYOUT.sidebarMinWidth, viewportWidth - GPU_LAYOUT.contentMinWidth)
    )
  );
}
