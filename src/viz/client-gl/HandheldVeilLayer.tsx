import type { RefObject } from 'react';
import type { HandheldWhiteoutPhase } from './handheld-whiteout.js';

/**
 * The handheld gate's white-out, as DOM over everything. `flood` is the one
 * element the rAF loop transforms (a pre-painted radial gradient scaled from
 * the bead outwards); once the phase is `white` the veil itself is solid and
 * the notice fades in, so the blank page reads as a closed door and not as a
 * crash. Idle, it is not in the DOM at all.
 */
export function HandheldVeilLayer({
  phase,
  floodRef,
  notice,
}: {
  phase: HandheldWhiteoutPhase;
  floodRef: RefObject<HTMLDivElement | null>;
  notice: string;
}) {
  if (phase === 'idle') return null;
  return (
    <div className="gpu-handheld-veil" data-phase={phase}>
      <div ref={floodRef} className="gpu-handheld-veil__flood" aria-hidden="true" />
      <p className="gpu-handheld-veil__notice" role="status">
        {phase === 'white' ? notice : null}
      </p>
    </div>
  );
}
