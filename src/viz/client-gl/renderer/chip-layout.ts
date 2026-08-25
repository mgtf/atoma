/**
 * Pure chip/lane layout for the GPU client — filter blocks, atom lanes, and
 * the label-width heuristics both share. No Pixi objects here: everything is
 * measured geometry a recording test can assert without a renderer.
 *
 * Extracted from gpu-renderer.ts (2026-08-15 decomposition).
 */
const CONTROL_HOVER_GAP = 14;

const FILTER_CHIP_MIN_WIDTH = 52;
const FILTER_CHIP_TEXT_PAD = 24;
const FILTER_CHIP_MIN_WIDTH_COMPACT = 36;
const FILTER_CHIP_TEXT_PAD_COMPACT = 14;

export function gpuFilterButtonWidth(label: string) {
  // FALLBACK ESTIMATE for renderer-less layout (tests, recordings). A view
  // with a renderer passes `measure` to layoutFilterChipBlock instead — an
  // estimate must over-shoot to never clip, so it pads long labels unevenly.
  // Uppercase filter labels use the 11px semibold face, whose wide glyphs
  // average closer to 7px than the 6px estimate used for ordinary chips.
  return Math.max(FILTER_CHIP_MIN_WIDTH, Math.ceil(label.length * 7.2 + FILTER_CHIP_TEXT_PAD));
}

export function gpuFilterButtonWidthCompact(label: string) {
  // Same fallback role as gpuFilterButtonWidth, for the compact 8px face
  // (~4.5px per uppercase glyph).
  return Math.max(
    FILTER_CHIP_MIN_WIDTH_COMPACT,
    Math.ceil(label.length * 4.8 + FILTER_CHIP_TEXT_PAD_COMPACT)
  );
}


export const FILTER_BLOCK_PAD = 8;
export const FILTER_BLOCK_GAP = 12;
export const FILTER_BUTTON_HEIGHT = 27;
export const FILTER_BUTTON_HEIGHT_COMPACT = 21;
export const FILTER_BUTTON_LABEL_SIZE = 11;
export const FILTER_BUTTON_LABEL_SIZE_COMPACT = 8;
export const ATOM_BUTTON_HEIGHT = 28;

export function gpuLaneLabelWidth(label: string) {
  return Math.min(132, Math.max(72, Math.ceil(label.length * 6 + 18)));
}

export interface FilterChipSpec {
  id: string;
  label: string;
}

export interface FilterChipLayout extends FilterChipSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FilterBlockLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  chips: FilterChipLayout[];
}

function placeChipBlock(
  chips: readonly FilterChipSpec[],
  originX: number,
  originY: number,
  maxRow: number,
  widthOf: (label: string) => number,
  buttonH: number,
  insetX = 0,
  gap: number = CONTROL_HOVER_GAP
): FilterBlockLayout {
  const pad = FILTER_BLOCK_PAD;
  let x = 0;
  let y = 0;
  let innerW = insetX;
  const placed: FilterChipLayout[] = [];
  for (const chip of chips) {
    const width = widthOf(chip.label);
    if (x > 0 && insetX + x + width > maxRow) {
      x = 0;
      y += buttonH + gap;
    }
    placed.push({
      ...chip,
      x: originX + pad + insetX + x,
      y: originY + pad + y,
      width,
      height: buttonH,
    });
    x += width + gap;
    innerW = Math.max(innerW, insetX + x - gap);
  }
  return {
    x: originX,
    y: originY,
    width: Math.max(innerW, insetX) + pad * 2,
    height: (chips.length ? y + buttonH : 0) + pad * 2,
    chips: placed,
  };
}

export interface FilterChipBlockOptions {
  size?: 'default' | 'compact';
  /**
   * Rendered width of a label through the REAL text style — pass
   * `ctx.measureText` bound to the face the chips draw with. The layout
   * module stays Pixi-free (tests run without a renderer), so measurement is
   * injected rather than imported; without it the per-character heuristic is
   * the fallback, and its estimate must over-shoot to stay safe, which pads
   * long labels unevenly.
   */
  measure?: (label: string) => number;
}

export function layoutFilterChipBlock(
  originX: number,
  originY: number,
  maxWidth: number,
  chips: readonly FilterChipSpec[],
  options: FilterChipBlockOptions = {}
): FilterBlockLayout {
  const compact = options.size === 'compact';
  const buttonH = compact ? FILTER_BUTTON_HEIGHT_COMPACT : FILTER_BUTTON_HEIGHT;
  const measure = options.measure;
  const minWidth = compact ? FILTER_CHIP_MIN_WIDTH_COMPACT : FILTER_CHIP_MIN_WIDTH;
  const textPad = compact ? FILTER_CHIP_TEXT_PAD_COMPACT : FILTER_CHIP_TEXT_PAD;
  const widthOf = measure
    ? (label: string) => Math.max(minWidth, Math.ceil(measure(label)) + textPad)
    : compact
      ? gpuFilterButtonWidthCompact
      : gpuFilterButtonWidth;
  return placeChipBlock(
    chips,
    originX,
    originY,
    Math.max(buttonH, maxWidth - FILTER_BLOCK_PAD * 2),
    widthOf,
    buttonH,
    0,
    compact ? 10 : undefined
  );
}

export function layoutRunFilterBlocks(options: {
  originX: number;
  originY: number;
  maxWidth: number;
  kinds: readonly FilterChipSpec[];
  roles: readonly FilterChipSpec[] | null;
}): { kinds: FilterBlockLayout; roles: FilterBlockLayout | null; bottom: number } {
  const pad = FILTER_BLOCK_PAD;
  const buttonH = FILTER_BUTTON_HEIGHT;
  const maxInner = Math.max(buttonH, options.maxWidth - pad * 2);
  const kinds = placeChipBlock(
    options.kinds,
    options.originX,
    options.originY,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  if (!options.roles?.length) {
    return { kinds, roles: null, bottom: kinds.y + kinds.height };
  }

  const stackedRoles = placeChipBlock(
    options.roles,
    options.originX,
    options.originY + kinds.height + FILTER_BLOCK_GAP,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  const inlineRoles = placeChipBlock(
    options.roles,
    options.originX + kinds.width + FILTER_BLOCK_GAP,
    options.originY,
    maxInner,
    gpuFilterButtonWidth,
    buttonH
  );
  const singleRow =
    kinds.height === buttonH + pad * 2 &&
    inlineRoles.height === buttonH + pad * 2 &&
    inlineRoles.x + inlineRoles.width <= options.originX + options.maxWidth;
  const roles = singleRow ? inlineRoles : stackedRoles;
  return { kinds, roles, bottom: Math.max(kinds.y + kinds.height, roles.y + roles.height) };
}

export interface AtomLaneSpec {
  tier: 1 | 2 | 3;
  label: string;
  names: readonly string[];
}

export interface AtomLaneBlockLayout extends FilterBlockLayout {
  tier: 1 | 2 | 3;
  label: string;
  labelX: number;
  labelY: number;
}

export function layoutAtomLaneBlocks(options: {
  originX: number;
  originY: number;
  maxWidth: number;
  lanes: readonly AtomLaneSpec[];
}): { lanes: AtomLaneBlockLayout[]; bottom: number } {
  const pad = FILTER_BLOCK_PAD;
  const buttonH = ATOM_BUTTON_HEIGHT;
  const maxInner = Math.max(buttonH, options.maxWidth - pad * 2);

  const measure = (lane: AtomLaneSpec, originX: number, originY: number, maxRow: number) => {
    const labelW = gpuLaneLabelWidth(lane.label);
    const block = placeChipBlock(
      lane.names.map((name) => ({ id: `atom.${name}`, label: name })),
      originX,
      originY,
      maxRow,
      gpuAtomButtonWidth,
      buttonH,
      labelW
    );
    return {
      ...block,
      tier: lane.tier,
      label: lane.label,
      labelX: originX + pad,
      labelY: originY + pad + 7,
    };
  };

  const natural = options.lanes.map((lane) => measure(lane, 0, 0, Number.POSITIVE_INFINITY));
  const inlineWidth =
    natural.reduce((sum, lane) => sum + lane.width, 0) +
    FILTER_BLOCK_GAP * Math.max(0, options.lanes.length - 1);
  const inline =
    options.lanes.length > 0 &&
    inlineWidth <= options.maxWidth &&
    natural.every((lane) => lane.height === buttonH + pad * 2);

  const lanes: AtomLaneBlockLayout[] = [];
  if (inline) {
    let x = options.originX;
    for (const lane of options.lanes) {
      const block = measure(lane, x, options.originY, Number.POSITIVE_INFINITY);
      lanes.push(block);
      x += block.width + FILTER_BLOCK_GAP;
    }
  } else {
    let y = options.originY;
    for (const lane of options.lanes) {
      const block = measure(lane, options.originX, y, maxInner);
      lanes.push(block);
      y += block.height + FILTER_BLOCK_GAP;
    }
  }
  const bottom = lanes.length
    ? Math.max(...lanes.map((lane) => lane.y + lane.height))
    : options.originY;
  return { lanes, bottom };
}

export function gpuAtomButtonWidth(label: string) {
  // 28px particle zone + 8px separation + 12px right padding.
  return Math.min(160, Math.max(80, Math.ceil(label.length * 6.4 + 48)));
}

