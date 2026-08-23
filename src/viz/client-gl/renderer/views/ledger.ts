import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { clockDate } from './journal-row.js';

/**
 * THE CATALOGUE LEDGER's tail — a SEPARATE record from the platform journal,
 * and deliberately never merged with it.
 *
 * The two answer different questions: the journal records what happened on the
 * DEPLOYMENT (who logged in, which organisation appeared), while
 * `lifecycle_events` records what the CATALOGUE learned — trust counters,
 * promotions, demotions. They also have different consumers: this one keeps
 * its own integrity checker (`ledger check`), which a merge would break.
 *
 * They used to share one tab, which read as one record with two headings.
 * Separate screens make the separation the interface states.
 */

const LIST_TOP = 8;
const ROW_HEIGHT = 22;
const ROW_HEIGHT_COMPACT = 44;

export function drawLedger(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const ledger = snapshot.data.adminLedger ?? [];
  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    snapshot.t('admin.ledger'),
    snapshot.t('admin.ledgerSummary', { count: ledger.length })
  );

  const contentTop = frame.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.ledger,
    bottomPadding: 24,
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compact = innerWidth < 400;
  const rowHeight = compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;

  let cursor = LIST_TOP;
  ctx.text(pane.content, snapshot.t('admin.ledgerHint'), columnX, cursor, {
    size: 10,
    color: GPU_COLORS.muted,
    width: innerWidth,
  });
  cursor += compact ? 40 : 26;

  if (ledger.length === 0) {
    ctx.text(pane.content, snapshot.t('admin.ledgerEmpty'), columnX, cursor, {
      size: 11,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    pane.extend(cursor + 32);
    ctx.scrollMax.ledger = pane.finish();
    return;
  }

  const listHeight = ledger.length * rowHeight + 12;
  ctx.panel(
    pane.content,
    x,
    cursor,
    panelWidth,
    listHeight,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  let rowY = cursor + 8;
  for (const entry of ledger) {
    if (pane.visible(rowY, rowY + rowHeight)) {
      ctx.text(pane.content, clockDate(entry.at), columnX + 8, rowY, {
        size: 9,
        color: GPU_COLORS.muted,
        mono: true,
        width: 132,
      });
      ctx.text(pane.content, truncate(entry.kind, 26), columnX + 146, rowY, {
        size: 9,
        color: GPU_COLORS.primary,
        mono: true,
        width: compact ? Math.max(0, innerWidth - 154) : 180,
      });
      ctx.text(
        pane.content,
        truncate(entry.entity, 48),
        compact ? columnX + 8 : columnX + 336,
        rowY + (compact ? 22 : 0),
        {
          size: 9,
          color: GPU_COLORS.text,
          width: compact ? Math.max(0, innerWidth - 16) : Math.max(0, innerWidth - 344),
        }
      );
    }
    rowY += rowHeight;
  }
  cursor += listHeight + 12;

  pane.extend(cursor + 8);
  ctx.scrollMax.ledger = pane.finish();
}
