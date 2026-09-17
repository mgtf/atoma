import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  readMarkCoreScreen,
  setMarkCoreSurge,
} from './renderer/mark-surge.js';
import { prefersReducedMotion } from './renderer/motion.js';
import { useGpuStore } from './store.js';

/**
 * The handheld gate's exit: Continue does not admit the app, it closes the
 * door with light. The bead inside the crystal emits more and more, a white
 * flood grows from where that bead is on screen, and the whole interface —
 * scene, chrome, the disabled button itself — ends uniformly white.
 *
 * ONE rAF loop drives both halves so the Pixi surge and the DOM flood cannot
 * drift apart: the surge is a mutable sample the mark reads per frame
 * (`renderer/mark-surge.ts`), the flood is a transform on one DOM element
 * (compositor-only, no per-frame gradient repaint on a phone). The veil is
 * DOM for the same reason the entry veil is: it must survive the scene
 * rebuild the button re-label provokes, and it must cover DOM overlays too.
 */
export const HANDHELD_WHITEOUT_MS = 2_600;
/**
 * The flood element's side, as a multiple of the viewport diagonal. Its
 * solid white stop (`HANDHELD_FLOOD_SOLID`) at full scale must reach the
 * farthest viewport corner from any bead position, or the end frame keeps a
 * grey corner: 2.4 × 0.55 = 1.32 diagonals of solid white, against a corner
 * at most one diagonal away.
 */
export const HANDHELD_FLOOD_DIAGONALS = 2.4;
export const HANDHELD_FLOOD_SOLID = 0.55;

export type HandheldWhiteoutPhase = 'idle' | 'flare' | 'white';

export interface HandheldWhiteoutSample {
  /** 0..1 for the bead: swells early so the light visibly comes from the gem. */
  surge: number;
  /** 0..1 scale of the flood element: eases in so the flood follows the flare. */
  flood: number;
  /** 0..1 opacity of the flood element. */
  alpha: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Pure timing curve, so tests can pin the choreography without a browser:
 * the surge leads (smoothstep), the flood trails it (cubic), and the flood is
 * fully opaque well before it is fully grown so the end is a clean white.
 */
export function handheldWhiteoutSample(progress: number): HandheldWhiteoutSample {
  const p = clamp01(progress);
  const surge = p * p * (3 - 2 * p);
  const flood = p * p * p;
  const alpha = clamp01(p * 1.6);
  return { surge, flood, alpha };
}

/** Where the flood is centred: the bead when the mark has published it, else the middle. */
export function handheldFloodCentre(
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number } {
  const bead = readMarkCoreScreen();
  if (bead && Number.isFinite(bead.clientX) && Number.isFinite(bead.clientY)) {
    return { x: bead.clientX, y: bead.clientY };
  }
  return { x: viewportWidth / 2, y: viewportHeight / 2 };
}

export function useHandheldWhiteout(): {
  phase: HandheldWhiteoutPhase;
  /** True when this hook took the activation (handheld); false to let the ordinary enter run. */
  begin: () => boolean;
  floodRef: RefObject<HTMLDivElement | null>;
} {
  const [phase, setPhase] = useState<HandheldWhiteoutPhase>('idle');
  const phaseRef = useRef<HandheldWhiteoutPhase>('idle');
  const floodRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    setMarkCoreSurge(0);
  }, []);

  const begin = useCallback((): boolean => {
    const store = useGpuStore.getState();
    if (!store.handheld) return false;
    // The button re-labels and disables at once: feedback first, light after.
    store.blockHandheld();
    if (phaseRef.current !== 'idle') return true;
    if (prefersReducedMotion()) {
      // No flare to watch: the information is "the door closed", so jump there.
      setMarkCoreSurge(1);
      phaseRef.current = 'white';
      setPhase('white');
      return true;
    }
    phaseRef.current = 'flare';
    setPhase('flare');
    let startedAt: number | null = null;
    const step = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = (now - startedAt) / HANDHELD_WHITEOUT_MS;
      const sample = handheldWhiteoutSample(progress);
      setMarkCoreSurge(sample.surge);
      const flood = floodRef.current;
      if (flood) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const side = Math.hypot(width, height) * HANDHELD_FLOOD_DIAGONALS;
        const centre = handheldFloodCentre(width, height);
        flood.style.width = `${side}px`;
        flood.style.height = `${side}px`;
        flood.style.opacity = String(sample.alpha);
        flood.style.transform =
          `translate3d(${centre.x - side / 2}px, ${centre.y - side / 2}px, 0) scale(${sample.flood})`;
      }
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = 0;
      phaseRef.current = 'white';
      setPhase('white');
    };
    frameRef.current = requestAnimationFrame(step);
    return true;
  }, []);

  return { phase, begin, floodRef };
}
