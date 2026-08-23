import type { RunIndexEntry, VizRun } from './client/types.js';

/**
 * THE LIVE PREDICATES — is this run still running?
 *
 * They live HERE, outside `client/`, because both sides ask the question: the
 * browser to label a run, and server-side readers (the sentinel's operator
 * source, `src/sentinel/sources.ts`) to decide what to screen. `client/` is
 * BUNDLED BY VITE, which empties `dist/viz/client/` and replaces it with
 * hashed assets — so a compiled server importing a module from there resolves
 * nothing at runtime, and the failure appears only in the compiled smoke, not
 * in typecheck or `tests/`. `client/run-utils.ts` re-exports these, so every
 * existing client import keeps working against one definition.
 *
 * The threshold exceeds any plausible gap between LLM/tool events, because the
 * cost of calling a live run dead is worse than watching a dead one: an
 * abandoned run is one nobody will ever close, so nothing else would.
 */
export const ABANDONED_AFTER_MS = 12 * 60 * 1000;

export function isAbandoned(run: VizRun, now = Date.now()): boolean {
  if (run.endedAt) return false;
  const latest = Math.max(
    Date.parse(run.startedAt),
    ...run.events.map((event) => event.ts || 0)
  );
  return now - latest > ABANDONED_AFTER_MS;
}

export function isRunLive(run: VizRun, now = Date.now()): boolean {
  return !run.endedAt && !isAbandoned(run, now);
}

export function isIndexEntryLive(entry: RunIndexEntry, now = Date.now()): boolean {
  if (entry.endedAt || !entry.inFlight) return false;
  const latest = entry.lastEventAt ?? Date.parse(entry.startedAt);
  return now - latest <= ABANDONED_AFTER_MS;
}
