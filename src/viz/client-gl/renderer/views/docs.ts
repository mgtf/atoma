import { Container, Graphics } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import {
  DOC_PAGES,
  DOC_THEMES,
  type DocCardSpec,
  type DocsThemeKey,
  type DocTone,
} from '../../docs-content.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * End-user field guide. It documents the member journey rather than mirroring
 * implementation or platform-admin surfaces: scope work in a project, brief
 * one run, inspect its evidence, and make the human hand-off decision.
 */

const NAV_WIDTH = 264;
const NAV_MIN_WIDTH = 208;
const NAV_MAX_SHARE = 0.31;
const NAV_ROW_HEIGHT = 38;
const NAV_BUTTON_HEIGHT = 32;
const NAV_STACKED_COLUMNS = 2;
const STACKED_BREAKPOINT = 720;
const CONTENT_MAX_WIDTH = 1_060;
const CONTENT_PAD = 28;
const CONTENT_PAD_COMPACT = 18;
const CONTENT_MIN_HEIGHT = 112;
const CARD_GAP = 12;
const CARD_PAD = 16;
const CARD_MIN_HEIGHT = 116;
const SECTION_GAP = 30;

const TONE_COLORS: Readonly<Record<DocTone, number>> = {
  primary: GPU_COLORS.primary,
  cyan: GPU_COLORS.cyan,
  success: GPU_COLORS.success,
  warning: GPU_COLORS.warning,
  error: GPU_COLORS.error,
  muted: GPU_COLORS.muted,
  tier1: GPU_COLORS.tiers[1],
  tier2: GPU_COLORS.tiers[2],
  tier3: GPU_COLORS.tiers[3],
  magenta: GPU_COLORS.magenta,
};

interface DocsPanelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DocsViewLayout {
  readonly stacked: boolean;
  readonly navigation: DocsPanelRect;
  readonly content: DocsPanelRect;
}

/**
 * The split guide becomes a stacked topic index + article on a narrow content
 * column. The index height is measured by its renderer, so translated copy can
 * grow without painting through the article below it.
 */
export function docsViewLayout(
  width: number,
  height: number,
  measuredNavigationHeight: number
): DocsViewLayout {
  const x = GPU_LAYOUT.gap;
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const panelHeight = Math.max(0, height - top - GPU_LAYOUT.gap);
  const availableWidth = Math.max(0, width - GPU_LAYOUT.gap * 2);
  const stacked = width < STACKED_BREAKPOINT;

  if (stacked) {
    const maximumNavigationHeight = Math.max(
      0,
      panelHeight - GPU_LAYOUT.gap - CONTENT_MIN_HEIGHT
    );
    const navigationHeight = Math.min(measuredNavigationHeight, maximumNavigationHeight);
    const contentY = top + navigationHeight + GPU_LAYOUT.gap;
    return {
      stacked,
      navigation: { x, y: top, width: availableWidth, height: navigationHeight },
      content: {
        x,
        y: contentY,
        width: availableWidth,
        height: Math.max(0, height - contentY - GPU_LAYOUT.gap),
      },
    };
  }

  const navigationWidth = Math.min(
    NAV_WIDTH,
    Math.max(NAV_MIN_WIDTH, availableWidth * NAV_MAX_SHARE)
  );
  const contentX = x + navigationWidth + GPU_LAYOUT.gap;
  return {
    stacked,
    navigation: { x, y: top, width: navigationWidth, height: panelHeight },
    content: {
      x: contentX,
      y: top,
      width: Math.max(0, width - contentX - GPU_LAYOUT.gap),
      height: panelHeight,
    },
  };
}

interface MeasuredNavigation {
  readonly layer: Container;
  readonly requiredHeight: number;
}

function drawNavigationCopy(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  stacked: boolean,
  verticallyCondensed: boolean,
  originX: number,
  originY: number
): MeasuredNavigation {
  const layer = new Container();
  // Position BEFORE creating controls: recordHitTarget projects through the
  // live parent immediately and must never observe a later reparent/offset.
  layer.position.set(originX, originY);
  const innerWidth = Math.max(0, width - 32);
  ctx.text(layer, snapshot.t('nav.docs'), 16, 14, { size: 16, weight: '700' });
  const audience = verticallyCondensed
    ? null
    : ctx.text(layer, snapshot.t('docs.user.audience'), 16, 41, {
        size: 9,
        weight: '700',
        color: GPU_COLORS.primary,
        width: innerWidth,
      });
  const introY = audience ? 41 + audience.height + 6 : 38;
  const intro = verticallyCondensed
    ? null
    : ctx.text(layer, snapshot.t('docs.user.intro'), 16, introY, {
        size: 10,
        color: GPU_COLORS.muted,
        width: innerWidth,
      });

  const columns = stacked ? NAV_STACKED_COLUMNS : 1;
  const columnGap = 8;
  const buttonWidth = Math.max(0, (innerWidth - columnGap * (columns - 1)) / columns);
  const rowStart = intro
    ? introY + intro.height + 16
    : introY + 10;
  for (const [index, theme] of DOC_THEMES.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    ctx.button(
      layer,
      `docs.theme.${theme.key}`,
      'button',
      snapshot.t(theme.navKey),
      16 + column * (buttonWidth + columnGap),
      rowStart + row * NAV_ROW_HEIGHT,
      buttonWidth,
      NAV_BUTTON_HEIGHT,
      snapshot.state.selectedDocsTheme === theme.key,
      snapshot.onActivate
    );
  }

  const rows = Math.ceil(DOC_THEMES.length / columns);
  return {
    layer,
    requiredHeight:
      rowStart + rows * NAV_ROW_HEIGHT - (NAV_ROW_HEIGHT - NAV_BUTTON_HEIGHT) + 16,
  };
}

function sectionColumns(width: number, maximum: number): number {
  if (maximum <= 1 || width < 460) return 1;
  if (width < 720) return Math.min(2, maximum);
  return maximum;
}

interface CardMeasurement {
  readonly x: number;
  readonly width: number;
  readonly accent: number;
}

function drawCardGrid(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  parent: Container,
  cards: readonly DocCardSpec[],
  x: number,
  y: number,
  width: number,
  maximumColumns: number,
  flow: boolean
): number {
  const columns = sectionColumns(width, maximumColumns);
  const cardWidth = Math.max(0, (width - CARD_GAP * (columns - 1)) / columns);
  const background = new Container();
  const connectors = new Container();
  const foreground = new Container();
  parent.addChild(background, connectors, foreground);

  let cursor = y;
  for (let rowStart = 0; rowStart < cards.length; rowStart += columns) {
    const rowCards = cards.slice(rowStart, rowStart + columns);
    const measurements: CardMeasurement[] = [];
    let rowHeight = CARD_MIN_HEIGHT;

    rowCards.forEach((card, column) => {
      const cardX = x + column * (cardWidth + CARD_GAP);
      const accent = TONE_COLORS[card.tone];
      let textY = cursor + CARD_PAD;
      if (card.tagKey) {
        const tag = ctx.text(foreground, snapshot.t(card.tagKey), cardX + CARD_PAD, textY, {
          size: 9,
          weight: '700',
          color: accent,
          width: Math.max(0, cardWidth - CARD_PAD * 2),
        });
        textY += tag.height + 7;
      }
      const title = ctx.text(
        foreground,
        snapshot.t(card.titleKey),
        cardX + CARD_PAD,
        textY,
        {
          size: 13,
          weight: '700',
          width: Math.max(0, cardWidth - CARD_PAD * 2),
        }
      );
      textY += title.height + 9;
      const body = ctx.text(
        foreground,
        snapshot.t(card.bodyKey),
        cardX + CARD_PAD,
        textY,
        {
          size: 11,
          color: GPU_COLORS.muted,
          width: Math.max(0, cardWidth - CARD_PAD * 2),
        }
      );
      rowHeight = Math.max(
        rowHeight,
        textY + body.height + CARD_PAD - cursor
      );
      measurements.push({ x: cardX, width: cardWidth, accent });
    });

    for (const measurement of measurements) {
      ctx.panel(
        background,
        measurement.x,
        cursor,
        measurement.width,
        rowHeight,
        GPU_COLORS.panelRaised,
        GPU_COLORS.border,
        GPU_LAYOUT.radius,
        2
      );
      const accent = new Graphics();
      accent.roundRect(measurement.x, cursor + 14, 3, Math.max(12, rowHeight - 28), 2);
      accent.fill({ color: measurement.accent, alpha: 0.88 });
      accent.eventMode = 'none';
      background.addChild(accent);
    }

    // The connective rail is intentionally direction-neutral. Numbered tags
    // carry order without drawing an LTR-only arrow into Arabic and Urdu.
    if (flow && measurements.length > 1) {
      const rail = new Graphics();
      const railY = cursor + Math.min(30, rowHeight / 2);
      for (let index = 0; index < measurements.length - 1; index += 1) {
        const current = measurements[index]!;
        const next = measurements[index + 1]!;
        rail.moveTo(current.x + current.width + 2, railY);
        rail.lineTo(next.x - 2, railY);
        rail.stroke({ color: GPU_COLORS.primary, width: 1.5, alpha: 0.5 });
      }
      rail.eventMode = 'none';
      connectors.addChild(rail);
    }

    cursor += rowHeight + CARD_GAP;
  }

  return cursor - CARD_GAP;
}

function drawArticle(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  rect: DocsPanelRect,
  active: DocsThemeKey
): void {
  const pane = createScrollPane(ctx.root, {
    ...rect,
    scrollY: snapshot.state.scrollY.docs,
    bottomPadding: 30,
  });
  const compact = rect.width < 600;
  const horizontalPad = compact ? CONTENT_PAD_COMPACT : CONTENT_PAD;
  const articleWidth = Math.max(
    0,
    Math.min(CONTENT_MAX_WIDTH, rect.width - horizontalPad * 2)
  );
  const x = Math.max(horizontalPad, (rect.width - articleWidth) / 2);
  const page = DOC_PAGES[active];
  let cursor = 24;

  const eyebrow = ctx.text(pane.content, snapshot.t(page.eyebrowKey), x, cursor, {
    size: 9,
    weight: '700',
    color: GPU_COLORS.primary,
    width: articleWidth,
  });
  cursor += eyebrow.height + 8;
  const title = ctx.text(pane.content, snapshot.t(page.titleKey), x, cursor, {
    size: compact ? 19 : 22,
    weight: '700',
    width: articleWidth,
  });
  cursor += title.height + 12;
  const lede = ctx.text(pane.content, snapshot.t(page.ledeKey), x, cursor, {
    size: 12,
    color: GPU_COLORS.muted,
    width: articleWidth,
  });
  cursor += lede.height + 22;

  const divider = new Graphics();
  divider.moveTo(x, cursor);
  divider.lineTo(x + articleWidth, cursor);
  divider.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.75 });
  divider.eventMode = 'none';
  pane.content.addChild(divider);
  cursor += 24;

  for (const section of page.sections) {
    const heading = ctx.text(pane.content, snapshot.t(section.titleKey), x, cursor, {
      size: 14,
      weight: '700',
      width: articleWidth,
    });
    cursor += heading.height + 8;
    if (section.introKey) {
      const intro = ctx.text(pane.content, snapshot.t(section.introKey), x, cursor, {
        size: 11,
        color: GPU_COLORS.muted,
        width: articleWidth,
      });
      cursor += intro.height + 14;
    } else {
      cursor += 6;
    }
    cursor = drawCardGrid(
      ctx,
      snapshot,
      pane.content,
      section.cards,
      x,
      cursor,
      articleWidth,
      section.maxColumns,
      section.flow === true
    );
    cursor += SECTION_GAP;
  }

  pane.extend(cursor);
  ctx.scrollMax.docs = pane.finish();
}

export function drawDocs(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const stacked = width < STACKED_BREAKPOINT;
  const availableWidth = Math.max(0, width - GPU_LAYOUT.gap * 2);
  const navigationWidth = stacked
    ? availableWidth
    : Math.min(NAV_WIDTH, Math.max(NAV_MIN_WIDTH, availableWidth * NAV_MAX_SHARE));
  const navigation = drawNavigationCopy(
    ctx,
    snapshot,
    navigationWidth,
    stacked,
    stacked && height < 600,
    GPU_LAYOUT.gap,
    GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap
  );
  const layout = docsViewLayout(width, height, navigation.requiredHeight);

  const navigationBackground = new Container();
  ctx.root.addChild(navigationBackground);
  ctx.panel(
    navigationBackground,
    layout.navigation.x,
    layout.navigation.y,
    layout.navigation.width,
    layout.navigation.height,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  const navigationMask = new Graphics();
  navigationMask.rect(
    layout.navigation.x,
    layout.navigation.y,
    layout.navigation.width,
    layout.navigation.height
  );
  navigationMask.fill(0xffffff);
  navigationMask.eventMode = 'none';
  ctx.root.addChild(navigation.layer, navigationMask);
  navigation.layer.mask = navigationMask;

  ctx.panel(
    ctx.root,
    layout.content.x,
    layout.content.y,
    layout.content.width,
    layout.content.height,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );

  const selected = snapshot.state.selectedDocsTheme;
  const active = DOC_THEMES.some((theme) => theme.key === selected)
    ? selected
    : DOC_THEMES[0]!.key;
  drawArticle(ctx, snapshot, layout.content, active);
}
