import { useCallback, useEffect, useState } from 'react';
import { pinMarkElapsedMs, setMarkBeadVisible } from './renderer/mark-clock.js';
import { prefersReducedMotion } from './renderer/motion.js';
import { useGpuStore } from './store.js';

/**
 * Arrival fade. Two short beats — cover the welcome, then lift to reveal
 * the chrome. Kept in CSS/DOM so the veil survives the Pixi scene rebuild
 * that `enter()` triggers; a Pixi overlay would be destroyed mid-fade.
 */
export const ENTRY_FADE_OUT_MS = 140;
export const ENTRY_FADE_IN_MS = 160;

export type EntryFadePhase = 'out' | 'in' | null;

export function useEntryFade() {
  const [phase, setPhase] = useState<EntryFadePhase>(null);

  const begin = useCallback(() => {
    // Welcome inspect knobs must not follow the user into the product: the
    // navigation mark would otherwise stay frozen or beadless after Continue.
    pinMarkElapsedMs(null);
    setMarkBeadVisible(true);
    if (useGpuStore.getState().entered) return;
    if (prefersReducedMotion()) {
      useGpuStore.getState().enter();
      return;
    }
    setPhase((current) => current ?? 'out');
  }, []);

  useEffect(() => {
    if (phase === 'out') {
      const id = window.setTimeout(() => {
        useGpuStore.getState().enter();
        setPhase('in');
      }, ENTRY_FADE_OUT_MS);
      return () => window.clearTimeout(id);
    }
    if (phase === 'in') {
      const id = window.setTimeout(() => {
        setPhase(null);
      }, ENTRY_FADE_IN_MS);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [phase]);

  return { phase, begin };
}
