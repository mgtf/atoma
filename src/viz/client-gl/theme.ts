/** Supersample cached glyphs, not the full scene's MSAA/filter targets. */
export function gpuTextRasterOptions() {
  const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  return {
    resolution: Math.min(4, Math.max(2, ratio * 2)),
    roundPixels: true,
  };
}

export const GPU_COLORS = {
  background: 0x0d1726,
  panel: 0x182941,
  panelRaised: 0x223754,
  panelHover: 0x2b4668,
  border: 0x426386,
  text: 0xe6edf7,
  /**
   * Secondary text. Was 0x8a96ae: about 5.5:1 against the card fills, which
   * passes the WCAG bar for BODY copy and misses badly for what this token is
   * actually spent on — 8 and 9px facts lines, the densest and most-read text
   * in the client (owner report, 2026-09-21: "le gris du texte est
   * illisible"). 0xa8b4cc lifts that to ~7.9:1 while staying clearly below
   * `text`, so the two-level hierarchy this token exists for survives.
   */
  muted: 0xa8b4cc,
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
   * The overview utility band. A 34px account orb keeps 7px of air above and
   * below; the brand now owns a larger, independent slot in the left rail.
   */
  headerHeight: 48,
  /**
   * Focus has no horizontal header, but its camera crop and compact rail were
   * composed against the former 54px top inset. Keep that endpoint stable
   * while the overview header becomes shorter.
   */
  focusTopInset: 54,
  /**
   * The nav rail's width. Views draw in their own viewport space starting at
   * 0; `render()` places that space at this offset. Hit targets project
   * through their live parents in `recordHitTarget`; only plain bounds need
   * an explicit translation.
   */
  sidebarWidth: 208,
  /** Destination surface kept at the trailing edge of the focused crop. */
  sidebarFocusButtonWidth: 44,
  /** Narrowest the rail may become before its labels stop being legible. */
  sidebarMinWidth: 112,
  /**
   * The rail a phone gets: one icon tile plus its pad, with no label column
   * at all. Below the labelled floor a label had 20px to live in and rendered
   * as an ellipsis, so the rail drops labels rather than clipping them.
   */
  sidebarCompactWidth: 56,
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
export function sidebarWidthForViewport(
  viewportWidth: number
): number {
  if (sidebarIsCompactForViewport(viewportWidth)) {
    return Math.max(0, Math.min(viewportWidth, GPU_LAYOUT.sidebarCompactWidth));
  }
  return Math.max(
    0,
    Math.min(
      viewportWidth,
      GPU_LAYOUT.sidebarWidth,
      Math.max(GPU_LAYOUT.sidebarMinWidth, viewportWidth - GPU_LAYOUT.contentMinWidth)
    )
  );
}

/**
 * The widest viewport that cannot hold BOTH the labelled rail at its floor
 * and the content minimum. From here down the rail is icon tiles only, in
 * overview as well as focus; `--gpu-sidebar`'s media query mirrors this
 * exact boundary.
 */
export const SIDEBAR_COMPACT_MAX_VIEWPORT =
  GPU_LAYOUT.sidebarMinWidth + GPU_LAYOUT.contentMinWidth - 1;

/** A phone-width viewport: the rail shows icons, never a clipped label. */
export function sidebarIsCompactForViewport(viewportWidth: number): boolean {
  return viewportWidth <= SIDEBAR_COMPACT_MAX_VIEWPORT;
}
