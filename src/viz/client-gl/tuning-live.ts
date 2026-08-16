/**
 * The LIVE tuning sample: a mutable module-level value read once per frame by
 * the ticker, never a store field.
 *
 * This is deliberate and it is the difference between the panel working and
 * the panel being unusable. Every value here is consumed by
 * `updatePointerLight` and `updateCastShadows`, which run on the Pixi ticker
 * and touch only uniforms and `position`. Routing a drag through Zustand
 * instead would fire the React effect in `GpuSurface`, and that effect calls
 * `renderer.render()` — which tears the whole scene down
 * (`root.removeChildren()` + recursive destroy) and rebuilds it. One full
 * scene rebuild per `pointermove` is the exact thing AGENTS.md forbids by
 * name: "Keep GPU animation state out of React/Zustand hot paths. Use mutable
 * samples read once per frame; do not rebuild the scene for pointer motion."
 *
 * `pointer-light.ts` is the same pattern for the same reason, down to the
 * revision counter, and this module is its sibling on purpose.
 */

import {
  TUNING_IDENTITY,
  TUNING_KEYS,
  clampTuningValue,
  normalizeTuning,
  type VizTuning,
} from './tuning.js';

const STORAGE_KEY = 'atoma.viz.tuning';

interface LiveTuning extends VizTuning {
  /** Bumped on every accepted change, so a reader can tell "same" from "again". */
  revision: number;
}

function restore(): VizTuning {
  try {
    if (typeof localStorage === 'undefined') return { ...TUNING_IDENTITY };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...TUNING_IDENTITY };
    // `normalizeTuning` clamps every field, so a hand-edited or stale entry
    // degrades to the identity per key rather than poisoning the scene.
    return normalizeTuning(JSON.parse(raw) as Partial<VizTuning>);
  } catch {
    return { ...TUNING_IDENTITY };
  }
}

const live: LiveTuning = { ...restore(), revision: 0 };

/** The current sample. Callers must READ it each frame, never cache it. */
export function readTuning(): Readonly<LiveTuning> {
  return live;
}

function persist() {
  try {
    if (typeof localStorage === 'undefined') return;
    const plain: Partial<VizTuning> = {};
    for (const key of TUNING_KEYS) plain[key] = live[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
  } catch {
    // Persistence is a convenience for a developer surface, never a
    // precondition: a full or blocked localStorage must not break the drag.
  }
}

/** Returns true when the value actually moved, so callers can skip no-op work. */
export function setTuningValue(key: keyof VizTuning, value: number): boolean {
  const next = clampTuningValue(key, value);
  if (live[key] === next) return false;
  live[key] = next;
  live.revision += 1;
  persist();
  return true;
}

export function resetTuning(): void {
  let changed = false;
  for (const key of TUNING_KEYS) {
    if (live[key] === TUNING_IDENTITY[key]) continue;
    live[key] = TUNING_IDENTITY[key];
    changed = true;
  }
  if (!changed) return;
  live.revision += 1;
  persist();
}
