import { Graphics, type Container } from 'pixi.js';
import type { RendererCtx } from '../../gpu-renderer.js';
import { TUNING_PANEL_ROW_HEIGHT } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { TUNING_KEYS } from '../../tuning.js';

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
 * A DEVELOPER surface, drawn only when the URL asks for it (`?atomaTune=1`),
 * mirroring the `?atomaDiag=1` handle the smokes use. The values it edits are
 * read by the renderer whether or not this panel is on screen — they are the
 * identity when untouched — so the tuned path and the shipped path are the
 * same code and the panel cannot bit-rot behind its flag.
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
  // Says how to turn it off, because a panel reached by a URL flag is also
  // dismissed by one and nothing else on screen would tell you that.
  ctx.text(parent, '?atomaTune', x + width - PANEL_PADDING - 58, y + PANEL_PADDING, {
    size: 8,
    color: GPU_COLORS.muted,
  });

  let cursor = y + PANEL_PADDING + PANEL_HEADING;
  for (const key of TUNING_KEYS) {
    ctx.tuningRow(parent, key, x + PANEL_PADDING, cursor, width - PANEL_PADDING * 2);
    cursor += TUNING_PANEL_ROW_HEIGHT + ROW_GAP;
  }
}
