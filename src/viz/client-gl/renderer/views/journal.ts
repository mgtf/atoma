import { PLATFORM_EVENT_FAMILIES } from '../../../../contracts/platformEvents.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { gpuFilterButtonWidth } from '../chip-layout.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { drawJournalRow, journalRowHeight } from './journal-row.js';

/**
 * THE PLATFORM JOURNAL — every control-plane event, newest first, in one
 * continuous list.
 *
 * It used to be a section stacked under the organisation list, capped at one
 * page, with no way to reach anything older. It is its own screen now because
 * it answers its own question ("what happened on this deployment") and needs
 * its own scroll position and its own filters.
 *
 * PAGING IS SERVER-SIDE and so is FILTERING. Reaching the bottom asks for the
 * next page with the `seq` cursor the previous page handed back, so a boundary
 * can neither repeat nor skip a row. Filtering client-side over already-loaded
 * pages would THIN each page instead of finding more matching rows — a viewer
 * would see three security events where the journal holds three hundred.
 *
 * Filters are two closed vocabularies: severity, and the kind's FAMILY (its
 * first segment). Twenty-eight kinds is not a chip row, and the family list is
 * derived from the kind vocabulary rather than written down a second time.
 */

const LIST_TOP = 8;
const FILTER_ROW_HEIGHT = 34;
const FOOTER_HEIGHT = 44;

export const JOURNAL_SEVERITIES: readonly string[] = [
  'all',
  'info',
  'warning',
  'error',
  'security',
];

export const JOURNAL_FAMILIES: readonly string[] = ['all', ...PLATFORM_EVENT_FAMILIES];

export function drawJournal(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const events = snapshot.data.adminEvents ?? [];
  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    snapshot.t('admin.journal'),
    snapshot.t('admin.journalSummary', { count: events.length })
  );

  const contentTop = frame.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.journal,
    bottomPadding: 24,
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compact = innerWidth < 400;

  let cursor = LIST_TOP;

  // Two filter rows, each a closed vocabulary. They scroll WITH the list
  // rather than floating above it: this pane has one scroll position, and a
  // sticky header inside a masked GL pane would need a second.
  const chipRow = (
    label: string,
    values: readonly string[],
    active: string,
    idFor: (value: string) => string
  ): void => {
    ctx.text(pane.content, label, columnX, cursor + 8, {
      size: 9,
      weight: '700',
      color: GPU_COLORS.muted,
      width: 70,
    });
    let chipX = columnX + 76;
    let rowY = cursor;
    for (const value of values) {
      const text = value === 'all' ? snapshot.t('journal.filter.all') : value;
      const buttonWidth = gpuFilterButtonWidth(text);
      if (chipX + buttonWidth > columnX + innerWidth && chipX > columnX + 76) {
        chipX = columnX + 76;
        rowY += FILTER_ROW_HEIGHT;
      }
      ctx.filterButton(
        pane.content,
        idFor(value),
        text,
        chipX,
        rowY,
        buttonWidth,
        28,
        value === active,
        snapshot.onActivate
      );
      chipX += buttonWidth + 6;
    }
    cursor = rowY + FILTER_ROW_HEIGHT + 4;
  };

  chipRow(
    snapshot.t('journal.severity').toUpperCase(),
    JOURNAL_SEVERITIES,
    snapshot.state.journalSeverity,
    (value) => `journal.severity.${value}`
  );
  chipRow(
    snapshot.t('journal.family').toUpperCase(),
    JOURNAL_FAMILIES,
    snapshot.state.journalFamily,
    (value) => `journal.family.${value}`
  );

  const filtered =
    snapshot.state.journalSeverity !== 'all' || snapshot.state.journalFamily !== 'all';
  if (events.length === 0) {
    ctx.text(
      pane.content,
      snapshot.t(filtered ? 'journal.filteredEmpty' : 'admin.journalEmpty'),
      columnX,
      cursor,
      { size: 11, color: GPU_COLORS.muted, width: innerWidth }
    );
    cursor += 28;
  } else {
    const rowHeight = journalRowHeight(compact, false);
    const listHeight = events.length * rowHeight + 12;
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
    for (const event of events) {
      // Cull by skipping the DRAW, never the cursor: a layout that stops
      // advancing would collapse everything below it.
      if (pane.visible(rowY, rowY + rowHeight)) {
        drawJournalRow(ctx, pane.content, event, {
          x: columnX,
          y: rowY,
          innerWidth,
          compact,
          relative: { t: snapshot.t, locale: snapshot.state.locale },
        });
      }
      rowY += rowHeight;
    }
    cursor += listHeight + 12;
  }

  // The foot of the list says what happens next, and offers the same page a
  // scroll to the bottom would fetch. The button is not a fallback for a
  // broken gesture: it is the keyboard and touch route to the same page.
  if (snapshot.data.adminEventsLoading) {
    ctx.text(pane.content, snapshot.t('journal.loading'), columnX, cursor + 8, {
      size: 10,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += FOOTER_HEIGHT;
  } else if (snapshot.data.adminEventsHasMore) {
    ctx.button(
      pane.content,
      'journal.more',
      'button',
      snapshot.t('journal.more'),
      columnX,
      cursor,
      Math.min(260, innerWidth),
      28,
      false,
      snapshot.onActivate
    );
    ctx.text(
      pane.content,
      snapshot.t('journal.scrollHint'),
      columnX,
      cursor + 34,
      { size: 9, color: GPU_COLORS.muted, width: innerWidth }
    );
    cursor += FOOTER_HEIGHT + 18;
  } else if (events.length > 0) {
    ctx.text(pane.content, snapshot.t('journal.end'), columnX, cursor + 8, {
      size: 10,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += FOOTER_HEIGHT;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.journal = pane.finish();
}
