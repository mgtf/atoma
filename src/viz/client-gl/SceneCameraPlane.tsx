import {
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { prefersReducedMotion } from './renderer/motion.js';
import { useNavigationTracker, type NavigationIntent } from './navigation-intent.js';
import {
  applySceneCamera,
  interpolateSceneCamera,
  pinSceneCameraTopRight,
  sceneCameraAxis,
  sceneCameraEase,
  sceneCameraForMode,
  sceneCameraNavigationPose,
  sceneCameraNavigationShot,
  sceneCameraTransitionDuration,
  sceneCameraViewport,
  type SceneCamera,
  type SceneCameraMode,
} from './scene-camera.js';

function sameCamera(left: SceneCamera, right: SceneCamera): boolean {
  return Math.abs(left.perspectivePx - right.perspectivePx) < 1e-6 &&
    Math.abs(left.pitchDegrees - right.pitchDegrees) < 1e-9 &&
    Math.abs(left.yawDegrees - right.yawDegrees) < 1e-9 &&
    Math.abs(left.sceneScale - right.sceneScale) < 1e-9 &&
    Math.abs(left.targetXRatio - right.targetXRatio) < 1e-9 &&
    Math.abs(left.targetYRatio - right.targetYRatio) < 1e-9 &&
    Math.abs(left.sourceTopRatio - right.sourceTopRatio) < 1e-9 &&
    Math.abs(left.anchorXRatio - right.anchorXRatio) < 1e-9 &&
    Math.abs(left.anchorYRatio - right.anchorYRatio) < 1e-9;
}

/**
 * Imperative camera driver: React publishes only the navigation intent, while
 * rAF owns the intermediate poses. Every frame is written once to the DOM and
 * to the shared camera registry, so rendering and inverse hit-testing cannot
 * observe different points in the travelling shot.
 *
 * Two intents reach it. A MODE change is the long move between the whole-scene
 * overview and the focused content column. A change of DESTINATION at an
 * unchanged mode is the navigation shot: the same axis, travelled out and back
 * in one beat, so reaching a section from the rail is a camera move rather
 * than a silent content swap under a static lens.
 */
export function SceneCameraPlane({
  mode,
  navigation,
  onSettled,
  children,
}: {
  mode: SceneCameraMode;
  navigation?: NavigationIntent;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const planeRef = useRef<HTMLDivElement>(null);
  // The route is read from the shared tracker, never from the painted pose: a
  // navigation shot begins and ends on the same pose, so only the intent
  // records that one was asked for.
  const readRoute = useNavigationTracker();
  const navigationKey = navigation?.key ?? null;
  const navigationRank = navigation?.rank ?? -1;
  const navigationGroup = navigation?.group ?? '';

  useLayoutEffect(() => {
    const plane = planeRef.current;
    if (!plane) return;
    let frameRequest: number | null = null;
    let disposed = false;

    const { navigated, route } = readRoute(mode, navigation);

    const targetCamera = () => sceneCameraForMode(
      mode,
      plane.clientWidth,
      plane.clientHeight
    );
    const current = sceneCameraViewport(plane)?.camera ?? sceneCameraForMode(
      'overview',
      plane.clientWidth,
      plane.clientHeight
    );
    const settle = () => {
      applySceneCamera(plane, targetCamera());
      plane.dataset['sceneCameraMotion'] = 'settled';
      plane.dataset['sceneCameraProgress'] = '1';
      onSettled?.();
    };

    const travel = (duration: number, poseAt: (progress: number) => SceneCamera) => {
      const startedAt = performance.now();
      plane.dataset['sceneCameraMotion'] = 'moving';
      plane.dataset['sceneCameraProgress'] = '0';
      const tick = (now: number) => {
        if (disposed) return;
        const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
        if (progress === 1) {
          frameRequest = null;
          settle();
          return;
        }
        applySceneCamera(plane, poseAt(progress));
        plane.dataset['sceneCameraProgress'] = progress.toFixed(4);
        frameRequest = requestAnimationFrame(tick);
      };
      frameRequest = requestAnimationFrame(tick);
    };

    const animatable = typeof requestAnimationFrame !== 'undefined' &&
      !prefersReducedMotion();
    if (animatable && navigated && mode === 'focus') {
      // The rail moved the reader sideways at an unchanged mode. Depart from
      // where the camera actually stands rather than from the nominal focus
      // pose, so a second click during the first shot continues the move
      // instead of cutting back to focus for it.
      const shot = sceneCameraNavigationShot(route.rowDistance);
      const fromAxis = sceneCameraAxis(current, plane.clientWidth, plane.clientHeight);
      travel(shot.durationMs, (progress) => sceneCameraNavigationPose(
        progress,
        shot,
        plane.clientWidth,
        plane.clientHeight,
        fromAxis
      ));
    } else if (animatable && !sameCamera(current, targetCamera())) {
      travel(sceneCameraTransitionDuration(mode), (progress) => pinSceneCameraTopRight(
        interpolateSceneCamera(
          current,
          targetCamera(),
          sceneCameraEase(progress)
        ),
        plane.clientWidth,
        plane.clientHeight
      ));
    } else {
      settle();
    }

    // The target column is responsive because the rail is. Once animation is
    // settled, resize recomputes the pose immediately; during motion the rAF
    // already resolves the target from the live dimensions on every frame.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (frameRequest === null) settle();
        });
    observer?.observe(plane);
    return () => {
      disposed = true;
      observer?.disconnect();
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    };
    // `navigation` is read through its parts: a new object for the same
    // destination is a re-render, never a route.
  }, [mode, navigationKey, navigationRank, navigationGroup, onSettled, readRoute]);

  return (
    <div
      ref={planeRef}
      className="gpu-scene-camera"
      data-scene-camera="perspective"
      data-scene-camera-mode={mode}
      data-scene-camera-motion="settled"
      data-scene-camera-progress="1"
    >
      {children}
    </div>
  );
}
