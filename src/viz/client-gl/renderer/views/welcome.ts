import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import {
  ATOMA_MARK_LOCAL_CENTER,
  attachAtomaMark,
} from '../atoma-mark.js';
import { GPU_COLORS } from '../../theme.js';

const BUTTON_WIDTH = 200;
const BUTTON_HEIGHT = 46;
/** Space from the mark's visual edge to the inspect row. Must stay ABOVE the
 *  film crop (`crystalClip` uses a +18 pad below the crystal). */
const MARK_TO_SLIDER = 22;
const SLIDER_HEIGHT = 28;
const SLIDER_TO_BUTTON = 18;
const COPY_HEIGHT = 22;
const COPY_TO_BUTTON = 22;
const COPY_MAX_WIDTH = 640;
const EDGE = 28;
const INSPECT_WIDTH = 400;
const BEAD_CHECK_WIDTH = 92;
/**
 * Turn slider + bead checkbox. Kept wired (layout, factories, i18n, film
 * crop) so a lighting session can flip this without rebuilding the gate.
 * Off on the public arrival page.
 */
export const WELCOME_SHOW_INSPECT = false;
const LOCAL_SIZE = ATOMA_MARK_LOCAL_CENTER * 2;
/** Fraction of the shorter viewport side. The arrival mark is the hero. */
const MARK_VIEWPORT_FRACTION = 0.52;
const FLOAT_AMPLITUDE_PX = 12;
const FLOAT_PERIOD_MS = 1800;

export interface WelcomeLayout {
  scale: number;
  markX: number;
  markY: number;
  sliderX: number;
  sliderY: number;
  sliderWidth: number;
  sliderHeight: number;
  beadX: number;
  beadY: number;
  beadWidth: number;
  beadHeight: number;
  copyX: number;
  copyY: number;
  copyWidth: number;
  copyHeight: number;
  buttonX: number;
  buttonY: number;
  buttonWidth: number;
  buttonHeight: number;
}

/**
 * Logo centred on the viewport; a one-line pitch sits just below it, Continue
 * below that. The inspect row (turn slider + bead check) stays in the layout
 * so the lighting film crop and a later flip of `WELCOME_SHOW_INSPECT` do not
 * invent new geometry. Pure so tests can check it without a GPU.
 *
 * The inspect row must stay below the lighting-film crop. `scripts/viz-mark-turn.mjs`
 * duplicates MARK_TO_SLIDER / SLIDER_HEIGHT / SLIDER_TO_BUTTON / BUTTON_HEIGHT /
 * EDGE — keep them in lockstep (tests/viz-mark-turn.test.ts holds both).
 */
export function welcomeLayout(width: number, height: number): WelcomeLayout {
  const buttonBlock = MARK_TO_SLIDER + SLIDER_HEIGHT + SLIDER_TO_BUTTON + BUTTON_HEIGHT + EDGE;
  const maxMarkPx = Math.min(
    Math.min(width, height) * MARK_VIEWPORT_FRACTION,
    Math.max(LOCAL_SIZE * 6, (height - buttonBlock - EDGE) * 0.92)
  );
  const scale = Math.max(6, maxMarkPx / LOCAL_SIZE);
  const radius = ATOMA_MARK_LOCAL_CENTER * scale;
  const inspectWidth = Math.min(INSPECT_WIDTH, Math.max(240, width - EDGE * 2));
  const sliderWidth = Math.max(160, inspectWidth - 16 - BEAD_CHECK_WIDTH);
  const inspectX = (width - inspectWidth) / 2;
  const sliderY = height / 2 + radius + MARK_TO_SLIDER;
  const copyWidth = Math.min(COPY_MAX_WIDTH, Math.max(240, width - EDGE * 2));
  const copyY = WELCOME_SHOW_INSPECT
    ? sliderY + SLIDER_HEIGHT + SLIDER_TO_BUTTON
    : sliderY;
  return {
    scale,
    markX: width / 2 - ATOMA_MARK_LOCAL_CENTER,
    markY: height / 2 - ATOMA_MARK_LOCAL_CENTER,
    sliderX: inspectX,
    sliderY,
    sliderWidth,
    sliderHeight: SLIDER_HEIGHT,
    beadX: inspectX + sliderWidth + 16,
    beadY: sliderY,
    beadWidth: BEAD_CHECK_WIDTH,
    beadHeight: SLIDER_HEIGHT,
    copyX: width / 2,
    copyY,
    copyWidth,
    copyHeight: COPY_HEIGHT,
    buttonX: (width - BUTTON_WIDTH) / 2,
    buttonY: copyY + COPY_HEIGHT + COPY_TO_BUTTON,
    buttonWidth: BUTTON_WIDTH,
    buttonHeight: BUTTON_HEIGHT,
  };
}

/**
 * Arrival gate: one floating Pixi crystal on the Three.js field, a one-line
 * pitch, and the continue control that will become login when tenancy lands.
 * Not a nav view. Inspect knobs remain behind `WELCOME_SHOW_INSPECT`.
 */
export function drawWelcome(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const layout = welcomeLayout(width, height);
  attachAtomaMark(
    ctx.markRoot,
    (callback) => ctx.addTicker(callback),
    layout.markX,
    layout.markY,
    layout.scale,
    ctx.pixiRenderer,
    { bobPx: FLOAT_AMPLITUDE_PX, bobPeriodMs: FLOAT_PERIOD_MS }
  );
  if (WELCOME_SHOW_INSPECT) {
    ctx.turnSlider(
      ctx.root,
      layout.sliderX,
      layout.sliderY,
      layout.sliderWidth,
      snapshot.t('welcome.turn'),
      snapshot.t('welcome.turnLive')
    );
    ctx.markBeadCheck(
      ctx.root,
      'welcome.bead',
      layout.beadX,
      layout.beadY,
      layout.beadWidth,
      snapshot.t('welcome.bead')
    );
  }
  const tagline = ctx.text(
    ctx.root,
    snapshot.t('welcome.tagline'),
    layout.copyX,
    layout.copyY,
    {
      size: 14,
      color: GPU_COLORS.muted,
      weight: '400',
      width: layout.copyWidth,
      alpha: 0.88,
    }
  );
  tagline.anchor.set(0.5, 0);
  ctx.button(
    ctx.root,
    'welcome.continue',
    'button',
    snapshot.t('welcome.continue'),
    layout.buttonX,
    layout.buttonY,
    layout.buttonWidth,
    layout.buttonHeight,
    false,
    snapshot.onActivate,
    GPU_COLORS.primary,
    true
  );
}
