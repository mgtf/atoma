/**
 * Live scene tuning: the six knobs the tuning panel exposes, as PURE data.
 *
 * Every value is a MULTIPLIER over what the scene already renders, and
 * `TUNING_IDENTITY` is the point where every multiplier is neutral. That is
 * the load-bearing property of this module: turning the panel on, or resetting
 * it, must reproduce the shipped look byte for byte rather than quietly
 * restyling the application. The first version of this panel declared
 * `buttonDepth: 2` against an effective depth of 1, so merely wiring it up
 * would have doubled every button's shadow offset and called that "the
 * default" — `tests/viz-tuning.test.ts` now pins each identity value against
 * the constant the renderer actually uses.
 *
 * No Pixi, no window, no store: this module is the vocabulary those layers
 * share, so the drag mapping and the range clamping can be tested without a
 * GPU or a DOM.
 */

export interface VizTuning {
  /**
   * How high the pointer light floats above the scene. Higher spreads the pool
   * wider and SHORTENS the shadows it throws, the way a lamp lifted off a desk
   * does; lower rakes them long. One number moves both, because the light's
   * reach and its shadows' reach are the same physical fact — `cast-shadow.ts`
   * says so, and this is what keeps them agreeing.
   */
  lightHeight: number;
  /** Brightness of the pool under the cursor. Scales the shader's uStrength. */
  lightIntensity: number;
  /** Degrees of hue rotation applied to the light's colour. 0 keeps the blue. */
  lightHue: number;
  /** How far a button stands off the frame that groups it. */
  buttonDepth: number;
  /** How far that group frame stands off the column behind it. */
  controlFrameDepth: number;
  /** How far the column stands off the page. */
  columnDepth: number;
}

/**
 * Neutral. Each value is the one the renderer uses today with no panel open:
 * see `addSurfaceShadow`'s `depth = 1` default (buttons), `filterBlockFrame`'s
 * explicit 0.8, and `panel`'s elevation-derived depths. A test asserts this,
 * because a drifting identity is invisible until the whole UI has shifted.
 */
export const TUNING_IDENTITY: VizTuning = {
  lightHeight: 1,
  lightIntensity: 1,
  lightHue: 0,
  buttonDepth: 1,
  controlFrameDepth: 0.8,
  columnDepth: 1,
};

export interface TuningRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Shown on the panel row. English; the panel is a developer surface. */
  readonly label: string;
  /** Rendered next to the value so a bare multiplier is not ambiguous. */
  readonly unit: '×' | '°';
}

/**
 * Ranges bracket the identity rather than starting at it, so every knob can be
 * pushed BOTH ways from the shipped look — a tuning panel that can only make
 * things bigger cannot tell you the shipped value was already too big.
 */
export const TUNING_RANGE: Readonly<Record<keyof VizTuning, TuningRange>> = {
  lightHeight: { min: 0.3, max: 3, step: 0.05, label: 'Light height', unit: '×' },
  lightIntensity: { min: 0, max: 2.5, step: 0.05, label: 'Light power', unit: '×' },
  lightHue: { min: -180, max: 180, step: 1, label: 'Light hue', unit: '°' },
  buttonDepth: { min: 0, max: 4, step: 0.05, label: 'Button lift', unit: '×' },
  controlFrameDepth: { min: 0, max: 4, step: 0.05, label: 'Group frame lift', unit: '×' },
  columnDepth: { min: 0, max: 4, step: 0.05, label: 'Column lift', unit: '×' },
};

export const TUNING_KEYS = Object.keys(TUNING_RANGE) as ReadonlyArray<keyof VizTuning>;

/** Snap to the range's step and clamp, so a value is always one a row can draw. */
export function clampTuningValue(key: keyof VizTuning, value: number): number {
  const range = TUNING_RANGE[key];
  if (!Number.isFinite(value)) return TUNING_IDENTITY[key];
  const stepped = Math.round(value / range.step) * range.step;
  const clamped = Math.min(range.max, Math.max(range.min, stepped));
  // Snapping by division leaves 0.30000000000000004 behind; the panel prints
  // this number, so round it to the step's own precision.
  const decimals = range.step < 1 ? String(range.step).split('.')[1]?.length ?? 0 : 0;
  return Number(clamped.toFixed(decimals));
}

/**
 * Where a pointer sitting at `pointerX` puts the value, given the track it is
 * dragging along. Both coordinates must be in the SAME space — renderer
 * pixels. The bug this replaces compared a window `clientX` against a Pixi
 * `position.x` (a coordinate in the parent's space), which agreed only by
 * accident on an unscaled canvas at the window origin.
 */
export function tuningValueFromTrack(
  key: keyof VizTuning,
  pointerX: number,
  trackX: number,
  trackWidth: number
): number {
  const range = TUNING_RANGE[key];
  if (!(trackWidth > 0) || !Number.isFinite(pointerX) || !Number.isFinite(trackX)) {
    return TUNING_IDENTITY[key];
  }
  const ratio = Math.min(1, Math.max(0, (pointerX - trackX) / trackWidth));
  return clampTuningValue(key, range.min + ratio * (range.max - range.min));
}

/** The inverse: where the thumb sits for a value. Same space as the track. */
export function trackXFromTuningValue(
  key: keyof VizTuning,
  value: number,
  trackX: number,
  trackWidth: number
): number {
  const range = TUNING_RANGE[key];
  const span = range.max - range.min;
  if (!(span > 0)) return trackX;
  const ratio = Math.min(1, Math.max(0, (value - range.min) / span));
  return trackX + ratio * trackWidth;
}

export function normalizeTuning(value: Partial<VizTuning> | null | undefined): VizTuning {
  const next = { ...TUNING_IDENTITY };
  if (!value) return next;
  for (const key of TUNING_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'number') next[key] = clampTuningValue(key, candidate);
  }
  return next;
}

/** True when nothing is being asked of the renderer beyond the shipped look. */
export function isIdentityTuning(value: VizTuning): boolean {
  return TUNING_KEYS.every((key) => value[key] === TUNING_IDENTITY[key]);
}
