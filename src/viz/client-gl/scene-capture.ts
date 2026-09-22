/**
 * A STILL OF THE SCREEN, published by the renderer and read by the cube turn.
 *
 * The turn needs the face it is leaving after React has already swapped the
 * view, and only the renderer can produce it: the canvas is transparent where
 * nothing is drawn (`backgroundAlpha: 0`) and a WebGPU drawing buffer does not
 * hand its pixels back to `drawImage`. So the renderer renders the live scene
 * once more into an off-screen target, through the same camera transform the
 * screen is showing, and reads that back.
 *
 * A module handle rather than a prop, for the same reason the pointer light is
 * one: the renderer is created imperatively inside a lazy import, and React
 * must not hold a reference to it to ask a question between two frames.
 */

/**
 * A still, and the view it depicts. The turn needs BOTH faces: the one it
 * leaves, taken before the renderer redraws, and the destination's, taken once
 * the renderer has drawn it — the rail is served from that second one, which is
 * why the row you clicked is lit from the first frame of the turn instead of
 * catching up when the box lands.
 */
export interface SceneStill {
  readonly canvas: HTMLCanvasElement;
  readonly view: string;
}

type SceneCapture = () => SceneStill | null;

let capture: SceneCapture | null = null;

/** The renderer publishes on init and withdraws on destroy. */
export function publishSceneCapture(next: SceneCapture | null): void {
  capture = next;
}

/** Null whenever no renderer is mounted, or the readback failed. */
export function captureScene(): SceneStill | null {
  try {
    return capture?.() ?? null;
  } catch {
    return null;
  }
}
