import type { RendererCtx } from '../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../theme.js';

/**
 * THE COLUMN FRAME — one definition of what a view's central column looks
 * like, and where its title and content sit inside it.
 *
 * The app had grown two conventions: Registry, Skills, Docs and Runs framed
 * their column and put the view title INSIDE it, while Projects, Admin,
 * Settings and Burn-in left the title floating at y = 78 over the page and
 * framed only their content. Same product, two ideas of what a surface is.
 * Everything now reads from here, so a third convention cannot appear by
 * being written down somewhere else.
 *
 * `.gpu-project-form` and `.gpu-settings-form` are DOM overlays that sit
 * INSIDE a frame, so they restate these numbers in CSS; tests hold the two
 * sides together.
 */

/** Inset from the frame's own edge to its content. */
export const VIEW_FRAME_PAD = 16;
/** Title baseline, measured from the frame's top. */
export const VIEW_FRAME_TITLE_Y = 14;
export const VIEW_FRAME_TITLE_SIZE = 16;
/** Where content clears the title, measured from the frame's top. */
export const VIEW_FRAME_CONTENT_TOP = 46;
/** How far the subtitle sits from the title's own left edge. */
const SUBTITLE_X = 200;
/** Narrow columns: the gap between the measured title and its subtitle. */
const SUBTITLE_TITLE_GAP = 12;

export interface ViewFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Left edge of content inside the frame. */
  readonly innerX: number;
  readonly innerWidth: number;
  /** Absolute y where content starts, below the title. */
  readonly contentTop: number;
  /** Absolute y of the frame's bottom edge. */
  readonly bottom: number;
}

export interface ViewFrameGutterRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Chrome wash behind the overview frame's header/rail seam.
 *
 * Focus crops the horizontal header out of the composition, so it has no seam
 * to bridge. Keeping this L-shaped wash there leaves its translucent vertical
 * leg visible through the frame's rounded top-left corner.
 */
export function viewFrameGutterRects(
  focused: boolean,
  contentWidth: number,
  layoutHeight: number
): ViewFrameGutterRect[] {
  if (focused) return [];
  const frameTop = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  return [
    {
      x: 0,
      y: GPU_LAYOUT.headerHeight,
      width: contentWidth,
      height: GPU_LAYOUT.gap,
    },
    {
      x: 0,
      y: frameTop,
      width: GPU_LAYOUT.gap,
      height: Math.max(0, layoutHeight - frameTop),
    },
  ];
}

/**
 * Geometry only, so a layout can be asserted without a GPU.
 *
 * `columnWidth` caps a view that reads better as a centred column (Settings)
 * than as a full-bleed one; omit it and the frame spans the viewport inside
 * the standard gap, which is what the list/detail views do.
 */
export function viewFrame(
  viewportWidth: number,
  viewportHeight: number,
  columnWidth?: number
): ViewFrame {
  const y = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const available = viewportWidth - GPU_LAYOUT.gap * 2;
  const width = Math.max(0, Math.min(columnWidth ?? available, available));
  const height = Math.max(0, viewportHeight - y - GPU_LAYOUT.gap);
  const x = (viewportWidth - width) / 2;
  return {
    x,
    y,
    width,
    height,
    innerX: x + VIEW_FRAME_PAD,
    innerWidth: Math.max(0, width - VIEW_FRAME_PAD * 2),
    contentTop: y + VIEW_FRAME_CONTENT_TOP,
    bottom: y + height,
  };
}

/** Draw the frame, its title, and an optional muted subtitle beside it. */
export function drawViewFrame(
  ctx: RendererCtx,
  frame: ViewFrame,
  title: string,
  subtitle?: string
): void {
  const surface = ctx.panel(
    ctx.root,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  surface.label = 'view-frame-primary';
  const titleStyle = {
    size: VIEW_FRAME_TITLE_SIZE,
    weight: '700',
  } as const;
  const fittedTitle = ctx.fitText(title, frame.innerWidth, titleStyle);
  ctx.text(ctx.root, fittedTitle, frame.innerX, frame.y + VIEW_FRAME_TITLE_Y, {
    ...titleStyle,
    width: frame.innerWidth,
    singleLine: true,
  });
  if (subtitle) {
    const subtitleY = frame.y + VIEW_FRAME_TITLE_Y + 5;
    const subtitleStyle = { size: 11, color: GPU_COLORS.muted } as const;
    // A narrow column (a phone) keeps the subtitle ON THE TITLE LINE, measured
    // from the title's own width and ellipsised to what is left. It used to
    // stack under the title, which put it exactly where
    // `VIEW_FRAME_CONTENT_TOP` starts the content — and the DOM project form
    // sits there, so the count was drawn under the form (2026-09-15).
    const titleWidth = ctx.measureText(fittedTitle, titleStyle);
    const subtitleX = frame.innerX + Math.max(
      titleWidth + SUBTITLE_TITLE_GAP,
      frame.innerWidth >= SUBTITLE_X + 100 ? SUBTITLE_X : 0
    );
    const available = Math.max(0, frame.innerX + frame.innerWidth - subtitleX);
    if (available === 0) return;
    ctx.text(
      ctx.root,
      ctx.fitText(subtitle, available, subtitleStyle),
      subtitleX,
      subtitleY,
      { ...subtitleStyle, width: available, singleLine: true }
    );
  }
}
