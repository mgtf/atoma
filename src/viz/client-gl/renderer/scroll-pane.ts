import { Container, Graphics } from 'pixi.js';
import { GPU_COLORS } from '../theme.js';

/**
 * A bounded, masked scroll region — THE way a GPU view presents content that
 * can exceed its panel. Drawing without a mask leaks scrolled content over
 * neighbouring panels and headers; scrolling without a reported max lets the
 * wheel run into the void. Both were observed on Registry/Skills and the
 * detail panes in the 2026-08-14 review; this pane is the one shared fix.
 *
 * Contract: draw into `content` using pane-local coordinates (0,0 = pane
 * top-left at scroll 0). The pane positions the layer, applies the
 * caller-owned scrollY, and masks to the pane rect on `finish()`. Cull by
 * SKIPPING draws outside [scrollY - margin, scrollY + height + margin] while
 * still advancing your layout cursor, then `extend(bottomY)` with the full
 * content bottom — the returned max scroll must reflect content that was
 * culled, or the wheel can never reach it. `finish()` also draws the shared
 * scrollbar thumb when the content overflows, so every pane advertises that
 * it scrolls without per-view code.
 */
export interface ScrollPaneOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Current scroll offset — state-owned; the pane only applies it. */
  scrollY: number;
  /** Extra space kept below the last content row (default 12). */
  bottomPadding?: number;
}

export interface ScrollPane {
  /** Draw here in pane-local coordinates. */
  readonly content: Container;
  readonly width: number;
  readonly height: number;
  readonly scrollY: number;
  /** True when a row spanning [topY, bottomY] pane-local is worth drawing. */
  visible(topY: number, bottomY: number): boolean;
  /** Record content extending down to this pane-local Y (culled or not). */
  extend(bottomY: number): void;
  /** Apply the mask and return the clamped max scroll for the wheel handler. */
  finish(): number;
}

const CULL_MARGIN = 48;

/**
 * THE scrollbar-thumb definition, shared by every scrollable region: scroll
 * panes (drawn automatically by `finish()`), the runs event-detail layer and
 * the run-picker popup. `x`/`width` describe the region the bar belongs to —
 * the 3px track hugs its right edge, 8px in, spanning `y` to `y + height`.
 * The thumb length is the region's visible share of the content and its ride
 * follows `scrollY / maxScroll` (clamped: state-owned offsets may overshoot
 * for one frame). No-ops when nothing scrolls, so callers invoke it
 * unconditionally. Geometry/styling are the runs view's original thumb
 * (2026-08-15 review residual: one definition, and Registry/Skills/detail
 * panes had none).
 */
export interface ScrollbarThumbOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollY: number;
  maxScroll: number;
}

export function drawScrollbarThumb(parent: Container, options: ScrollbarThumbOptions): void {
  const { x, y, width, height, maxScroll } = options;
  if (maxScroll <= 0 || height <= 0) return;
  const thumbHeight = Math.max(28, height * Math.min(1, height / (height + maxScroll)));
  const ratio = Math.min(1, Math.max(0, options.scrollY / maxScroll));
  const thumbY = y + (height - thumbHeight) * ratio;
  const scrollbar = new Graphics();
  scrollbar.roundRect(x + width - 8, y, 3, height, 2);
  scrollbar.fill({ color: GPU_COLORS.border, alpha: 0.55 });
  scrollbar.roundRect(x + width - 8, thumbY, 3, thumbHeight, 2);
  scrollbar.fill({ color: GPU_COLORS.primary, alpha: 0.9 });
  scrollbar.label = 'scrollbar-thumb';
  scrollbar.eventMode = 'none';
  parent.addChild(scrollbar);
}

export function createScrollPane(parent: Container, options: ScrollPaneOptions): ScrollPane {
  const { x, y, scrollY } = options;
  const width = Math.max(0, options.width);
  const height = Math.max(0, options.height);
  const bottomPadding = options.bottomPadding ?? 12;
  const layer = new Container();
  layer.position.set(x, y);
  const content = new Container();
  content.position.set(0, -scrollY);
  layer.addChild(content);
  parent.addChild(layer);
  let contentBottom = 0;
  let finished = false;
  return {
    content,
    width,
    height,
    scrollY,
    visible(topY: number, bottomY: number) {
      return bottomY >= scrollY - CULL_MARGIN && topY <= scrollY + height + CULL_MARGIN;
    },
    extend(bottomY: number) {
      contentBottom = Math.max(contentBottom, bottomY);
    },
    finish() {
      if (finished) return Math.max(0, contentBottom + bottomPadding - height);
      finished = true;
      const mask = new Graphics();
      mask.rect(x, y, width, height).fill(0xffffff);
      mask.eventMode = 'none';
      parent.addChild(mask);
      layer.mask = mask;
      const maxScroll = Math.max(0, contentBottom + bottomPadding - height);
      drawScrollbarThumb(parent, { x, y, width, height, scrollY, maxScroll });
      return maxScroll;
    },
  };
}
