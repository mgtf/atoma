export const POINTER_LIGHT_RADIUS_PX = 220;

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
