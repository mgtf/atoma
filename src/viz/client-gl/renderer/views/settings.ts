import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_CONTENT_TOP } from '../view-frame.js';

/**
 * SETTINGS — the account's own page, reached from the header orb and
 * deliberately absent from the nav tabs (`isRoutableView` in store.ts).
 *
 * The display-name field and the rest of Settings (models, keys, org
 * directory) are real DOM (`.gpu-settings-form` / `.gpu-org-models-form`).
 * GPU draws the column frame and the account orb only: a second copy of the
 * directory in the scroll pane painted *through* the form (the 2026-08-27
 * overlap). Membership is still changed by invitation, in the admin plane.
 */

/** Settings reads as a centred column; Projects and Admin went full-bleed. */
const SETTINGS_COLUMN_MAX_WIDTH = 720;
/**
 * Must match `.gpu-settings-form { top }` in styles.css: the account orb is
 * the first thing inside the column frame, and the rename field sits under it.
 */
export const SETTINGS_DOM_FORM_TOP =
  GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP + 56 + 12;
export const SETTINGS_DOM_FORM_HEIGHT = 96;
/** Must match `.gpu-org-models-form { top }` — sits under the rename form. */
export const SETTINGS_LLM_FORM_TOP = SETTINGS_DOM_FORM_TOP + SETTINGS_DOM_FORM_HEIGHT + 16;
const ORB_SIZE = 56;
/** Height of one member row; exported so the layout test speaks the same unit. */
export const MEMBER_ROW_HEIGHT = 30;
/** Panel-local geometry, shared by the frame's height and the rows it must hold. */
const PANEL_BOTTOM_PAD = 16;
const FACTS_TOP = 38;
const FACT_LINE_HEIGHT = 26;
const MEMBERS_HEADER_GAP = 10;
const MEMBERS_LIST_GAP = 18;
const PANEL_GAP = 16;

export function settingsGpuContentTop(): number {
  return SETTINGS_DOM_FORM_TOP + SETTINGS_DOM_FORM_HEIGHT + PANEL_GAP;
}

export interface OrganisationPanelLayout {
  /** Fact pairs are laid out two per line; this is how many lines that takes. */
  readonly factLines: number;
  readonly membersHeaderY: number;
  readonly firstMemberY: number;
  readonly height: number;
}

/**
 * ONE definition of the organisation panel's geometry.
 *
 * The frame's height and the rows drawn inside it were computed
 * independently, the height from a hand-tuned constant — so an owner (who
 * sees one extra fact, the pending invitation count) pushed the member list
 * past the bottom edge and the last row was clipped. Deriving both from here
 * makes that class of drift impossible rather than merely fixed.
 */
export function organisationPanelLayout(
  factCount: number,
  memberCount: number,
  factColumns = 2,
  memberRowHeight = MEMBER_ROW_HEIGHT
): OrganisationPanelLayout {
  const factLines = Math.ceil(factCount / factColumns);
  const membersHeaderY = FACTS_TOP + factLines * FACT_LINE_HEIGHT + MEMBERS_HEADER_GAP;
  const firstMemberY = membersHeaderY + MEMBERS_LIST_GAP;
  return {
    factLines,
    membersHeaderY,
    firstMemberY,
    height: firstMemberY + memberCount * memberRowHeight + PANEL_BOTTOM_PAD,
  };
}

/**
 * Where the account orb sits INSIDE the column frame — its x follows the
 * frame, so only the vertical placement and the size are fixed here.
 */
export const SETTINGS_ORB = {
  y: GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP,
  size: ORB_SIZE,
} as const;

export function drawSettings(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const auth = snapshot.data.auth;

  const frame = viewFrame(width, height, SETTINGS_COLUMN_MAX_WIDTH);
  drawViewFrame(ctx, frame, snapshot.t('nav.settings'));

  if (auth) {
    // The same orb as the header, larger — its OWN slot, because the header
    // draws its orb in the same frame and one slot had them evicting each
    // other every render.
    ctx.retainAvatarOrb(
      'settings',
      frame.innerX,
      SETTINGS_ORB.y,
      SETTINGS_ORB.size,
      auth.viewer.avatarUrl,
      auth.viewer.principalId,
      false
    );
    ctx.text(
      ctx.root,
      auth.viewer.displayNameSource === 'user'
        ? snapshot.t('settings.displayNameOwn')
        : snapshot.t('settings.displayNameProvider'),
      frame.innerX + ORB_SIZE + 18,
      SETTINGS_ORB.y + 18,
      { size: 11, color: GPU_COLORS.muted, width: Math.max(120, frame.innerWidth - ORB_SIZE - 30) }
    );
  }

  // Models, keys and the organisation directory live in DOM filling the
  // frame under the rename field. Nothing GPU is drawn there — a pane that
  // reserved a band and then painted the directory is what overlapped.
  ctx.scrollMax.settings = 0;
}
