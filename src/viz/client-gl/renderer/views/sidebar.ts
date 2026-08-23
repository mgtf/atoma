import { Graphics } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { ADMIN_VIEWS, visibleViews, type ViewName } from '../../store.js';

/**
 * THE NAV RAIL — the tab strip that used to live in the header, stood on its
 * end down the left edge.
 *
 * It is chrome, not a view: it is drawn from `render()` beside the header,
 * OUTSIDE the shifted content layer, so it keeps screen coordinates while
 * every view draws from 0 in its own viewport space.
 *
 * `visibleViews` stays the ONE definition of which tabs a viewer gets — this
 * module only groups them. A view that reaches `visibleViews` without a group
 * here would silently vanish from the nav, so a test holds the two lists to
 * each other rather than trusting the reader to notice.
 *
 * Settings deliberately has NO row: it is reachable from the account menu,
 * which is where an account-scoped surface belongs. Giving it a second
 * entrance here would put one job in two places — the split the Launch tab
 * was folded away to end.
 */

const SIDEBAR_PAD = 12;
const SIDEBAR_TOP = GPU_LAYOUT.headerHeight + 18;
const GROUP_HEIGHT = 20;
const GROUP_GAP = 18;
const ITEM_HEIGHT = 32;
const ITEM_GAP = 6;

export const SIDEBAR_GROUPS: readonly { key: string; views: readonly ViewName[] }[] = [
  { key: 'workspace', views: ['projects', 'runs', 'docs'] },
  { key: 'operate', views: ['registry', 'skills', 'burnin'] },
  { key: 'admin', views: ADMIN_VIEWS },
];

export type SidebarRow =
  | { readonly kind: 'group'; readonly group: string; readonly y: number; readonly height: number }
  | { readonly kind: 'item'; readonly view: ViewName; readonly y: number; readonly height: number };

interface SidebarMetrics {
  readonly top: number;
  readonly groupHeight: number;
  readonly groupGap: number;
  readonly itemHeight: number;
  readonly itemGap: number;
}

function groupedLayout(
  views: readonly ViewName[],
  metrics: SidebarMetrics
): SidebarRow[] {
  const rows: SidebarRow[] = [];
  let y = metrics.top;
  for (const group of SIDEBAR_GROUPS) {
    const members = group.views.filter((view) => views.includes(view));
    if (members.length === 0) continue;
    if (rows.length > 0) y += metrics.groupGap;
    rows.push({ kind: 'group', group: group.key, y, height: metrics.groupHeight });
    y += metrics.groupHeight;
    for (const view of members) {
      rows.push({ kind: 'item', view, y, height: metrics.itemHeight });
      y += metrics.itemHeight + metrics.itemGap;
    }
    y -= metrics.itemGap;
  }
  return rows;
}

function rowsBottom(rows: readonly SidebarRow[]): number {
  const last = rows.at(-1);
  return last ? last.y + last.height : 0;
}

/**
 * Pure layout, so the row set and its ordering can be asserted without a GPU.
 * An empty group is dropped whole — a gated member sees "workspace" alone,
 * not two headings with nothing under them.
 */
export function sidebarLayout(
  views: readonly ViewName[],
  viewportHeight = Number.POSITIVE_INFINITY
): readonly SidebarRow[] {
  const normal = groupedLayout(views, {
    top: SIDEBAR_TOP,
    groupHeight: GROUP_HEIGHT,
    groupGap: GROUP_GAP,
    itemHeight: ITEM_HEIGHT,
    itemGap: ITEM_GAP,
  });
  if (rowsBottom(normal) <= viewportHeight - 4) return normal;

  // Landscape windows first tighten whitespace while keeping group labels.
  const compact = groupedLayout(views, {
    top: GPU_LAYOUT.headerHeight + 8,
    groupHeight: 14,
    groupGap: 6,
    itemHeight: 26,
    itemGap: 2,
  });
  if (rowsBottom(compact) <= viewportHeight - 4) return compact;

  // If labels themselves would hide a destination, destinations win. Flatten
  // the known group order and distribute every hit target through the space
  // below the header; even a short landscape canvas keeps its last tab.
  const members = SIDEBAR_GROUPS.flatMap((group) =>
    group.views.filter((view) => views.includes(view))
  );
  const top = GPU_LAYOUT.headerHeight + 4;
  const gap = 2;
  const available = Math.max(0, viewportHeight - top - 4 - gap * Math.max(0, members.length - 1));
  const itemHeight = members.length > 0 ? Math.min(26, available / members.length) : 0;
  return members.map((view, index) => ({
    kind: 'item' as const,
    view,
    y: top + index * (itemHeight + gap),
    height: itemHeight,
  }));
}

/** Draw the rail: one wash band, then a heading and a nav button per row. */
export function drawSidebar(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  height: number,
  width: number = GPU_LAYOUT.sidebarWidth
): void {
  const top = GPU_LAYOUT.headerHeight;

  // Wash, not an opaque slab — the same 0.42 the header bar uses, so the far
  // field still reads behind both pieces of chrome.
  const band = new Graphics();
  band.rect(0, top, width, Math.max(0, height - top));
  band.fill({ color: 0x0b111e, alpha: 0.42 });
  band.moveTo(width, top);
  band.lineTo(width, height);
  band.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.55 });
  band.eventMode = 'none';
  ctx.root.addChild(band);

  const itemWidth = Math.max(0, width - SIDEBAR_PAD * 2);
  for (const row of sidebarLayout(visibleViews(snapshot.data.auth), height)) {
    if (row.kind === 'group') {
      ctx.text(
        ctx.root,
        snapshot.t(`nav.group.${row.group}`).toUpperCase(),
        SIDEBAR_PAD + 2,
        row.y,
        { size: 9, weight: '700', color: GPU_COLORS.muted }
      );
      continue;
    }
    ctx.navButton(
      ctx.root,
      `nav.${row.view}`,
      snapshot.t(`nav.${row.view}`).toUpperCase(),
      SIDEBAR_PAD,
      row.y,
      itemWidth,
      row.height,
      snapshot.state.view === row.view,
      snapshot.onActivate
    );
  }
}
