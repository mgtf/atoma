import { Graphics, type Container } from 'pixi.js';
import type { RendererCtx } from '../../gpu-renderer.js';
import { TUNING_PANEL_ROW_HEIGHT } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { TUNING_KEYS } from '../../tuning.js';
import { resetTuning } from '../../tuning-live.js';

const PANEL_PADDING = 12;
const PANEL_HEADING = 20;
const ROW_GAP = 6;

/** Height this panel needs, so the caller can reserve it before drawing. */
export function tuningPanelHeight(): number {
  return (
    PANEL_PADDING * 2 +
    PANEL_HEADING +
    TUNING_KEYS.length * (TUNING_PANEL_ROW_HEIGHT + ROW_GAP)
  );
}

/**
 * The scene tuning panel: six live knobs over the light and the three depth
 * stacks it throws shadows from.
 *
 * Visible by default in the runs right column. `?atomaTune=0` hides it, for a
 * clean screenshot or to judge the scene without its own controls sitting in
 * it. RESET forgets the persisted offsets so the next visit is the shipped
 * identity. The values it edits are read by the renderer whether or not the
 * panel is on screen — they are the identity when untouched — so the tuned
 * path and the shipped path are the same code and neither can bit-rot.
 */
export function drawTuningPanel(
  ctx: RendererCtx,
  parent: Container,
  x: number,
  y: number,
  width: number
): void {
  const height = tuningPanelHeight();
  const frame = new Graphics();
  frame.roundRect(x, y, width, height, 8);
  frame.fill({ color: GPU_COLORS.panelRaised, alpha: 0.55 });
  frame.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.7 });
  frame.eventMode = 'none';
  parent.addChild(frame);

  ctx.text(parent, 'SCENE TUNING', x + PANEL_PADDING, y + PANEL_PADDING, {
    size: 9,
    color: GPU_COLORS.primary,
    weight: '700',
  });
  // Persisted drags used to restyle the next visit with no way back to the
  // identity (review 2026-08-18 §1.11). RESET is that way back.
  const resetWidth = 52;
  const hideHintWidth = 66;
  ctx.button(
    parent,
    'tuning:reset',
    'button',
    'RESET',
    x + width - PANEL_PADDING - hideHintWidth - 8 - resetWidth,
    y + PANEL_PADDING - 2,
    resetWidth,
    16,
    false,
    () => resetTuning()
  );
  // How to dismiss it. Nothing else on screen would tell you, and a panel you
  // cannot turn off is in the way the moment you want to judge the scene.
  ctx.text(parent, '?atomaTune=0', x + width - PANEL_PADDING - hideHintWidth, y + PANEL_PADDING, {
    size: 8,
    color: GPU_COLORS.muted,
  });

  let cursor = y + PANEL_PADDING + PANEL_HEADING;
  for (const key of TUNING_KEYS) {
    ctx.tuningRow(parent, key, x + PANEL_PADDING, cursor, width - PANEL_PADDING * 2);
    cursor += TUNING_PANEL_ROW_HEIGHT + ROW_GAP;
  }
}
