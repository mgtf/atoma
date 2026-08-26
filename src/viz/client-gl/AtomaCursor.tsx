import { useEffect, useRef } from 'react';
import {
  hidePointerLight,
  hideTrackedPointer,
  movePointerLight,
  trackPointer,
} from './pointer-light.js';
import {
  ATOMA_CURSOR_HOTSPOT,
  ATOMA_CURSOR_PATH,
} from './pointer-cursor.js';

export { ATOMA_CURSOR_HOTSPOT, ATOMA_CURSOR_PATH };

const FINE_POINTER_QUERY = '(any-hover: hover) and (any-pointer: fine)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FORCED_COLORS_QUERY = '(forced-colors: active)';
const ROOT_CURSOR_CLASS = 'atoma-cursor-active';

function mediaAllowsCursor(
  finePointer: MediaQueryList,
  reducedMotion: MediaQueryList,
  forcedColors: MediaQueryList
) {
  return finePointer.matches && !reducedMotion.matches && !forcedColors.matches;
}

export function AtomaCursor() {
  const cursor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = cursor.current;
    if (!element || typeof matchMedia === 'undefined') return;
    const finePointer = matchMedia(FINE_POINTER_QUERY);
    const reducedMotion = matchMedia(REDUCED_MOTION_QUERY);
    const forcedColors = matchMedia(FORCED_COLORS_QUERY);
    let enabled = false;
    let frame = 0;
    let positioned = false;
    let latestX = 0;
    let latestY = 0;
    let previousX = 0;

    const cancelFrame = () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const hide = () => {
      cancelFrame();
      positioned = false;
      element.dataset['visible'] = 'false';
      document.documentElement.classList.remove(ROOT_CURSOR_CLASS);
      hidePointerLight();
      hideTrackedPointer();
    };
    const paint = () => {
      frame = 0;
      const tilt = positioned
        ? Math.max(-5.5, Math.min(5.5, (latestX - previousX) * 0.22))
        : 0;
      previousX = latestX;
      positioned = true;
      element.style.transform = `translate3d(${latestX - ATOMA_CURSOR_HOTSPOT.x}px, ${latestY - ATOMA_CURSOR_HOTSPOT.y}px, 0) rotate(${tilt}deg)`;
      element.dataset['x'] = String(latestX);
      element.dataset['y'] = String(latestY);
      element.dataset['visible'] = 'true';
      document.documentElement.classList.add(ROOT_CURSOR_CLASS);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        hide();
        return;
      }
      latestX = event.clientX;
      latestY = event.clientY;
      // Tooltips remain real input in reduced-motion, forced-colour and native
      // cursor modes; only the decorative cursor/light are conditional.
      if (enabled) movePointerLight(latestX, latestY);
      else trackPointer(latestX, latestY);
      if (!enabled) return;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) hide();
    };
    const onVisibilityChange = () => {
      if (document.hidden) hide();
    };
    const applyMediaState = () => {
      const next = mediaAllowsCursor(finePointer, reducedMotion, forcedColors);
      if (next === enabled) return;
      enabled = next;
      element.dataset['enabled'] = String(enabled);
      if (!enabled) hide();
    };

    const mediaQueries = [finePointer, reducedMotion, forcedColors];
    for (const query of mediaQueries) query.addEventListener('change', applyMediaState);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerout', onPointerOut, { passive: true });
    window.addEventListener('pointercancel', hide, { passive: true });
    window.addEventListener('blur', hide);
    document.documentElement.addEventListener('pointerleave', hide, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    applyMediaState();

    return () => {
      cancelFrame();
      hidePointerLight();
      hideTrackedPointer();
      document.documentElement.classList.remove(ROOT_CURSOR_CLASS);
      for (const query of mediaQueries) query.removeEventListener('change', applyMediaState);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('pointercancel', hide);
      window.removeEventListener('blur', hide);
      document.documentElement.removeEventListener('pointerleave', hide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <div
      ref={cursor}
      className="atoma-pointer-cursor"
      data-enabled="false"
      data-visible="false"
      aria-hidden="true"
    >
      <svg viewBox="0 0 52 54" role="presentation">
        <defs>
          <linearGradient id="atoma-cursor-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0a1019" />
            <stop offset="0.62" stopColor="#010308" />
            <stop offset="1" stopColor="#000000" />
          </linearGradient>
          <filter id="atoma-cursor-halo" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4.4" />
          </filter>
        </defs>
        {/*
          NO glow at the hotspot. The light sits UNDER the cursor: it belongs to
          the scene, where the Pixi filter relights card edges and the backdrop
          pools around the pointer. A blurred disc drawn here instead read as a
          lamp stuck to the tip, floating above everything it was meant to lift.
        */}
        <path
          className="atoma-pointer-halo"
          d={ATOMA_CURSOR_PATH}
          filter="url(#atoma-cursor-halo)"
        />
        <path
          className="atoma-pointer-extrusion"
          d={ATOMA_CURSOR_PATH}
          transform="translate(1.35 1.6)"
        />
        <path className="atoma-pointer-face" d={ATOMA_CURSOR_PATH} />
        <path className="atoma-pointer-inner-rim" d={ATOMA_CURSOR_PATH} />
      </svg>
    </div>
  );
}
