import { Rectangle } from 'pixi.js';
import { matchesSearchQuery, skillSearchText } from '../../../client/search.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';

export function drawSkills(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const top = GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap;
  const leftWidth = Math.min(560, width * 0.45);
  ctx.panel(
    ctx.root,
    GPU_LAYOUT.gap,
    top,
    leftWidth,
    height - top - GPU_LAYOUT.gap,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  ctx.text(ctx.root, snapshot.t('nav.skills'), 26, top + 14, { size: 16, weight: '700' });
  const query = snapshot.state.search.skills;
  // Namespace lists scroll inside a masked pane below the fixed title.
  // Culled rows still advance the cursor so the reported max scroll covers
  // every row, including the ones skipped this frame. Pane-local x 16 is the
  // historical screen x 26 (= GPU_LAYOUT.gap + 16).
  const paneTop = top + 100;
  const pane = createScrollPane(ctx.root, {
    x: GPU_LAYOUT.gap,
    y: paneTop,
    width: leftWidth,
    height: height - GPU_LAYOUT.gap - paneTop,
    scrollY: snapshot.state.scrollY.skills,
  });
  let y = 0;
  for (const namespace of snapshot.data.skillNamespaces) {
    const skills = (snapshot.data.skillsByNamespace[namespace.l1Name] ?? []).filter((skill) =>
      matchesSearchQuery(skillSearchText(skill, namespace.l1Name), query)
    );
    if (!skills.length) continue;
    if (pane.visible(y, y + 24)) {
      ctx.text(pane.content, `${namespace.l1Name} (${skills.length})`, 16, y, {
        size: 11,
        weight: '700',
        color: GPU_COLORS.tiers[1],
      });
    }
    y += 24;
    for (const skill of skills) {
      if (pane.visible(y, y + 31)) {
        ctx.button(
          pane.content,
          `skill.select.${namespace.l1Name}::${skill.id}`,
          'button',
          `${skill.id} · ✓${skill.successes}/✗${skill.failures}`,
          16,
          y,
          leftWidth - 32,
          31,
          snapshot.state.selectedSkill?.l1Name === namespace.l1Name &&
            snapshot.state.selectedSkill.id === skill.id,
          snapshot.onActivate,
          skill.kind === 'script' ? GPU_COLORS.warning : GPU_COLORS.primary
        );
      }
      y += 36;
    }
    y += 10;
  }
  pane.extend(y);
  ctx.scrollMax.skills = pane.finish();
  const rightX = leftWidth + GPU_LAYOUT.gap * 2;
  const rightWidth = width - rightX - GPU_LAYOUT.gap;
  ctx.panel(
    ctx.root,
    rightX,
    top,
    rightWidth,
    height - top - GPU_LAYOUT.gap,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  const skill = snapshot.data.skillDetail;
  if (!skill) {
    ctx.text(ctx.root, snapshot.t('pane.selectSkill'), rightX + 18, top + 20, {
      color: GPU_COLORS.muted,
    });
    return;
  }
  ctx.text(ctx.root, skill.id, rightX + 18, top + 16, { size: 16, weight: '700' });
  ctx.text(ctx.root, `${skill.kind} · ✓${skill.successes}/✗${skill.failures}`, rightX + 18, top + 44, {
    size: 10,
    color: skill.kind === 'script' ? GPU_COLORS.warning : GPU_COLORS.primary,
  });
  ctx.text(ctx.root, skill.description, rightX + 18, top + 70, {
    size: 11,
    width: rightWidth - 36,
  });
  // The shareability box and the body (up to 6000 chars) far exceed the
  // panel: they scroll inside a masked pane driven by the shared detail wheel
  // route, below the fixed id/kind/description headings.
  const detailPaneTop = top + 118;
  const detailPane = createScrollPane(ctx.root, {
    x: rightX,
    y: detailPaneTop,
    width: rightWidth,
    height: height - GPU_LAYOUT.gap - detailPaneTop,
    scrollY: ctx.detailScrollY,
  });
  let bodyY = 14;
  if (skill.shareability) {
    const blocked = skill.shareability.verdict === 'blocked';
    ctx.panel(
      detailPane.content,
      18,
      0,
      rightWidth - 36,
      58,
      blocked ? 0x361921 : 0x112c25,
      blocked ? GPU_COLORS.error : GPU_COLORS.success
    );
    ctx.text(
      detailPane.content,
      snapshot.t(`skill.share.${skill.shareability.verdict}`),
      30,
      12,
      {
        size: 10,
        color: blocked ? GPU_COLORS.error : GPU_COLORS.success,
        weight: '700',
        width: rightWidth - 60,
      }
    );
    bodyY = 74;
  }
  const body = ctx.text(detailPane.content, truncate(skill.body ?? '', 6000), 18, bodyY, {
    size: 10,
    mono: true,
    width: rightWidth - 36,
  });
  detailPane.extend(bodyY + body.height);
  ctx.detailScrollMax = detailPane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
  detailPane.content.position.y = -ctx.detailScrollY;
  ctx.detailBounds = new Rectangle(rightX, top, rightWidth, height - top - GPU_LAYOUT.gap);
}
