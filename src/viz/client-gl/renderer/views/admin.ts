import { Container } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';

/**
 * Admin plane: every organisation with its members, and one-use invitations
 * minted per organisation. Platform admin only — the server 403s everyone
 * else, and `visibleViews` never offers the tab to anyone else either.
 *
 * A minted invitation is a bearer credential shown EXACTLY once: it is
 * rendered until the next mint or refresh and the clipboard receives the URL
 * at mint time (see GpuApp); nothing here persists it.
 */

/** Admin reads as a full-bleed column, like Projects and Burn-in. */
const LIST_TOP = 12;
const ORG_HEADER_HEIGHT = 34;
const MEMBER_ROW_HEIGHT = 20;
const INVITE_ROW_HEIGHT = 40;
const ORG_GAP = 18;
const INVITE_PANEL_HEIGHT = 84;
const SECTION_HEADING_HEIGHT = 30;
const JOURNAL_ROW_HEIGHT = 34;
const LEDGER_ROW_HEIGHT = 18;

/**
 * Severity → colour. Read through a lookup with a FALLBACK because the
 * server's vocabulary can be newer than this bundle: an unknown severity
 * renders in the muted colour rather than crashing the row.
 */
const SEVERITY_COLORS: Record<string, number> = {
  info: GPU_COLORS.muted,
  warning: GPU_COLORS.warning,
  error: GPU_COLORS.error,
  security: GPU_COLORS.magenta,
};

/** `HH:MM:SS` from an ISO instant, or the raw value if it will not parse. */
function clockTime(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? truncate(at, 19) : parsed.toISOString().slice(11, 19);
}

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

  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    snapshot.t('nav.admin'),
    snapshot.t('admin.summary', { count: organisations.length })
  );

  const contentTop = frame.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: scroll,
    bottomPadding: 24,
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compactColumns = innerWidth < 400;

  let cursor = LIST_TOP;

  if (invitation || failure) {
    // Reserve the frame's layer first, then size it from the text that wraps
    // inside it. A fixed 84px panel let long bearer URLs collide with the
    // copied notice on narrow windows.
    const frameLayer = new Container();
    pane.content.addChild(frameLayer);
    let invitationPanelHeight = INVITE_PANEL_HEIGHT;
    if (failure) {
      const error = ctx.text(pane.content, failure, columnX, cursor + 14, {
        size: 11,
        color: GPU_COLORS.error,
        width: innerWidth,
      });
      invitationPanelHeight = Math.max(INVITE_PANEL_HEIGHT, 28 + error.height);
    } else if (invitation) {
      const ready = ctx.text(
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
      let invitationY = cursor + 12 + Math.max(14, ready.height) + 8;
      // The full URL, visible for manual transcription: GL text is not
      // selectable, which is exactly why the clipboard copy happened at mint
      // time — this line is the fallback, not the primary channel.
      const url = ctx.text(pane.content, invitation.url, columnX, invitationY, {
        size: 9,
        color: GPU_COLORS.text,
        mono: true,
        width: innerWidth,
      });
      invitationY += Math.max(12, url.height) + 8;
      const copied = ctx.text(pane.content, snapshot.t('admin.invitationCopied'), columnX, invitationY, {
        size: 9,
        color: GPU_COLORS.muted,
        width: innerWidth,
      });
      invitationPanelHeight = Math.max(
        INVITE_PANEL_HEIGHT,
        invitationY - cursor + Math.max(12, copied.height) + 12
      );
    }
    ctx.panel(
      frameLayer,
      x,
      cursor,
      panelWidth,
      invitationPanelHeight,
      GPU_COLORS.panel,
      failure ? GPU_COLORS.error : GPU_COLORS.success,
      GPU_LAYOUT.radius,
      2
    );
    cursor += invitationPanelHeight + ORG_GAP;
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
    const orgHeaderHeight = compactColumns ? 54 : ORG_HEADER_HEIGHT;
    const inviteRowHeight = compactColumns ? 72 : INVITE_ROW_HEIGHT;
    const orgHeight =
      orgHeaderHeight + organisation.members.length * MEMBER_ROW_HEIGHT + inviteRowHeight + 12;
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
    ctx.text(
      pane.content,
      truncate(organisation.name, compactColumns ? 18 : 64),
      columnX,
      cursor + 10,
      {
        size: 13,
        weight: '600',
        width: compactColumns ? innerWidth : innerWidth - 220,
      }
    );
    ctx.text(
      pane.content,
      organisation.orgId,
      compactColumns ? columnX : columnX + innerWidth - 300,
      cursor + (compactColumns ? 32 : 13),
      {
        size: 8,
        color: GPU_COLORS.muted,
        mono: true,
        width: compactColumns ? innerWidth : 300,
      }
    );
    let memberY = cursor + orgHeaderHeight;
    for (const member of organisation.members) {
      const roleWidth = Math.min(160, Math.max(60, innerWidth * 0.35));
      ctx.text(pane.content, truncate(member.displayName, 48), columnX + 12, memberY, {
        size: 10,
        width: Math.max(20, innerWidth - roleWidth - 24),
      });
      ctx.text(pane.content, member.role, columnX + innerWidth - roleWidth, memberY, {
        size: 9,
        color: GPU_COLORS.muted,
        mono: true,
        width: roleWidth,
      });
      memberY += MEMBER_ROW_HEIGHT;
    }
    // Two invitations cover the model the operator described — owner and
    // user (org:member). Finer roles stay on the CLI.
    const inviteWidth = compactColumns ? Math.max(0, innerWidth - 24) : 180;
    ctx.button(
      pane.content,
      `admin.invite.org:member.${organisation.orgId}`,
      'button',
      snapshot.t('admin.inviteUser'),
      columnX + 12,
      memberY + 6,
      inviteWidth,
      26,
      false,
      snapshot.onActivate
    );
    ctx.button(
      pane.content,
      `admin.invite.org:owner.${organisation.orgId}`,
      'button',
      snapshot.t('admin.inviteOwner'),
      compactColumns ? columnX + 12 : columnX + 204,
      memberY + (compactColumns ? 38 : 6),
      inviteWidth,
      26,
      false,
      snapshot.onActivate
    );
    cursor += orgHeight + ORG_GAP;
  }

  // ------------------------------------------------- the platform journal
  // What happened on this deployment, newest first. Rows are rendered
  // TOLERANTLY: an unknown kind or severity from a newer server shows its
  // raw label rather than hiding the rows around it.
  const events = snapshot.data.adminEvents ?? [];
  const sectionHeadingHeight = compactColumns ? 48 : SECTION_HEADING_HEIGHT;
  const journalRowHeight = compactColumns ? 58 : JOURNAL_ROW_HEIGHT;
  const ledgerRowHeight = compactColumns ? 42 : LEDGER_ROW_HEIGHT;
  ctx.text(pane.content, snapshot.t('admin.journal'), columnX, cursor + 6, {
    size: 13,
    weight: '700',
  });
  ctx.text(
    pane.content,
    snapshot.t('admin.journalSummary', { count: events.length }),
    compactColumns ? columnX : columnX + 220,
    cursor + (compactColumns ? 25 : 8),
    {
      size: 10,
      color: GPU_COLORS.muted,
      width: compactColumns ? innerWidth : innerWidth - 240,
    }
  );
  cursor += sectionHeadingHeight;

  if (events.length === 0) {
    ctx.text(pane.content, snapshot.t('admin.journalEmpty'), columnX, cursor, {
      size: 11,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 24;
  } else {
    const journalHeight = events.length * journalRowHeight + 12;
    ctx.panel(
      pane.content,
      x,
      cursor,
      panelWidth,
      journalHeight,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
    let rowY = cursor + 8;
    for (const event of events) {
      // Cull by skipping the DRAW, never the cursor: a layout that stops
      // advancing would collapse everything below it.
      if (pane.visible(rowY, rowY + journalRowHeight)) {
        const color = SEVERITY_COLORS[event.severity] ?? GPU_COLORS.muted;
        ctx.text(pane.content, clockTime(event.at), columnX + 8, rowY, {
          size: 9,
          color: GPU_COLORS.muted,
          mono: true,
          width: 64,
        });
        ctx.text(pane.content, truncate(event.kind, 28), columnX + 78, rowY, {
          size: 10,
          color,
          mono: true,
          width: compactColumns ? Math.max(0, innerWidth - 86) : 200,
        });
        ctx.text(
          pane.content,
          truncate(event.summary, 96),
          columnX + 8,
          rowY + (compactColumns ? 32 : 15),
          {
          size: 10,
          color: GPU_COLORS.text,
          width: compactColumns ? Math.max(0, innerWidth - 16) : innerWidth - 120,
          }
        );
        ctx.text(
          pane.content,
          event.actorType,
          compactColumns ? columnX + 8 : columnX + innerWidth - 84,
          rowY + (compactColumns ? 17 : 0),
          {
          size: 9,
          color: GPU_COLORS.muted,
          mono: true,
          width: compactColumns ? Math.max(0, innerWidth - 16) : 84,
          }
        );
      }
      rowY += journalRowHeight;
    }
    cursor += journalHeight + ORG_GAP;
  }

  // ------------------------------------------- the product ledger's tail
  // A SEPARATE journal in the same tab, deliberately not merged with the
  // one above: this one records what the CATALOGUE learned (trust counters,
  // promotions), and it keeps its own integrity checker.
  const ledger = snapshot.data.adminLedger ?? [];
  if (ledger.length > 0) {
    ctx.text(pane.content, snapshot.t('admin.ledger'), columnX, cursor + 6, {
      size: 13,
      weight: '700',
    });
    ctx.text(
      pane.content,
      snapshot.t('admin.ledgerHint'),
      compactColumns ? columnX : columnX + 220,
      cursor + (compactColumns ? 25 : 8),
      {
      size: 10,
      color: GPU_COLORS.muted,
      width: compactColumns ? innerWidth : innerWidth - 240,
      }
    );
    cursor += sectionHeadingHeight;
    const ledgerHeight = ledger.length * ledgerRowHeight + 12;
    ctx.panel(
      pane.content,
      x,
      cursor,
      panelWidth,
      ledgerHeight,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
    let ledgerY = cursor + 8;
    for (const entry of ledger) {
      if (pane.visible(ledgerY, ledgerY + ledgerRowHeight)) {
        ctx.text(pane.content, clockTime(entry.at), columnX + 8, ledgerY, {
          size: 9,
          color: GPU_COLORS.muted,
          mono: true,
          width: 64,
        });
        ctx.text(pane.content, truncate(entry.kind, 26), columnX + 78, ledgerY, {
          size: 9,
          color: GPU_COLORS.primary,
          mono: true,
          width: compactColumns ? Math.max(0, innerWidth - 86) : 180,
        });
        ctx.text(
          pane.content,
          truncate(entry.entity, 48),
          compactColumns ? columnX + 8 : columnX + 268,
          ledgerY + (compactColumns ? 19 : 0),
          {
          size: 9,
          color: GPU_COLORS.text,
          width: compactColumns ? Math.max(0, innerWidth - 16) : innerWidth - 280,
          }
        );
      }
      ledgerY += ledgerRowHeight;
    }
    cursor += ledgerHeight + ORG_GAP;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.admin = pane.finish();
}
