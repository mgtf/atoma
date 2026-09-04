import { Graphics, Rectangle } from 'pixi.js';
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '../../../../contracts/locales.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';

const EDGE = 12;
const PANEL_WIDTH = 224;
const PANEL_PAD = 8;
const ITEM_HEIGHT = 28;
const ITEM_GAP = 6;
const ANCHOR_GAP = 6;

export interface LocaleMenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LocaleMenuLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a panel of the given size sits beside its anchor: opening away from
 * the nearest viewport edge, below the control when the panel fits there, and
 * always clamped fully on screen. ONE resolution for every chrome menu that
 * anchors to a control living in either the header band or the focus rail —
 * the locale picker and the notification tray must not each reinvent it.
 */
export function anchoredMenuPosition(
  viewportWidth: number,
  viewportHeight: number,
  anchor: LocaleMenuAnchor,
  width: number,
  height: number
): { x: number; y: number } {
  const opensRight = anchor.x + anchor.width / 2 < viewportWidth / 2;
  const preferredX = opensRight
    ? anchor.x + anchor.width + ANCHOR_GAP
    : anchor.x + anchor.width - width;
  const opensDown = anchor.y + anchor.height + ANCHOR_GAP + height <= viewportHeight - EDGE;
  const preferredY = opensDown
    ? anchor.y + anchor.height + ANCHOR_GAP
    : anchor.y - height - ANCHOR_GAP;
  return {
    x: Math.min(Math.max(EDGE, preferredX), Math.max(EDGE, viewportWidth - width - EDGE)),
    y: Math.min(Math.max(EDGE, preferredY), Math.max(EDGE, viewportHeight - height - EDGE)),
  };
}

/** Anchor beside a rail control, opening away from the nearest viewport edge. */
export function localeMenuLayout(
  viewportWidth: number,
  viewportHeight: number,
  anchor: LocaleMenuAnchor
): LocaleMenuLayout {
  const width = Math.min(PANEL_WIDTH, Math.max(180, viewportWidth - EDGE * 2));
  const height = SUPPORTED_LOCALES.length * ITEM_HEIGHT +
    Math.max(0, SUPPORTED_LOCALES.length - 1) * ITEM_GAP +
    PANEL_PAD * 2;
  return {
    ...anchoredMenuPosition(viewportWidth, viewportHeight, anchor, width, height),
    width,
    height,
  };
}

export function drawLocaleMenu(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  viewportWidth: number,
  viewportHeight: number,
  anchor: LocaleMenuAnchor
): void {
  if (!snapshot.state.localeMenuOpen) return;
  const layout = localeMenuLayout(viewportWidth, viewportHeight, anchor);

  const scrim = new Graphics();
  scrim.rect(0, 0, viewportWidth, viewportHeight);
  scrim.fill({ color: 0x050810, alpha: 0.2 });
  scrim.eventMode = 'static';
  scrim.cursor = 'default';
  scrim.hitArea = new Rectangle(0, 0, viewportWidth, viewportHeight);
  scrim.on('pointertap', () => snapshot.onActivate('locale.menu.close'));
  ctx.root.addChild(scrim);

  ctx.panel(
    ctx.root,
    layout.x,
    layout.y,
    layout.width,
    layout.height,
    GPU_COLORS.panel,
    GPU_COLORS.primary,
    GPU_LAYOUT.radius,
    2
  );

  for (const [index, locale] of SUPPORTED_LOCALES.entries()) {
    ctx.button(
      ctx.root,
      `locale.select.${locale}`,
      'menuitemradio',
      LOCALE_NAMES[locale],
      layout.x + PANEL_PAD,
      layout.y + PANEL_PAD + index * (ITEM_HEIGHT + ITEM_GAP),
      layout.width - PANEL_PAD * 2,
      ITEM_HEIGHT,
      locale === snapshot.state.locale,
      snapshot.onActivate,
      GPU_COLORS.primary
    );
  }
}
