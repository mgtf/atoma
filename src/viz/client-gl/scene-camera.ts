import { GPU_LAYOUT, sidebarWidthForViewport } from './theme.js';

/**
 * The one camera for the complete visualizer scene.
 *
 * The product camera stays face-on: Pixi projects geometry before rasterising,
 * while DOM overlays consume the same affine frame in CSS. A pose names both
 * the point the lens looks at (`target`) and where the optical axis lands in the
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
/** Ceiling on the solved focus scale. Must clear the 528×800 case (~1.44)
 *  where the labelled rail is still 208px; 1.12 left a ~170px compact column. */
const FOCUS_MAX_SCALE = 1.5;

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
  // A resting perspective resamples the completed canvas and blurs every
  // glyph. Face-on poses keep the zoom, but let Pixi rasterise at final pixels.
  const pitchDegrees = 0;
  const sourceTopRatio = Math.min(1, GPU_LAYOUT.focusTopInset / height);
  // Keep the source layout stable while the camera travels. The labelled
  // rail keeps its overview width on the plane, but focus draws its icon at
  // the trailing edge and projects that edge into a compact screen-space rail.
  // Solve the scale from the requested guard. The cap bounds degenerate
  // aspect ratios; a low cap leaves the labelled rail's empty lead on screen.
  const requestedTopScale = (width - guard) / Math.max(1, width - buttonLeft);
  const focusScale = Math.min(
    FOCUS_MAX_SCALE,
    Math.max(1, requestedTopScale)
  );
  return pinSceneCameraTopRight({
    perspectivePx,
    pitchDegrees,
    // Keep both axes face-on so navigation remains an affine projection.
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
  return travelSceneCamera(from, to, value);
}

/**
 * The same pose interpolation, along the WHOLE line rather than the segment:
 * 0 is `from`, 1 is `to`, and a position past 1 keeps going in the same
 * direction, in the same parameter space (reciprocal distance, log scale,
 * linear ratios). The navigation shot uses that continuation for its landing
 * overshoot; `interpolateSceneCamera` is this function clamped to the segment.
 */
export function travelSceneCamera(
  from: SceneCamera,
  to: SceneCamera,
  position: number
): SceneCamera {
  const inverseDistance = lerp(1 / from.perspectivePx, 1 / to.perspectivePx, position);
  return {
    perspectivePx: 1 / Math.max(Number.EPSILON, inverseDistance),
    pitchDegrees: from.pitchDegrees + shortestAngle(from.pitchDegrees, to.pitchDegrees) * position,
    yawDegrees: from.yawDegrees + shortestAngle(from.yawDegrees, to.yawDegrees) * position,
    sceneScale: Math.exp(lerp(Math.log(from.sceneScale), Math.log(to.sceneScale), position)),
    targetXRatio: lerp(from.targetXRatio, to.targetXRatio, position),
    targetYRatio: lerp(from.targetYRatio, to.targetYRatio, position),
    sourceTopRatio: lerp(from.sourceTopRatio, to.sourceTopRatio, position),
    anchorXRatio: lerp(from.anchorXRatio, to.anchorXRatio, position),
    anchorYRatio: lerp(from.anchorYRatio, to.anchorYRatio, position),
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

/** The product's affine camera in renderer coordinates, before rasterisation. */
export function sceneCameraRenderTransform(
  frame: SceneCameraViewport,
  rendererWidth: number,
  rendererHeight: number
) {
  const m = frame.forward;
  const xRatio = rendererWidth / frame.width;
  const yRatio = rendererHeight / frame.height;
  return {
    a: m[0] / m[8],
    b: m[3] / m[8] * yRatio / xRatio,
    c: m[1] / m[8] * xRatio / yRatio,
    d: m[4] / m[8],
    tx: m[2] / m[8] * xRatio,
    ty: m[5] / m[8] * yRatio,
  };
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
  // Only the canvas cancels this CSS projection: its vertices already pass
  // through the same camera in Pixi. DOM inputs retain the outer transform.
  element.style.setProperty('--gpu-camera-inverse', matrix3dCss(frame.inverse));
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

/**
 * THE NAVIGATION SHOT.
 *
 * Reaching a section from the rail while the camera is ALREADY focused used to
 * move nothing: the content swapped underneath a static lens. This is the beat
 * that answers such a click — the camera eases back along its own
 * overview↔focus axis, lets the scene breathe, then glides in and lands on the
 * focus pose with a small approach overshoot.
 *
 * It travels the segment the two poses already define, so it inherits every
 * invariant they were built for: face-on, pinned to the top-right corner, no
 * page background at any edge. `pullBack` is how far back along that axis the
 * shot goes (1 would be the full overview), `overshoot` bounds how far past
 * focus the landing carries before it settles.
 */
export interface SceneCameraNavigationShot {
  readonly pullBack: number;
  readonly overshoot: number;
  readonly durationMs: number;
}

/** Fraction of the shot spent leaving; the rest is the approach and landing. */
const NAV_RETREAT_FRACTION = 0.32;
/**
 * HALF the amplitude this shot was born with. The cube turn now carries the
 * gross movement of a route and draws the whole box back while it turns; the
 * shot kept its full pull-back on top of that, the two recoils compounded, and
 * the scene visibly lurched. What remains is the shot's job inside the face:
 * a breath that makes the arriving content settle rather than appear.
 */
const NAV_PULL_BACK_BASE = 0.07;
const NAV_PULL_BACK_PER_ROW = 0.02;
/**
 * The ceiling is composition, not safety: the focused crop holds the rail's
 * icon column at the viewport edge, and pulling further back slides the rail's
 * empty lead into shot.
 */
const NAV_PULL_BACK_MAX = 0.15;
const NAV_OVERSHOOT_BASE = 0.05;
const NAV_OVERSHOOT_PER_ROW = 0.012;
const NAV_OVERSHOOT_MAX = 0.09;
const NAV_DURATION_BASE = 520;
const NAV_DURATION_PER_ROW = 40;
const NAV_DURATION_MAX = 760;
/** Peak of `sin(pi v) * v^2`, the late kick that lands the approach. */
const NAV_KICK_PEAK = 0.399793;
/** Beyond this the amplitude stops growing: a jump is a jump. */
const NAV_MAX_ROWS = 5;

/**
 * Resolves the shot for a click that travelled `rowDistance` rail rows. A
 * neighbouring section gets a short beat; crossing the rail gets a longer,
 * wider one, so the rail's own geometry is what the motion reports.
 */
export function sceneCameraNavigationShot(rowDistance: number): SceneCameraNavigationShot {
  const rows = Math.min(NAV_MAX_ROWS, Math.max(1, Math.round(Math.abs(rowDistance)))) - 1;
  return {
    pullBack: Math.min(NAV_PULL_BACK_MAX, NAV_PULL_BACK_BASE + NAV_PULL_BACK_PER_ROW * rows),
    overshoot: Math.min(NAV_OVERSHOOT_MAX, NAV_OVERSHOOT_BASE + NAV_OVERSHOOT_PER_ROW * rows),
    durationMs: Math.min(NAV_DURATION_MAX, NAV_DURATION_BASE + NAV_DURATION_PER_ROW * rows),
  };
}

/**
 * Where the shot stands on the overview→focus axis at `progress`: 1 is the
 * focus pose it starts and ends on, lower values are further back toward the
 * whole-scene composition. Departure is a fast ease-out, the return a
 * zero-velocity approach carrying one late kick past the pose it lands on.
 */
export function sceneCameraNavigationAxis(
  progress: number,
  shot: SceneCameraNavigationShot,
  fromAxis = 1
): number {
  const value = clamp01(progress);
  const back = 1 - shot.pullBack;
  if (value <= NAV_RETREAT_FRACTION) {
    const departure = 1 - (1 - value / NAV_RETREAT_FRACTION) ** 3;
    return fromAxis + (back - fromAxis) * departure;
  }
  const approach = (value - NAV_RETREAT_FRACTION) / (1 - NAV_RETREAT_FRACTION);
  const kick = Math.sin(Math.PI * approach) * approach * approach / NAV_KICK_PEAK;
  return 1 - shot.pullBack * (1 - sceneCameraEase(approach)) + shot.overshoot * kick;
}

/**
 * How far past the focus pose a landing may carry before the rail's icon
 * column starts leaving the frame.
 *
 * The focused crop keeps `FOCUS_RAIL_GUARD_PX` of the rail's lead beside that
 * column; an approach overshoot may spend that guard and not one pixel more,
 * because the destination tile at the trailing edge is what the reader
 * navigates by. A viewport whose focus asks for no approach has no room at all.
 */
export function sceneCameraNavigationCeiling(
  viewportWidth: number,
  viewportHeight: number
): number {
  const width = Math.max(1, viewportWidth);
  const span = Math.log(
    sceneCameraForMode('focus', width, viewportHeight).sceneScale
  );
  if (!(span > 1e-9)) return 1;
  const buttonLeft = Math.max(
    0,
    sidebarWidthForViewport(width) - GPU_LAYOUT.sidebarFocusButtonWidth
  );
  const spentGuard = width / Math.max(1, width - buttonLeft);
  return Math.max(1, Math.log(spentGuard) / span);
}

/** The pinned pose the shot paints at `progress`, for this viewport. */
export function sceneCameraNavigationPose(
  progress: number,
  shot: SceneCameraNavigationShot,
  viewportWidth: number,
  viewportHeight: number,
  fromAxis = 1
): SceneCamera {
  const axis = Math.min(
    sceneCameraNavigationCeiling(viewportWidth, viewportHeight),
    Math.max(0, sceneCameraNavigationAxis(progress, shot, fromAxis))
  );
  return pinSceneCameraTopRight(
    travelSceneCamera(
      sceneCameraForMode('overview', viewportWidth, viewportHeight),
      sceneCameraForMode('focus', viewportWidth, viewportHeight),
      axis
    ),
    viewportWidth,
    viewportHeight
  );
}

/**
 * Where an already painted pose stands on the overview→focus axis.
 *
 * Scale is the axis: `travelSceneCamera` moves it in log space between the
 * overview's 1 and the focused pose, so one logarithm recovers the position a
 * travelling shot was interrupted at. A viewport whose focused pose asks for
 * no approach at all has no axis to speak of, and reports the focus end.
 */
export function sceneCameraAxis(
  camera: SceneCamera,
  viewportWidth: number,
  viewportHeight: number
): number {
  const focus = sceneCameraForMode('focus', viewportWidth, viewportHeight);
  const span = Math.log(focus.sceneScale);
  if (!(Math.abs(span) > 1e-9)) return 1;
  return Math.log(camera.sceneScale) / span;
}
