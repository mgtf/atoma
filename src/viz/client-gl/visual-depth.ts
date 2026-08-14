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
    pointerHaloRadius: 260,
    pointerCoreRadius: 60,
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
