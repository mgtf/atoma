import { Container, Graphics, Rectangle } from 'pixi.js';
import type { VizNotification } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { drawScrollbarThumb } from '../scroll-pane.js';
import { SEVERITY_COLORS } from './journal-row.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';
import { anchoredMenuPosition, type LocaleMenuAnchor } from './locale-menu.js';

/**
 * THE NOTIFICATION TRAY — the bell between the locale control and the profile
 * orb, and the overlay it opens.
 *
 * The rows are the viewer's own slice of the platform journal, rendered
 * server-side through the SAME push routing table a device subscription reads
 * (`/api/notifications`), so what the tray lists is exactly what push would
 * have said. A row whose subject exists somewhere in the app is a LINK to that
 * place — the run's trace, the project, the org card, the admin journal — and
 * a row with nowhere better to go stays plain text. The list scrolls under a
 * mask; reaching the bottom asks for the older page through the ordinary
 * activation channel, and the foot offers the same page by button — one
 * loader, two gestures, the journal's pattern.
 *
 * ROW HEIGHT FOLLOWS THE COPY. A push body is free prose (an announcement is
 * whatever the operator wrote, newlines included), so rows wrap it against the
 * MEASURED width — the chip-layout rule: the measure is injected, never a
 * character estimate — up to a bounded number of lines, and a body past the
 * bound ends in an ellipsis. The same wrap feeds the layout, the draw and the
 * DOM veil clip, so the three can never disagree about the panel's height.
 */

const EDGE = 12;
const PANEL_WIDTH = 356;
const PANEL_PAD = 8;
const HEADER_HEIGHT = 30;
const FOOT_HEIGHT = 34;
const EMPTY_HEIGHT = 34;
/** The list's own ceiling; shorter viewports bound it further below. */
const MAX_LIST_HEIGHT = 420;

/** Row geometry: title band, then measured body lines, then the divider gap. */
const ROW_TEXT_INSET = 12;
const TITLE_SIZE = 11;
const BODY_SIZE = 10;
const BODY_TOP = 26;
const BODY_LINE_HEIGHT = 14;
const ROW_FOOT = 12;
const BODYLESS_ROW_HEIGHT = 40;
export const NOTIFICATION_BODY_MAX_LINES = 3;

export type NotificationsMenuAnchor = LocaleMenuAnchor;

/** `ctx.measureText`'s shape — injected so a renderer-less test wraps identically. */
export type NotificationMeasure = (
  value: string,
  options?: { size?: number; weight?: '400' | '500' | '600' | '700' }
) => number;

/** The narrow slice of `GpuDataSnapshot` the tray reads. */
export interface NotificationsMenuData {
  readonly notifications: readonly VizNotification[];
  readonly notificationsHasMore: boolean;
  readonly notificationsLoading: boolean;
  readonly notificationsError: boolean;
}

/** Longest prefix of `value` that measures into `width`, ellipsised. */
function fitLine(value: string, width: number, measure: NotificationMeasure): string {
  if (width <= 0) return '';
  if (measure(value, { size: BODY_SIZE }) <= width) return value;
  if (measure('…', { size: BODY_SIZE }) > width) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${value.slice(0, mid).trimEnd()}…`, { size: BODY_SIZE }) <= width) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? '…' : `${value.slice(0, low).trimEnd()}…`;
}

/**
 * Wrap one body against the measured width: explicit newlines are honoured,
 * words wrap greedily, a lone word wider than the column is broken by
 * characters, and copy past `maxLines` collapses into an ellipsis on the last
 * line. Returns the strings the row DRAWS, so layout height and rendered text
 * come from one computation.
 */
export function wrapNotificationBody(
  body: string,
  width: number,
  measure: NotificationMeasure,
  maxLines = NOTIFICATION_BODY_MAX_LINES
): string[] {
  const cleaned = body.trim();
  if (!cleaned || width <= 0 || maxLines <= 0) return [];
  const fits = (value: string) => measure(value, { size: BODY_SIZE }) <= width;
  // One queue of words; `null` is an explicit line break the author typed.
  const queue: (string | null)[] = [];
  for (const [index, paragraph] of cleaned.split(/\s*\r?\n\s*/).entries()) {
    if (index > 0) queue.push(null);
    for (const word of paragraph.split(/\s+/)) if (word) queue.push(word);
  }
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < queue.length) {
    const token = queue[index];
    if (token === undefined) break;
    const breaking = token === null || !fits(current ? `${current} ${token}` : token);
    if (!breaking) {
      current = current ? `${current} ${token}` : token;
      index += 1;
      continue;
    }
    if (token !== null && !current) {
      // One word wider than the whole column: break it by characters so the
      // layout never claims a line the draw would have to overflow.
      let low = 1;
      let high = token.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(token.slice(0, mid))) low = mid;
        else high = mid - 1;
      }
      current = token.slice(0, low);
      queue[index] = token.slice(low);
    }
    // About to need a new line. If this would be the last permitted one, stop
    // here and let the remainder collapse into it below.
    if (lines.length + 1 >= maxLines) break;
    lines.push(current);
    current = '';
    if (token === null) index += 1;
  }
  const remainder = queue
    .slice(index)
    .filter((token): token is string => typeof token === 'string' && token !== '')
    .join(' ');
  if (!remainder) {
    if (current) lines.push(current);
    return lines;
  }
  // Truncation: the last permitted line carries what fits of everything left,
  // ellipsised by the same measure the layout trusts.
  lines.push(fitLine([current, remainder].filter(Boolean).join(' '), width, measure));
  return lines;
}

/** One measured row: its offset inside the scrolled content, and its lines. */
export interface NotificationRowLayout {
  readonly y: number;
  readonly height: number;
  readonly lines: readonly string[];
}

export interface NotificationsMenuLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The masked list viewport, panel-absolute. */
  readonly list: { readonly y: number; readonly height: number };
  readonly rows: readonly NotificationRowLayout[];
  readonly contentHeight: number;
  readonly scrollMax: number;
  readonly foot: { readonly y: number } | null;
}

/**
 * Complete geometry, shared by the draw and the DOM veil clip. The panel
 * grows with its measured rows up to a bounded list viewport; past that the
 * list scrolls and `scrollMax` is what the wheel handler clamps against.
 */
export function notificationsMenuLayout(
  viewportWidth: number,
  viewportHeight: number,
  anchor: NotificationsMenuAnchor,
  data: NotificationsMenuData,
  measure: NotificationMeasure
): NotificationsMenuLayout {
  const width = Math.min(PANEL_WIDTH, Math.max(220, viewportWidth - EDGE * 2));
  const innerWidth = width - 28;
  const rows: NotificationRowLayout[] = [];
  let cursor = 0;
  for (const notification of data.notifications) {
    const lines = wrapNotificationBody(notification.body, innerWidth - ROW_TEXT_INSET, measure);
    const height =
      lines.length === 0 ? BODYLESS_ROW_HEIGHT : BODY_TOP + lines.length * BODY_LINE_HEIGHT + ROW_FOOT;
    rows.push({ y: cursor, height, lines });
    cursor += height;
  }
  const contentHeight = rows.length > 0 ? cursor : EMPTY_HEIGHT;
  const foot =
    data.notificationsHasMore || data.notificationsLoading || data.notificationsError;
  const footHeight = foot ? FOOT_HEIGHT : 0;
  const chrome = HEADER_HEIGHT + footHeight + PANEL_PAD;
  const listHeight = Math.max(
    BODYLESS_ROW_HEIGHT,
    Math.min(contentHeight, MAX_LIST_HEIGHT, viewportHeight - EDGE * 2 - chrome)
  );
  const height = chrome + listHeight;
  const position = anchoredMenuPosition(viewportWidth, viewportHeight, anchor, width, height);
  return {
    ...position,
    width,
    height,
    list: { y: position.y + HEADER_HEIGHT, height: listHeight },
    rows,
    contentHeight,
    scrollMax: Math.max(0, contentHeight - listHeight),
    foot: foot ? { y: position.y + HEADER_HEIGHT + listHeight + 4 } : null,
  };
}

/** What the tray knows about the viewer when it resolves a row's destination. */
export interface NotificationViewer {
  readonly platformAdmin: boolean;
  readonly activeOrgId: string | null;
}

/**
 * Where one notification LEADS, as an activation id — or null when the app
 * holds no better surface than the row itself. The rules are deliberately
 * conservative: org-scoped destinations require the event's organisation to
 * be the viewer's ACTIVE one, because Projects and Settings render the active
 * organisation and a click that lands on the wrong org's list is worse than
 * no link. A platform admin can always reach the run corpus and the journal,
 * so their trace links cross organisations and their fallback is the journal
 * row every notification came from.
 */
export function notificationTarget(
  notification: VizNotification,
  viewer: NotificationViewer
): string | null {
  const sameOrg =
    typeof notification.orgId === 'string' &&
    notification.orgId !== '' &&
    notification.orgId === viewer.activeOrgId;
  if (notification.traceId && (viewer.platformAdmin || sameOrg)) {
    return `notifications.go.run.${notification.traceId}`;
  }
  if (notification.projectId && sameOrg) {
    return `notifications.go.project.${notification.projectId}`;
  }
  if (notification.kind === 'org.member_joined' && sameOrg) {
    return 'notifications.go.view.settings';
  }
  if (notification.kind === 'github.installation_status' && sameOrg) {
    return 'notifications.go.view.projects';
  }
  // Every notification is a journal row; for the operator the journal IS the
  // detail surface of last resort. Members have no journal, so no fallback.
  if (viewer.platformAdmin) return 'notifications.go.view.journal';
  return null;
}

/** What the renderer needs back for wheel routing over the open tray. */
export interface NotificationsMenuScrollRegion {
  readonly bounds: Rectangle;
  readonly scrollMax: number;
}

export function drawNotificationsMenu(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  viewportWidth: number,
  viewportHeight: number,
  anchor: NotificationsMenuAnchor,
  scrollY: number
): NotificationsMenuScrollRegion | null {
  const auth = snapshot.data.auth;
  if (!auth || !snapshot.state.notificationsMenuOpen) return null;
  const data = snapshot.data;
  const layout = notificationsMenuLayout(
    viewportWidth,
    viewportHeight,
    anchor,
    data,
    (value, options) => ctx.measureText(value, options)
  );

  // Click-away, the account menu's scrim: Pixi has no stage-level pointer
  // handler, so closing on an outside click needs a real object under the
  // panel.
  const scrim = new Graphics();
  scrim.rect(0, 0, viewportWidth, viewportHeight);
  scrim.fill({ color: 0x050810, alpha: 0.28 });
  scrim.eventMode = 'static';
  scrim.cursor = 'default';
  scrim.hitArea = new Rectangle(0, 0, viewportWidth, viewportHeight);
  scrim.on('pointertap', () => snapshot.onActivate('notifications.menu.close'));
  ctx.root.addChild(scrim);

  ctx.panel(
    ctx.root,
    layout.x,
    layout.y,
    layout.width,
    layout.height,
    0x0c1321,
    GPU_COLORS.primary,
    GPU_LAYOUT.radius,
    2
  );

  const innerX = layout.x + 14;
  const innerWidth = layout.width - 28;
  ctx.text(ctx.root, snapshot.t('notifications.title').toUpperCase(), innerX, layout.y + 10, {
    size: 9,
    weight: '700',
    color: GPU_COLORS.muted,
  });

  const resolvedScroll = Math.max(0, Math.min(layout.scrollMax, scrollY));
  const listMask = new Graphics();
  listMask
    .rect(layout.x + 4, layout.list.y, layout.width - 8, layout.list.height)
    .fill(0xffffff);
  listMask.eventMode = 'none';
  ctx.root.addChild(listMask);
  const listLayer = new Container();
  listLayer.mask = listMask;
  ctx.root.addChild(listLayer);

  if (layout.rows.length === 0) {
    ctx.text(
      ctx.root,
      snapshot.t(data.notificationsError ? 'notifications.error' : 'notifications.empty'),
      innerX,
      layout.list.y + 10,
      { size: 10, color: data.notificationsError ? GPU_COLORS.error : GPU_COLORS.muted, width: innerWidth }
    );
  } else {
    const viewer: NotificationViewer = {
      platformAdmin: auth.viewer.platformAdmin,
      activeOrgId: auth.viewer.activeOrganisation?.id ?? null,
    };
    // Cull by skipping draws while the offsets keep advancing (they were all
    // computed by the layout above, culled or not).
    for (const [index, row] of layout.rows.entries()) {
      const notification = data.notifications[index]!;
      const rowY = layout.list.y + row.y - resolvedScroll;
      if (rowY + row.height < layout.list.y - 48 || rowY > layout.list.y + layout.list.height + 48) {
        continue;
      }
      drawNotificationRow(ctx, listLayer, snapshot, notification, row, viewer, innerX, rowY, innerWidth);
    }
    drawScrollbarThumb(ctx.root, {
      x: layout.x,
      y: layout.list.y + 4,
      width: layout.width,
      height: layout.list.height - 8,
      scrollY: resolvedScroll,
      maxScroll: layout.scrollMax,
    });
  }

  if (layout.foot) {
    if (data.notificationsError && layout.rows.length > 0) {
      ctx.text(ctx.root, snapshot.t('notifications.error'), innerX, layout.foot.y + 8, {
        size: 10,
        color: GPU_COLORS.error,
        width: innerWidth,
      });
    } else if (data.notificationsLoading) {
      ctx.text(ctx.root, snapshot.t('notifications.loading'), innerX, layout.foot.y + 8, {
        size: 10,
        color: GPU_COLORS.muted,
        width: innerWidth,
      });
    } else if (data.notificationsHasMore) {
      ctx.button(
        ctx.root,
        'notifications.more',
        'button',
        snapshot.t('notifications.more'),
        innerX,
        layout.foot.y,
        innerWidth,
        FOOT_HEIGHT - 8,
        false,
        snapshot.onActivate,
        GPU_COLORS.primary,
        true
      );
    }
  }

  return {
    bounds: new Rectangle(layout.x, layout.y, layout.width, layout.height),
    scrollMax: layout.scrollMax,
  };
}

/**
 * One tray row: severity dot, bold title with the relative age on its right,
 * then the measured body lines. The relative phrase is lossy by design, so
 * the exact instant stays reachable in the hover bubble on the stamp (the
 * journal rule). A row whose subject has a surface in the app is one link
 * region over the whole row, with a hover wash for feedback; the accessible
 * name is the title the push carried.
 */
function drawNotificationRow(
  ctx: RendererCtx,
  parent: Container,
  snapshot: GpuRenderSnapshot,
  row: VizNotification,
  rowLayout: NotificationRowLayout,
  viewer: NotificationViewer,
  x: number,
  y: number,
  innerWidth: number
): void {
  const target = notificationTarget(row, viewer);
  if (target) {
    const hover = new Graphics();
    hover.roundRect(x - 6, y + 1, innerWidth + 12, rowLayout.height - 7, 6);
    hover.fill({ color: GPU_COLORS.primary, alpha: 0.1 });
    hover.alpha = 0;
    hover.eventMode = 'none';
    parent.addChild(hover);
    const region = ctx.linkRegion(
      parent,
      target,
      row.title,
      x - 6,
      y + 1,
      innerWidth + 12,
      rowLayout.height - 7,
      snapshot.onActivate
    );
    region.on('pointerover', () => {
      hover.alpha = 1;
    });
    region.on('pointerout', () => {
      hover.alpha = 0;
    });
  }

  const color = SEVERITY_COLORS[row.severity] ?? GPU_COLORS.muted;
  const dot = new Graphics();
  dot.circle(x + 3, y + 14, 3);
  dot.fill({ color, alpha: 0.95 });
  dot.eventMode = 'none';
  parent.addChild(dot);

  const stamp = relativeTime(row.at, snapshot.t, snapshot.state.locale) || truncate(row.at, 19);
  const stampWidth = Math.min(118, ctx.measureText(stamp, { size: 9 }) + 4);
  const stampX = x + innerWidth - stampWidth;
  ctx.text(parent, stamp, stampX, y + 9, {
    size: 9,
    color: GPU_COLORS.muted,
    width: stampWidth,
    singleLine: true,
  });
  const exact = timestampTooltip(row.at, snapshot.state.locale);
  if (exact) {
    ctx.tooltip(parent, { x: stampX, y: y + 9, width: stampWidth, height: 13, text: exact });
  }

  const titleWidth = Math.max(0, innerWidth - stampWidth - 18);
  ctx.text(
    parent,
    ctx.fitText(row.title, titleWidth, { size: TITLE_SIZE, weight: '700' }),
    x + ROW_TEXT_INSET,
    y + 7,
    { size: TITLE_SIZE, weight: '700', color: GPU_COLORS.text }
  );
  for (const [lineIndex, line] of rowLayout.lines.entries()) {
    // Already wrapped against the measured width; singleLine is the backstop
    // that keeps a measurement disagreement inside its own line.
    ctx.text(parent, line, x + ROW_TEXT_INSET, y + BODY_TOP + lineIndex * BODY_LINE_HEIGHT, {
      size: BODY_SIZE,
      color: GPU_COLORS.muted,
      width: innerWidth - ROW_TEXT_INSET,
      singleLine: true,
    });
  }

  const rule = new Graphics();
  rule.moveTo(x, y + rowLayout.height - 5);
  rule.lineTo(x + innerWidth, y + rowLayout.height - 5);
  rule.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.35 });
  rule.eventMode = 'none';
  parent.addChild(rule);
}

/**
 * The bell control itself, shared by the overview header and the focus rail:
 * one `button()` frame (its hover, shadow, activation and hit target) whose
 * label is drawn as vector geometry — a dome, a lip and a clapper — because
 * the chrome's iconography is drawn, never emoji glyphs.
 */
export function drawNotificationsBell(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  x: number,
  y: number,
  width: number,
  height: number
): Container {
  const control = ctx.button(
    ctx.root,
    'notifications.menu.toggle',
    'button',
    '',
    x,
    y,
    width,
    height,
    snapshot.state.notificationsMenuOpen,
    snapshot.onActivate,
    GPU_COLORS.primary,
    true,
    false,
    undefined,
    undefined,
    snapshot.t('notifications.open')
  );
  const active = snapshot.state.notificationsMenuOpen;
  const bell = new Graphics();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.21;
  // Dome: an arc over two shoulders flaring to the lip.
  bell
    .moveTo(cx - r - 2.5, cy + r * 0.62)
    .lineTo(cx - r + 0.5, cy + r * 0.42)
    .lineTo(cx - r + 0.5, cy - r * 0.28)
    .arc(cx, cy - r * 0.28, r - 0.5, Math.PI, 0)
    .lineTo(cx + r - 0.5, cy + r * 0.42)
    .lineTo(cx + r + 2.5, cy + r * 0.62)
    .closePath()
    .fill({ color: active ? GPU_COLORS.text : GPU_COLORS.muted, alpha: active ? 1 : 0.9 });
  // Clapper.
  bell.circle(cx, cy + r * 0.62 + 2.6, 1.7);
  bell.fill({ color: active ? GPU_COLORS.text : GPU_COLORS.muted, alpha: active ? 1 : 0.9 });
  bell.eventMode = 'none';
  control.addChild(bell);
  return control;
}
