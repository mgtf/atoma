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

/**
 * Geometry only, so a layout can be asserted without a GPU.
 *
 * `columnWidth` caps a view that reads better as a centred column (Projects,
 * Admin, Settings) than as a full-bleed one; omit it and the frame spans the
 * viewport inside the standard gap, which is what the list/detail views do.
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
  ctx.panel(
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
  ctx.text(ctx.root, title, frame.innerX, frame.y + VIEW_FRAME_TITLE_Y, {
    size: VIEW_FRAME_TITLE_SIZE,
    weight: '700',
  });
  if (subtitle) {
    const compact = frame.innerWidth < SUBTITLE_X + 100;
    ctx.text(
      ctx.root,
      subtitle,
      compact ? frame.innerX : frame.innerX + SUBTITLE_X,
      frame.y + VIEW_FRAME_TITLE_Y + (compact ? 22 : 5),
      {
        size: 11,
        color: GPU_COLORS.muted,
        width: compact ? frame.innerWidth : Math.max(0, frame.innerWidth - SUBTITLE_X),
      }
    );
  }
}
