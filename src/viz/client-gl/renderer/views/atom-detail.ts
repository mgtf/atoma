import { Rectangle } from 'pixi.js';
import type { RegistryType } from '../../../client/types.js';
import { taxonomyForTier } from '../../../../core/taxonomy.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * Right-pane agent detail — ONE definition, shared by the Registry view and
 * the Runs view's atom selection. Name, counters and description stay fixed;
 * the system prompt (up to 5000 chars) scrolls inside a masked pane driven by
 * the shared detail wheel route, so its tail is reachable instead of silently
 * overflowing the panel (2026-08-14 review).
 */
export function drawAtomDetail(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  atom: RegistryType,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const taxonomy = taxonomyForTier(atom.tier as 1 | 2 | 3);
  ctx.text(ctx.root, atom.name, x + 18, y + 16, { size: 16, weight: '700' });
  ctx.text(ctx.root, `L${atom.tier} ${snapshot.t(`rank.${taxonomy.rank}`)} · v${atom.version} · ✓${atom.successes}/✗${atom.failures}`, x + 18, y + 43, {
    size: 10,
    color: GPU_COLORS.tiers[atom.tier as 1 | 2 | 3],
  });
  ctx.text(ctx.root, atom.description, x + 18, y + 67, {
    size: 11,
    color: GPU_COLORS.muted,
    width: width - 36,
  });
  const paneTop = y + 130;
  const pane = createScrollPane(ctx.root, {
    x,
    y: paneTop,
    width,
    height: y + height - paneTop,
    scrollY: ctx.detailScrollY,
  });
  const prompt = ctx.text(pane.content, truncate(atom.systemPrompt, 5000), 18, 0, {
    size: 10,
    mono: true,
    width: width - 36,
  });
  pane.extend(prompt.height);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
  pane.content.position.y = -ctx.detailScrollY;
  ctx.detailBounds = new Rectangle(x, y, width, height);
}
