import { describe, expect, it } from 'vitest';
import {
  POINTER_LIGHT_CORE_RADIUS_PX,
  POINTER_LIGHT_RADIUS_PX,
} from '../src/viz/client-gl/pointer-light.js';
import {
  effectiveFarAlpha,
  VIZ_VISUAL_DEPTH,
} from '../src/viz/client-gl/visual-depth.js';
import { readFileSync } from 'node:fs';

describe('viz visual depth contract', () => {
  it('keeps the aurora field slower and finer-grained than a UI grid', () => {
    expect(VIZ_VISUAL_DEPTH.far.motionRate).toBeLessThanOrEqual(0.055 * 0.65);
    expect(VIZ_VISUAL_DEPTH.far.gridFrequency).toBeGreaterThan(18);
    expect(VIZ_VISUAL_DEPTH.far.compositeOpacity).toBeGreaterThan(0);
    expect(VIZ_VISUAL_DEPTH.far.compositeOpacity).toBeLessThan(1);
  });

  it('makes near surfaces more opaque than the composited far field', () => {
    const styles = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    expect(styles).not.toMatch(/\.three-backdrop/);
    const farAlpha = effectiveFarAlpha();
    expect(farAlpha).toBeLessThanOrEqual(0.34);
    expect(VIZ_VISUAL_DEPTH.near.panelAlpha / farAlpha).toBeGreaterThan(2.7);
    expect(VIZ_VISUAL_DEPTH.near.navAlpha).toBeGreaterThanOrEqual(
      VIZ_VISUAL_DEPTH.near.panelAlpha
    );
    expect(VIZ_VISUAL_DEPTH.near.cardAlpha).toBeGreaterThan(
      VIZ_VISUAL_DEPTH.near.navAlpha
    );
    expect(VIZ_VISUAL_DEPTH.near.shadowY).toBeGreaterThan(
      VIZ_VISUAL_DEPTH.near.shadowX
    );
  });

  it('keeps a wider, weaker pointer contribution on the far field', () => {
    expect(VIZ_VISUAL_DEPTH.far.pointerGain).toBeLessThanOrEqual(0.35);
    expect(VIZ_VISUAL_DEPTH.far.pointerHaloRadius).toBeGreaterThan(
      POINTER_LIGHT_RADIUS_PX
    );
    expect(VIZ_VISUAL_DEPTH.far.pointerCoreRadius).toBeGreaterThan(
      POINTER_LIGHT_CORE_RADIUS_PX
    );
    expect(VIZ_VISUAL_DEPTH.far.markGain).toBeGreaterThan(
      VIZ_VISUAL_DEPTH.far.pointerGain
    );
    expect(VIZ_VISUAL_DEPTH.far.markGain).toBeLessThan(1);
    expect(VIZ_VISUAL_DEPTH.far.markHaloSpread).toBeGreaterThan(1);
    expect(VIZ_VISUAL_DEPTH.far.markHaloSpread).toBeLessThan(2);
    expect(VIZ_VISUAL_DEPTH.far.markHaloMinPx).toBeGreaterThan(52);
  });

  it('lights only the Pixi foreground while leaving the ambient field unfiltered', () => {
    const renderer = readFileSync('src/viz/client-gl/gpu-renderer.ts', 'utf8');
    // Layer ORDER, bottom to top: the ambient field, the filtered UI stage,
    // the crystal, and the hover bubble last so it draws over all of them.
    expect(renderer).toMatch(
      /stage\.addChild\(this\.ambientRoot, this\.stage, this\.markRoot, this\.tooltipRoot\)/
    );
    // The bubble is chrome, not lit surface: the pointer light must not smear
    // the text a reader opened it to read.
    expect(renderer).not.toMatch(/this\.tooltipRoot\.filters\s*=/);
    expect(renderer).toMatch(/drawAmbientGrid\(this\.ambientRoot/);
    expect(renderer).toMatch(/this\.stage\.filters = \[filter\]/);
    expect(renderer).not.toMatch(/this\.ambientRoot\.filters\s*=/);
    expect(renderer).not.toMatch(/this\.markRoot\.filters\s*=/);
    expect(renderer).toMatch(/attachAtomaMark\(\s*this\.markRoot/);
    expect(renderer).toMatch(/createFarField\(/);
    expect(renderer).toMatch(/FAR_FIELD_LABEL/);
    expect(renderer).toMatch(/ticker\.add\(this\.tickFarField\)/);
  });
});
