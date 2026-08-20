import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POINTER_LIGHT_CORE_RADIUS_PX,
  POINTER_LIGHT_RADIUS_PX,
} from '../src/viz/client-gl/pointer-light.js';
import {
  effectiveFarAlpha,
  maximumTopologyWorldZ,
  VIZ_VISUAL_DEPTH,
} from '../src/viz/client-gl/visual-depth.js';

describe('viz visual depth contract', () => {
  it('keeps the decorative field and topology behind the aligned Three midground', () => {
    expect(VIZ_VISUAL_DEPTH.far.fieldZ).toBeLessThan(
      VIZ_VISUAL_DEPTH.far.topologyZ
    );
    expect(VIZ_VISUAL_DEPTH.far.topologyZ).toBeLessThan(
      VIZ_VISUAL_DEPTH.mid.threeZ
    );
    expect(maximumTopologyWorldZ()).toBeLessThan(
      VIZ_VISUAL_DEPTH.mid.threeZ - 0.4
    );
    expect(VIZ_VISUAL_DEPTH.far.motionRate).toBeLessThanOrEqual(0.055 * 0.65);
    expect(VIZ_VISUAL_DEPTH.far.gridFrequency).toBeGreaterThan(18);
  });

  it('makes near surfaces more opaque than the composited far field', () => {
    const styles = readFileSync('src/viz/client-gl/styles.css', 'utf8');
    const backdropOpacity = Number(
      /\.three-backdrop\s*\{[^}]*opacity:\s*([\d.]+)/s.exec(styles)?.[1]
    );
    expect(backdropOpacity).toBeGreaterThan(0);
    const farAlpha = effectiveFarAlpha(backdropOpacity);
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
    expect(
      VIZ_VISUAL_DEPTH.far.topologyPointerIntensity /
      VIZ_VISUAL_DEPTH.mid.pointerIntensity
    ).toBeLessThanOrEqual(0.35);
    // WIDER than the foreground light, whatever the foreground light is. The
    // old form froze both sides as literals, so shrinking the near pool left
    // the far one stranded at its former size around a smaller cursor light.
    expect(VIZ_VISUAL_DEPTH.far.pointerHaloRadius).toBeGreaterThan(
      POINTER_LIGHT_RADIUS_PX
    );
    expect(VIZ_VISUAL_DEPTH.far.pointerCoreRadius).toBeGreaterThan(
      POINTER_LIGHT_CORE_RADIUS_PX
    );
    // Stained lantern light tints the far field; it must stay above the
    // pointer hint (mix-blend screen eats dim adds) and below a spotlight.
    expect(VIZ_VISUAL_DEPTH.far.markGain).toBeGreaterThan(
      VIZ_VISUAL_DEPTH.far.pointerGain
    );
    expect(VIZ_VISUAL_DEPTH.far.markGain).toBeLessThan(1);
    expect(VIZ_VISUAL_DEPTH.far.markHaloSpread).toBeGreaterThan(1);
    expect(VIZ_VISUAL_DEPTH.far.markHaloSpread).toBeLessThan(2);
    expect(VIZ_VISUAL_DEPTH.far.markHaloMinPx).toBeGreaterThan(52);
  });

  it('lights only the Pixi foreground while leaving the ambient grid on the far plane', () => {
    const renderer = readFileSync('src/viz/client-gl/gpu-renderer.ts', 'utf8');
    expect(renderer).toMatch(/stage\.addChild\(this\.ambientRoot, this\.root, this\.markRoot\)/);
    expect(renderer).toMatch(/drawAmbientGrid\(this\.ambientRoot/);
    expect(renderer).toMatch(/this\.root\.filters = \[filter\]/);
    expect(renderer).not.toMatch(/this\.ambientRoot\.filters\s*=/);
    expect(renderer).not.toMatch(/this\.markRoot\.filters\s*=/);
    expect(renderer).toMatch(/attachAtomaMark\(\s*this\.markRoot/);
  });
});
