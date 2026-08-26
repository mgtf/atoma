import { Graphics } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { ADMIN_VIEWS, visibleViews, type ViewName } from '../../store.js';
import { NAV_ICON_OUTSIDE_GAP, NAV_ICON_RENDER_SIZE } from '../nav-icons.js';
import {
  ATOMA_MARK_LOCAL_CENTER,
  ATOMA_MARK_OVERVIEW_RAIL_SCALE,
} from '../atoma-mark.js';

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
const GROUP_HEIGHT = 20;
const GROUP_GAP = 18;
const ITEM_HEIGHT = 32;
const ITEM_GAP = 12;
const GROUP_LABEL_SIZE = 9;
const GROUP_RULE_GAP = 8;
/** The compact rail gives each destination one centred icon tile. */
export const FOCUS_SIDEBAR_BUTTON_WIDTH = GPU_LAYOUT.sidebarFocusButtonWidth;
const FOCUS_RAIL_BOTTOM_PAD = 6;
const FOCUS_RAIL_DOCK_GAP = 6;
const FOCUS_RAIL_FPS_GAP = 4;
const FOCUS_RAIL_FPS_HEIGHT = 8;
const FOCUS_RAIL_LOCALE_HEIGHT = 26;
const FOCUS_RAIL_PROFILE_SIZE = 30;
const FOCUS_RAIL_CRYSTAL_HEIGHT = 51;
const OVERVIEW_RAIL_CRYSTAL_TOP = 4;
const OVERVIEW_RAIL_CRYSTAL_SIDE_PAD = 8;
export const FOCUS_RAIL_FPS_SCALE = 0.68;

export interface FocusRailRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FocusRailChromeLayout {
  readonly crystal: FocusRailRect;
  readonly profile: FocusRailRect | null;
  readonly locale: FocusRailRect;
  readonly fps: FocusRailRect;
  /** Source-space bottom of chrome reserved above the first navigation row. */
  readonly navigationTop: number;
  /** Last source-space y the navigation rows may occupy. */
  readonly navigationBottom: number;
}

export interface OverviewRailChromeLayout {
  readonly crystal: FocusRailRect;
  readonly crystalScale: number;
  /** Source-space bottom of chrome reserved above the first navigation row. */
  readonly navigationTop: number;
}

/**
 * The overview brand owns the complete rail width, with no adjacent wordmark.
 * Its scale shrinks only for pathological viewports narrower than the normal
 * 112px rail floor and always remains below the hero reflection threshold.
 */
export function overviewRailChromeLayout(
  sidebarWidth: number
): OverviewRailChromeLayout {
  const markSize = ATOMA_MARK_LOCAL_CENTER * 2;
  const availableWidth = Math.max(0, sidebarWidth - OVERVIEW_RAIL_CRYSTAL_SIDE_PAD * 2);
  const crystalScale = Math.min(
    ATOMA_MARK_OVERVIEW_RAIL_SCALE,
    availableWidth / markSize
  );
  const crystalHeight = markSize * crystalScale;
  const crystal: FocusRailRect = {
    x: 0,
    y: OVERVIEW_RAIL_CRYSTAL_TOP,
    width: Math.max(0, sidebarWidth),
    height: crystalHeight,
  };
  return {
    crystal,
    crystalScale,
    navigationTop: crystal.y + crystal.height,
  };
}

/**
 * Source-space chrome for the projected focus rail. `visibleBottom` is the
 * viewport foot inverse-projected onto the scene plane; anchoring here keeps
 * the dock on screen after perspective rather than below the camera crop.
 */
export function focusRailChromeLayout(
  sidebarWidth: number,
  visibleBottom: number,
  authenticated: boolean
): FocusRailChromeLayout {
  const buttonX = Math.max(0, sidebarWidth - FOCUS_SIDEBAR_BUTTON_WIDTH);
  const bottom = Math.max(0, visibleBottom) - FOCUS_RAIL_BOTTOM_PAD;
  const fps: FocusRailRect = {
    x: buttonX,
    y: bottom - FOCUS_RAIL_FPS_HEIGHT,
    width: Math.min(sidebarWidth, FOCUS_SIDEBAR_BUTTON_WIDTH),
    height: FOCUS_RAIL_FPS_HEIGHT,
  };
  const locale: FocusRailRect = {
    x: buttonX,
    y: fps.y - FOCUS_RAIL_FPS_GAP - FOCUS_RAIL_LOCALE_HEIGHT,
    width: Math.min(sidebarWidth, FOCUS_SIDEBAR_BUTTON_WIDTH),
    height: FOCUS_RAIL_LOCALE_HEIGHT,
  };
  const profile = authenticated
    ? {
        x: buttonX + (FOCUS_SIDEBAR_BUTTON_WIDTH - FOCUS_RAIL_PROFILE_SIZE) / 2,
        y: locale.y - FOCUS_RAIL_DOCK_GAP - FOCUS_RAIL_PROFILE_SIZE,
        width: FOCUS_RAIL_PROFILE_SIZE,
        height: FOCUS_RAIL_PROFILE_SIZE,
      }
    : null;
  const dockTop = profile?.y ?? locale.y;
  return {
    crystal: {
      x: buttonX,
      y: GPU_LAYOUT.focusTopInset + 3,
      width: Math.min(sidebarWidth, FOCUS_SIDEBAR_BUTTON_WIDTH),
      height: FOCUS_RAIL_CRYSTAL_HEIGHT,
    },
    profile,
    locale,
    fps,
    navigationTop: GPU_LAYOUT.focusTopInset + 3 + FOCUS_RAIL_CRYSTAL_HEIGHT,
    navigationBottom: Math.max(0, dockTop - FOCUS_RAIL_DOCK_GAP),
  };
}

export const SIDEBAR_GROUPS: readonly { key: string; views: readonly ViewName[] }[] = [
  { key: 'workspace', views: ['projects', 'runs', 'docs'] },
  { key: 'operate', views: ['registry', 'skills', 'burnin'] },
  { key: 'admin', views: ADMIN_VIEWS },
];

export type SidebarRow =
  | { readonly kind: 'group'; readonly group: string; readonly y: number; readonly height: number }
  | { readonly kind: 'item'; readonly view: ViewName; readonly y: number; readonly height: number }
  | { readonly kind: 'action'; readonly action: 'tuning'; readonly y: number; readonly height: number };

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
    // Scene tuning is a utility, not a route. It lives at the foot of ADMIN
    // and therefore appears only when that gated group itself is present.
    if (group.key === 'admin') {
      rows.push({ kind: 'action', action: 'tuning', y, height: metrics.itemHeight });
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
  viewportHeight = Number.POSITIVE_INFINITY,
  navigationTop: number = GPU_LAYOUT.headerHeight
): readonly SidebarRow[] {
  const normal = groupedLayout(views, {
    top: navigationTop + 18,
    groupHeight: GROUP_HEIGHT,
    groupGap: GROUP_GAP,
    itemHeight: ITEM_HEIGHT,
    itemGap: ITEM_GAP,
  });
  if (rowsBottom(normal) <= viewportHeight - 4) return normal;

  // Landscape windows first tighten whitespace while keeping group labels.
  const compact = groupedLayout(views, {
    top: navigationTop + 8,
    groupHeight: 14,
    groupGap: 6,
    itemHeight: 26,
    itemGap: 10,
  });
  if (rowsBottom(compact) <= viewportHeight - 4) return compact;

  // If labels themselves would hide a destination, destinations win. Flatten
  // the known group order and distribute every hit target through the space
  // below the header; even a short landscape canvas keeps its last tab.
  const members: Array<
    | { readonly kind: 'item'; readonly view: ViewName }
    | { readonly kind: 'action'; readonly action: 'tuning' }
  > = [];
  for (const group of SIDEBAR_GROUPS) {
    const groupViews = group.views.filter((view) => views.includes(view));
    members.push(...groupViews.map((view) => ({ kind: 'item' as const, view })));
    if (group.key === 'admin' && groupViews.length > 0) {
      members.push({ kind: 'action', action: 'tuning' });
    }
  }
  const top = navigationTop + 4;
  const gap = 2;
  const available = Math.max(0, viewportHeight - top - 4 - gap * Math.max(0, members.length - 1));
  const itemHeight = members.length > 0 ? Math.min(26, available / members.length) : 0;
  return members.map((member, index) => ({
    ...member,
    y: top + index * (itemHeight + gap),
    height: itemHeight,
  }));
}

/** Draw the rail: one wash band, then a heading and a nav button per row. */
export function drawSidebar(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  height: number,
  width: number = GPU_LAYOUT.sidebarWidth,
  layoutHeight: number = height,
  navigationTop: number = GPU_LAYOUT.headerHeight
): void {
  const iconOnly = snapshot.state.sceneCameraMode === 'focus';
  const top = iconOnly ? 0 : GPU_LAYOUT.headerHeight;

  // Wash, not an opaque slab — the same 0.42 the header bar uses, so the far
  // field still reads behind both pieces of chrome.
  const band = new Graphics();
  band.label = 'sidebar-band';
  band.rect(0, top, width, Math.max(0, height - top));
  band.fill({ color: 0x0b111e, alpha: 0.42 });
  band.eventMode = 'none';
  ctx.root.addChild(band);

  const buttonX = iconOnly
    ? Math.max(0, width - FOCUS_SIDEBAR_BUTTON_WIDTH)
    : SIDEBAR_PAD + NAV_ICON_RENDER_SIZE + NAV_ICON_OUTSIDE_GAP;
  const itemWidth = iconOnly
    ? Math.min(width, FOCUS_SIDEBAR_BUTTON_WIDTH)
    : Math.max(0, width - buttonX - SIDEBAR_PAD);
  for (const row of sidebarLayout(
    visibleViews(snapshot.data.auth),
    layoutHeight,
    navigationTop
  )) {
    if (row.kind === 'group') {
      // Focus leaves only the icon buttons. Keeping the rows themselves
      // preserves each group's rhythm without repeating its heading.
      if (iconOnly) continue;
      const label = snapshot.t(`nav.group.${row.group}`).toUpperCase();
      const labelOptions = {
        size: GROUP_LABEL_SIZE,
        weight: '700' as const,
        color: GPU_COLORS.muted,
      };
      const labelWidth = ctx.measureText(label, labelOptions);
      const centreX = width / 2;
      const ruleY = row.y + GROUP_LABEL_SIZE / 2 + 1;
      const ruleLeft = SIDEBAR_PAD + 3;
      const ruleRight = width - SIDEBAR_PAD - 3;
      const labelLeft = centreX - labelWidth / 2 - GROUP_RULE_GAP;
      const labelRight = centreX + labelWidth / 2 + GROUP_RULE_GAP;

      // A restrained bevel gives the headings the requested "— TITLE —"
      // silhouette without making punctuation part of the translated copy.
      const rules = new Graphics();
      rules
        .moveTo(ruleLeft, ruleY + 1)
        .lineTo(Math.max(ruleLeft, labelLeft), ruleY + 1)
        .moveTo(Math.min(ruleRight, labelRight), ruleY + 1)
        .lineTo(ruleRight, ruleY + 1)
        .stroke({ color: 0x02050b, width: 1, alpha: 0.85 });
      rules
        .moveTo(ruleLeft, ruleY)
        .lineTo(Math.max(ruleLeft, labelLeft), ruleY)
        .moveTo(Math.min(ruleRight, labelRight), ruleY)
        .lineTo(ruleRight, ruleY)
        .stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.75 });
      rules.eventMode = 'none';
      ctx.root.addChild(rules);

      const labelText = ctx.text(
        ctx.root,
        label,
        centreX,
        row.y,
        labelOptions
      );
      labelText.anchor.x = 0.5;
      continue;
    }
    if (row.kind === 'action') {
      const label = snapshot.t('nav.sceneTuning');
      ctx.navButton(
        ctx.root,
        'tuning.toggle',
        label.toUpperCase(),
        buttonX,
        row.y,
        itemWidth,
        row.height,
        snapshot.state.tuningPanelOpen,
        snapshot.onActivate,
        iconOnly ? { iconOnly: true, tooltip: label } : undefined
      );
      continue;
    }
    const label = snapshot.t(`nav.${row.view}`);
    ctx.navButton(
      ctx.root,
      `nav.${row.view}`,
      label.toUpperCase(),
      buttonX,
      row.y,
      itemWidth,
      row.height,
      snapshot.state.view === row.view,
      snapshot.onActivate,
      iconOnly ? { iconOnly: true, tooltip: label } : undefined
    );
  }
}
