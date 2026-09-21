import type {
  StructuredDetailField,
  StructuredDetailNode,
} from '../../client/structured-detail.js';

/**
 * Two-up packing for the run-step detail pane.
 *
 * The pane gave every field a full-width card, so `Status ✓ Success`,
 * `Path server.mjs` and `Bytes 4727` — three values under forty characters
 * between them — cost 200 vertical pixels and pushed the rest of a tool
 * result below the fold (2026-09-21). A card whose LABEL and VALUE both
 * measurably fit half the node box shares its row with the next such card.
 *
 * Pixi-free on purpose: this file is the geometry, the view is the pixels.
 * `measure` is REQUIRED rather than optional — this pane already carried one
 * character-count estimate (`value.length * 6.4 + 22`) that could size a
 * 24px pill too narrow for its own text, and a proportional face makes a
 * per-character guess wrong in both directions. Ordering is NOT here: the
 * shared projection ranks a payload's keys once, for both clients.
 */

/** Air between two paired cards: `GPU_LAYOUT.gap`, the gutter this pane's own summary grid uses. */
export const DETAIL_PAIR_GAP = 10;
/** Inner padding a card reserves on EACH side. */
export const DETAIL_CARD_PAD = 10;
/** Text width inside a card of a given width. */
export const DETAIL_CARD_TEXT_PAD = DETAIL_CARD_PAD * 2;
/** The legibility floor a card has always had, re-read as "one column's minimum". */
export const DETAIL_CARD_MIN_WIDTH = 120;
/** A badge pill is never drawn narrower than this. */
export const DETAIL_BADGE_MIN_WIDTH = 72;
/** Pill width above its own text: the 10px lead-in plus the 8px trail. */
export const DETAIL_BADGE_TEXT_PAD = 18;
/** Horizontal inset each nesting level adds. */
export const DETAIL_SECTION_INSET = 12;
/**
 * A value longer than this can never share a line at any pane width, so it is
 * rejected before anything is measured. It must OVER-admit — the measurement
 * is the real bound — so it is set well above the ~35 glyphs the widest
 * column (204px of text at ~5.9px per glyph) can actually hold.
 */
export const COMPACT_VALUE_MAX_CHARS = 40;

/** Rendered widths, through the exact faces the view will draw with. */
export interface DetailMeasure {
  /** The 9px semibold label face. */
  readonly label: (value: string) => number;
  /** A value's own face: 10px/700 in a badge, 10px mono for code, else 10px/400. */
  readonly value: (field: StructuredDetailField) => number;
}

export interface DetailPlacedCard {
  readonly node: StructuredDetailNode;
  /** Offset from the row's left edge. 0 for a full-width card. */
  readonly dx: number;
  readonly width: number;
}

/** One or two cards sharing a vertical band. */
export interface DetailRow {
  readonly cards: readonly DetailPlacedCard[];
}

/** The card box for one nesting level. Integral: see `layoutDetailRows`. */
export function detailNodeWidth(width: number, depth: number): number {
  return Math.floor(
    Math.max(DETAIL_CARD_MIN_WIDTH, width - depth * DETAIL_SECTION_INSET)
  );
}

/** Half the node box, less the gutter. */
export function detailColumnWidth(nodeWidth: number): number {
  return Math.floor((nodeWidth - DETAIL_PAIR_GAP) / 2);
}

/**
 * Structural eligibility, decided before anything is measured. A section
 * never becomes a cell: it owns a rail and a child list, and half a pane is
 * not enough for either.
 */
export function detailFieldPairable(
  node: StructuredDetailNode
): node is StructuredDetailField {
  if (node.kind !== 'field') return false;
  if (node.value.includes('\n')) return false;
  // A success/error/warning tone is the pane ASSERTING something — the green
  // `✓ Success` a viewer scans a tool step for. Halving its card halves the
  // only thing on screen they came to read, so a toned field keeps the full
  // width and the small neutral facts pair up underneath it. `info` is the
  // tone every plain number carries, so it pairs.
  if (node.tone === 'success' || node.tone === 'error' || node.tone === 'warning') {
    return false;
  }
  return node.value.length <= COMPACT_VALUE_MAX_CHARS;
}

/**
 * Whether a field's label AND value each fit one line of a column. Both must,
 * so a paired cell never ellipsises and never wraps — which is also why the
 * pane needs no new hover bubble to recover clipped copy.
 */
function fitsColumn(
  field: StructuredDetailField,
  measure: DetailMeasure,
  columnWidth: number
): boolean {
  const inner = columnWidth - DETAIL_CARD_TEXT_PAD;
  if (inner <= 0) return false;
  if (measure.label(field.label) > inner) return false;
  const room =
    field.presentation === 'badge' ? inner - DETAIL_BADGE_TEXT_PAD : inner;
  return measure.value(field) <= room;
}

/**
 * Rows for one sibling list, in the order given — the shared projection has
 * already ranked it, and pairing must not disturb that reading order, which
 * runs left to right then top to bottom.
 *
 * Greedy and single-pass: a rejected candidate takes its own full-width row
 * and the field after it is retried against the next one. Clipping is
 * impossible by construction, and every rejection path lands on exactly the
 * single-column layout this pane had before.
 *
 * A lone trailing compact field takes the full row rather than leaving an
 * orphaned half-card beside empty space.
 */
export function layoutDetailRows(
  nodes: readonly StructuredDetailNode[],
  nodeWidth: number,
  measure: DetailMeasure
): readonly DetailRow[] {
  const columnWidth = detailColumnWidth(nodeWidth);
  // Below two minimum cards plus their gutter the level is single-column, and
  // that is the only width rule: everything else is measured.
  const canPair = columnWidth >= DETAIL_CARD_MIN_WIDTH;
  const rows: DetailRow[] = [];
  let index = 0;
  while (index < nodes.length) {
    const first = nodes[index]!;
    const second = index + 1 < nodes.length ? nodes[index + 1]! : undefined;
    const pair =
      canPair &&
      second !== undefined &&
      detailFieldPairable(first) &&
      detailFieldPairable(second) &&
      fitsColumn(first, measure, columnWidth) &&
      fitsColumn(second, measure, columnWidth);
    if (pair) {
      rows.push({
        cards: [
          { node: first, dx: 0, width: columnWidth },
          // Placed from the RIGHT edge, so a pair's outer edges are exactly a
          // full-width card's and the realised gutter absorbs the odd pixel.
          { node: second, dx: nodeWidth - columnWidth, width: columnWidth },
        ],
      });
      index += 2;
      continue;
    }
    rows.push({ cards: [{ node: first, dx: 0, width: nodeWidth }] });
    index += 1;
  }
  return rows;
}
