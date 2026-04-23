import type { Tool } from '../core/types.js';
import type { AtomRegistry, AtomType } from '../registry/atomRegistry.js';

/**
 * CAPABILITY-FIRST DESCRIPTIONS
 * =============================
 * Historically `L2Atom.createSubtaskL1` (and `L3Atom.createSubtaskL2`) used the
 * subtask's full task-description as the newly-created atom's registry
 * description. The intent was "make the catalog searchable by prefilter", but
 * the side-effect was catastrophic registry pollution:
 *
 *   Potassium — "L1 for subtask: Build a minimal WebGL Minesweeper game…"
 *   Chlorine  — "L1 for subtask: Build a single-page chess puzzle with 8x8…"
 *
 * These entries look specific on paper but their ACTUAL capability is
 * identical ("single-file web artefact: write + serve + validate + fix
 * loop"). Prefilter sees the themes, rejects cross-domain reuse (correctly,
 * per its cross-domain rule), and the next run spawns yet another
 * near-clone. The registry fills up with dozens of task-bound singletons
 * that never get re-used.
 *
 * This module centralises the fix: registry descriptions are now derived
 * from the atom's TOOL SIGNATURE (its structural capability), not from the
 * task narrative. An L1 that owns `{write_file, read_file, list_files,
 * start_static_server, validate_html}` always gets the same canonical
 * "single-file web artefact builder…" label — regardless of whether the
 * current task is a chess puzzle, a minesweeper, or a FPS dashboard.
 *
 * The task-specific information doesn't disappear; it flows via the
 * per-invocation `task.description` passed to `handle(task, ctx)`. The
 * registry entry just stops advertising it.
 */

/** Toolset-based capability buckets, ordered from most-specific to most-general. */
interface CapabilityBucket {
  id: string;
  required: readonly string[];
  label: string;
}

const CAPABILITY_BUCKETS: readonly CapabilityBucket[] = [
  {
    id: 'web-artefact-build+validate',
    required: ['write_file', 'start_static_server', 'validate_html'],
    label:
      'single-file web artefact builder: writes an index.html on disk, serves it locally, and iterates against headless-browser validation (validate_html) until zero console errors',
  },
  {
    id: 'web-artefact-write+serve',
    required: ['write_file', 'start_static_server'],
    label:
      'static-site runner: writes files on disk and serves them locally (no headless validation in the loop)',
  },
  {
    id: 'web-artefact-write+validate',
    required: ['write_file', 'validate_html'],
    label:
      'HTML writer + headless validator: writes files and checks them through a headless browser',
  },
  {
    id: 'file-scribe',
    required: ['write_file'],
    label: 'file scribe: reads, writes, and lists workspace files',
  },
];

const AUXILIARY_TOOLS: Readonly<Record<string, string>> = {
  fetch_url: 'fetches arbitrary HTTP URLs',
  run_shell: 'executes shell commands inside the sandbox',
};

/**
 * Canonical capability description for a set of tools. Deterministic — two
 * atoms with the same tool signature always get the same string, so
 * prefilter (which matches on description) treats them as
 * interchangeable.
 *
 * The output is intentionally task-neutral: no domain nouns, no grid
 * dimensions, no UI verbs. Anything task-specific must live on the
 * runtime `task.description`, not on the registry entry.
 */
export function capabilityDescription(tools: readonly Tool[]): string {
  const names = new Set(tools.map((t) => t.name));
  const parts: string[] = [];

  const primary = CAPABILITY_BUCKETS.find((b) => b.required.every((r) => names.has(r)));
  if (primary) parts.push(primary.label);

  for (const [name, label] of Object.entries(AUXILIARY_TOOLS)) {
    if (names.has(name)) parts.push(label);
  }

  if (parts.length === 0) {
    // No bucket matched — still produce a stable, distinguishable label
    // instead of falling back to task prose. Sort for determinism so the
    // same toolset never produces two different descriptions.
    const sig = [...names].sort().join(', ');
    parts.push(`custom toolset: ${sig || 'no tools'}`);
  }

  return parts.join('; ');
}

const TASK_THEME_PATTERNS: readonly RegExp[] = [
  // Game / app themes commonly encoded into L1/L2 descriptions.
  /\b(chess|checkmate|mate[- ]?in[- ]?\d+|puzzle|minesweeper|tetris|snake|sudoku|wordle|2048|roguelike|platformer|mario|dashboard|chatbot|chat ?bot|webgl)\b/i,
  // Grid / board dimensions: "8x8", "10 x 10".
  /\b\d+\s*[x×]\s*\d+\b/i,
  // UI affordances that always come from the task, not the capability.
  /\b(drag[- ]and[- ]drop|right[- ]click|left[- ]click)\b/i,
  // "L1 for subtask: …" preamble from the legacy fallback.
  /^L[123] for subtask:/i,
  // "Build a …" narrative from LLM-generated seeds.
  /^Build an?\s+/i,
];

/**
 * True when a candidate description encodes domain-specific narrative
 * rather than a reusable capability. Used to decide whether to DROP a
 * seed-provided description in favour of the tool-derived canonical one.
 *
 * Heuristics (deliberately aggressive — false positives on capability
 * strings are impossible by construction, false negatives just mean a
 * slightly-themed but short description survives):
 *   - length > 140 chars (capability labels are concise)
 *   - mentions of well-known game/app themes
 *   - grid dimensions like "8x8"
 *   - UI verbs that belong to the task, not the atom
 *   - the "L1 for subtask:" or "Build a ..." preambles
 */
export function looksTaskThemed(desc: string): boolean {
  if (!desc) return false;
  if (desc.length > 140) return true;
  return TASK_THEME_PATTERNS.some((re) => re.test(desc));
}

/**
 * Pick a description for a newly-created atom:
 *   1. If the LLM's seed suggested a description AND it looks clean
 *      (short, task-neutral), honour it — the planner may have useful
 *      nuance we don't want to lose.
 *   2. Otherwise, derive the canonical capability label from the
 *      tool signature.
 *
 * Call sites: `L2Atom.createSubtaskL1`, `L3Atom.createSubtaskL2`, and the
 * canonical-bootstrap path in `examples/build-app.ts`.
 */
export function resolveCreationDescription(
  suggested: string | undefined,
  tools: readonly Tool[]
): string {
  const canonical = capabilityDescription(tools);
  const cleaned = suggested?.trim();
  if (!cleaned) return canonical;
  if (looksTaskThemed(cleaned)) return canonical;
  return cleaned;
}

/** Marker for registry entries created by the example's bootstrap step. */
export const CANONICAL_BOOTSTRAP_MARKER = 'bootstrap-canonical';

/**
 * Description used for the canonical tier-2 "web build orchestrator"
 * seeded by `examples/build-app.ts`. L3.prefilter matches on this string
 * so the first run on a clean registry doesn't need to spin up a bespoke
 * L2 for a plain web-artefact task.
 */
export const CANONICAL_L2_WEB_DESCRIPTION =
  'web artefact orchestrator: routes a single-file web-build leaf to an L1 element (write + serve + validate loop), no side-effects at tier 2';

const CANONICAL_L1_SYSTEM_PROMPT_LINES: readonly string[] = [
  `You are an L1 element with ONE narrow responsibility.`,
  `DO NOT attempt to solve the whole task — only the specific subtask you are handed.`,
  `Call tools sequentially to produce your single output. Return a structured`,
  `{"output", "summary"} JSON at the end.`,
  ``,
  `Scope boundary: if the subtask seems to require coordinating with other`,
  `subtasks (reading their outputs, sharing state) — that's a planning bug at`,
  `L2/L3, not an excuse to expand scope. Surface it in your summary instead of`,
  `silently growing your remit.`,
];

const CANONICAL_L2_SYSTEM_PROMPT_LINES: readonly string[] = [
  `You are a domain-neutral L2 orchestrator for single-file web builds.`,
  `DELEGATION DISCIPLINE: you NEVER call tools yourself. Decompose the task`,
  `into AT MOST one L1 leaf (the write + serve + validate loop) and delegate.`,
  `Prefer reusing the existing canonical L1 via prefilter — only request a`,
  `new L1 when the toolset genuinely diverges.`,
  ``,
  `Scope boundary: task-specific nouns (grid dimensions, game rules, UI`,
  `copy) belong in the SUBTASK DESCRIPTION you pass down, never in the L1's`,
  `registry metadata. Keep the catalog reusable.`,
];

/**
 * Idempotently ensure the registry has a canonical L1 "web artefact
 * builder" — the one L2.prefilter is supposed to reuse for every
 * single-file web build, regardless of theme. If a canonical entry is
 * already present we refresh its tool list to track the current
 * executor set. If not, we create it.
 *
 * The canonical entry is tagged via `createdBy = CANONICAL_BOOTSTRAP_MARKER`,
 * so subsequent boots find it unambiguously even if its taxonomy name
 * drifted or other L1 entries share part of its description.
 *
 * `smokeGuidance` is the same block that `L2Atom.SMOKE_DESIGN_GUIDANCE`
 * appends on fresh-L1 creation. We accept it as a parameter (rather
 * than importing it here) to keep the `capability` module free of
 * dependencies on L2Atom.
 */
export function ensureCanonicalL1(
  registry: AtomRegistry,
  tools: readonly Tool[],
  smokeGuidance: string
): AtomType {
  const existing = registry
    .listByTier(1)
    .find((t) => t.createdBy === CANONICAL_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: tools as Tool[] },
      'build-app-bootstrap',
      'refresh canonical L1 tools'
    );
  }
  const systemPrompt = [...CANONICAL_L1_SYSTEM_PROMPT_LINES, ``, smokeGuidance].join('\n');
  return registry.create(1, {
    description: capabilityDescription(tools),
    systemPrompt,
    tools: tools as Tool[],
    params: {},
    createdBy: CANONICAL_BOOTSTRAP_MARKER,
  });
}

/**
 * Idempotent counterpart for the canonical tier-2 orchestrator. See
 * `ensureCanonicalL1` for the contract — same shape, different tier.
 */
export function ensureCanonicalL2(
  registry: AtomRegistry,
  tools: readonly Tool[]
): AtomType {
  const existing = registry
    .listByTier(2)
    .find((t) => t.createdBy === CANONICAL_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: tools as Tool[] },
      'build-app-bootstrap',
      'refresh canonical L2 tools'
    );
  }
  return registry.create(2, {
    description: CANONICAL_L2_WEB_DESCRIPTION,
    systemPrompt: CANONICAL_L2_SYSTEM_PROMPT_LINES.join('\n'),
    tools: tools as Tool[],
    params: {},
    createdBy: CANONICAL_BOOTSTRAP_MARKER,
  });
}
