import { GPU_COLORS } from '../theme.js';

/**
 * ONE colour table for event kinds and LLM roles, used by both the filter
 * chips and the cards they filter.
 *
 * Before this the two disagreed by construction: cards were coloured by an
 * inline chain in `eventAccent`, while every filter chip fell back to the
 * default blue. So the control that selects `TOOLS` looked nothing like the
 * cards it produced, and the palette itself was a set of literals no one could
 * see side by side to check they were distinguishable.
 *
 * Hues are spread rather than merely different: amber, sky, green, magenta,
 * cyan, violet. `all` keeps the neutral primary because it is the absence of a
 * filter, not a category.
 */
export const EVENT_KIND_COLOR: Record<string, number> = {
  all: GPU_COLORS.primary,
  llm: 0xfbbf24,
  tool: 0x38bdf8,
  trust: 0x4ade80,
  skill: GPU_COLORS.magenta,
  // Teal, not the theme cyan: cyan sits ~10 degrees of hue from the sky blue
  // `tool` wears, and tool is the most common event on screen. The palette
  // test measures that separation rather than trusting the eye.
  cache: 0x14b8a6,
  context: 0xfb7185,
  registry: 0xa78bfa,
  branch: 0x94a3b8,
};

/**
 * The LLM family, ramped YELLOW → ORANGE across the roles in the order a run
 * actually performs them. The ramp is the point: every LLM card reads as one
 * family at a glance (it is all warm), and its position within the family says
 * which phase produced it without reading a word.
 *
 * `skill` sits beside `execute` rather than at the end because a skill-driven
 * call IS an execution, just one a learned recipe steered.
 */
export const LLM_ROLE_ORDER = [
  'prefilter',
  'plan',
  'validate-plan',
  'execute',
  'skill',
  'validate-result',
] as const;

export const LLM_ROLE_COLOR: Record<string, number> = {
  prefilter: 0xfef08a,
  plan: 0xfacc15,
  'validate-plan': 0xf59e0b,
  execute: 0xf97316,
  skill: 0xfdba74,
  'validate-result': 0xdc6803,
};

/** The family anchor: what the LLM filter chip itself wears. */
export const LLM_FAMILY_COLOR = EVENT_KIND_COLOR['llm']!;

export function llmRoleColor(role: string | undefined): number {
  if (role === undefined) return LLM_FAMILY_COLOR;
  return LLM_ROLE_COLOR[role] ?? LLM_FAMILY_COLOR;
}

/** Colour for a kind filter chip; unknown kinds stay neutral rather than loud. */
export function eventKindColor(kind: string): number {
  return EVENT_KIND_COLOR[kind] ?? GPU_COLORS.primary;
}
