/**
 * Debug tuning panel for the Runs view's right pane.
 *
 * Displays sliders for real-time control of the scene's geometry and
 * lighting: pointer light height and intensity, control frame depth, button
 * depth, column depth.
 */

import { Container, Graphics, Rectangle } from 'pixi.js';
import type { RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import {
  globalTuning,
  type TuningParams,
} from '../debug-tuning.js';
import { Slider } from '../slider.js';

interface SliderDef {
  label: string;
  key: keyof TuningParams;
  min: number;
  max: number;
  step?: number;
}

const SLIDER_DEFS: SliderDef[] = [
  { label: 'Pointer light height', key: 'pointerLightHeight', min: 8, max: 80, step: 1 },
  { label: 'Pointer light intensity', key: 'pointerLightIntensity', min: 0, max: 2, step: 0.1 },
  { label: 'Pointer light hue', key: 'pointerLightHue', min: 0, max: 360, step: 1 },
  { label: 'Button depth', key: 'buttonDepth', min: 0, max: 12, step: 0.5 },
  { label: 'Control frame depth', key: 'controlFrameDepth', min: 0, max: 16, step: 0.5 },
  { label: 'Column depth', key: 'columnDepth', min: 0, max: 24, step: 0.5 },
];

const SLIDER_HEIGHT = 28;
const LABEL_WIDTH = 160;
const SLIDER_WIDTH = 140;

export function drawDebugPanel(
  ctx: RendererCtx,
  parent: Container,
  x: number,
  y: number,
  width: number,
  maxHeight: number
): { height: number; bounds: Rectangle } {
  const sliderSpacing = SLIDER_HEIGHT + 8;
  const totalHeight = SLIDER_DEFS.length * sliderSpacing + 20;

  if (totalHeight > maxHeight) {
    // Panel doesn't fit; draw nothing.
    return { height: 0, bounds: new Rectangle(x, y, width, 0) };
  }

  // Background card
  const background = new Graphics();
  background.roundRect(x, y, width - 8, totalHeight, 8);
  background.fill({ color: GPU_COLORS.panelRaised, alpha: 0.45 });
  background.stroke({ color: GPU_COLORS.border, width: 1, alpha: 0.65 });
  parent.addChild(background);

  // Title
  ctx.text(parent, '⚙ Tuning', x + 12, y + 6, {
    size: 11,
    color: GPU_COLORS.primary,
    weight: '700',
  });

  // Sliders
  let cursor = y + 24;
  for (const sliderDef of SLIDER_DEFS) {
    const currentValue = globalTuning.params[sliderDef.key];

    // Label
    ctx.text(parent, sliderDef.label, x + 12, cursor + 3, {
      size: 9,
      color: GPU_COLORS.muted,
    });

    // Value display
    const displayValue = typeof currentValue === 'number'
      ? currentValue.toFixed(sliderDef.step ? 1 : 0)
      : '—';
    ctx.text(parent, displayValue, x + LABEL_WIDTH + SLIDER_WIDTH + 8, cursor + 3, {
      size: 9,
      color: GPU_COLORS.cyan,
      weight: '700',
    });

    // Slider
    const slider = new Slider({
      x: x + LABEL_WIDTH,
      y: cursor + 2,
      width: SLIDER_WIDTH,
      height: 14,
      min: sliderDef.min,
      max: sliderDef.max,
      step: sliderDef.step,
      initialValue: currentValue,
      onChange: (value) => {
        globalTuning.update({ [sliderDef.key]: value });
      },
    });
    parent.addChild(slider);

    cursor += sliderSpacing;
  }

  const bounds = new Rectangle(x, y, width - 8, totalHeight);
  return { height: totalHeight, bounds };
}
