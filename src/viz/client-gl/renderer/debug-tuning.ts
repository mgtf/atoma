/**
 * Live tuning parameters for the GPU renderer: geometry offsets, light
 * intensity, material properties. These are drawn as sliders in the detail
 * pane and update the scene in real time.
 */

export interface TuningParams {
  /** How far the pointer light sits above the scene, in pixels. */
  pointerLightHeight: number;
  /** Intensity of the pointer light's illumination (0–1). */
  pointerLightIntensity: number;
  /** Hue rotation of the pointer light (0–360). */
  pointerLightHue: number;
  /** How far buttons sit above their containing frame, in pixels. */
  buttonDepth: number;
  /** How far control group frames sit above the main scene column, in pixels. */
  controlFrameDepth: number;
  /** How far the central scene column sits above the page background, in pixels. */
  columnDepth: number;
}

export const DEFAULT_TUNING: TuningParams = {
  pointerLightHeight: 24,
  pointerLightIntensity: 1,
  pointerLightHue: 0,
  buttonDepth: 2,
  controlFrameDepth: 4,
  columnDepth: 8,
};

export class TuningState {
  params: TuningParams = { ...DEFAULT_TUNING };

  update(partial: Partial<TuningParams>) {
    this.params = { ...this.params, ...partial };
  }

  reset() {
    this.params = { ...DEFAULT_TUNING };
  }
}

export const globalTuning = new TuningState();
