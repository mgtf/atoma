/**
 * THE ONE ANSWER to "did this run land, or did it deliver?"
 *
 * There are two reasons a run can end with real work and no delivery, and they
 * COMPOSE — a run can hit its budget mid-plan AND be refused at delivery when
 * the root judges what it did report:
 *
 *   - `unfinishedPhases` — the deadline landed the dispatch before some phases
 *     ran (`markLanded`, `src/atoms/dispatch.ts`);
 *   - `refusal` — root delivery acceptance did not accept the result
 *     (`markRefused`, `src/run/depth.ts`).
 *
 * Both mean `partial`: work that is real, kept and seeded, but never
 * published. Absence of both means a delivery.
 *
 * It lives in `src/contracts` because FOUR readers derive it independently and
 * none of them can import the others: the runner decides the outcome, the viz
 * client and the supervisor digest each re-derive it from a persisted trace,
 * and the project coordinator reads the epilogue the runner wrote. Before
 * 2026-09-24 the first three were three separate copies of
 * `(result.unfinishedPhases?.length ?? 0) > 0`, byte-identical and unlinked —
 * so a second reason added to one of them would have been silently missing
 * from the other two, and the visualizer would have chipped a refused run
 * green while the analyst wrote a post-mortem headed `delivered`.
 *
 * The parameter is structural on purpose: `Result` (src/core/types.ts) and the
 * persisted `VizRun['result']` (src/viz/trace.ts) are different types carrying
 * the same two fields, and this must answer the same for both.
 */
export interface LandingSignals {
  readonly unfinishedPhases?: readonly string[] | undefined;
  readonly refusal?: string | undefined;
}

/** True when the result is real work that is NOT a delivery. */
export function isLanded(result: LandingSignals | null | undefined): boolean {
  if (!result) return false;
  return (result.unfinishedPhases?.length ?? 0) > 0 || Boolean(result.refusal);
}

/**
 * Why it landed, for the readers that explain a run to a PERSON.
 *
 * Returns both reasons when both apply. A reader that reported only the phases
 * would drop the refusal — and the refusal is the half a customer needs, since
 * it is the one that says the work was judged and found wanting rather than
 * merely cut short.
 *
 * Returns an empty array for a delivery, so a caller can use it as the test.
 */
export function landingReasons(result: LandingSignals | null | undefined): string[] {
  if (!result) return [];
  const reasons: string[] = [];
  const phases = result.unfinishedPhases ?? [];
  if (phases.length > 0) {
    reasons.push(
      `reached its budget with ${phases.length} phase(s) never run: ${phases.join(' | ')}`
    );
  }
  if (result.refusal) reasons.push(`refused at delivery: ${result.refusal}`);
  return reasons;
}

/**
 * HOW A LANDING REACHES THE NEXT RUN OF THE SAME PROJECT.
 *
 * A project run already continues from the previous run's workspace
 * (`previousSeedRun`). Until 2026-09-24 it inherited the bytes and nothing
 * else: a run could start from a workspace root delivery acceptance had
 * explicitly refused, with no record that it had been.
 *
 * ENV, NOT ARGV, and the repo says why three times over: `parseRunnerArgs`
 * DISCARDS an undeclared flag with only a warning, so a version-skewed child
 * would lose this silently; the MCP keeps a closed flag set a source-grep test
 * enforces; and argv is the E2BIG surface the 4 000-char goal already fills,
 * besides being world-readable in `ps`. Every other host→child input on this
 * launch already rides the environment, including two that carry JSON.
 *
 * THE VALUE IS THE TYPED REASONS, never the row's error string. That string is
 * recovered from a log the tenant's own goal is echoed into, so it was
 * forgeable — a goal carrying a newline and a plausible line could put the
 * tenant's words where the next run's planner reads them.
 */
export const PREVIOUS_LANDING_ENV = 'ATOMA_PREVIOUS_RUN_LANDING';

/** Serialise for the child. Empty reasons produce no variable at all. */
export function encodePreviousLanding(reasons: readonly string[] | undefined): string | null {
  const kept = (reasons ?? []).filter((reason) => reason.trim().length > 0).slice(0, 16);
  if (kept.length === 0) return null;
  return JSON.stringify(kept.map((reason) => reason.slice(0, 1_000)));
}

/**
 * Read it in the child. BOUNDED AND TOTAL: a malformed value yields nothing
 * rather than throwing, because a run must not fail to start over a hint.
 */
export function decodePreviousLanding(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 16)
      .map((item) => item.slice(0, 1_000));
  } catch {
    return [];
  }
}
