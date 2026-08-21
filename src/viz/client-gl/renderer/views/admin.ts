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

  // ------------------------------------------------- the platform journal
  // What happened on this deployment, newest first. Rows are rendered
  // TOLERANTLY: an unknown kind or severity from a newer server shows its
  // raw label rather than hiding the rows around it.
  const events = snapshot.data.adminEvents ?? [];
  ctx.text(pane.content, snapshot.t('admin.journal'), columnX, cursor + 6, {
    size: 13,
    weight: '700',
  });
  ctx.text(
    pane.content,
    snapshot.t('admin.journalSummary', { count: events.length }),
    columnX + 220,
    cursor + 8,
    { size: 10, color: GPU_COLORS.muted, width: innerWidth - 240 }
  );
  cursor += SECTION_HEADING_HEIGHT;

  if (events.length === 0) {
    ctx.text(pane.content, snapshot.t('admin.journalEmpty'), columnX, cursor, {
      size: 11,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 24;
  } else {
    const journalHeight = events.length * JOURNAL_ROW_HEIGHT + 12;
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
      if (pane.visible(rowY, rowY + JOURNAL_ROW_HEIGHT)) {
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
          width: 200,
        });
        ctx.text(pane.content, truncate(event.summary, 96), columnX + 8, rowY + 15, {
          size: 10,
          color: GPU_COLORS.text,
          width: innerWidth - 120,
        });
        ctx.text(pane.content, event.actorType, columnX + innerWidth - 84, rowY, {
          size: 9,
          color: GPU_COLORS.muted,
          mono: true,
          width: 84,
        });
      }
      rowY += JOURNAL_ROW_HEIGHT;
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
    ctx.text(pane.content, snapshot.t('admin.ledgerHint'), columnX + 220, cursor + 8, {
      size: 10,
      color: GPU_COLORS.muted,
      width: innerWidth - 240,
    });
    cursor += SECTION_HEADING_HEIGHT;
    const ledgerHeight = ledger.length * LEDGER_ROW_HEIGHT + 12;
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
      if (pane.visible(ledgerY, ledgerY + LEDGER_ROW_HEIGHT)) {
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
          width: 180,
        });
        ctx.text(pane.content, truncate(entry.entity, 48), columnX + 268, ledgerY, {
          size: 9,
          color: GPU_COLORS.text,
          width: innerWidth - 280,
        });
      }
      ledgerY += LEDGER_ROW_HEIGHT;
    }
    cursor += ledgerHeight + ORG_GAP;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.admin = pane.finish();
}
