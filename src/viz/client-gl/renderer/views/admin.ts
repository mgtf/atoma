import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * Admin plane: every organisation with its members, and one-use invitations
 * minted per organisation. Platform admin only — the server 403s everyone
 * else, and `visibleViews` never offers the tab to anyone else either.
 *
 * A minted invitation is a bearer credential shown EXACTLY once: it is
 * rendered until the next mint or refresh and the clipboard receives the URL
 * at mint time (see GpuApp); nothing here persists it.
 */

const HEADER_Y = 78;
const LIST_TOP = 12;
const ORG_HEADER_HEIGHT = 34;
const MEMBER_ROW_HEIGHT = 20;
const INVITE_ROW_HEIGHT = 40;
const ORG_GAP = 18;
const INVITE_PANEL_HEIGHT = 84;

export function drawAdmin(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const organisations = snapshot.data.adminOrganisations ?? [];
  const invitation = snapshot.data.adminInvitation ?? null;
  const failure = snapshot.data.adminError ?? null;
  const scroll = snapshot.state.scrollY.admin;

  ctx.text(ctx.root, snapshot.t('nav.admin'), 20, HEADER_Y, { size: 18, weight: '700' });
  ctx.text(
    ctx.root,
    snapshot.t('admin.summary', { count: organisations.length }),
    20 + 200,
    HEADER_Y + 6,
    { size: 11, color: GPU_COLORS.muted }
  );

  const contentTop = HEADER_Y + 34;
  const pane = createScrollPane(ctx.root, {
    x: 0,
    y: contentTop,
    width,
    height: Math.max(0, height - contentTop),
    scrollY: scroll,
    bottomPadding: 24,
  });

  const panelWidth = Math.min(880, width - GPU_LAYOUT.gap * 2);
  const x = (width - panelWidth) / 2;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;

  let cursor = LIST_TOP;

  if (invitation || failure) {
    ctx.panel(
      pane.content,
      x,
      cursor,
      panelWidth,
      INVITE_PANEL_HEIGHT,
      GPU_COLORS.panel,
      failure ? GPU_COLORS.error : GPU_COLORS.success,
      GPU_LAYOUT.radius,
      2
    );
    if (failure) {
      ctx.text(pane.content, failure, columnX, cursor + 14, {
        size: 11,
        color: GPU_COLORS.error,
        width: innerWidth,
      });
    } else if (invitation) {
      ctx.text(
        pane.content,
        snapshot.t('admin.invitationReady', {
          role: invitation.role,
          name: invitation.orgName,
          expires: invitation.expiresAt,
        }),
        columnX,
        cursor + 12,
        { size: 11, color: GPU_COLORS.success, width: innerWidth }
      );
      // The full URL, visible for manual transcription: GL text is not
      // selectable, which is exactly why the clipboard copy happened at mint
      // time — this line is the fallback, not the primary channel.
      ctx.text(pane.content, invitation.url, columnX, cursor + 36, {
        size: 9,
        color: GPU_COLORS.text,
        mono: true,
        width: innerWidth,
      });
      ctx.text(pane.content, snapshot.t('admin.invitationCopied'), columnX, cursor + 58, {
        size: 9,
        color: GPU_COLORS.muted,
        width: innerWidth,
      });
    }
    cursor += INVITE_PANEL_HEIGHT + ORG_GAP;
  }

  if (organisations.length === 0) {
    ctx.text(pane.content, snapshot.t('admin.empty'), columnX, cursor, {
      size: 13,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 24;
  }

  for (const organisation of organisations) {
    const orgHeight =
      ORG_HEADER_HEIGHT + organisation.members.length * MEMBER_ROW_HEIGHT + INVITE_ROW_HEIGHT + 12;
    ctx.panel(
      pane.content,
      x,
      cursor,
      panelWidth,
      orgHeight,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
    ctx.text(pane.content, truncate(organisation.name, 64), columnX, cursor + 10, {
      size: 13,
      weight: '600',
      width: innerWidth - 220,
    });
    ctx.text(pane.content, organisation.orgId, columnX + innerWidth - 300, cursor + 13, {
      size: 8,
      color: GPU_COLORS.muted,
      mono: true,
      width: 300,
    });
    let memberY = cursor + ORG_HEADER_HEIGHT;
    for (const member of organisation.members) {
      ctx.text(pane.content, truncate(member.displayName, 48), columnX + 12, memberY, {
        size: 10,
        width: innerWidth - 220,
      });
      ctx.text(pane.content, member.role, columnX + innerWidth - 160, memberY, {
        size: 9,
        color: GPU_COLORS.muted,
        mono: true,
        width: 160,
      });
      memberY += MEMBER_ROW_HEIGHT;
    }
    // Two invitations cover the model the operator described — owner and
    // user (org:member). Finer roles stay on the CLI.
    ctx.button(
      pane.content,
      `admin.invite.org:member.${organisation.orgId}`,
      'button',
      snapshot.t('admin.inviteUser'),
      columnX + 12,
      memberY + 6,
      180,
      26,
      false,
      snapshot.onActivate
    );
    ctx.button(
      pane.content,
      `admin.invite.org:owner.${organisation.orgId}`,
      'button',
      snapshot.t('admin.inviteOwner'),
      columnX + 204,
      memberY + 6,
      180,
      26,
      false,
      snapshot.onActivate
    );
    cursor += orgHeight + ORG_GAP;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.admin = pane.finish();
}
