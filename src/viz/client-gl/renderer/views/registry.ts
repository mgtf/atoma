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
  const registries = snapshot.data.registries;
  const sourceHeading = registries.length > 1
    ? snapshot.t('nav.selectRegistry')
    : snapshot.t('registry.storeSource');
  ctx.text(ctx.root, sourceHeading.toUpperCase(), x + 16, top + 44, {
    size: 9,
    weight: '700',
    color: GPU_COLORS.muted,
  });

  if (registries.length === 1) {
    // The normal one-store deployment has nothing to SELECT. Rendering its
    // basename and population as information avoids a blue button that looks
    // like an unexplained command and, when re-clicked, only resets the atom.
    const registry = registries[0]!;
    const label = registrySourceLabel(snapshot, registry);
    ctx.text(ctx.root, label, x + 16, top + 64, {
      size: 11,
      weight: '600',
      width: leftWidth - 32,
      singleLine: true,
    });
    ctx.tooltip(ctx.root, {
      x: x + 16,
      y: top + 62,
      width: leftWidth - 32,
      height: 18,
      text: registry.path,
    });
  }

  const multipleRegistries = registries.length > 1;
  // A repeated `--db` list is unbounded. Its choices live INSIDE the same
  // masked scroll pane as the tiers, so no number of long store names can
  // push the atom list to a negative height or leave a choice off-screen.
  // The pane starts below the native search input in that case.
  const paneTop = top + (multipleRegistries ? 82 : 92);
  const pane = createScrollPane(ctx.root, {
    x,
    y: paneTop,
    width: leftWidth,
    height: Math.max(0, height - GPU_LAYOUT.gap - paneTop),
    scrollY: snapshot.state.scrollY.registry,
  });
  let y = 0;
  if (multipleRegistries) {
    const selectorLeft = 16;
    const selectorRight = leftWidth - 16;
    let selectorX = selectorLeft;
    let selectorY = 0;
    for (const registry of registries) {
      const label = registrySourceLabel(snapshot, registry);
      const naturalWidth = Math.max(
        70,
        ctx.measureText(label, { size: 11, weight: '700' }) + 20
      );
      const buttonWidth = Math.min(leftWidth - 32, naturalWidth);
      if (selectorX > selectorLeft && selectorX + buttonWidth > selectorRight) {
        selectorX = selectorLeft;
        selectorY += 36;
      }
      const drawnWidth = Math.min(buttonWidth, selectorRight - selectorX);
      if (pane.visible(selectorY, selectorY + 30)) {
        ctx.button(
          pane.content,
          `registry.select.${registry.id}`,
          'button',
          label,
          selectorX,
          selectorY,
          drawnWidth,
          30,
          snapshot.state.selectedRegistryId === registry.id,
          snapshot.onActivate
        );
        ctx.tooltip(pane.content, {
          x: selectorX,
          y: selectorY,
          width: drawnWidth,
          height: 30,
          text: registry.path,
        });
      }
      selectorX += drawnWidth + 6;
      y = selectorY + 30;
    }
    y += 16;
  }
  if (!payload) {
    if (pane.visible(y, y + 28)) {
      ctx.text(pane.content, snapshot.t('common.loading'), 16, y + 8);
    }
    pane.extend(y + 28);
    ctx.scrollMax.registry = pane.finish();
    return;
  }
  const query = snapshot.state.search.registry;
  // Culled rows still advance the cursor so the reported max scroll covers
  // every source and atom, including the ones skipped this frame.
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

function registrySourceLabel(
  snapshot: GpuRenderSnapshot,
  registry: GpuRenderSnapshot['data']['registries'][number]
): string {
  const fileName = registry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? registry.label;
  return registry.exists
    ? snapshot.t('registry.storeCount', { label: fileName, count: registry.counts.total })
    : `${fileName} · ${snapshot.t('registry.missing')}`;
}
