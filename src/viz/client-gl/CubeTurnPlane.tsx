import { useLayoutEffect, useRef, type ReactNode } from 'react';
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

/** Mounts a still on a layer, replacing whatever it held. */
function mountStill(layer: HTMLElement, still: HTMLCanvasElement): void {
  still.className = 'gpu-cube__still';
  layer.replaceChildren(still);
}

/**
 * Where the rail ends and the content column begins, ON SCREEN.
 *
 * The rail's width is a SOURCE measurement and the focused camera crops it, so
 * the boundary has to be projected through the live camera frame rather than
 * read off the layout. The frame is asked of the scene plane INSIDE the face —
 * `sceneCameraViewport` looks upwards from the element it is given, and the
 * plane is this face's child, not its ancestor. Null means there is no frame
 * to ask, and the caller then declines the turn rather than cutting the column
 * at a guess.
 */
function contentColumnLeft(face: Element): number | null {
  const plane = face.querySelector('[data-scene-camera="perspective"]');
  const frame = plane === null ? null : sceneCameraViewport(plane);
  if (!frame) return null;
  const rail = sidebarWidthForViewport(frame.width);
  return projectScenePointInFrame({ x: rail, y: 0 }, frame).x;
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
    };

    const turnable = navigated &&
      mode === 'focus' &&
      typeof requestAnimationFrame !== 'undefined' &&
      !prefersReducedMotion();
    const columnLeft = turnable ? contentColumnLeft(arriving) : null;
    const leavingStill = columnLeft === null ? null : captureScene();
    if (columnLeft === null || !leavingStill) {
      rest();
      return;
    }

    const plan = cubeTurnPlan(route.rowDistance, route.sameGroup, route.descending);
    const destination = navigationKey;
    const startedAt = performance.now();
    let frameRequest: number | null = null;
    let disposed = false;
    let railPinned = false;
    mountStill(leaving, leavingStill.canvas);
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
      // The destination's own rail, pinned as soon as the renderer has drawn
      // it. Asking every frame until then costs ONE readback in total, not one
      // a frame: the first still that depicts the destination is the last one
      // this turn takes.
      if (!railPinned) {
        const arrival = captureScene();
        if (arrival && arrival.view === destination) {
          mountStill(rail, arrival.canvas);
          railPinned = true;
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
        {children}
      </div>
      <div className="gpu-cube__rail" ref={railRef} aria-hidden="true" />
    </div>
  );
}
