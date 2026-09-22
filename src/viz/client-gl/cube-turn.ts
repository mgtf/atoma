import { sceneCameraEase, sceneCameraNavigationShot } from './scene-camera.js';

/**
 * THE CUBE TURN.
 *
 * A route from the rail turns the whole interface the way a box turns: the
 * screen you leave is one face, the screen you reach is the next one round,
 * and the two are hinged on the edge they share.
 *
 * There is NO cube. Only two faces are ever built — the one being left and the
 * one being reached — and they are rebuilt for every route, so the six faces a
 * real cube would have never bound how many sections the rail may hold.
 *
 * The turn is expressed as CSS 3D on the scene plane's wrapper, not as camera
 * poses and not as Pixi geometry, and that is the load-bearing choice:
 *
 * - the camera stays the ONE face-on camera. Its matrix keeps being painted
 *   inside the face, so Pixi's affine render transform remains the exact
 *   homography the DOM overlays and the inverse hit tests use. A turn built
 *   from `yawDegrees` would have broken that on the first frame;
 * - the arriving face carries the LIVE canvas and the live DOM overlays in one
 *   transformed subtree, so a form keeps its state and its place on the face
 *   without a second projection to keep in step;
 * - the leaving face is a frozen bitmap of the canvas, so it costs one copy
 *   per route and nothing per frame. It carries no DOM: the overlays of the
 *   view being left are already gone when the turn starts.
 */

export type CubeTurnAxis = 'y' | 'x';

export interface CubeTurnPlan {
  /** `y` swings the wall sideways; `x` tips it. */
  readonly axis: CubeTurnAxis;
  /** `1` brings the arriving face in from the right (or from below). */
  readonly direction: 1 | -1;
  readonly durationMs: number;
}

export interface CubeTurnFrame {
  /** Degrees the box has turned, signed by the plan's direction. */
  readonly angleDegrees: number;
  /** CSS transform for the face being left — the frozen bitmap. */
  readonly outgoingTransform: string;
  /** CSS transform for the face being reached — the live scene plane. */
  readonly incomingTransform: string;
  /**
   * Which face paints over the other where they overlap.
   *
   * A box is solid: the wall that has not come round yet is behind the one
   * facing you, and you do not see it. CSS cannot cull it for us —
   * `backface-visibility` reads the element's normal, and a wall parallel to
   * the line of sight sits exactly on that test's boundary, so the browser
   * drew its inside, mirrored, across half the screen. Depth order is the
   * honest fix and it leaves no seam: the nearer face simply covers the other.
   */
  readonly outgoingOnTop: boolean;
}

/** How far back the box goes while it turns, as a fraction of its size. */
const CUBE_RECOIL = 0.08;
/** Lens distance, as a share of the longest viewport side. */
const CUBE_PERSPECTIVE_RATIO = 2.2;
const CUBE_MIN_PERSPECTIVE_PX = 1_600;

/**
 * Resolves the turn a route deserves.
 *
 * The axis carries the route rather than decorating it: moving inside one rail
 * group swings the wall sideways, and crossing into another group tips it. A
 * reader who lands somewhere unexpected has already been told, by the way the
 * screen moved, whether they stayed in the same part of the product.
 *
 * Duration comes from the navigation shot, so the camera's pull-back and the
 * turn are one beat and not two clocks racing.
 */
export function cubeTurnPlan(
  rowDistance: number,
  sameGroup: boolean,
  descending: boolean
): CubeTurnPlan {
  return {
    axis: sameGroup ? 'y' : 'x',
    direction: descending ? 1 : -1,
    durationMs: sceneCameraNavigationShot(rowDistance).durationMs,
  };
}

function cubeFaceTransform(
  rotationDegrees: number,
  axis: CubeTurnAxis,
  halfDepthPx: number,
  perspectivePx: number,
  scale: number
): string {
  const rotate = axis === 'y'
    ? `rotateY(${rotationDegrees.toFixed(4)}deg)`
    : `rotateX(${rotationDegrees.toFixed(4)}deg)`;
  return [
    `scale(${scale.toFixed(6)})`,
    `perspective(${perspectivePx.toFixed(3)}px)`,
    `translateZ(${(-halfDepthPx).toFixed(3)}px)`,
    rotate,
    `translateZ(${halfDepthPx.toFixed(3)}px)`,
  ].join(' ');
}

/**
 * The pair of face transforms at `progress`.
 *
 * Both faces hinge around the SAME point, half a box behind the screen, which
 * is what makes them read as one solid rather than two cards: the box is as
 * deep as the viewport is wide (or tall, when it tips), so its cross-section
 * is square and the turn is a quarter of a real revolution.
 *
 * The box also draws back a little at mid-turn. That recoil is what keeps the
 * corners of a turning solid inside the frame instead of ramming the viewport
 * edge, and it is the camera move a reader expects when something this size
 * moves: step back, let it turn, step in.
 */
export function cubeTurnFrame(
  progress: number,
  plan: CubeTurnPlan,
  viewportWidth: number,
  viewportHeight: number
): CubeTurnFrame {
  const eased = sceneCameraEase(Math.max(0, Math.min(1, progress)));
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const depth = plan.axis === 'y' ? width : height;
  const halfDepth = depth / 2;
  const perspectivePx = Math.max(
    CUBE_MIN_PERSPECTIVE_PX,
    Math.max(width, height) * CUBE_PERSPECTIVE_RATIO
  );
  const scale = 1 - CUBE_RECOIL * Math.sin(Math.PI * eased);
  const angleDegrees = -90 * plan.direction * eased;
  const face = (rotation: number) => cubeFaceTransform(
    rotation,
    plan.axis,
    halfDepth,
    perspectivePx,
    scale
  );
  return {
    angleDegrees,
    outgoingOnTop: Math.abs(angleDegrees) < 45,
    outgoingTransform: face(angleDegrees),
    // The arriving face is the next one round: a quarter turn away at rest,
    // square to the reader exactly when the box finishes.
    incomingTransform: face(angleDegrees + 90 * plan.direction),
  };
}

/** The identity face, for the settled scene and for reduced motion. */
export const CUBE_TURN_AT_REST = 'none';
