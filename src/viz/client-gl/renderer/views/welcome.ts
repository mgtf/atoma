import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import {
  ATOMA_MARK_LOCAL_CENTER,
  attachAtomaMark,
} from '../atoma-mark.js';
import { prefersReducedMotion } from '../motion.js';
import { GPU_COLORS } from '../../theme.js';

const BUTTON_WIDTH = 200;
const BUTTON_HEIGHT = 46;
const GAP = 36;
const EDGE = 28;
const LOCAL_SIZE = ATOMA_MARK_LOCAL_CENTER * 2;
/** Fraction of the shorter viewport side. The arrival mark is the hero. */
const MARK_VIEWPORT_FRACTION = 0.52;
const FLOAT_AMPLITUDE_PX = 12;
const FLOAT_PERIOD_MS = 1800;

export interface WelcomeLayout {
  scale: number;
  markX: number;
  markY: number;
  buttonX: number;
  buttonY: number;
  buttonWidth: number;
  buttonHeight: number;
}

/**
 * Logo centred on the viewport; the continue control sits just below it and
 * is clamped so a short window still shows both. Pure so tests can check
 * geometry without a GPU.
 */
export function welcomeLayout(width: number, height: number): WelcomeLayout {
  const buttonBlock = GAP + BUTTON_HEIGHT + EDGE;
  const maxMarkPx = Math.min(
    Math.min(width, height) * MARK_VIEWPORT_FRACTION,
    Math.max(LOCAL_SIZE * 6, (height - buttonBlock - EDGE) * 0.92)
  );
  const scale = Math.max(6, maxMarkPx / LOCAL_SIZE);
  const radius = ATOMA_MARK_LOCAL_CENTER * scale;
  return {
    scale,
    markX: width / 2 - ATOMA_MARK_LOCAL_CENTER,
    markY: height / 2 - ATOMA_MARK_LOCAL_CENTER,
    buttonX: (width - BUTTON_WIDTH) / 2,
    buttonY: height / 2 + radius + GAP,
    buttonWidth: BUTTON_WIDTH,
    buttonHeight: BUTTON_HEIGHT,
  };
}

/**
 * Arrival gate: one floating Pixi crystal on the Three.js field, plus the
 * continue control that will become login when tenancy lands. Not a nav view.
 */
export function drawWelcome(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const layout = welcomeLayout(width, height);
  const mark = attachAtomaMark(
    ctx.root,
    (callback) => ctx.addTicker(callback),
    layout.markX,
    layout.markY,
    layout.scale,
    ctx.pixiRenderer
  );
  const baseY = layout.markY;
  if (!prefersReducedMotion()) {
    ctx.addTicker(() => {
      if (mark.destroyed) return;
      mark.y = baseY + Math.sin(performance.now() / FLOAT_PERIOD_MS) * FLOAT_AMPLITUDE_PX;
    });
  }
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
