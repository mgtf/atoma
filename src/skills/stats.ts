import type { Skill } from './types.js';

/**
 * SKILL CATALOG STATS — the utility/hygiene view behind `skills stats`.
 *
 * Pure functions over loaded Skill[] (no fs, no LLM) so the CLI stays a
 * thin renderer and tests drive the logic directly. Two signals, both
 * borrowed from measured findings in the skill-learning literature and
 * mapped onto counters atoma already persists:
 *
 *   - UTILITY (AWM's utility rate): `matches` vs driven runs
 *     (successes + failures). A skill the prefilter never picks is
 *     utility-zero; a skill matched often but rarely driving runs is a
 *     free-rider the usage-conditioned credit gate keeps exposing.
 *   - REDUNDANCY (CODESKILL's merge trigger): token-Jaccard overlap of
 *     the matching surface (description + when_to_use) between skills of
 *     the SAME L1 — high overlap splits the prefilter's vote between
 *     near-duplicates and is the merge candidate signal.
 *
 * Healthy steady state per the AWM numbers: ~7 skills per scope with
 * pairwise overlap under ~0.2.
 */

export interface SkillStatsRow {
  readonly l1: string;
  readonly id: string;
  readonly kind: Skill['kind'];
  readonly matches: number;
  readonly successes: number;
  readonly failures: number;
  /** Runs the skill was matched into but did not demonstrably drive. */
  readonly freeRides: number;
  readonly status: string;
}

/**
 * Lifecycle-position labels, mirroring the `skills show` "next" logic but
 * compressed to one cell. Thresholds are passed in (call-time operator
 * config — see trustThreshold/promoteThreshold in cost.ts).
 */
export function skillStatus(
  s: Skill,
  // `stampIsCurrent` is a PREDICATE (not a generation string to compare):
  // refusal stamps come in two currencies — combined compile+scan for
  // compile/scan refusals, compile-only for demotions — and only
  // generations.ts knows both. Pass `refusalStampIsCurrent` in production.
  opts: { trust: number; promote: number; stampIsCurrent: (gen: string | undefined) => boolean }
): string {
  const parts: string[] = [];
  const driven = s.successes + s.failures;
  if ((s.matches ?? 0) === 0 && driven === 0) parts.push('never-matched');
  else if (driven === 0 && !s.trigger) parts.push('matched-never-drove');
  // Event-driven skills are recovery guidance: they never drive a run
  // (no trust counters, no promotion lifecycle) — their utility signal
  // is `matches` alone, so the driven-run labels don't apply.
  if (s.trigger) {
    parts.push('event-driven');
    return parts.join(' ');
  }
  if (s.kind === 'llm') {
    if (s.failures > 0) parts.push('blocked(reset)');
    else if (s.promotionRefusedAt && opts.stampIsCurrent(s.promotionRefusedGeneration))
      parts.push('refused(current-gen)');
    else if (s.promotionRefusedAt) parts.push('refusal-stale(will-retry)');
    else if (s.successes >= opts.promote) parts.push('promotion-eligible');
    else if (s.successes > 0) parts.push(`promotion-in-${opts.promote - s.successes}`);
  } else {
    if (s.failures > 0) parts.push('blocked(reset)');
    else if (s.successes >= opts.trust) parts.push('zero-llm-dispatch');
    else parts.push(`trust-in-${opts.trust - s.successes}`);
    if (s.directFailures) parts.push(`direct✗${s.directFailures}`);
  }
  return parts.join(' ');
}

export function computeStatsRows(
  byL1: ReadonlyMap<string, readonly Skill[]>,
  opts: { trust: number; promote: number; stampIsCurrent: (gen: string | undefined) => boolean }
): SkillStatsRow[] {
  const rows: SkillStatsRow[] = [];
  for (const [l1, skills] of byL1) {
    for (const s of skills) {
      const driven = s.successes + s.failures;
      rows.push({
        l1,
        id: s.id,
        kind: s.kind,
        matches: s.matches ?? 0,
        successes: s.successes,
        failures: s.failures,
        freeRides: Math.max(0, (s.matches ?? 0) - driven),
        status: skillStatus(s, opts),
      });
    }
  }
  return rows;
}

/** Lowercased word tokens (length ≥ 3) of a skill's matching surface. */
export function matchSurfaceTokens(s: Pick<Skill, 'description' | 'whenToUse'>): Set<string> {
  const tokens = `${s.description} ${s.whenToUse}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(tokens);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SimilarPair {
  readonly l1: string;
  readonly a: string;
  readonly b: string;
  readonly score: number;
}

/**
 * Same-L1 pairs whose matching surfaces overlap at or above `threshold`
 * — the `skills merge` candidates. Cross-L1 overlap is deliberately not
 * reported: skills are namespaced per L1 and never compete in the same
 * prefilter catalog.
 */
export function similarityPairs(
  byL1: ReadonlyMap<string, readonly Skill[]>,
  threshold: number
): SimilarPair[] {
  const out: SimilarPair[] = [];
  for (const [l1, skills] of byL1) {
    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const score = jaccard(matchSurfaceTokens(skills[i]!), matchSurfaceTokens(skills[j]!));
        if (score >= threshold) {
          out.push({ l1, a: skills[i]!.id, b: skills[j]!.id, score });
        }
      }
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}
