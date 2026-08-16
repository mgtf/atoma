/**
 * THE pointer-light geometry, in CSS pixels. One definition, consumed by the
 * Pixi filter shaders (both GLSL and WGSL), by the far-field backdrop through
 * `VIZ_VISUAL_DEPTH`, and by `pointerLightFalloff` for CPU-side reasoning.
 * The shaders used to hardcode their own copies, which is how the pool ended
 * up wider than anything it was lighting.
 */
export const POINTER_LIGHT_RADIUS_PX = 150;
/**
 * The near falloff. Deliberately NOT a bright core: the light is under the
 * cursor, so this tightens the pool close in — it does not add a highlight
 * that would read as a lamp sitting on top of the scene.
 */
export const POINTER_LIGHT_CORE_RADIUS_PX = 34;

export interface PointerLightSnapshot {
  readonly clientX: number;
  readonly clientY: number;
  readonly active: boolean;
  readonly revision: number;
}

export interface PointerLightBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

const pointerLight = {
  clientX: 0,
  clientY: 0,
  active: false,
  revision: 0,
};

export function readPointerLight(): PointerLightSnapshot {
  return pointerLight;
}

export function movePointerLight(clientX: number, clientY: number) {
  pointerLight.clientX = clientX;
  pointerLight.clientY = clientY;
  pointerLight.active = true;
  pointerLight.revision += 1;
}

export function hidePointerLight() {
  if (!pointerLight.active) return;
  pointerLight.active = false;
  pointerLight.revision += 1;
}

export function pointerClientToUv(
  clientX: number,
  clientY: number,
  width: number,
  height: number
) {
  return {
    x: clientX / Math.max(1, width),
    y: 1 - clientY / Math.max(1, height),
  };
}

export function pointerClientToRenderer(
  clientX: number,
  clientY: number,
  bounds: PointerLightBounds,
  rendererWidth: number,
  rendererHeight: number
) {
  return {
    x: (clientX - bounds.left) * rendererWidth / Math.max(1, bounds.width),
    y: (clientY - bounds.top) * rendererHeight / Math.max(1, bounds.height),
  };
}

export function pointerLightFalloff(
  distancePx: number,
  radiusPx = POINTER_LIGHT_RADIUS_PX
) {
  const normalized = Math.max(0, distancePx) / Math.max(1, radiusPx);
  return Math.exp(-normalized * normalized * 2.2);
}
