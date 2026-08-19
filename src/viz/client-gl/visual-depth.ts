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
    fieldZ: -10,
    fieldScale: [48, 27] as const,
    topologyZ: -2.8,
    topologyPitch: -0.08,
    topologyPitchAmplitude: 0.025,
    topologyYawAmplitude: 0.035,
    topologyPointerIntensity: 10,
    topologyBounds: {
      halfX: 7.85,
      halfY: 3.65,
      halfZ: 1.55,
    },
    colorGain: 0.7,
    alpha: 0.64,
    motionRate: 0.035,
    gridFrequency: 24,
    pointerGain: 0.32,
    pointerHaloRadius: POINTER_LIGHT_RADIUS_PX * FAR_POINTER_SPREAD,
    pointerCoreRadius: POINTER_LIGHT_CORE_RADIUS_PX * FAR_POINTER_SPREAD,
    /**
     * How much wider a rear-face pool is on the far plane than in the mark's
     * local box. The lantern lights the FIELD, which is metres behind the gem
     * in this depth model, so the halo has to spread — a 1:1 copy would read
     * as a sticker on the crystal again.
     */
    markHaloSpread: 1.35,
    /**
     * Floor, in CSS pixels, so a header-sized crystal still throws past the
     * 52px bar onto the page field. Welcome scale already exceeds this.
     */
    markHaloMinPx: 168,
    /**
     * Loudness of stained lantern light on the aurora. Above the pointer so
     * mix-blend screen still shows a tint; well below a second lamp. The
     * 1.85 / hot-core pass washed the welcome field to a teal spotlight.
     */
    markGain: 0.88,
  },
  mid: {
    threeZ: 0,
    pointerIntensity: 30,
  },
  near: {
    panelAlpha: 0.94,
    navAlpha: 0.95,
    cardAlpha: 0.96,
    shadowX: 4,
    shadowY: 6,
  },
} as const;

export function effectiveFarAlpha(backdropOpacity: number) {
  return backdropOpacity * VIZ_VISUAL_DEPTH.far.alpha;
}

export function maximumTopologyWorldZ() {
  const far = VIZ_VISUAL_DEPTH.far;
  const pitch = Math.abs(far.topologyPitch) + far.topologyPitchAmplitude;
  const yaw = far.topologyYawAmplitude;
  return far.topologyZ +
    Math.abs(Math.sin(yaw)) * far.topologyBounds.halfX +
    Math.abs(Math.cos(yaw) * Math.sin(pitch)) * far.topologyBounds.halfY +
    Math.abs(Math.cos(yaw) * Math.cos(pitch)) * far.topologyBounds.halfZ;
}
