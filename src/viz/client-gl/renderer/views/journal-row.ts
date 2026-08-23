import type { Container } from 'pixi.js';
import type { VizPlatformEvent } from '../../../client/types.js';
import type { RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { truncate } from '../copy.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';

/**
 * ONE journal row, drawn in one place.
 *
 * The platform journal and the sentinel screen both list journal rows — the
 * sentinel's findings ARE journal rows, of two specific kinds. Two renderers
 * would drift on the day a row gains a field, so there is one, and each view
 * supplies only what is particular to it (an `extra` line for a finding's
 * rule and corpus).
 *
 * Rows are rendered TOLERANTLY: an unknown kind or severity from a newer
 * server shows its raw label rather than hiding the rows around it.
 */

export const JOURNAL_ROW_HEIGHT = 34;
export const JOURNAL_ROW_HEIGHT_COMPACT = 58;
/** With an `extra` line, a row needs one more text line's worth of space. */
export const JOURNAL_ROW_EXTRA = 16;

/**
 * Severity → colour, read through a lookup with a FALLBACK: the server's
 * vocabulary can be newer than this bundle.
 */
export const SEVERITY_COLORS: Record<string, number> = {
  info: GPU_COLORS.muted,
  warning: GPU_COLORS.warning,
  error: GPU_COLORS.error,
  security: GPU_COLORS.magenta,
};

/** `HH:MM:SS` from an ISO instant, or the raw value if it will not parse. */
export function clockTime(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? truncate(at, 19) : parsed.toISOString().slice(11, 19);
}

/** `YYYY-MM-DD HH:MM:SS`, for a list that spans more than one day. */
export function clockDate(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? truncate(at, 19)
    : parsed.toISOString().slice(0, 19).replace('T', ' ');
}

export function journalRowHeight(compact: boolean, hasExtra: boolean): number {
  return (
    (compact ? JOURNAL_ROW_HEIGHT_COMPACT : JOURNAL_ROW_HEIGHT) +
    (hasExtra ? JOURNAL_ROW_EXTRA : 0)
  );
}

export function drawJournalRow(
  ctx: RendererCtx,
  parent: Container,
  event: VizPlatformEvent,
  options: {
    readonly x: number;
    readonly y: number;
    readonly innerWidth: number;
    readonly compact: boolean;
    /**
     * Show HOW LONG AGO instead of a wall clock. Needs the reader's locale and
     * translator: the phrase is translated, and the hover bubble carries the
     * exact instant formatted in that locale.
     */
    readonly relative?: { readonly t: (key: string, vars?: Record<string, unknown>) => string; readonly locale: string };
    /** Absolute timestamps, for a list that is not "the last few minutes". */
    readonly withDate?: boolean;
    /** One extra muted line under the summary. Already bounded by the caller. */
    readonly extra?: string | null;
  }
): void {
  const { x, y, innerWidth, compact } = options;
  const color = SEVERITY_COLORS[event.severity] ?? GPU_COLORS.muted;
  const relative = options.relative;
  // TOLERANT, like the kind and severity below: a stamp this bundle cannot
  // parse shows its RAW value rather than an empty column, so bad data from a
  // newer server is visible instead of silently blank.
  const stamp = relative
    ? relativeTime(event.at, relative.t, relative.locale) || truncate(event.at, 19)
    : options.withDate
      ? clockDate(event.at)
      : clockTime(event.at);
  const stampWidth = relative ? 118 : options.withDate ? 132 : 64;
  ctx.text(parent, stamp, x + 8, y, {
    size: 9,
    color: GPU_COLORS.muted,
    mono: !relative,
    width: stampWidth,
    singleLine: true,
  });
  // The relative phrase is lossy BY DESIGN, so the exact instant has to stay
  // reachable. It is on the stamp only: the row's other fields say what they
  // mean already.
  if (relative) {
    const exact = timestampTooltip(event.at, relative.locale);
    if (exact) {
      ctx.tooltip(parent, { x: x + 8, y, width: stampWidth, height: 13, text: exact });
    }
  }
  ctx.text(parent, truncate(event.kind, 28), x + stampWidth + 14, y, {
    size: 10,
    color,
    mono: true,
    width: compact ? Math.max(0, innerWidth - stampWidth - 22) : 200,
  });
  ctx.text(parent, truncate(event.summary, 96), x + 8, y + (compact ? 32 : 15), {
    size: 10,
    color: GPU_COLORS.text,
    width: compact ? Math.max(0, innerWidth - 16) : innerWidth - 120,
  });
  ctx.text(
    parent,
    event.actorType,
    compact ? x + 8 : x + innerWidth - 84,
    y + (compact ? 17 : 0),
    { size: 9, color: GPU_COLORS.muted, mono: true, width: compact ? Math.max(0, innerWidth - 16) : 84 }
  );
  if (options.extra) {
    ctx.text(parent, options.extra, x + 8, y + (compact ? 44 : 30), {
      size: 9,
      color: GPU_COLORS.muted,
      mono: true,
      width: Math.max(0, innerWidth - 16),
    });
  }
}
