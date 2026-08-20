import {
  POINTER_LIGHT_CORE_RADIUS_PX,
  POINTER_LIGHT_RADIUS_PX,
} from './pointer-light.js';

/**
 * The far field spreads the pointer WIDER and weaker than the Pixi foreground:
 * distance softens a light, so the backdrop pools further out at lower gain.
 * Derived rather than typed in, so shrinking the near light cannot leave a
 * backdrop halo hanging around it — which is exactly how the pool came to
 * dwarf everything it lit.
 */
const FAR_POINTER_SPREAD = 1.15;

export const VIZ_VISUAL_DEPTH = {
  far: {
    colorGain: 0.7,
    alpha: 0.64,
    /**
     * Was CSS opacity on the Three.js canvas. Baked into the Pixi field so
     * one canvas still composites as dark as the old two-layer stack.
     */
    compositeOpacity: 0.52,
    motionRate: 0.035,
    gridFrequency: 24,
    pointerGain: 0.32,
    pointerHaloRadius: POINTER_LIGHT_RADIUS_PX * FAR_POINTER_SPREAD,
    pointerCoreRadius: POINTER_LIGHT_CORE_RADIUS_PX * FAR_POINTER_SPREAD,
    /**
     * How much wider a rear-face pool is on the far plane than in the mark's
     * local box. The lantern lights the FIELD behind the gem, so the halo
     * has to spread — a 1:1 copy would read as a sticker on the crystal.
     */
    markHaloSpread: 1.35,
    /**
     * Floor, in CSS pixels, so a header-sized crystal still throws past the
     * 52px bar onto the page field. Welcome scale already exceeds this.
     */
    markHaloMinPx: 168,
    /**
     * Loudness of stained lantern light on the aurora. Above the pointer so
     * a tint still reads; well below a second lamp. The 1.85 / hot-core pass
     * washed the welcome field to a teal spotlight.
     */
    markGain: 0.88,
  },
  near: {
    panelAlpha: 0.94,
    navAlpha: 0.95,
    cardAlpha: 0.96,
    shadowX: 4,
    shadowY: 6,
  },
} as const;

export function effectiveFarAlpha() {
  return VIZ_VISUAL_DEPTH.far.compositeOpacity * VIZ_VISUAL_DEPTH.far.alpha;
}
