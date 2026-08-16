import { describe, expect, it } from 'vitest';

import {
  softShadowLayers,
  softShadowPeakAlpha,
} from '../src/viz/client-gl/renderer/soft-shadow.js';

describe('soft shadow penumbra', () => {
  it('keeps the requested alpha as the stack peak, so it drops in for a flat fill', () => {
    // The whole point of solving for `per`: every call site kept the alpha it
    // already passed, and none of them had to be re-tuned when the flat fill
    // became a stack. If this drifts, every shadow in the scene changes weight.
    for (const alpha of [0.4, 0.44, 0.48, 0.56]) {
      const layers = softShadowLayers(200, 40, 10, alpha);
      expect(softShadowPeakAlpha(layers)).toBeCloseTo(alpha, 6);
    }
  });

  it('grows outward and stays centred on the surface', () => {
    const layers = softShadowLayers(200, 40, 10, 0.5);
    expect(layers.length).toBeGreaterThan(1);
    for (const layer of layers) {
      // Each layer is the surface rect inflated by the same amount on all four
      // sides — an off-centre penumbra would read as a second offset, which is
      // the very defect this replaces.
      expect(layer.width + layer.x * 2).toBeCloseTo(200, 6);
      expect(layer.height + layer.y * 2).toBeCloseTo(40, 6);
      expect(layer.radius).toBeCloseTo(10 - layer.x, 6);
    }
  });

  it('orders layers outermost first so painting them in order builds toward the core', () => {
    const layers = softShadowLayers(200, 40, 10, 0.5);
    const widths = layers.map((layer) => layer.width);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    // The last one is the core: the surface's own rect, no growth.
    expect(layers.at(-1)).toMatchObject({ x: 0, y: 0, width: 200, height: 40, radius: 10 });
  });

  it('softens with depth — a surface held further off the page blurs wider', () => {
    const near = softShadowLayers(200, 40, 10, 0.5, 0.5);
    const far = softShadowLayers(200, 40, 10, 0.5, 2);
    expect(far[0]!.width).toBeGreaterThan(near[0]!.width);
    // Wider, not darker: spreading a shadow must not also deepen it.
    expect(softShadowPeakAlpha(far)).toBeCloseTo(softShadowPeakAlpha(near), 6);
  });

  it('collapses to one crisp rect at depth 0, keeping a flat surface an exact no-op', () => {
    const layers = softShadowLayers(200, 40, 10, 0.5, 0);
    expect(layers).toEqual([{ x: 0, y: 0, width: 200, height: 40, radius: 10, alpha: 0.5 }]);
  });

  it('emits nothing for a shadow with no area or no opacity', () => {
    // A degenerate rect would otherwise cost a full stack of tessellated
    // geometry per frame for something that cannot be seen.
    expect(softShadowLayers(0, 40, 10, 0.5)).toEqual([]);
    expect(softShadowLayers(200, 0, 10, 0.5)).toEqual([]);
    expect(softShadowLayers(200, 40, 10, 0)).toEqual([]);
    expect(softShadowLayers(200, 40, 10, -1)).toEqual([]);
  });

  it('never composites past full opacity', () => {
    expect(softShadowPeakAlpha(softShadowLayers(200, 40, 10, 5))).toBeCloseTo(1, 6);
  });
});
