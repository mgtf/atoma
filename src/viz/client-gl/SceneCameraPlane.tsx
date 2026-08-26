import {
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { prefersReducedMotion } from './renderer/motion.js';
import {
  applySceneCamera,
  interpolateSceneCamera,
  pinSceneCameraTopRight,
  sceneCameraEase,
  sceneCameraForMode,
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
 */
export function SceneCameraPlane({
  mode,
  onSettled,
  children,
}: {
  mode: SceneCameraMode;
  onSettled?: () => void;
  children: ReactNode;
}) {
  const planeRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const plane = planeRef.current;
    if (!plane) return;
    let frameRequest: number | null = null;
    let disposed = false;

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

    const canAnimate = typeof requestAnimationFrame !== 'undefined' &&
      !prefersReducedMotion() &&
      !sameCamera(current, targetCamera());
    if (!canAnimate) {
      settle();
    } else {
      const startedAt = performance.now();
      const duration = sceneCameraTransitionDuration(mode);
      plane.dataset['sceneCameraMotion'] = 'moving';
      plane.dataset['sceneCameraProgress'] = '0';
      const tick = (now: number) => {
        if (disposed) return;
        const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
        const camera = pinSceneCameraTopRight(
          interpolateSceneCamera(
            current,
            targetCamera(),
            sceneCameraEase(progress)
          ),
          plane.clientWidth,
          plane.clientHeight
        );
        applySceneCamera(plane, camera);
        plane.dataset['sceneCameraProgress'] = progress.toFixed(4);
        if (progress < 1) {
          frameRequest = requestAnimationFrame(tick);
        } else {
          frameRequest = null;
          settle();
        }
      };
      frameRequest = requestAnimationFrame(tick);
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
  }, [mode, onSettled]);

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
