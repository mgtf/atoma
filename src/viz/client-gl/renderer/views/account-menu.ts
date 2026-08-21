import { Graphics, Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import type { AuthUiSnapshot } from '../../AuthControls.js';

/**
 * THE ACCOUNT MENU — what used to be a panel pinned to the bottom-right
 * corner, now anchored under the header orb where an account menu belongs.
 *
 * Drawn from `drawOverlays`, on the same layer as the run picker, so it sits
 * above every view. It opens on the orb and closes on navigation (see
 * `setView` in store.ts) or on a click anywhere else — the scrim below is a
 * real hit target because the Pixi stage has no background handler of its own.
 */

const EDGE = 12;
const PANEL_WIDTH = 272;
const IDENTITY_HEIGHT = 54;
const ORG_HEIGHT = 36;
const ROW_HEIGHT = 30;
const ACTION_HEIGHT = 32;
const DIVIDER_HEIGHT = 9;
const FAILURE_HEIGHT = 20;

export type AccountMenuItemKind =
  | 'identity'
  | 'organisation'
  | 'switch'
  | 'divider'
  | 'settings'
  | 'signOut'
  | 'failure';

export interface AccountMenuItem {
  readonly kind: AccountMenuItemKind;
  /** Activation id, for the rows that are controls. */
  readonly id?: string;
  /** Organisation name, for switch rows. */
  readonly name?: string;
  /** Offset from the panel top. */
  readonly y: number;
  readonly height: number;
}

export interface AccountMenuLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly items: readonly AccountMenuItem[];
}

/**
 * Pure layout, so the row set can be asserted without a GPU. Ordering is the
 * contract: who you are, where you are, where else you could be, then the two
 * actions.
 */
export function accountMenuLayout(
  viewportWidth: number,
  auth: AuthUiSnapshot
): AccountMenuLayout {
  const width = Math.min(PANEL_WIDTH, Math.max(200, viewportWidth - EDGE * 2));
  const items: AccountMenuItem[] = [];
  let cursor = 0;
  const push = (item: Omit<AccountMenuItem, 'y'>): void => {
    items.push({ ...item, y: cursor });
    cursor += item.height;
  };

  push({ kind: 'identity', height: IDENTITY_HEIGHT });
  if (auth.viewer.activeOrganisation) push({ kind: 'organisation', height: ORG_HEIGHT });
  for (const organisation of auth.viewer.organisations) {
    if (organisation.id === auth.viewer.activeOrganisation?.id) continue;
    push({
      kind: 'switch',
      id: `org.switch.${organisation.id}`,
      name: organisation.name,
      height: ROW_HEIGHT,
    });
  }
  push({ kind: 'divider', height: DIVIDER_HEIGHT });
  push({ kind: 'settings', id: 'account.settings', height: ACTION_HEIGHT });
  push({ kind: 'signOut', id: 'auth.signOut', height: ACTION_HEIGHT });
  if (auth.failure) push({ kind: 'failure', height: FAILURE_HEIGHT });

  return {
    x: Math.max(EDGE, viewportWidth - width - EDGE),
    y: GPU_LAYOUT.headerHeight + 6,
    width,
    height: cursor + 10,
    items,
  };
}

/** The role a viewer holds, plus the operator flag when they carry it. */
function roleLabel(snapshot: GpuRenderSnapshot, role: string): string {
  const translated = snapshot.t(`auth.role.${role}`);
  // An unknown role must still read as something: the catalogs cover the four
  // org roles, and `translate` returns the key itself for anything else.
  return translated === `auth.role.${role}` ? role : translated;
}

export function drawAccountMenu(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  viewportWidth: number,
  viewportHeight: number
): void {
  const auth = snapshot.data.auth;
  if (!auth || !snapshot.state.accountMenuOpen) return;
  const layout = accountMenuLayout(viewportWidth, auth);

  // Click-away. Pixi has no stage-level pointer handler, so the only way to
  // close on an outside click is a real object under the panel. It also reads
  // as a veil, which is what a menu this size wants.
  const scrim = new Graphics();
  scrim.rect(0, 0, viewportWidth, viewportHeight);
  scrim.fill({ color: 0x050810, alpha: 0.28 });
  scrim.eventMode = 'static';
  scrim.cursor = 'default';
  scrim.hitArea = new Rectangle(0, 0, viewportWidth, viewportHeight);
  scrim.on('pointertap', () => snapshot.onActivate('account.menu.close'));
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
  for (const item of layout.items) {
    const y = layout.y + item.y;
    if (item.kind === 'identity') {
      ctx.text(ctx.root, auth.viewer.displayName, innerX, y + 10, {
        size: 13,
        weight: '700',
        width: innerWidth,
      });
      const role = roleLabel(snapshot, auth.viewer.role);
      ctx.text(ctx.root, role.toUpperCase(), innerX, y + 31, {
        size: 9,
        weight: '700',
        color:
          auth.viewer.role === 'org:owner' || auth.viewer.role === 'org:admin'
            ? GPU_COLORS.tiers[2]
            : GPU_COLORS.muted,
      });
      if (auth.viewer.platformAdmin) {
        ctx.text(
          ctx.root,
          snapshot.t('auth.platformAdmin').toUpperCase(),
          innerX + Math.max(60, role.length * 7 + 14),
          y + 31,
          { size: 9, weight: '700', color: GPU_COLORS.tiers[3] }
        );
      }
      continue;
    }
    if (item.kind === 'organisation' && auth.viewer.activeOrganisation) {
      ctx.text(ctx.root, snapshot.t('settings.organisation').toUpperCase(), innerX, y + 2, {
        size: 8,
        weight: '700',
        color: GPU_COLORS.muted,
      });
      ctx.text(ctx.root, auth.viewer.activeOrganisation.name, innerX, y + 15, {
        size: 11,
        color: GPU_COLORS.text,
        width: innerWidth,
        mono: true,
      });
      continue;
    }
    if (item.kind === 'switch' && item.id) {
      ctx.button(
        ctx.root,
        item.id,
        'menuitem',
        snapshot.t('auth.switchToOrganisation', { name: item.name ?? '' }),
        innerX,
        y,
        innerWidth,
        ROW_HEIGHT - 4,
        false,
        snapshot.onActivate,
        GPU_COLORS.primary,
        false,
        auth.switchingOrganisationId === item.id.slice('org.switch.'.length)
      );
      continue;
    }
    if (item.kind === 'divider') {
      const rule = new Graphics();
      rule.moveTo(innerX, y + 4);
      rule.lineTo(innerX + innerWidth, y + 4);
      rule.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.8 });
      rule.eventMode = 'none';
      ctx.root.addChild(rule);
      continue;
    }
    if (item.kind === 'settings' && item.id) {
      ctx.button(
        ctx.root,
        item.id,
        'menuitem',
        snapshot.t('nav.settings'),
        innerX,
        y,
        innerWidth,
        ACTION_HEIGHT - 4,
        snapshot.state.view === 'settings',
        snapshot.onActivate,
        GPU_COLORS.primary
      );
      continue;
    }
    if (item.kind === 'signOut' && item.id) {
      ctx.button(
        ctx.root,
        item.id,
        'menuitem',
        snapshot.t('auth.signOut'),
        innerX,
        y,
        innerWidth,
        ACTION_HEIGHT - 4,
        false,
        snapshot.onActivate,
        GPU_COLORS.warning,
        false,
        auth.signingOut
      );
      continue;
    }
    if (item.kind === 'failure') {
      ctx.text(ctx.root, snapshot.t('auth.actionFailed'), innerX, y, {
        size: 10,
        color: GPU_COLORS.error,
        width: innerWidth,
      });
    }
  }
}
