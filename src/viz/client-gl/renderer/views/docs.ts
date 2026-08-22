import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { DOC_THEMES } from '../../store.js';

/**
 * Docs view: a fixed left list of themes and, on the right, one short
 * product-facing paragraph per theme plus a pointer to the AGENTS.md file
 * that holds its real contract. Purely static prose — no query, no loading
 * state — so every theme is offered regardless of `visibleViews` gating;
 * describing a feature is not the same as exposing its data.
 */

const THEME_ROW_HEIGHT = 38;
const TITLE_Y = 22;
const BODY_Y = 64;

export function drawDocs(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const x = GPU_LAYOUT.gap;
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const leftWidth = Math.min(240, width * 0.32);
  const panelHeight = height - top - GPU_LAYOUT.gap;

  ctx.panel(
    ctx.root,
    x,
    top,
    leftWidth,
    panelHeight,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(ctx.root, snapshot.t('nav.docs'), x + 16, top + 14, { size: 16, weight: '700' });
  const intro = ctx.text(ctx.root, snapshot.t('docs.intro'), x + 16, top + 40, {
    size: 10,
    color: GPU_COLORS.muted,
    width: leftWidth - 32,
  });

  const selected = snapshot.state.selectedDocsTheme;
  let rowY = top + 40 + intro.height + 16;
  for (const theme of DOC_THEMES) {
    ctx.button(
      ctx.root,
      `docs.theme.${theme.key}`,
      'button',
      snapshot.t(`docs.theme.${theme.key}.title`),
      x + 12,
      rowY,
      leftWidth - 24,
      32,
      selected === theme.key,
      snapshot.onActivate
    );
    rowY += THEME_ROW_HEIGHT;
  }

  const rightX = x + leftWidth + GPU_LAYOUT.gap;
  const rightWidth = width - rightX - GPU_LAYOUT.gap;
  ctx.panel(
    ctx.root,
    rightX,
    top,
    rightWidth,
    panelHeight,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );

  const active = DOC_THEMES.find((theme) => theme.key === selected) ?? DOC_THEMES[0]!;
  const innerX = 22;
  const innerWidth = rightWidth - innerX * 2;
  const pane = createScrollPane(ctx.root, {
    x: rightX,
    y: top,
    width: rightWidth,
    height: panelHeight,
    scrollY: snapshot.state.scrollY.docs,
    bottomPadding: 24,
  });
  ctx.text(pane.content, snapshot.t(`docs.theme.${active.key}.title`), innerX, TITLE_Y, {
    size: 18,
    weight: '700',
  });
  const body = ctx.text(pane.content, snapshot.t(`docs.theme.${active.key}.body`), innerX, BODY_Y, {
    size: 13,
    width: innerWidth,
  });
  const refY = BODY_Y + body.height + 28;
  ctx.text(pane.content, `${snapshot.t('docs.refLabel')} ${active.ref}`, innerX, refY, {
    size: 10,
    mono: true,
    color: GPU_COLORS.muted,
    width: innerWidth,
  });
  pane.extend(refY + 24);
  ctx.scrollMax.docs = pane.finish();
}
