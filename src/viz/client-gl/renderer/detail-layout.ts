import type {
  StructuredDetailField,
  StructuredDetailNode,
} from '../../client/structured-detail.js';

/**
 * Column packing for the run-step detail pane.
 *
 * The pane gave every field a full-width card, so `Status ✓ Success`,
 * `Path server.mjs` and `Bytes 4727` — three values under forty characters
 * between them — cost 200 vertical pixels and pushed the rest of a tool
 * result below the fold (2026-09-21). A card whose LABEL and VALUE both
 * measurably fit a column shares its row with the next such card, up to
 * `DETAIL_MAX_COLUMNS` of them.
 *
 * Pixi-free on purpose: this file is the geometry, the view is the pixels.
 * `measure` is REQUIRED rather than optional — this pane already carried one
 * character-count estimate (`value.length * 6.4 + 22`) that could size a
 * 24px pill too narrow for its own text, and a proportional face makes a
 * per-character guess wrong in both directions. Ordering is NOT here: the
 * shared projection ranks a payload's keys once, for both clients.
 */

/** Air between two cards of one row: `GPU_LAYOUT.gap`, the gutter this pane's own summary grid uses. */
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
 * The most cards one row may hold. Three columns are what a verdict strip
 * needs — `Decision ✗ Rejected`, `Mutation scope This run only`,
 * `Recipe adherence ✓ Followed` are one glance, not three rows (owner
 * request, 2026-09-21). A fourth column would fall under the
 * `DETAIL_CARD_MIN_WIDTH` floor at every pane width this client offers, so
 * the cap states what fits rather than a preference.
 */
export const DETAIL_MAX_COLUMNS = 3;
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

/** One to `DETAIL_MAX_COLUMNS` cards sharing a vertical band. */
export interface DetailRow {
  readonly cards: readonly DetailPlacedCard[];
}

/** The card box for one nesting level. Integral: see `layoutDetailRows`. */
export function detailNodeWidth(width: number, depth: number): number {
  return Math.floor(
    Math.max(DETAIL_CARD_MIN_WIDTH, width - depth * DETAIL_SECTION_INSET)
  );
}

/** One column of an `n`-up row, less its share of the gutters. */
export function detailColumnWidth(nodeWidth: number, columns = 2): number {
  return Math.floor(
    (nodeWidth - (columns - 1) * DETAIL_PAIR_GAP) / Math.max(1, columns)
  );
}

/**
 * Structural eligibility, decided before anything is measured. A section
 * never becomes a cell: it owns a rail and a child list, and a fraction of a
 * pane is not enough for either.
 *
 * A toned badge DOES share a row. It was once held back at full width on the
 * argument that halving the green `✓ Success` halves what the viewer came to
 * read — but a failure and its status code (`✗ Failure`, `404`) are one fact
 * in two cards, and a run of verdict badges each owning a row was the densest
 * part of the pane's height problem rather than the cure for it.
 */
export function detailFieldPairable(
  node: StructuredDetailNode
): node is StructuredDetailField {
  if (node.kind !== 'field') return false;
  if (node.value.includes('\n')) return false;
  return node.value.length <= COMPACT_VALUE_MAX_CHARS;
}

/**
 * Whether a field's label AND value each fit one line of a column. Both must,
 * so a packed cell never ellipsises and never wraps — which is also why the
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
 * The most columns this ONE field could live in, or 1 when it needs the full
 * width. Measured against each candidate column, widest first, so the answer
 * is a property of the field and the pane — never of its neighbours.
 */
function fittingColumns(
  node: StructuredDetailNode,
  nodeWidth: number,
  measure: DetailMeasure
): number {
  if (!detailFieldPairable(node)) return 1;
  for (let columns = DETAIL_MAX_COLUMNS; columns >= 2; columns -= 1) {
    const columnWidth = detailColumnWidth(nodeWidth, columns);
    if (columnWidth < DETAIL_CARD_MIN_WIDTH) continue;
    if (fitsColumn(node, measure, columnWidth)) return columns;
  }
  return 1;
}

/** One row's cards, the first flush left and the last flush right. */
function placeRow(
  members: readonly StructuredDetailNode[],
  nodeWidth: number
): DetailPlacedCard[] {
  const first = members[0]!;
  if (members.length === 1) {
    return [{ node: first, dx: 0, width: nodeWidth }];
  }
  const width = detailColumnWidth(nodeWidth, members.length);
  // Spread over the leftover span rather than stepping by width + gap: the
  // outer edges then line up exactly with a full-width card's, and the odd
  // pixel of an indivisible width is absorbed by the realised gutters.
  const span = nodeWidth - width;
  return members.map((node, index) => ({
    node,
    dx: Math.round((span * index) / (members.length - 1)),
    width,
  }));
}

/**
 * Rows for one sibling list, in the order given — the shared projection has
 * already ranked it, and packing must not disturb that reading order, which
 * runs left to right then top to bottom.
 *
 * A maximal RUN of adjacent packable fields is laid out at ONE column count,
 * the narrowest any of its members can live in, and split into rows of equal
 * size: four fields at three columns become 2 + 2, not 3 + 1, because an
 * orphan beside empty space reads as a rendering fault. A field that needs
 * the full width takes its own row and ends the run, so one long value can
 * never drag its neighbours out of their columns.
 *
 * Clipping is impossible by construction, and every rejection path lands on
 * exactly the single-column layout this pane had before.
 */
export function layoutDetailRows(
  nodes: readonly StructuredDetailNode[],
  nodeWidth: number,
  measure: DetailMeasure
): readonly DetailRow[] {
  const columnsFor = nodes.map((node) => fittingColumns(node, nodeWidth, measure));
  const rows: DetailRow[] = [];
  let index = 0;
  while (index < nodes.length) {
    if (columnsFor[index]! < 2) {
      rows.push({ cards: placeRow([nodes[index]!], nodeWidth) });
      index += 1;
      continue;
    }
    let end = index;
    let columns = DETAIL_MAX_COLUMNS;
    while (end < nodes.length && columnsFor[end]! >= 2) {
      columns = Math.min(columns, columnsFor[end]!);
      end += 1;
    }
    const count = end - index;
    const rowCount = Math.ceil(count / columns);
    const perRow = Math.floor(count / rowCount);
    let extra = count % rowCount;
    let cursor = index;
    for (let row = 0; row < rowCount; row += 1) {
      const size = perRow + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      rows.push({ cards: placeRow(nodes.slice(cursor, cursor + size), nodeWidth) });
      cursor += size;
    }
    index = end;
  }
  return rows;
}
