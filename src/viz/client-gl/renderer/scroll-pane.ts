import { Container, Graphics } from 'pixi.js';

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
 * culled, or the wheel can never reach it.
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
      return Math.max(0, contentBottom + bottomPadding - height);
    },
  };
}
