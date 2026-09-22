import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { prefersReducedMotion } from './renderer/motion.js';
import {
  CUBE_TURN_AT_REST,
  cubeTurnFrame,
  cubeTurnPlan,
} from './cube-turn.js';
import { useNavigationTracker, type NavigationIntent } from './navigation-intent.js';
import { captureScene } from './scene-capture.js';
import type { SceneCameraMode } from './scene-camera.js';

/**
 * Mounts the still of the screen being left onto its face.
 *
 * Taken in a LAYOUT effect, which is the last moment the scene still holds the
 * view being left: the renderer redraws from an ordinary effect, after paint.
 * False means no still — no renderer, a suspended one, or a readback the
 * browser refused — and the caller then skips the turn rather than swinging an
 * empty face through the frame.
 */
function mountLeavingFace(face: HTMLElement | null): boolean {
  if (!face) return false;
  const still = captureScene();
  if (!still) {
    face.replaceChildren();
    return false;
  }
  still.className = 'gpu-cube__still';
  face.replaceChildren(still);
  return true;
}

/**
 * THE CUBE TURN, driven.
 *
 * Wraps the scene plane in the face of a box and turns that box a quarter of a
 * revolution whenever the rail routes somewhere else. The face being reached
 * is the live scene — canvas AND DOM overlays in one transformed subtree, so a
 * form keeps its state and stays where it belongs on the face. The face being
 * left is a still taken from the renderer, which is why it carries no
 * overlays: the DOM of the view being left is already gone when the turn
 * begins, and a bitmap has none to give back.
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
  const readRoute = useNavigationTracker();
  const navigationKey = navigation?.key ?? null;
  const navigationRank = navigation?.rank ?? -1;
  const navigationGroup = navigation?.group ?? '';

  useLayoutEffect(() => {
    const cube = cubeRef.current;
    const leaving = leavingRef.current;
    const arriving = arrivingRef.current;
    if (!cube || !leaving || !arriving) return;
    const { navigated, route } = readRoute(mode, navigation);

    const rest = () => {
      cube.dataset['cubeTurn'] = 'idle';
      cube.dataset['cubeTurnProgress'] = '1';
      leaving.style.transform = CUBE_TURN_AT_REST;
      arriving.style.transform = CUBE_TURN_AT_REST;
      leaving.style.zIndex = '';
      arriving.style.zIndex = '';
      // The still is a full-screen bitmap. Holding it between routes would
      // keep a screen of pixels alive for nothing.
      leaving.replaceChildren();
    };

    const turnable = navigated &&
      mode === 'focus' &&
      typeof requestAnimationFrame !== 'undefined' &&
      !prefersReducedMotion() &&
      mountLeavingFace(leaving);
    if (!turnable) {
      rest();
      return;
    }

    const plan = cubeTurnPlan(route.rowDistance, route.sameGroup, route.descending);
    const startedAt = performance.now();
    let frameRequest: number | null = null;
    let disposed = false;
    cube.dataset['cubeTurn'] = 'turning';
    cube.dataset['cubeTurnAxis'] = plan.axis;
    const paint = (progress: number) => {
      const frame = cubeTurnFrame(
        progress,
        plan,
        cube.clientWidth,
        cube.clientHeight
      );
      leaving.style.transform = frame.outgoingTransform;
      arriving.style.transform = frame.incomingTransform;
      leaving.style.zIndex = frame.outgoingOnTop ? '2' : '1';
      arriving.style.zIndex = frame.outgoingOnTop ? '1' : '2';
      cube.dataset['cubeTurnProgress'] = progress.toFixed(4);
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
    </div>
  );
}
