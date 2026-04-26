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

/**
 * Languages supported by `kind: 'script'` skills. The L1 receives the
 * skill body verbatim, writes it to a sandbox file with the matching
 * extension, and runs it via `run_shell`. Picking a language sets
 * the file extension AND tells `run_shell` which interpreter to use
 * (node, python3, bash). All three appear in the default
 * `runShellTool` allowlist (`src/tools/builtin.ts`).
 */
export type SkillLanguage = 'node' | 'python' | 'bash';

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
   * `'llm'` — the body is markdown instructions baked into the
   * L1's effective system prompt; the L1's normal LLM tool-use
   * loop drives execution. This is the auto-creation default
   * (`learnSkillFromRun` / C3) and the dominant mode in practice.
   *
   * `'script'` — the body IS executable code in `language`. The L1
   * is told to write the body to a sandbox file, invoke it via
   * `run_shell`, capture stdout, and return it. Runtime cost is
   * 1 LLM call + 2 tool calls (write_file + run_shell) regardless
   * of how many lines the script is — strictly cheaper than
   * `'llm'` on tasks whose deliverable is fully deterministic.
   */
  readonly kind: SkillKind;
  /**
   * Required when `kind === 'script'`. Selects extension + run_shell
   * interpreter. Ignored for `kind: 'llm'`.
   */
  readonly language?: SkillLanguage;
  /**
   * For `kind: 'llm'`: markdown how-to baked into the system prompt.
   * For `kind: 'script'`: the executable source in `language`.
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
  /** Required iff `kind === 'script'`; rejected for `kind: 'llm'`. */
  readonly language?: SkillLanguage;
}

export interface SkillMeta {
  readonly successes: number;
  readonly failures: number;
  readonly updatedAt: string;
}
