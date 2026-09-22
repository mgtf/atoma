import {
  Component,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { prefersReducedMotion } from './renderer/motion.js';
import {
  CUBE_TURN_AT_REST,
  cubeTurnFrame,
  cubeTurnPlan,
} from './cube-turn.js';
import { useNavigationTracker, type NavigationIntent } from './navigation-intent.js';
import { captureScene } from './scene-capture.js';
import {
  projectScenePointInFrame,
  sceneCameraViewport,
  type SceneCameraMode,
} from './scene-camera.js';
import { sidebarWidthForViewport } from './theme.js';

/**
 * How often the rail's still is retaken while the box turns. Fast enough that
 * the crystal keeps turning, slow enough that a turn allocates a dozen screens
 * of pixels rather than forty.
 */
const CUBE_RAIL_REFRESH_MS = 50;

/** Mounts a still on a layer, replacing whatever it held. */
function mountStill(layer: HTMLElement, still: HTMLCanvasElement): void {
  still.className = 'gpu-cube__still';
  layer.replaceChildren(still);
}

/**
 * A DEAD COPY of the scene plane's overlays, for the face being left.
 *
 * The still is a picture of the CANVAS, and the forms are not on the canvas —
 * they are real HTML over it. React unmounts them the instant the view
 * changes, so the face being left lost every form it had before it had turned
 * a single degree (owner report, 2026-09-22: "les formulaires disparaissent").
 * They cannot be kept alive: their state belongs to the view that is leaving.
 * So they are cloned, and the copy turns away with the face that owned them.
 *
 * The copy keeps the plane's own class and inline style, which is what the
 * overlays are positioned against, and gives up everything that would let it
 * be mistaken for the live one: it is `inert` and `aria-hidden`, its ids are
 * stripped so the live subtree keeps them, and the canvas host goes — the
 * still already carries those pixels, and a cloned canvas is blank anyway.
 */
function cloneOverlays(plane: HTMLElement): HTMLElement {
  const ghost = plane.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-scene-camera');
  ghost.removeAttribute('data-scene-camera-mode');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.querySelector('.gpu-ui-host')?.remove();
  for (const element of ghost.querySelectorAll('[id]')) element.removeAttribute('id');
  // `cloneNode` copies attributes, and what a viewer TYPED is not one. A form
  // left mid-edit would turn away blank without this.
  const live = plane.querySelectorAll('input, textarea, select');
  const copies = ghost.querySelectorAll('input, textarea, select');
  for (const [index, element] of copies.entries()) {
    const source = live[index];
    if (source instanceof HTMLInputElement && element instanceof HTMLInputElement) {
      element.value = source.value;
      element.checked = source.checked;
    } else if (
      (source instanceof HTMLTextAreaElement && element instanceof HTMLTextAreaElement) ||
      (source instanceof HTMLSelectElement && element instanceof HTMLSelectElement)
    ) {
      element.value = source.value;
    }
  }
  return ghost;
}

/**
 * Where the rail ends and the content column begins, ON SCREEN.
 *
 * The rail's width is a SOURCE measurement and the focused camera crops it, so
 * the boundary has to be projected through the live camera frame rather than
 * read off the layout. It is asked of the scene plane INSIDE the arriving face
 * — `sceneCameraViewport` looks upwards from the element it is given, and the
 * plane is that face's child, not its ancestor. Null means there is no frame
 * to ask, and the caller then declines the turn rather than cutting the column
 * at a guess.
 */
function contentColumnLeft(plane: Element): number | null {
  const frame = sceneCameraViewport(plane);
  if (!frame) return null;
  const rail = sidebarWidthForViewport(frame.width);
  return projectScenePointInFrame({ x: rail, y: 0 }, frame).x;
}

interface GhostProps {
  /** Changes exactly when a route does; nothing else takes a copy. */
  readonly signal: string;
  readonly face: RefObject<HTMLDivElement | null>;
  readonly onGhost: (ghost: HTMLElement) => void;
  readonly children: ReactNode;
}

/**
 * Takes the copy of the overlays at the ONE moment it can be taken.
 *
 * A layout effect is already too late: React has mutated the DOM by then, and
 * the forms of the view being left are gone — measured, not assumed, when the
 * first attempt at this cloned an empty plane. `getSnapshotBeforeUpdate` runs
 * BEFORE the mutation, and a class is the only thing that has it; that is the
 * whole reason there is a class in a file of hooks.
 *
 * It hands the copy to the driver through `componentDidUpdate`, which runs in
 * the same commit and, being a descendant, before the driver's own layout
 * effect — so the face has its ghost by the time the turn starts.
 */
class CubeOverlayGhost extends Component<GhostProps, Record<string, never>, HTMLElement | null> {
  override getSnapshotBeforeUpdate(previous: Readonly<GhostProps>): HTMLElement | null {
    if (previous.signal === this.props.signal) return null;
    const plane = this.props.face.current?.querySelector<HTMLElement>(
      '[data-scene-camera="perspective"]'
    );
    return plane ? cloneOverlays(plane) : null;
  }

  override componentDidUpdate(
    _previous: Readonly<GhostProps>,
    _state: Readonly<Record<string, never>>,
    snapshot?: HTMLElement | null
  ): void {
    if (snapshot) this.props.onGhost(snapshot);
  }

  override render(): ReactNode {
    return this.props.children;
  }
}

/**
 * THE CUBE TURN, driven.
 *
 * Turns the content column a quarter of a revolution whenever the rail routes
 * somewhere else, and leaves the rail alone. The face being reached is the
 * live scene — canvas AND DOM overlays in one transformed subtree, so a form
 * keeps its state and stays where it belongs on the face. The face being left
 * is a still, which is why it carries no overlays: the DOM of the view being
 * left is already gone when the turn begins.
 *
 * The rail is the part that must NOT move, and it lives inside the arriving
 * face, so it is clipped out of the box and served from a still of the
 * DESTINATION for the length of the turn. That still can only be taken a frame
 * late — the renderer draws from an ordinary effect, after paint — so the
 * driver asks each frame until it gets one that depicts the destination, and
 * never pins the view being left over the rail.
 *
 * Canvas pointer input is suspended while the box moves. The inverse hit test
 * knows about the camera, not about the box, so a click during the turn would
 * land on whatever happens to sit at the untransformed coordinate. The DOM
 * overlays stay live throughout — the browser hit-tests transformed HTML
 * correctly — so the keyboard mirror never goes away.
 */
export function CubeTurnPlane({
  mode,
  navigation,
  children,
}: {
  mode: SceneCameraMode;
  navigation?: NavigationIntent;
  children: ReactNode;
}) {
  const cubeRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef<HTMLDivElement>(null);
  const arrivingRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  /** Set from `CubeOverlayGhost`, one commit before the driver reads it. */
  const ghostRef = useRef<HTMLElement | null>(null);
  const readRoute = useNavigationTracker();
  const navigationKey = navigation?.key ?? null;
  const navigationRank = navigation?.rank ?? -1;
  const navigationGroup = navigation?.group ?? '';

  useLayoutEffect(() => {
    const cube = cubeRef.current;
    const leaving = leavingRef.current;
    const arriving = arrivingRef.current;
    const rail = railRef.current;
    if (!cube || !leaving || !arriving || !rail) return;
    const { navigated, route } = readRoute(mode, navigation);

    const rest = () => {
      cube.dataset['cubeTurn'] = 'idle';
      cube.dataset['cubeTurnProgress'] = '1';
      for (const layer of [leaving, arriving, rail]) {
        layer.style.transform = CUBE_TURN_AT_REST;
        layer.style.transformOrigin = '';
        layer.style.clipPath = '';
        layer.style.zIndex = '';
      }
      // The stills are whole screens of pixels. Holding them between routes
      // would keep two of them alive for nothing.
      leaving.replaceChildren();
      rail.replaceChildren();
      ghostRef.current = null;
    };

    const turnable = navigated &&
      mode === 'focus' &&
      typeof requestAnimationFrame !== 'undefined' &&
      !prefersReducedMotion();
    const plane = turnable
      ? arriving.querySelector<HTMLElement>('[data-scene-camera="perspective"]')
      : null;
    const columnLeft = plane === null ? null : contentColumnLeft(plane);
    const leavingStill = columnLeft === null ? null : captureScene();
    if (plane === null || columnLeft === null || !leavingStill) {
      rest();
      return;
    }

    const plan = cubeTurnPlan(route.rowDistance, route.sameGroup, route.descending);
    const startedAt = performance.now();
    let frameRequest: number | null = null;
    let disposed = false;
    let railRefreshedAt = Number.NEGATIVE_INFINITY;
    mountStill(leaving, leavingStill.canvas);
    // The overlays of the view being left, copied before React mutated them
    // away, so they turn out of frame on the face that owned them.
    if (ghostRef.current) leaving.append(ghostRef.current);
    ghostRef.current = null;
    cube.dataset['cubeTurn'] = 'turning';
    cube.dataset['cubeTurnAxis'] = plan.axis;

    const paint = (progress: number) => {
      const frame = cubeTurnFrame(
        progress,
        plan,
        cube.clientWidth,
        cube.clientHeight,
        columnLeft
      );
      for (const layer of [leaving, arriving]) {
        layer.style.transformOrigin = frame.transformOrigin;
        layer.style.clipPath = frame.columnClip;
      }
      leaving.style.transform = frame.outgoingTransform;
      arriving.style.transform = frame.incomingTransform;
      leaving.style.zIndex = frame.outgoingOnTop ? '2' : '1';
      arriving.style.zIndex = frame.outgoingOnTop ? '1' : '2';
      rail.style.clipPath = frame.railClip;
      cube.dataset['cubeTurnProgress'] = progress.toFixed(4);
      // THE RAIL KEEPS LIVING. A still taken once froze it for the length of
      // the turn — the crystal stopped turning and the pointer light stopped
      // following — so it is retaken on a cadence instead. Measured on the
      // compiled build: a capture costs 0.33ms and 60fps holds even at one a
      // frame, but each one allocates a screen of pixels, and THAT is what the
      // cadence bounds. The first one lands on the first frame, so the row
      // just clicked is lit from the start.
      const now = performance.now();
      if (now - railRefreshedAt >= CUBE_RAIL_REFRESH_MS) {
        const still = captureScene();
        if (still) {
          mountStill(rail, still.canvas);
          railRefreshedAt = now;
        }
      }
    };

    paint(0);
    const tick = (now: number) => {
      if (disposed) return;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / plan.durationMs));
      if (progress === 1) {
        frameRequest = null;
        rest();
        return;
      }
      paint(progress);
      frameRequest = requestAnimationFrame(tick);
    };
    frameRequest = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
      // A route that interrupts a turn owns the box from here. Leaving it
      // mid-angle would hand the next turn a face that is already askew.
      rest();
    };
    // `navigation` is read through its parts: a new object for the same
    // destination is a re-render, never a route.
  }, [mode, navigationKey, navigationRank, navigationGroup, readRoute]);

  return (
    <div className="gpu-cube" ref={cubeRef} data-cube-turn="idle" data-cube-turn-progress="1">
      <div className="gpu-cube__face gpu-cube__face--leaving" ref={leavingRef} aria-hidden="true" />
      <div className="gpu-cube__face gpu-cube__face--arriving" ref={arrivingRef}>
        <CubeOverlayGhost
          signal={`${mode}:${navigationKey ?? ''}`}
          face={arrivingRef}
          onGhost={(ghost) => { ghostRef.current = ghost; }}
        >
          {children}
        </CubeOverlayGhost>
      </div>
      <div className="gpu-cube__rail" ref={railRef} aria-hidden="true" />
    </div>
  );
}
