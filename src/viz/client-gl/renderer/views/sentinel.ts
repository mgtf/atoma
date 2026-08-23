import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { drawJournalRow, journalRowHeight, SEVERITY_COLORS } from './journal-row.js';

/**
 * THE SENTINEL SCREEN — what is being watched, what is being looked for, and
 * what has been flagged.
 *
 * Three things and no fourth, in that order, because that is the order the
 * questions arrive in: which runs are in flight right now (both corpora — the
 * operator's `runs/` and every project run the control plane calls running),
 * which rules screen them, and what those rules have said.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT CLAIM. There is no green light. The
 * watch is a separate process (`npm run sentinel`) and the server has no way
 * to know whether it is running — a health indicator here would be a claim
 * nothing backs, which is worse than no indicator. The screen says what it
 * reads: runs in flight, and findings in the journal.
 *
 * And no control. A finding is a flag, never a judgment: whether the sentinel
 * may cancel a run at all is an open decision in the design document, so no
 * button here can.
 */

const LIST_TOP = 8;
const SECTION_GAP = 16;
const SECTION_HEADING = 26;
const COVERAGE_ROW_HEIGHT = 34;
const COVERAGE_ROW_HEIGHT_COMPACT = 56;
const RULE_ROW_HEIGHT = 46;
const RULE_ROW_HEIGHT_COMPACT = 74;

const CORPUS_COLORS: Record<string, number> = {
  operator: GPU_COLORS.cyan,
  project: GPU_COLORS.primary,
};

export function drawSentinel(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const payload = snapshot.data.adminSentinel;
  const rules = payload?.rules ?? [];
  const live = payload?.live ?? [];
  const skipped = payload?.skipped ?? [];
  const findings = payload?.findings ?? [];

  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    snapshot.t('sentinel.title'),
    snapshot.t('sentinel.summary', { rules: rules.length, live: live.length })
  );

  const contentTop = frame.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.sentinel,
    bottomPadding: 24,
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compact = innerWidth < 400;

  let cursor = LIST_TOP;

  const heading = (label: string): void => {
    ctx.text(pane.content, label, columnX, cursor, {
      size: 13,
      weight: '700',
      width: innerWidth,
    });
    cursor += SECTION_HEADING;
  };

  const note = (text: string): void => {
    const drawn = ctx.text(pane.content, text, columnX, cursor, {
      size: 10,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += Math.max(14, drawn.height) + 12;
  };

  note(snapshot.t('sentinel.processHint'));

  // ------------------------------------------------------------- coverage
  heading(snapshot.t('sentinel.coverage'));
  if (live.length === 0) {
    note(snapshot.t('sentinel.coverageEmpty'));
  } else {
    const rowHeight = compact ? COVERAGE_ROW_HEIGHT_COMPACT : COVERAGE_ROW_HEIGHT;
    const listHeight = live.length * rowHeight + 12;
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
    for (const run of live) {
      if (pane.visible(rowY, rowY + rowHeight)) {
        ctx.text(
          pane.content,
          snapshot.t(`sentinel.corpus.${run.corpus}`).toUpperCase(),
          columnX + 8,
          rowY,
          {
            size: 9,
            weight: '700',
            color: CORPUS_COLORS[run.corpus] ?? GPU_COLORS.muted,
            width: 72,
          }
        );
        ctx.text(pane.content, truncate(run.label ?? run.runId, 48), columnX + 88, rowY, {
          size: 11,
          width: compact ? Math.max(0, innerWidth - 96) : Math.max(0, innerWidth - 300),
        });
        ctx.text(
          pane.content,
          run.runId,
          compact ? columnX + 8 : columnX + innerWidth - 210,
          rowY + (compact ? 18 : 1),
          {
            size: 8,
            color: GPU_COLORS.muted,
            mono: true,
            width: compact ? Math.max(0, innerWidth - 16) : 210,
          }
        );
        // The row IS the control: opening the run is the only action this
        // screen offers, and it is a read.
        ctx.button(
          pane.content,
          `sentinel.run.${run.runId}`,
          'button',
          '',
          columnX,
          rowY - 4,
          Math.max(0, innerWidth),
          rowHeight - 4,
          false,
          snapshot.onActivate
        ).alpha = 0.001;
      }
      rowY += rowHeight;
    }
    cursor += listHeight + SECTION_GAP;
  }

  if (skipped.length > 0) {
    heading(snapshot.t('sentinel.skipped'));
    for (const skip of skipped) {
      note(`${skip.runId ?? '—'} · ${skip.reason}`);
    }
    cursor += 4;
  }

  // ---------------------------------------------------------- rule table
  heading(snapshot.t('sentinel.rules'));
  const ruleRowHeight = compact ? RULE_ROW_HEIGHT_COMPACT : RULE_ROW_HEIGHT;
  if (rules.length > 0) {
    const rulesHeight = rules.length * ruleRowHeight + 12;
    ctx.panel(
      pane.content,
      x,
      cursor,
      panelWidth,
      rulesHeight,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
    let ruleY = cursor + 8;
    for (const rule of rules) {
      if (pane.visible(ruleY, ruleY + ruleRowHeight)) {
        ctx.text(pane.content, rule.id, columnX + 8, ruleY, {
          size: 10,
          weight: '600',
          mono: true,
          width: compact ? Math.max(0, innerWidth - 16) : 220,
        });
        ctx.text(
          pane.content,
          rule.kind,
          compact ? columnX + 8 : columnX + innerWidth - 150,
          ruleY + (compact ? 16 : 0),
          {
            size: 9,
            color: SEVERITY_COLORS[rule.kind === 'security.flagged' ? 'security' : 'warning'],
            mono: true,
            width: compact ? Math.max(0, innerWidth - 16) : 150,
          }
        );
        // A rule with no catalog entry shows nothing rather than its key: the
        // id above it already names the rule.
        const prose = snapshot.t(`sentinel.rule.${rule.id}`);
        ctx.text(
          pane.content,
          prose === `sentinel.rule.${rule.id}` ? '' : prose,
          columnX + 8,
          ruleY + (compact ? 32 : 16),
          { size: 10, color: GPU_COLORS.muted, width: Math.max(0, innerWidth - 16) }
        );
      }
      ruleY += ruleRowHeight;
    }
    cursor += rulesHeight + SECTION_GAP;
  }

  // ------------------------------------------------------------ findings
  heading(snapshot.t('sentinel.findings'));
  note(snapshot.t('sentinel.flagOnly'));
  if (findings.length === 0) {
    note(snapshot.t('sentinel.findingsEmpty'));
  } else {
    const rowHeight = journalRowHeight(compact, true);
    const listHeight = findings.length * rowHeight + 12;
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
    for (const finding of findings) {
      if (pane.visible(rowY, rowY + rowHeight)) {
        const detail = finding.detail ?? {};
        const ruleId = typeof detail['ruleId'] === 'string' ? detail['ruleId'] : '';
        const corpus = typeof detail['corpus'] === 'string' ? detail['corpus'] : '';
        drawJournalRow(ctx, pane.content, finding, {
          x: columnX,
          y: rowY,
          innerWidth,
          compact,
          withDate: true,
          extra: [ruleId, corpus, finding.runId ?? ''].filter(Boolean).join(' · '),
        });
        if (finding.runId) {
          ctx.button(
            pane.content,
            `sentinel.run.${finding.runId}`,
            'button',
            '',
            columnX,
            rowY - 4,
            Math.max(0, innerWidth),
            rowHeight - 4,
            false,
            snapshot.onActivate
          ).alpha = 0.001;
        }
      }
      rowY += rowHeight;
    }
    cursor += listHeight + SECTION_GAP;
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.sentinel = pane.finish();
}
