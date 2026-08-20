import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';

const EDGE = 14;
const MAX_WIDTH = 400;
const BASE_HEIGHT = 72;
const FAILURE_HEIGHT = 22;

export interface AuthAccountLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  buttonX: number;
  buttonY: number;
  buttonWidth: number;
}

export function authAccountLayout(
  viewportWidth: number,
  viewportHeight: number,
  hasFailure: boolean
): AuthAccountLayout {
  const width = Math.min(MAX_WIDTH, Math.max(180, viewportWidth - EDGE * 2));
  const height = BASE_HEIGHT + (hasFailure ? FAILURE_HEIGHT : 0);
  const buttonWidth = Math.min(116, Math.max(86, width * 0.32));
  const x = Math.max(EDGE, viewportWidth - width - EDGE);
  const y = Math.max(EDGE, viewportHeight - height - EDGE);
  return {
    x,
    y,
    width,
    height,
    buttonX: x + width - buttonWidth - 10,
    buttonY: y + 14,
    buttonWidth,
  };
}

/** Project the authenticated account into the one Pixi scene. */
export function drawAuthAccount(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  viewportWidth: number,
  viewportHeight: number
): void {
  const auth = snapshot.data.auth;
  if (!auth) return;

  const layout = authAccountLayout(viewportWidth, viewportHeight, auth.failure);
  ctx.panel(ctx.root, layout.x, layout.y, layout.width, layout.height);
  ctx.text(
    ctx.root,
    snapshot.t('auth.signedInAs', { name: auth.viewer.displayName }),
    layout.x + 12,
    layout.y + 10,
    {
      size: 11,
      color: GPU_COLORS.muted,
      width: Math.max(40, layout.buttonX - layout.x - 24),
      mono: true,
    }
  );
  if (auth.viewer.activeOrganisation) {
    ctx.text(
      ctx.root,
      snapshot.t('auth.organisation', { name: auth.viewer.activeOrganisation.name }),
      layout.x + 12,
      layout.y + 30,
      {
        size: 10,
        color: GPU_COLORS.text,
        width: Math.max(40, layout.buttonX - layout.x - 24),
        mono: true,
      }
    );
  }
  const nextOrganisation = auth.viewer.organisations.find(
    (organisation) => organisation.id !== auth.viewer.activeOrganisation?.id
  );
  if (nextOrganisation) {
    ctx.button(
      ctx.root,
      `org.switch.${nextOrganisation.id}`,
      'button',
      snapshot.t('auth.switchOrganisation'),
      layout.buttonX - 100,
      layout.buttonY,
      92,
      30,
      auth.switchingOrganisationId !== null,
      snapshot.onActivate,
      GPU_COLORS.primary,
      true,
      auth.switchingOrganisationId !== null
    );
  }
  ctx.button(
    ctx.root,
    'auth.signOut',
    'button',
    snapshot.t('auth.signOut'),
    layout.buttonX,
    layout.buttonY,
    layout.buttonWidth,
    30,
    auth.signingOut,
    snapshot.onActivate,
    GPU_COLORS.primary,
    true,
    auth.signingOut
  );
  if (auth.failure) {
    ctx.text(
      ctx.root,
      snapshot.t('auth.actionFailed'),
      layout.x + 12,
      layout.y + BASE_HEIGHT,
      { size: 10, color: GPU_COLORS.warning, width: layout.width - 24, mono: true }
    );
  }
}
