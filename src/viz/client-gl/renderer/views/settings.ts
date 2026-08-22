import { Container } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { TIER_MODEL_CHOICES } from '../../../../contracts/tierModels.js';
import { attachAvatarChip } from '../avatar-orb.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_CONTENT_TOP, VIEW_FRAME_PAD } from '../view-frame.js';

/**
 * SETTINGS — the account's own page, reached from the header orb and
 * deliberately absent from the nav tabs (`isRoutableView` in store.ts).
 *
 * Three panels: who you are, which model each tier uses for YOUR runs, and the
 * organisation you are in. Only the first two are writable; organisation
 * membership is changed by invitation, in the admin plane.
 *
 * The display-name field is real DOM (`.gpu-settings-form`, laid out against
 * the constants below) for the same reason the project form is: text entry,
 * autofill and screen readers belong to the browser. Everything else is GL.
 */

/** Settings reads as a centred column, like Projects and Admin. */
const SETTINGS_COLUMN_MAX_WIDTH = 720;
/**
 * Must match `.gpu-settings-form { top }` in styles.css: the account orb is
 * the first thing inside the column frame, and the rename field sits under it.
 */
export const SETTINGS_DOM_FORM_TOP =
  GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP + 56 + 12;
export const SETTINGS_DOM_FORM_HEIGHT = 96;
const ORB_SIZE = 56;
const TIER_ROW_HEIGHT = 42;
const TIER_CHIP_HEIGHT = 26;
/** Height of one member row; exported so the layout test speaks the same unit. */
export const MEMBER_ROW_HEIGHT = 30;
/** Panel-local geometry, shared by the frame's height and the rows it must hold. */
const PANEL_TITLE_Y = 14;
const PANEL_BOTTOM_PAD = 16;
const FACTS_TOP = 38;
const FACT_LINE_HEIGHT = 26;
const MEMBERS_HEADER_GAP = 10;
const MEMBERS_LIST_GAP = 18;
/** Right-hand columns of a member row, measured back from the panel's inner edge. */
const MEMBER_ROLE_COLUMN = 128;
const MEMBER_JOINED_COLUMN = 268;
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

/**
 * Display copy for a model id. The stored value stays the full id — this is
 * only what a 90-pixel chip can carry.
 */
export function modelChipLabel(model: string): string {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return model;
  const family = match[1]!;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2]!;
  return `${name} ${version}`;
}

/** Activation id for one tier/choice cell. `default` clears the pin. */
export function settingsModelId(tier: 1 | 2 | 3, choice: number | 'default'): string {
  return `settings.model.${tier}.${choice}`;
}

/** Parse one back, or null when the id is not a model cell. */
export function parseSettingsModelId(
  id: string
): { tier: 1 | 2 | 3; model: string | null } | null {
  const match = /^settings\.model\.([123])\.(default|[0-9]+)$/.exec(id);
  if (!match) return null;
  const tier = Number(match[1]) as 1 | 2 | 3;
  if (match[2] === 'default') return { tier, model: null };
  const model = TIER_MODEL_CHOICES[Number(match[2])];
  return model ? { tier, model } : null;
}

export function drawSettings(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const auth = snapshot.data.auth;
  const models = snapshot.data.accountModels;
  const organisation = snapshot.data.organisation;

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

  const contentTop = settingsGpuContentTop();
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.settings,
    bottomPadding: 24,
  });
  const LEFT = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const innerX = LEFT + 18;
  const innerWidth = panelWidth - 36;
  const compactColumns = innerWidth < 360;
  let cursor = 0;

  // Panel FRAMES go here, and this layer is added first so it paints behind
  // everything below. Both panels size themselves from content they can only
  // measure after drawing it — a frame appended afterwards would cover it.
  const frames = new Container();
  pane.content.addChild(frames);

  // ------------------------------------------------------------ tier models
  ctx.text(pane.content, snapshot.t('settings.models'), innerX, cursor + PANEL_TITLE_Y, {
    size: 13,
    weight: '700',
  });
  // The hint wraps on a narrow viewport; the rows start below where it
  // ACTUALLY ended, not below where one line would have.
  const hint = ctx.text(pane.content, snapshot.t('settings.modelsHint'), innerX, cursor + 34, {
    size: 10,
    color: GPU_COLORS.muted,
    width: innerWidth,
  });
  const rowsTop = cursor + 34 + Math.max(20, hint.height) + 12;
  let rowY = rowsTop;
  let lastChipBottom = rowsTop;
  for (const tier of [1, 2, 3] as const) {
    const pinned = models ? models.pins[`l${tier}`] : null;
    const fallbackModel = models?.defaults[`l${tier}`] ?? null;
    ctx.text(pane.content, snapshot.t(`settings.tier${tier}`), innerX, rowY + 4, {
      size: 10,
      color: GPU_COLORS.tiers[tier],
      weight: '700',
      width: compactColumns ? innerWidth : 168,
    });
    const chipsX = compactColumns ? innerX : innerX + 176;
    const chipsY = compactColumns ? rowY + 20 : rowY;
    const available = compactColumns ? innerWidth : Math.max(0, innerWidth - 176);
    // 1.6 units for default + 3×0.78 choices + three 6px gaps.
    const chipWidth = Math.max(0, Math.min(112, (available - 18) / 3.94));
    ctx.filterButton(
      pane.content,
      settingsModelId(tier, 'default'),
      fallbackModel
        ? `${snapshot.t('settings.operatorDefault')} · ${modelChipLabel(fallbackModel)}`
        : snapshot.t('settings.operatorDefault'),
      chipsX,
      chipsY,
      chipWidth * 1.6,
      TIER_CHIP_HEIGHT,
      pinned === null,
      snapshot.onActivate,
      GPU_COLORS.muted
    );
    TIER_MODEL_CHOICES.forEach((choice, index) => {
      ctx.filterButton(
        pane.content,
        settingsModelId(tier, index),
        modelChipLabel(choice),
        chipsX + chipWidth * 1.6 + 6 + index * (chipWidth * 0.78 + 6),
        chipsY,
        chipWidth * 0.78,
        TIER_CHIP_HEIGHT,
        pinned === choice,
        snapshot.onActivate,
        GPU_COLORS.tiers[tier]
      );
    });
    lastChipBottom = chipsY + TIER_CHIP_HEIGHT;
    rowY += compactColumns ? 58 : TIER_ROW_HEIGHT;
  }
  let modelsBottom = lastChipBottom + PANEL_BOTTOM_PAD;
  if (snapshot.data.accountError) {
    const failure = ctx.text(pane.content, snapshot.data.accountError, innerX, rowY, {
      size: 10,
      color: GPU_COLORS.error,
      width: innerWidth,
    });
    modelsBottom = rowY + Math.max(14, failure.height) + PANEL_BOTTOM_PAD;
  }
  ctx.panel(frames, LEFT, cursor, panelWidth, modelsBottom - cursor);
  cursor = modelsBottom + PANEL_GAP;

  // ----------------------------------------------------------- organisation
  if (organisation) {
    ctx.text(pane.content, organisation.name, innerX, cursor + PANEL_TITLE_Y, {
      size: 13,
      weight: '700',
      width: innerWidth,
    });
    const facts: Array<[string, string]> = [
      [snapshot.t('settings.orgId'), organisation.id],
      [snapshot.t('settings.orgCreated'), organisation.createdAt.slice(0, 10)],
      [
        snapshot.t('settings.yourRole'),
        snapshot.t(`auth.role.${organisation.viewerRole}`),
      ],
      [snapshot.t('settings.projects'), String(organisation.projectCount)],
    ];
    if (organisation.pendingInvitations !== null) {
      facts.push([
        snapshot.t('settings.pendingInvitations'),
        String(organisation.pendingInvitations),
      ]);
    }
    const factColumns = compactColumns ? 1 : 2;
    const memberRowHeight = compactColumns ? 56 : MEMBER_ROW_HEIGHT;
    const orgLayout = organisationPanelLayout(
      facts.length,
      organisation.members.length,
      factColumns,
      memberRowHeight
    );
    facts.forEach(([label, value], index) => {
      const column = index % factColumns;
      const line = Math.floor(index / factColumns);
      const factWidth = innerWidth / factColumns;
      const factX = innerX + column * factWidth;
      ctx.text(pane.content, label.toUpperCase(), factX, cursor + FACTS_TOP + line * FACT_LINE_HEIGHT, {
        size: 8,
        color: GPU_COLORS.muted,
        weight: '700',
      });
      ctx.text(pane.content, value, factX, cursor + FACTS_TOP + 11 + line * FACT_LINE_HEIGHT, {
        size: 10,
        color: GPU_COLORS.text,
        mono: true,
        width: Math.max(0, factWidth - 12),
      });
    });

    ctx.text(
      pane.content,
      snapshot.t('settings.members', { count: organisation.members.length }),
      innerX,
      cursor + orgLayout.membersHeaderY,
      { size: 10, weight: '700', color: GPU_COLORS.muted }
    );
    organisation.members.forEach((member, index) => {
      const memberY = cursor + orgLayout.firstMemberY + index * memberRowHeight;
      attachAvatarChip(pane.content, {
        x: innerX,
        y: memberY,
        size: 22,
        photoUrl: member.avatarUrl ?? null,
        seed: member.principalId,
      });
      // Three left-aligned columns rather than anchored right edges: `text()`
      // treats `width` as a wrap bound, so a zero-width right-aligned label
      // wraps to one character per line.
      const roleColumn = compactColumns
        ? innerX + 32
        : innerX + innerWidth - MEMBER_ROLE_COLUMN;
      const joinedColumn = compactColumns
        ? innerX + 32
        : innerX + innerWidth - MEMBER_JOINED_COLUMN;
      ctx.text(
        pane.content,
        truncate(member.displayName, 34),
        innerX + 32,
        memberY + 2,
        {
          size: 11,
          width: compactColumns
            ? Math.max(0, innerWidth - 32)
            : Math.max(60, joinedColumn - innerX - 44),
        }
      );
      if (member.joinedAt) {
        ctx.text(
          pane.content,
          snapshot.t('settings.joined', { date: member.joinedAt.slice(0, 10) }),
          joinedColumn,
          memberY + (compactColumns ? 19 : 4),
          {
            size: 9,
            color: GPU_COLORS.muted,
            mono: true,
            width: compactColumns
              ? Math.max(0, innerWidth - 32)
              : MEMBER_JOINED_COLUMN - MEMBER_ROLE_COLUMN - 12,
          }
        );
      }
      const role = snapshot.t(`auth.role.${member.role}`);
      ctx.text(pane.content, role.toUpperCase(), roleColumn, memberY + (compactColumns ? 33 : 3), {
        size: 9,
        weight: '700',
        width: compactColumns ? Math.max(0, innerWidth - 32) : MEMBER_ROLE_COLUMN - 8,
        color:
          member.role === 'org:owner' || member.role === 'org:admin'
            ? GPU_COLORS.tiers[2]
            : GPU_COLORS.muted,
      });
      if (member.platformAdmin) {
        ctx.text(
          pane.content,
          snapshot.t('auth.platformAdmin').toUpperCase(),
          roleColumn,
          memberY + (compactColumns ? 45 : 15),
          {
            size: 8,
            weight: '700',
            width: compactColumns ? Math.max(0, innerWidth - 32) : MEMBER_ROLE_COLUMN - 8,
            color: GPU_COLORS.tiers[3],
          }
        );
      }
    });
    ctx.panel(frames, LEFT, cursor, panelWidth, orgLayout.height);
    cursor += orgLayout.height + PANEL_GAP;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.settings = pane.finish();
}
