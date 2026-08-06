import type { Skill } from './types.js';

/**
 * EXPORT to the Agent Skills base spec (agentskills.io) — the "skill
 * factory" story: skills atoma learned and battle-tested become
 * consumable by any spec-compliant runtime (Claude Code, Codex, Gemini
 * CLI, …).
 *
 * The exported frontmatter carries ONLY `name` + `description` — the
 * two universal required fields. Everything else is deliberately
 * folded or dropped: `when_to_use` is folded into the description
 * (the spec says a good description states what AND when; and while
 * Claude Code understands a `when_to_use` key, the claude.ai Skills
 * API hard-errors on ANY key outside the base six — two-field output
 * is the only shape portable everywhere). atoma's runtime keys
 * (`kind`, `trigger`) never ship.
 *
 * Two shapes are refused rather than mistranslated:
 *   - `kind: script` — the spec convention for executable code is a
 *     `scripts/` directory driven by body instructions, not a body
 *     that IS the script; shipping ours as-is would hand a foreign
 *     agent a JSON-envelope contract it cannot honour.
 *   - event skills (`trigger`) — recovery guidance coupled to atoma's
 *     mid-run rejection machinery; meaningless as a standalone skill.
 */

/** Spec constraint: description is 1–1024 chars. */
export const SPEC_DESCRIPTION_MAX_CHARS = 1024;

export function exportSkillToSpec(
  skill: Skill
): { content: string } | { error: string } {
  if (skill.kind === 'script') {
    return {
      error:
        `"${skill.id}" is kind:script — its body is an executable with atoma's stdout-envelope contract, ` +
        `not portable spec content. Export the llm form (demote or use the _fallback.md) instead.`,
    };
  }
  if (skill.trigger) {
    return {
      error:
        `"${skill.id}" is an event-driven recovery skill — it is coupled to atoma's mid-run rejection ` +
        `matcher and has no standalone meaning. Not exportable.`,
    };
  }
  const description = `${skill.description.trim()} Use when: ${skill.whenToUse.trim()}`.slice(
    0,
    SPEC_DESCRIPTION_MAX_CHARS
  );
  const content = [
    '---',
    `name: ${skill.id}`,
    `description: ${description}`,
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');
  return { content };
}
