import { GPU_LAYOUT, sidebarWidthForViewport } from './theme.js';

/**
 * The one camera for the complete visualizer scene.
 *
 * Pixi's display tree is two-dimensional, so the browser composites the final
 * scene plane through this pinhole camera. A pose names both the point on that
 * plane the lens looks at (`target`) and where the optical axis lands in the
 * viewport (`anchor`). Overview is the exact, undeformed authored plane;
 * navigation alone moves the camera to the compact rail + content column.
 */

export type SceneCameraMode = 'overview' | 'focus';

export interface SceneCamera {
  /** Resolved distance from the projection plane in CSS pixels. */
  readonly perspectivePx: number;
  /** Positive pitches the foot of the scene toward the viewer. */
  readonly pitchDegrees: number;
  /** Positive turns the scene's left edge toward the viewer. */
  readonly yawDegrees: number;
  /** Pull-back/approach of the complete scene plane. */
  readonly sceneScale: number;
  /** Point on the unprojected plane the lens looks at, as viewport ratios. */
  readonly targetXRatio: number;
  readonly targetYRatio: number;
  /** Source-plane row pinned to the viewport top, as a height ratio. */
  readonly sourceTopRatio: number;
  /** Viewport point where the optical axis lands, as viewport ratios. */
  readonly anchorXRatio: number;
  readonly anchorYRatio: number;
}

export interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

export interface SceneCameraViewport {
  readonly width: number;
  readonly height: number;
  readonly camera: SceneCamera;
  /** Row-major projective matrix from scene pixels to client pixels. */
  readonly forward: Matrix3;
  /** The inverse matrix, calculated once when the frame is published. */
  readonly inverse: Matrix3;
  /** Exact CSS projection represented by `forward`. */
  readonly cssTransform: string;
}

type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

const OVERVIEW_MIN_DISTANCE_PX = 1600;
const OVERVIEW_DISTANCE_VIEWPORT_RATIO = 2.2;
const FOCUS_MIN_DISTANCE_PX = 1800;
const FOCUS_DISTANCE_VIEWPORT_RATIO = 3;
const FOCUS_RAIL_GUARD_PX = 8;
const FOCUS_MAX_SCALE = 1.12;

/**
 * Reference overview pose. `sceneCameraForMode()` resolves its responsive
 * distance for the live viewport; this export remains useful for explicit
 * tests and hand-authored variants.
 */
export const SCENE_CAMERA: SceneCamera = Object.freeze({
  perspectivePx: OVERVIEW_MIN_DISTANCE_PX,
  // Overview is deliberately the identity plane. The camera exists from the
  // first frame, but a reader must see the authored scene without convergence,
  // scale or skew until navigation explicitly asks it to focus.
  pitchDegrees: 0,
  yawDegrees: 0,
  sceneScale: 1,
  targetXRatio: 0.5,
  targetYRatio: 0.5,
  sourceTopRatio: 0,
  anchorXRatio: 0.5,
  anchorYRatio: 0.5,
});

const degreesToRadians = (degrees: number) => degrees * Math.PI / 180;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

/** A smooth camera acceleration with zero velocity at both poses. */
export function sceneCameraEase(progress: number): number {
  const value = clamp01(progress);
  return value * value * value * (value * (value * 6 - 15) + 10);
}

/**
 * Resolves the requested navigation pose for this viewport.
 *
 * Overview is the exact authored plane. Focus aims at the centre of the
 * content viewport (the column to the right of the rail) and approaches it,
 * so that column moves to the optical centre while a narrow part of the rail
 * remains as spatial context.
 */
export function sceneCameraForMode(
  mode: SceneCameraMode,
  viewportWidth: number,
  viewportHeight: number
): SceneCamera {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const longestSide = Math.max(width, height);
  if (mode === 'overview') {
    return {
      ...SCENE_CAMERA,
      perspectivePx: Math.max(
        OVERVIEW_MIN_DISTANCE_PX,
        longestSide * OVERVIEW_DISTANCE_VIEWPORT_RATIO
      ),
    };
  }
  const contentLeft = sidebarWidthForViewport(width);
  const contentCentreX = contentLeft + (width - contentLeft) / 2;
  const contentCentreXRatio = contentCentreX / width;
  const buttonLeft = Math.max(0, contentLeft - GPU_LAYOUT.sidebarFocusButtonWidth);
  const guard = Math.min(FOCUS_RAIL_GUARD_PX, buttonLeft);
  const perspectivePx = Math.max(
    FOCUS_MIN_DISTANCE_PX,
    longestSide * FOCUS_DISTANCE_VIEWPORT_RATIO
  );
  const pitchDegrees = 1.25;
  const pitch = degreesToRadians(pitchDegrees);
  const sourceTopRatio = Math.min(1, GPU_LAYOUT.focusTopInset / height);
  const topPerspectiveFactor = Math.sin(pitch) *
    (height / 2 - GPU_LAYOUT.focusTopInset) / perspectivePx;
  // Keep the source layout stable while the camera travels. The labelled
  // rail keeps its overview width on the plane, but focus draws its icon at
  // the trailing edge and projects that edge into a compact screen-space rail.
  // Solve the top-edge scale from the requested guard. Pitch changes the
  // apparent scale across the plane, so this uses the top edge rather than an
  // affine approximation. The cap keeps compact viewports legible.
  const requestedTopScale = (width - guard) / Math.max(1, width - buttonLeft);
  const focusScale = Math.min(
    FOCUS_MAX_SCALE,
    Math.max(
      1,
      requestedTopScale / Math.max(
        Number.EPSILON,
        1 - requestedTopScale * topPerspectiveFactor
      )
    )
  );
  return pinSceneCameraTopRight({
    perspectivePx,
    pitchDegrees,
    // The vertical rail is the stable edge of the composition. Horizontal
    // convergence would move it by a viewport-dependent amount; pitch keeps
    // the requested depth without sacrificing that anchor.
    yawDegrees: 0,
    sceneScale: focusScale,
    targetXRatio: contentCentreXRatio,
    targetYRatio: 0.5,
    // The focus rail replaces the horizontal header. Frame the first content
    // row at the viewport top so removing the bar also recovers its space for
    // every Pixi view and every DOM overlay on the same scene plane.
    sourceTopRatio,
    anchorXRatio: 0.5,
    anchorYRatio: 0.5,
  }, width, height);
}

/**
 * Re-anchors a yaw-neutral pose so its framed source-top row covers y=0 and
 * its right corner lands exactly on the viewport corner. The lower
 * right edge then projects beyond the viewport for a positive pitch, leaving
 * no page-background strip or wedge. This also runs on travelling poses:
 * interpolating two valid anchors alone does not preserve a projective edge.
 */
export function pinSceneCameraTopRight(
  camera: SceneCamera,
  viewportWidth: number,
  viewportHeight: number
): SceneCamera {
  const yaw = degreesToRadians(camera.yawDegrees);
  if (Math.abs(Math.sin(yaw)) > 1e-9) return camera;
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const pitch = degreesToRadians(camera.pitchDegrees);
  const targetX = camera.targetXRatio * width;
  const targetY = camera.targetYRatio * height;
  const sourceTopY = camera.sourceTopRatio * height;
  const distance = Math.max(1, camera.perspectivePx);
  const targetToTop = targetY - sourceTopY;
  const topDivisor = 1 +
    camera.sceneScale * Math.sin(pitch) * targetToTop / distance;
  if (!Number.isFinite(topDivisor) || topDivisor <= 1e-9) return camera;
  const topScale = camera.sceneScale / topDivisor;
  return {
    ...camera,
    anchorXRatio: (width - topScale * (width - targetX)) / width,
    anchorYRatio: topScale * Math.cos(pitch) * targetToTop / height,
  };
}

function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Interpolates one physical pose. Pass an eased 0..1 progress. */
export function interpolateSceneCamera(
  from: SceneCamera,
  to: SceneCamera,
  progress: number
): SceneCamera {
  const value = clamp01(progress);
  if (value === 0) return from;
  if (value === 1) return to;
  const inverseDistance = lerp(1 / from.perspectivePx, 1 / to.perspectivePx, value);
  return {
    perspectivePx: 1 / Math.max(Number.EPSILON, inverseDistance),
    pitchDegrees: from.pitchDegrees + shortestAngle(from.pitchDegrees, to.pitchDegrees) * value,
    yawDegrees: from.yawDegrees + shortestAngle(from.yawDegrees, to.yawDegrees) * value,
    sceneScale: Math.exp(lerp(Math.log(from.sceneScale), Math.log(to.sceneScale), value)),
    targetXRatio: lerp(from.targetXRatio, to.targetXRatio, value),
    targetYRatio: lerp(from.targetYRatio, to.targetYRatio, value),
    sourceTopRatio: lerp(from.sourceTopRatio, to.sourceTopRatio, value),
    anchorXRatio: lerp(from.anchorXRatio, to.anchorXRatio, value),
    anchorYRatio: lerp(from.anchorYRatio, to.anchorYRatio, value),
  };
}

interface CameraBasis {
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

/** Rotated and scaled X/Y basis vectors of the scene plane. */
function cameraBasis(camera: SceneCamera): CameraBasis {
  const pitch = degreesToRadians(camera.pitchDegrees);
  const yaw = degreesToRadians(camera.yawDegrees);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const scale = camera.sceneScale;

  // CSS applies scale -> rotateX -> rotateY -> perspective.
  return {
    ux: scale * cosYaw,
    uy: 0,
    uz: -scale * sinYaw,
    vx: scale * sinYaw * sinPitch,
    vy: scale * cosPitch,
    vz: scale * cosYaw * sinPitch,
  };
}

function multiplyMatrix3(left: Matrix3, right: Matrix3): Matrix3 {
  return [
    left[0] * right[0] + left[1] * right[3] + left[2] * right[6],
    left[0] * right[1] + left[1] * right[4] + left[2] * right[7],
    left[0] * right[2] + left[1] * right[5] + left[2] * right[8],
    left[3] * right[0] + left[4] * right[3] + left[5] * right[6],
    left[3] * right[1] + left[4] * right[4] + left[5] * right[7],
    left[3] * right[2] + left[4] * right[5] + left[5] * right[8],
    left[6] * right[0] + left[7] * right[3] + left[8] * right[6],
    left[6] * right[1] + left[7] * right[4] + left[8] * right[7],
    left[6] * right[2] + left[7] * right[5] + left[8] * right[8],
  ];
}

function invertMatrix3(matrix: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const inverse = 1 / determinant;
  return [
    A * inverse,
    (c * h - b * i) * inverse,
    (b * f - c * e) * inverse,
    B * inverse,
    (a * i - c * g) * inverse,
    (c * d - a * f) * inverse,
    C * inverse,
    (b * g - a * h) * inverse,
    (a * e - b * d) * inverse,
  ];
}

function cssNumber(value: number): string {
  const rounded = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));
  return String(rounded);
}

function matrix3dCss(matrix: Matrix3): string {
  // CSS matrix3d is column-major. This embeds the 3x3 plane homography in a
  // 4x4 matrix whose homogeneous w performs the pinhole divide.
  const values = [
    matrix[0], matrix[3], 0, matrix[6],
    matrix[1], matrix[4], 0, matrix[7],
    0, 0, 1, 0,
    matrix[2], matrix[5], 0, matrix[8],
  ];
  return `matrix3d(${values.map(cssNumber).join(', ')})`;
}

/** Builds the one atomic frame consumed by CSS and all pointer mappings. */
export function buildSceneCameraFrame(
  camera: SceneCamera,
  viewportWidth: number,
  viewportHeight: number
): SceneCameraViewport {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const targetX = camera.targetXRatio * width;
  const targetY = camera.targetYRatio * height;
  const anchorX = camera.anchorXRatio * width;
  const anchorY = camera.anchorYRatio * height;
  const basis = cameraBasis(camera);
  const distance = Math.max(1, camera.perspectivePx);
  const local: Matrix3 = [
    basis.ux, basis.vx, 0,
    basis.uy, basis.vy, 0,
    -basis.uz / distance, -basis.vz / distance, 1,
  ];
  const fromTarget: Matrix3 = [1, 0, -targetX, 0, 1, -targetY, 0, 0, 1];
  const toAnchor: Matrix3 = [1, 0, anchorX, 0, 1, anchorY, 0, 0, 1];
  const forward = multiplyMatrix3(toAnchor, multiplyMatrix3(local, fromTarget));
  return {
    width,
    height,
    camera,
    forward,
    inverse: invertMatrix3(forward),
    cssTransform: matrix3dCss(forward),
  };
}

/** CSS transform driven by the exact homography used by the math below. */
export function sceneCameraCssTransform(
  camera: SceneCamera,
  viewportWidth: number,
  viewportHeight: number
): string {
  return buildSceneCameraFrame(camera, viewportWidth, viewportHeight).cssTransform;
}

function applyMatrix(point: ScenePoint, matrix: Matrix3): ScenePoint {
  const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  const safeDivisor = Math.abs(divisor) < 1e-9
    ? Math.sign(divisor || 1) * 1e-9
    : divisor;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / safeDivisor,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / safeDivisor,
  };
}

/** Projects a point on the scene plane into viewport/client coordinates. */
export function projectScenePoint(
  point: ScenePoint,
  viewportWidth: number,
  viewportHeight: number,
  camera?: SceneCamera
): ScenePoint {
  const resolved = camera ?? sceneCameraForMode('overview', viewportWidth, viewportHeight);
  return applyMatrix(
    point,
    buildSceneCameraFrame(resolved, viewportWidth, viewportHeight).forward
  );
}

/** Intersects a client-space camera ray with the original scene plane. */
export function unprojectScenePoint(
  point: ScenePoint,
  viewportWidth: number,
  viewportHeight: number,
  camera?: SceneCamera
): ScenePoint {
  const resolved = camera ?? sceneCameraForMode('overview', viewportWidth, viewportHeight);
  return applyMatrix(
    point,
    buildSceneCameraFrame(resolved, viewportWidth, viewportHeight).inverse
  );
}

export function projectScenePointInFrame(
  point: ScenePoint,
  frame: SceneCameraViewport
): ScenePoint {
  return applyMatrix(point, frame.forward);
}

export function unprojectScenePointInFrame(
  point: ScenePoint,
  frame: SceneCameraViewport
): ScenePoint {
  return applyMatrix(point, frame.inverse);
}

/** Maps a client point on the projected plane back to Pixi renderer pixels. */
export function clientToRendererPoint(
  point: ScenePoint,
  rendererWidth: number,
  rendererHeight: number,
  frame: SceneCameraViewport
): ScenePoint {
  const scene = unprojectScenePointInFrame(point, frame);
  return {
    x: scene.x * rendererWidth / frame.width,
    y: scene.y * rendererHeight / frame.height,
  };
}

/** Maps a Pixi renderer point through the camera into client coordinates. */
export function rendererToClientPoint(
  point: ScenePoint,
  rendererWidth: number,
  rendererHeight: number,
  frame: SceneCameraViewport
): ScenePoint {
  return projectScenePointInFrame({
    x: point.x * frame.width / Math.max(1, rendererWidth),
    y: point.y * frame.height / Math.max(1, rendererHeight),
  }, frame);
}

const cameraFrames = new WeakMap<HTMLElement, SceneCameraViewport>();
const cameraPlaneCache = new WeakMap<Element, HTMLElement>();
type SceneCameraFrameListener = (frame: SceneCameraViewport) => void;
const cameraFrameListeners = new WeakMap<HTMLElement, Set<SceneCameraFrameListener>>();

function sceneCameraPlane(element: Element | null): HTMLElement | null {
  if (!element) return null;
  let plane: HTMLElement | null | undefined = cameraPlaneCache.get(element);
  if (plane === undefined) {
    plane = element.closest<HTMLElement>('[data-scene-camera="perspective"]');
    if (plane) cameraPlaneCache.set(element, plane);
  }
  return plane ?? null;
}

/**
 * Source-space row that meets the viewport foot in this exact camera frame.
 * Taking both corners keeps the contract valid if a future pose adds yaw.
 */
export function visibleSceneLayoutHeight(frame: SceneCameraViewport): number {
  const left = unprojectScenePointInFrame({ x: 0, y: frame.height }, frame).y;
  const right = unprojectScenePointInFrame({ x: frame.width, y: frame.height }, frame).y;
  return Math.max(0, Math.min(frame.height, left, right));
}

/** True only while the fixed scene plane is travelling between two poses. */
export function sceneCameraIsMoving(element: Element | null): boolean {
  return sceneCameraPlane(element)?.dataset['sceneCameraMotion'] === 'moving';
}

/**
 * Subscribe to the same atomic camera frames painted by the DOM transform.
 * GPU consumers mutate retained geometry from this callback; React and the
 * store stay out of the per-frame path.
 */
export function subscribeSceneCameraFrames(
  element: Element,
  listener: SceneCameraFrameListener
): () => void {
  const plane = sceneCameraPlane(element);
  if (!plane) return () => undefined;
  let listeners = cameraFrameListeners.get(plane);
  if (!listeners) {
    listeners = new Set();
    cameraFrameListeners.set(plane, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) cameraFrameListeners.delete(plane);
  };
}

/**
 * Publishes the source-plane quadrilateral that is currently visible through
 * the camera. Fixed DOM descendants still lay themselves out in source pixels;
 * these inherited values let screen-edge overlays stay reachable without
 * escaping the global scene plane or approximating the perspective in CSS.
 */
function publishVisibleSceneCorners(
  element: HTMLElement,
  frame: SceneCameraViewport
): void {
  const corners = [
    ['top-left', unprojectScenePointInFrame({ x: 0, y: 0 }, frame)],
    ['top-right', unprojectScenePointInFrame({ x: frame.width, y: 0 }, frame)],
    ['bottom-right', unprojectScenePointInFrame({ x: frame.width, y: frame.height }, frame)],
    ['bottom-left', unprojectScenePointInFrame({ x: 0, y: frame.height }, frame)],
  ] as const;
  for (const [name, point] of corners) {
    element.style.setProperty(`--gpu-camera-${name}-x`, `${point.x}px`);
    element.style.setProperty(`--gpu-camera-${name}-y`, `${point.y}px`);
  }
}

/** Publishes one pose atomically and paints the exact same matrix on the DOM. */
export function applySceneCamera(
  element: HTMLElement,
  camera: SceneCamera
): SceneCameraViewport {
  const frame = buildSceneCameraFrame(camera, element.clientWidth, element.clientHeight);
  cameraFrames.set(element, frame);
  element.dataset['sceneCameraSourceTop'] = String(
    camera.sourceTopRatio * frame.height
  );
  publishVisibleSceneCorners(element, frame);
  element.style.transform = frame.cssTransform;
  for (const listener of [...(cameraFrameListeners.get(element) ?? [])]) {
    listener(frame);
  }
  return frame;
}

/**
 * Finds the fixed camera plane and returns its currently painted frame.
 * Null deliberately means "ordinary affine canvas" for isolated unit renders.
 */
export function sceneCameraViewport(element: Element | null): SceneCameraViewport | null {
  const plane = sceneCameraPlane(element);
  if (!plane || plane.clientWidth <= 0 || plane.clientHeight <= 0) return null;
  const current = cameraFrames.get(plane);
  if (current && current.width === plane.clientWidth && current.height === plane.clientHeight) {
    return current;
  }
  const camera = current?.camera ?? sceneCameraForMode(
    'overview',
    plane.clientWidth,
    plane.clientHeight
  );
  const resized = buildSceneCameraFrame(camera, plane.clientWidth, plane.clientHeight);
  cameraFrames.set(plane, resized);
  // ResizeObserver is asynchronous. If an input arrives in the small gap
  // after layout changed, keep the newly rebuilt inverse and the painted CSS
  // matrix atomic rather than waiting one observer turn.
  plane.dataset['sceneCameraSourceTop'] = String(
    camera.sourceTopRatio * resized.height
  );
  publishVisibleSceneCorners(plane, resized);
  plane.style.transform = resized.cssTransform;
  return resized;
}

/** Navigation timing; the return is a little quicker than the approach. */
export function sceneCameraTransitionDuration(mode: SceneCameraMode): number {
  return mode === 'focus' ? 780 : 650;
}
