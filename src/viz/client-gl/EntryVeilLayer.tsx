import {
  ENTRY_FADE_IN_MS,
  ENTRY_FADE_OUT_MS,
  type EntryFadePhase,
} from './entry-fade.js';

export function EntryVeilLayer({ phase }: { phase: EntryFadePhase }) {
  const durationMs = phase === 'in' ? ENTRY_FADE_IN_MS : ENTRY_FADE_OUT_MS;
  return (
    <div
      className="gpu-entry-veil"
      data-phase={phase ?? undefined}
      style={{ transitionDuration: `${durationMs}ms` }}
      aria-hidden="true"
    />
  );
}
