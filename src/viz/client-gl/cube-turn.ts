import { sceneCameraEase } from './scene-camera.js';

/**
 * THE CUBE TURN.
 *
 * A route from the rail turns the CONTENT COLUMN the way a box turns: the
 * screen you leave is one face, the screen you reach is the next one round,
 * and the two are hinged on the edge they share. The rail keeps still. It is
 * the thing you navigate BY, and a rail that swings away with the screen takes
 * the destination you just clicked with it.
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
 * - the leaving face is a still from the renderer, so it costs one capture per
 *   route and nothing per frame. It carries no DOM: the overlays of the view
 *   being left are already gone when the turn starts.
 *
 * And because the arriving face carries the whole scene plane — rail included —
 * the rail has to be taken back OUT of it: the faces are clipped to the content
 * column, and the rail is served for the length of the turn by a still of the
 * DESTINATION, pinned where it already was. That still is why the rail shows
 * the row you just clicked as lit from the first frame, rather than catching up
 * when the box lands.
 */

export type CubeTurnAxis = 'y' | 'x';

export interface CubeTurnPlan {
  /** `y` swings the column sideways; `x` tips it. */
  readonly axis: CubeTurnAxis;
  /** `1` brings the arriving face in from the right (or from below). */
  readonly direction: 1 | -1;
  readonly durationMs: number;
}

export interface CubeTurnFrame {
  /** Degrees the box has turned, signed by the plan's direction. */
  readonly angleDegrees: number;
  /** CSS transform for the face being left — the still. */
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
  /** The box turns about the COLUMN's axis, not the viewport's. */
  readonly transformOrigin: string;
  /** Keeps both faces inside the content column. */
  readonly columnClip: string;
  /** Keeps the still of the rail inside the rail, and nowhere else. */
  readonly railClip: string;
}

/** How far back the box goes while it turns, as a fraction of its size. */
const CUBE_RECOIL = 0.08;
/** Lens distance, as a share of the longest side of the column. */
const CUBE_PERSPECTIVE_RATIO = 2.2;
const CUBE_MIN_PERSPECTIVE_PX = 1_600;
const CUBE_DURATION_BASE_MS = 520;
const CUBE_DURATION_PER_ROW_MS = 40;
const CUBE_DURATION_MAX_MS = 760;
/** Beyond this the duration stops growing: a jump is a jump. */
const CUBE_MAX_ROWS = 5;

/**
 * Resolves the turn a route deserves.
 *
 * The axis carries the route rather than decorating it: moving inside one rail
 * group swings the column sideways, and crossing into another group tips it. A
 * reader who lands somewhere unexpected has already been told, by the way the
 * screen moved, whether they stayed in the same part of the product.
 *
 * Duration follows the rail rows the click travelled, so a neighbouring
 * section gets a beat and crossing the rail gets the whole move.
 */
export function cubeTurnPlan(
  rowDistance: number,
  sameGroup: boolean,
  descending: boolean
): CubeTurnPlan {
  const rows = Math.min(CUBE_MAX_ROWS, Math.max(1, Math.round(Math.abs(rowDistance)))) - 1;
  return {
    axis: sameGroup ? 'y' : 'x',
    direction: descending ? 1 : -1,
    durationMs: Math.min(
      CUBE_DURATION_MAX_MS,
      CUBE_DURATION_BASE_MS + CUBE_DURATION_PER_ROW_MS * rows
    ),
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
 * The pair of face transforms at `progress`, for a column that begins at
 * `columnLeftPx` on screen.
 *
 * Both faces hinge around the SAME point, half a box behind the screen, which
 * is what makes them read as one solid rather than two cards: the box is as
 * deep as the column is wide (or tall, when it tips), so its cross-section is
 * square and the turn is a quarter of a real revolution.
 *
 * The box also draws back a little at mid-turn. That recoil is the camera move
 * a reader expects when something this size moves — step back, let it turn,
 * step in — and it is the only such move a route makes: the scene camera holds
 * still for a route, because anything it did would take the rail with it.
 */
export function cubeTurnFrame(
  progress: number,
  plan: CubeTurnPlan,
  viewportWidth: number,
  viewportHeight: number,
  columnLeftPx: number
): CubeTurnFrame {
  const eased = sceneCameraEase(Math.max(0, Math.min(1, progress)));
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const columnLeft = Math.max(0, Math.min(width - 1, columnLeftPx));
  const columnWidth = width - columnLeft;
  const halfDepth = (plan.axis === 'y' ? columnWidth : height) / 2;
  const perspectivePx = Math.max(
    CUBE_MIN_PERSPECTIVE_PX,
    Math.max(columnWidth, height) * CUBE_PERSPECTIVE_RATIO
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
    transformOrigin: `${(columnLeft + columnWidth / 2).toFixed(3)}px 50%`,
    columnClip: `inset(0 0 0 ${columnLeft.toFixed(3)}px)`,
    railClip: `inset(0 ${(width - columnLeft).toFixed(3)}px 0 0)`,
  };
}

/** The identity face, for the settled scene and for reduced motion. */
export const CUBE_TURN_AT_REST = 'none';
