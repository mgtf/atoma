import { z } from 'zod';

/**
 * Machine-readable run epilogue consumed by the burn-in harness.
 *
 * Human logs are deliberately not part of this contract: task output and
 * validator prose are untrusted text and may contain any of the words used by
 * the lifecycle counters. The runner emits one final prefixed JSON object and
 * readers prefer the last valid object, while retaining the legacy log parser
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
  | 'dispatch-fallback';

export function formatRunStatsEpilogue(stats: RunStats): string {
  return RUN_STATS_PREFIX + JSON.stringify(runStatsSchema.parse(stats));
}

/** Return the last valid runner-owned epilogue, or null for legacy logs. */
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
      // usable; if none exists, the burn-in reader falls back to legacy logs.
    }
  }
  return parsed;
}
