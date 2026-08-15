import { atomSearchText, matchesSearchQuery } from '../../../client/search.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawAtomDetail } from './atom-detail.js';

export function drawRegistry(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const payload = snapshot.data.registry;
  const x = GPU_LAYOUT.gap;
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const leftWidth = Math.min(560, width * 0.45);
  ctx.panel(
    ctx.root,
    x,
    top,
    leftWidth,
    height - top - GPU_LAYOUT.gap,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(ctx.root, snapshot.t('nav.registry'), x + 16, top + 14, {
    size: 16,
    weight: '700',
  });
  let selectorX = x + 16;
  for (const registry of snapshot.data.registries.slice(0, 4)) {
    const buttonWidth = Math.max(70, registry.label.length * 7 + 24);
    ctx.button(
      ctx.root,
      `registry.select.${registry.id}`,
      'button',
      `${registry.label} · ${registry.counts.total}`,
      selectorX,
      top + 44,
      buttonWidth,
      30,
      snapshot.state.selectedRegistryId === registry.id,
      snapshot.onActivate
    );
    selectorX += buttonWidth + 6;
  }
  if (!payload) {
    ctx.text(ctx.root, snapshot.t('common.loading'), x + 16, top + 96);
    return;
  }
  const query = snapshot.state.search.registry;
  // Tier lists scroll inside a masked pane below the fixed title/selector
  // rows. Culled rows still advance the cursor so the reported max scroll
  // covers every row, including the ones skipped this frame.
  const paneTop = top + 92;
  const pane = createScrollPane(ctx.root, {
    x,
    y: paneTop,
    width: leftWidth,
    height: height - GPU_LAYOUT.gap - paneTop,
    scrollY: snapshot.state.scrollY.registry,
  });
  let y = 0;
  for (const tier of [3, 2, 1]) {
    const atoms = payload.types.filter(
      (atom) =>
        atom.tier === tier &&
        matchesSearchQuery(atomSearchText(atom), query)
    );
    if (!atoms.length) continue;
    if (pane.visible(y, y + 28)) {
      ctx.text(pane.content, snapshot.t(`lanes.l${tier}`), 16, y + 8, {
        size: 11,
        weight: '700',
        color: GPU_COLORS.tiers[tier as 1 | 2 | 3],
      });
    }
    y += 28;
    for (const atom of atoms) {
      if (pane.visible(y, y + 32)) {
        ctx.button(
          pane.content,
          `registry.atom.${atom.name}`,
          'button',
          `${atom.name} · ✓${atom.successes}/✗${atom.failures}`,
          16,
          y,
          leftWidth - 32,
          32,
          snapshot.state.selectedRegistryAtom === atom.name,
          snapshot.onActivate,
          GPU_COLORS.tiers[tier as 1 | 2 | 3]
        );
      }
      y += 37;
    }
    y += 8;
  }
  pane.extend(y);
  ctx.scrollMax.registry = pane.finish();
  const rightX = x + leftWidth + GPU_LAYOUT.gap;
  ctx.panel(
    ctx.root,
    rightX,
    top,
    width - rightX - GPU_LAYOUT.gap,
    height - top - GPU_LAYOUT.gap,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  const atom = payload.types.find((item) => item.name === snapshot.state.selectedRegistryAtom) ?? payload.types[0];
  if (atom) {
    drawAtomDetail(
      ctx,
      snapshot,
      atom,
      rightX,
      top,
      width - rightX - GPU_LAYOUT.gap,
      height - top - GPU_LAYOUT.gap
    );
  }
}
