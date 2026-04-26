/**
 * SKILLS — persistent task patterns attached to an L1 atom.
 *
 * A skill is a reusable answer to a CLASS of subtasks the L1 has
 * already learned to handle. When L2 spots a subtask that matches an
 * existing skill, it can hand the skill over to L1 along with the
 * task — L1 then follows the skill's instructions instead of starting
 * from a blank slate. Eventually skills can also carry a deterministic
 * script (phase 2), letting L2 invoke L1 to run the script with no
 * LLM call at all.
 *
 * Phase 1 (this file) only defines the LLM-instruction shape; the
 * `kind: 'script'` variant is reserved as a placeholder so storage
 * stays forward-compatible without adding migration churn later.
 *
 * Layout on disk (filesystem-first for diffability + git):
 *   ./skills/<l1-name>/<skill-id>/SKILL.md     — frontmatter + body
 *   ./skills/<l1-name>/<skill-id>/_meta.json   — runtime counters
 *
 * The L1 name is the skill namespace; two L1s with the same name (rare
 * — naming comes from the global taxonomy) share their skills set.
 * Skill IDs are stable kebab-case identifiers within their namespace
 * ("write-package-json", "headless-smoke-loop").
 */

export type SkillKind = 'llm' | 'script';

export interface Skill {
  /** Stable kebab-case id within the L1 namespace. */
  readonly id: string;
  /** One-line summary used by the skill prefilter at match time. */
  readonly description: string;
  /**
   * Plain-language hint about WHEN this skill is the right pick.
   * Read by the prefilter; complements `description`.
   */
  readonly whenToUse: string;
  /**
   * Phase-1 only `'llm'` is supported at runtime; `'script'` is a
   * declared placeholder so a future phase can land deterministic
   * skills without bumping the on-disk format.
   */
  readonly kind: SkillKind;
  /**
   * Markdown body — instructions baked into the L1 system prompt
   * when the skill is the chosen match. Should be written as a
   * concrete how-to ("first write package.json with this layout,
   * then start the server, …"), not as prose.
   */
  readonly body: string;
  /**
   * Cumulative successes — incremented when a supervise-loop run
   * using this skill is approved. Persisted in `_meta.json`.
   */
  readonly successes: number;
  /** Cumulative failures — incremented on rejection / escalation. */
  readonly failures: number;
  /** ISO timestamp of the most recent file update. */
  readonly updatedAt: string;
}

/**
 * Frontmatter + body shape persisted to SKILL.md. The runtime
 * counters live in `_meta.json` so a hand-written skill never needs
 * its frontmatter rewritten just because counters bumped.
 */
export interface SkillFrontmatter {
  readonly id: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly kind: SkillKind;
}

export interface SkillMeta {
  readonly successes: number;
  readonly failures: number;
  readonly updatedAt: string;
}
