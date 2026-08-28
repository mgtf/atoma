import { z } from 'zod';

/**
 * Machine-readable run epilogue consumed by the burn-in harness.
 *
 * Human logs are deliberately not part of this contract: task output and
 * validator prose are untrusted text and may contain any of the words used by
 * the lifecycle counters. The runner emits one final prefixed JSON object and
 * readers prefer the last valid object, while retaining the prose log parser
 * for runs killed before an epilogue can be written.
 */
export const RUN_STATS_PREFIX = 'ATOMA_RUN_STATS ';

const countSchema = z.number().int().nonnegative();

export const runStatsSchema = z.object({
  // 'cancelled' is first-class: a signal-terminated run still emits the
  // epilogue with its REAL totals. Before 2026-08-15 the teardown path
  // printed nothing, so parseRunLog read 'error' with null economics while
  // the trace held the actual spend — the CSV and the trace disagreed about
  // the same run's cost (both overnight 2026-08-14 'error' rows were this).
  outcome: z.enum(['delivered', 'failed', 'error', 'cancelled']),
  costUsd: z.number().finite().nonnegative().nullable(),
  /**
   * The share of `costUsd` that the HOST SUBSCRIPTION paid for, at API list
   * prices — not a bill: on a subscription nothing is charged per token.
   *
   * Nullable and OPTIONAL, because a run with no subscription tier has no
   * such share and every epilogue written before 2026-08-28 has no such
   * field. It exists so a mixed run's single `costUsd` stops silently
   * blending an organisation's real spend with the operator's notional one —
   * the journal row names both payers, and a cost figure that cannot be
   * split would contradict it from the first run.
   */
  subscriptionCostUsd: z.number().finite().nonnegative().nullable().optional(),
  llmCalls: countSchema.nullable(),
  opusCalls: countSchema,
  sonnetCalls: countSchema,
  haikuCalls: countSchema,
  otherCalls: countSchema,
  deterministicPhases: countSchema,
  escalations: countSchema,
  learnedSkills: countSchema,
  learnedEventSkills: countSchema,
  promotions: countSchema,
  refusals: countSchema,
  compileErrors: countSchema,
  demotions: countSchema,
  dispatchFallbacks: countSchema,
  /**
   * Phases whose plan DECLARED a proof obligation that no transport-observed
   * attestation covered. The deliverable may still have been approved; what
   * this counts is runs whose METHOD went unproven, and therefore earned no
   * atom trust, no skill credit, no distillation and no promotion. Without a
   * counter here a withheld run is indistinguishable from a quiet one in the
   * measurement CSV — the same reason `credit-withheld` exists as a skill
   * event rather than a counter that simply fails to move.
   */
  // Defaulted, unlike its neighbours: `parseRunStatsEpilogue` reads logs
  // written by EARLIER builds, and a newly required counter would turn every
  // archived epilogue into a parse failure — the exact class of breakage the
  // 'cancelled' outcome note above records.
  uncoveredObligations: countSchema.default(0),
});

export type RunStats = z.infer<typeof runStatsSchema>;

export type RunStatSignal =
  | 'deterministic'
  | 'escalation'
  | 'learned-skill'
  | 'learned-event-skill'
  | 'promotion'
  | 'refusal'
  | 'compile-error'
  | 'demotion'
  | 'dispatch-fallback'
  | 'uncovered-obligation';

export function formatRunStatsEpilogue(stats: RunStats): string {
  return RUN_STATS_PREFIX + JSON.stringify(runStatsSchema.parse(stats));
}

/** Return the last valid runner-owned epilogue, or null when a run was cut short. */
export function parseRunStatsEpilogue(log: string): RunStats | null {
  let parsed: RunStats | null = null;
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(RUN_STATS_PREFIX)) continue;
    try {
      const candidate = runStatsSchema.safeParse(
        JSON.parse(trimmed.slice(RUN_STATS_PREFIX.length))
      );
      if (candidate.success) parsed = candidate.data;
    } catch {
      // A torn/malformed line is ignored. An earlier valid epilogue remains
      // usable; if none exists, the burn-in reader parses the prose log.
    }
  }
  return parsed;
}
