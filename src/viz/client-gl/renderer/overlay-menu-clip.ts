import type { AuthUiSnapshot } from '../AuthControls.js';
import {
  accountMenuLayout,
  type AccountMenuAnchor,
} from './views/account-menu.js';
import {
  localeMenuLayout,
  type LocaleMenuAnchor,
} from './views/locale-menu.js';
import {
  notificationsMenuLayout,
  type NotificationMeasure,
  type NotificationsMenuAnchor,
  type NotificationsMenuData,
} from './views/notifications-menu.js';

/**
 * Extra hole around a Pixi overlay menu. DOM forms paint above the canvas, so
 * the clip must cover the panel stroke or a field still shows through the rim.
 */
export const OVERLAY_MENU_CLIP_PAD = 8;

export interface OverlayMenuClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The same layout the GL menus draw, so the DOM hole tracks the panel rather
 * than a guessed top-right band. Null when no overlay menu is open.
 */
export function overlayMenuClip(
  snapshot: {
    readonly data: { readonly auth?: AuthUiSnapshot | null } & NotificationsMenuData;
    readonly state: {
      readonly accountMenuOpen: boolean;
      readonly localeMenuOpen: boolean;
      readonly notificationsMenuOpen: boolean;
    };
  },
  viewportWidth: number,
  viewportHeight: number,
  anchors: {
    readonly account?: AccountMenuAnchor;
    readonly locale: LocaleMenuAnchor;
    readonly notifications?: NotificationsMenuAnchor;
  },
  /**
   * The renderer's own text measure. The tray's rows wrap prose, so its panel
   * height is a MEASURED fact — the hole must be cut from the same measure the
   * draw used or the veil clips through the panel's last rows.
   */
  measure: NotificationMeasure
): OverlayMenuClipRect | null {
  // The chrome menus are exclusive in the store, so order here is tie-breaking
  // paranoia, not policy.
  const auth = snapshot.data.auth;
  if (auth && snapshot.state.accountMenuOpen) {
    return accountMenuLayout(viewportWidth, auth, anchors.account);
  }
  if (auth && snapshot.state.notificationsMenuOpen && anchors.notifications) {
    return notificationsMenuLayout(
      viewportWidth,
      viewportHeight,
      anchors.notifications,
      snapshot.data,
      measure
    );
  }
  if (snapshot.state.localeMenuOpen) {
    return localeMenuLayout(viewportWidth, viewportHeight, anchors.locale);
  }
  return null;
}

/** Publish the hole in renderer pixels for `.gpu-overlays-veiled` clip-path. */
export function publishOverlayMenuClip(layout: OverlayMenuClipRect | null): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  if (!layout) {
    style.setProperty('--gpu-chrome-menu-x', '-10000px');
    style.setProperty('--gpu-chrome-menu-y', '0px');
    style.setProperty('--gpu-chrome-menu-w', '0px');
    style.setProperty('--gpu-chrome-menu-h', '0px');
    return;
  }
  style.setProperty('--gpu-chrome-menu-x', `${layout.x - OVERLAY_MENU_CLIP_PAD}px`);
  style.setProperty('--gpu-chrome-menu-y', `${layout.y - OVERLAY_MENU_CLIP_PAD}px`);
  style.setProperty(
    '--gpu-chrome-menu-w',
    `${layout.width + OVERLAY_MENU_CLIP_PAD * 2}px`
  );
  style.setProperty(
    '--gpu-chrome-menu-h',
    `${layout.height + OVERLAY_MENU_CLIP_PAD * 2}px`
  );
}
