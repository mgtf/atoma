import type { Tier, Tool } from '../core/types.js';
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

/**
 * Toolset-based capability buckets, ordered from most-specific to most-
 * general. Each bucket carries TIER-SPECIFIC labels so an L1 and an L2
 * with identical tool signatures get DIFFERENT registry descriptions —
 * the tier-1 atom IS the thing doing the work ("builder", "writer"),
 * the tier-2 atom ORCHESTRATES and DELEGATES ("orchestrator", "router").
 *
 * Without this distinction, fresh L2s created via L3.createSubtaskL2
 * would inherit an L1-shaped label like "single-file web artefact
 * builder: writes an index.html on disk…", which is both misleading
 * (L2s never call tools) and poisonous for prefilter (prefilter matches
 * on the description; an L3 looking for an L2 could match an L1 or
 * vice-versa).
 */
interface CapabilityBucket {
  id: string;
  required: readonly string[];
  /** tier-1 label — "X builder/writer: directly calls tools to …". */
  leafLabel: string;
  /**
   * tier-2 label — "X orchestrator: decomposes and delegates to a tier-1
   * atom that does Y". Tier 3 reuses the same string, prefixed by its
   * cell-level role.
   */
  orchestratorLabel: string;
}

const CAPABILITY_BUCKETS: readonly CapabilityBucket[] = [
  {
    id: 'http-server-build+probe',
    // Listed BEFORE the web-artefact bucket so a toolset that has BOTH
    // (a kitchen-sink L1 carrying the full executor set) sorts to the
    // HTTP label when `start_node_server` is present — the two workflows
    // are genuinely distinct (HTML render loop vs HTTP request/response
    // loop) and we don't want a Node/REST build to be described as a
    // "web artefact builder".
    required: ['write_file', 'run_shell', 'start_node_server', 'fetch_url'],
    leafLabel:
      'Node HTTP server builder: writes server code on disk, runs "npm install" via run_shell, boots the server through start_node_server (LISTENING_ON_PORT convention), and iterates against fetch_url probes until endpoints answer correctly',
    orchestratorLabel:
      'Node HTTP server orchestrator: routes a leaf task to a tier-1 builder that writes server code, installs dependencies, boots a Node process, and probes endpoints via fetch_url',
  },
  {
    id: 'web-artefact-build+validate',
    required: ['write_file', 'start_static_server', 'validate_html'],
    leafLabel:
      'single-file web artefact builder: writes an index.html on disk, serves it locally, and iterates against headless-browser validation (validate_html) until zero console errors',
    orchestratorLabel:
      'single-file web artefact orchestrator: routes a leaf task to a tier-1 builder that writes an index.html on disk, serves it, and validates via headless browser (validate_html)',
  },
  {
    id: 'web-artefact-write+serve',
    required: ['write_file', 'start_static_server'],
    leafLabel:
      'static-site runner: writes files on disk and serves them locally (no headless validation in the loop)',
    orchestratorLabel:
      'static-site orchestrator: routes a leaf task to a tier-1 atom that writes files and serves them locally (no headless validation)',
  },
  {
    id: 'web-artefact-write+validate',
    required: ['write_file', 'validate_html'],
    leafLabel:
      'HTML writer + headless validator: writes files and checks them through a headless browser',
    orchestratorLabel:
      'HTML-validation orchestrator: routes a leaf task to a tier-1 atom that writes HTML and validates via headless browser',
  },
  {
    id: 'file-scribe',
    required: ['write_file'],
    leafLabel: 'file scribe: reads, writes, and lists workspace files',
    orchestratorLabel:
      'file-scribe orchestrator: routes a leaf task to a tier-1 file scribe (read, write, list)',
  },
];

const AUXILIARY_TOOLS: Readonly<Record<string, string>> = {
  fetch_url: 'fetches arbitrary HTTP URLs',
  run_shell: 'executes shell commands inside the sandbox',
};

/**
 * Canonical capability description for a set of tools at a given tier.
 * Deterministic — two atoms with the same tool signature AND the same
 * tier always get the same string, so prefilter (which matches on
 * description) treats them as interchangeable. Different tiers with
 * the same tool signature get distinct labels so an L1 and an L2
 * never look like the same role to prefilter.
 *
 * The output is intentionally task-neutral: no domain nouns, no grid
 * dimensions, no UI verbs. Anything task-specific must live on the
 * runtime `task.description`, not on the registry entry.
 */
export function capabilityDescription(
  tools: readonly Tool[],
  tier: Tier
): string {
  const names = new Set(tools.map((t) => t.name));
  const parts: string[] = [];

  const primary = CAPABILITY_BUCKETS.find((b) => b.required.every((r) => names.has(r)));
  if (primary) {
    // Tier-1: the "hands" — baseline label. Tier-2 and tier-3: the
    // "brain" — orchestrator label. We don't create tier-3 atoms at
    // runtime (L3 is user-bootstrapped), but the function accepts it
    // for symmetry and future-proofing.
    parts.push(tier === 1 ? primary.leafLabel : primary.orchestratorLabel);
  }

  // Auxiliary tools are EXTRA capabilities beyond the primary bucket.
  // If a tool is already part of the primary bucket's required list
  // (e.g. run_shell for http-server-build+probe), skip it here — the
  // bucket label already describes how it is used. Without this
  // skip, the http bucket would get double-described (primary label +
  // "capable of delegating to a tier-1 atom that executes shell
  // commands…") which is both noisy and makes the canonical constants
  // impossible to keep in sync with capabilityDescription output.
  const primaryRequired = new Set(primary?.required ?? []);
  for (const [name, label] of Object.entries(AUXILIARY_TOOLS)) {
    if (names.has(name) && !primaryRequired.has(name)) {
      parts.push(
        tier === 1 ? label : `capable of delegating to a tier-1 atom that ${label}`
      );
    }
  }

  if (parts.length === 0) {
    // No bucket matched — still produce a stable, distinguishable label
    // instead of falling back to task prose. Sort for determinism so the
    // same toolset never produces two different descriptions. Prefix
    // the role so tier-cross contamination stays visible in prefilter.
    const sig = [...names].sort().join(', ');
    const role =
      tier === 1 ? 'leaf' : tier === 2 ? 'orchestrator' : 'top-level cell';
    parts.push(`custom ${role} toolset: ${sig || 'no tools'}`);
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
 * Pick a description for a newly-created atom at a given tier:
 *   1. If the LLM's seed suggested a description AND it looks clean
 *      (short, task-neutral), honour it — the planner may have useful
 *      nuance we don't want to lose.
 *   2. Otherwise, derive the canonical capability label from the
 *      tool signature AT THAT TIER (so an L1 and an L2 with the same
 *      toolset get distinguishable labels).
 *
 * Call sites: `L2Atom.createSubtaskL1`, `L3Atom.createSubtaskL2`, the
 * escalation-branch paths in both, and the canonical-bootstrap in
 * `examples/build-app.ts`.
 */
export function resolveCreationDescription(
  suggested: string | undefined,
  tools: readonly Tool[],
  tier: Tier
): string {
  const canonical = capabilityDescription(tools, tier);
  const cleaned = suggested?.trim();
  if (!cleaned) return canonical;
  if (looksTaskThemed(cleaned)) return canonical;
  return cleaned;
}

/** Marker for the canonical WEB L1/L2 entries (single-file artefact + headless
 * validator) created by the example's bootstrap step. Kept as
 * `bootstrap-canonical` for backwards compatibility with legacy DBs — new
 * canonical bootstraps should use the bucket-scoped markers (WEB_MARKER,
 * HTTP_MARKER) instead. */
export const CANONICAL_BOOTSTRAP_MARKER = 'bootstrap-canonical';

/** Marker for the canonical HTTP L1/L2 entries (Node server builder + API
 * probe loop). Separate from the web marker so both canonicals coexist in
 * the same registry without one idempotent-refreshing over the other. */
export const CANONICAL_HTTP_BOOTSTRAP_MARKER = 'bootstrap-canonical-http';

/** Marker for the canonical file-scribe L1 (JSON/markdown/text static
 * files, no server, no browser). Distinct from the web + http markers so
 * all three canonicals coexist in the same registry. Separated at the
 * L1 tier only — Opus at L3 / Sonnet at L2 can route file-scribe
 * subtasks to this L1 via prefilter without needing a dedicated file-
 * scribe L2 (the existing HTTP L2 Methane works fine as an agnostic
 * router here). */
export const CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER = 'bootstrap-canonical-filescribe';

/**
 * The TOOL SIGNATURE of each canonical atom. These are the names of the
 * tools we SELECT from the caller-provided toolset when seeding a
 * canonical — they deliberately DO NOT include auxiliary tools
 * (fetch_url, run_shell) for the web canonical, nor validate_html /
 * start_static_server for the http canonical. Without this narrowing a
 * kitchen-sink L1 would match the first CAPABILITY_BUCKETS entry
 * regardless of domain, collapsing the whole per-bucket distinction we
 * just built.
 *
 * read_file + list_files are universal read-only auxiliaries and ride
 * along in both scopes — they don't drive bucket selection (no bucket
 * requires them) but L1s genuinely need them in practice.
 */
const WEB_L1_TOOL_SCOPE: readonly string[] = [
  'write_file',
  'read_file',
  'list_files',
  'start_static_server',
  'validate_html',
];

const HTTP_L1_TOOL_SCOPE: readonly string[] = [
  'write_file',
  'read_file',
  'list_files',
  'run_shell',
  'fetch_url',
  'start_node_server',
];

const FILESCRIBE_L1_TOOL_SCOPE: readonly string[] = [
  // A minimal file-authoring toolkit: write / read / list workspace files,
  // plus run_shell so the atom can do quick `node -e` / `python3 -c`
  // validations of what it just wrote (JSON-parses, field values match,
  // markdown structure, etc.) without pulling in headless browsers or a
  // Node server runtime. No validate_html (not a web artefact), no
  // start_node_server / fetch_url (not an HTTP service). The bucket
  // purpose is documented in the canonical prompt below.
  'write_file',
  'read_file',
  'list_files',
  'run_shell',
];

/** Filter a tool list down to the given scope (by tool name). */
function pickTools(tools: readonly Tool[], scope: readonly string[]): Tool[] {
  const scopeSet = new Set(scope);
  return tools.filter((t) => scopeSet.has(t.name));
}

/**
 * Walk a supervise-loop trace backwards and extract the diagnostic
 * information we want to inject into a branched atom's prompt so the
 * branch doesn't repeat the same mistake that triggered the
 * escalation. Returns an empty string when there's nothing useful.
 *
 * Today we surface (in order):
 *   - Up to the 2 most-recent `verdict-result`/`verdict-plan` entries
 *     with `approved === false`: their reasoning often quotes a
 *     ground-truth probe response (e.g. "GROUND-TRUTH EVIDENCE:
 *     validate_html reported 404"), which is the signal the branched
 *     L1 must act on rather than rewrite the whole deliverable from
 *     scratch.
 *   - The LAST `applied-modifications` entry's `additionalContext`
 *     when present — that's the concrete "next-attempt" hint the
 *     validator produced on its last failed round.
 *
 * We cap the output at ~1500 characters so the injection stays
 * bounded: a long narrative diagnostic crowds out the actual
 * subtask description and confuses the model more than it helps.
 */
export function extractBranchDiagnostic(
  trace: readonly { kind: string; payload: unknown }[]
): string {
  const lines: string[] = [];
  const rejections: Array<{ phase: string; reasoning: string }> = [];

  // Walk newest-first, collect up to 2 negative verdicts.
  for (let i = trace.length - 1; i >= 0 && rejections.length < 2; i--) {
    const entry = trace[i];
    if (!entry) continue;
    if (entry.kind !== 'verdict-plan' && entry.kind !== 'verdict-result') continue;
    const payload = entry.payload as {
      approved?: boolean;
      reasoning?: string;
      modifications?: { additionalContext?: string };
    } | null;
    if (!payload || payload.approved !== false) continue;
    const reasoning =
      typeof payload.reasoning === 'string' && payload.reasoning.length > 0
        ? payload.reasoning.slice(0, 700)
        : '';
    if (!reasoning) continue;
    rejections.push({
      phase: entry.kind === 'verdict-plan' ? 'PLAN' : 'RESULT',
      reasoning,
    });
  }

  if (rejections.length > 0) {
    lines.push(`Prior attempt was REJECTED by the supervisor. Verbatim validator feedback (most recent first):`);
    for (const r of rejections) {
      lines.push(`  [${r.phase}] ${r.reasoning}`);
    }
  }

  // Last applied-modifications additionalContext — validator's "next-
  // attempt" instruction, if any.
  for (let i = trace.length - 1; i >= 0; i--) {
    const entry = trace[i];
    if (!entry || entry.kind !== 'applied-modifications') continue;
    const payload = entry.payload as {
      modifications?: { additionalContext?: string };
    } | null;
    const hint = payload?.modifications?.additionalContext;
    if (typeof hint === 'string' && hint.trim().length > 0) {
      lines.push(`Validator's prescription for the next attempt:`);
      lines.push(`  ${hint.trim().slice(0, 500)}`);
      break;
    }
  }

  if (lines.length === 0) return '';
  const out = lines.join('\n');
  return out.length > 1500 ? out.slice(0, 1500) + '…' : out;
}

/**
 * Return the CAPABILITY_BUCKETS id that best describes the given tool set
 * (first bucket whose `required` list is fully covered), or null if no
 * bucket matches. Used by prompt-selection code (e.g. the narrow-branch
 * L1 prompt) to tailor its guidance to the atom's actual bucket instead
 * of leaking web-centric smoke discipline into an HTTP atom.
 */
export function bucketIdForTools(tools: readonly Tool[]): string | null {
  const names = new Set(tools.map((t) => t.name));
  const match = CAPABILITY_BUCKETS.find((b) => b.required.every((r) => names.has(r)));
  return match?.id ?? null;
}

/**
 * Description used for the canonical tier-2 "web build orchestrator"
 * seeded by `examples/build-app.ts`. Kept as a named export (not just
 * derived inline) so tests and downstream tooling can reference the
 * exact string. It's the same value you'd get from
 * `capabilityDescription(tools, 2)` when `tools` includes the
 * web-artefact-build+validate bucket — we materialise it at module
 * load time via a helper that mirrors the bucket directly so we stay
 * decoupled from the actual tool list the example wires at runtime.
 *
 * NB: the exact wording MUST match the tier-2 orchestratorLabel of the
 * `web-artefact-build+validate` bucket — see the bucket table above.
 */
export const CANONICAL_L2_WEB_DESCRIPTION =
  'single-file web artefact orchestrator: routes a leaf task to a tier-1 builder that writes an index.html on disk, serves it, and validates via headless browser (validate_html)';

/**
 * Description used for the canonical tier-2 HTTP orchestrator. Mirror of
 * CANONICAL_L2_WEB_DESCRIPTION — kept as a named export so downstream
 * tooling doesn't have to re-derive it from the bucket table. Must match
 * the orchestratorLabel of the `http-server-build+probe` bucket above.
 */
export const CANONICAL_L2_HTTP_DESCRIPTION =
  'Node HTTP server orchestrator: routes a leaf task to a tier-1 builder that writes server code, installs dependencies, boots a Node process, and probes endpoints via fetch_url';

export const CANONICAL_L1_SYSTEM_PROMPT_LINES: readonly string[] = [
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

export const CANONICAL_L2_SYSTEM_PROMPT_LINES: readonly string[] = [
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

export const CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES: readonly string[] = [
  `You are an L1 element specialised for Node HTTP server builds.`,
  `Your job: write a single self-contained server entry point, install its`,
  `dependencies, boot it, and verify the endpoints with HTTP probes.`,
  ``,
  `Typical tool sequence:`,
  `  1. write_file  package.json  (declare dependencies; keep the dep list MINIMAL)`,
  `  2. write_file  <entry>.js    (Express / native http; MUST read process.env.PORT`,
  `                                and print "LISTENING_ON_PORT=" + address().port`,
  `                                so start_node_server can discover the bound port)`,
  `  3. run_shell   npm install    (give it time — first install can take 20s+)`,
  `  4. start_node_server entry=<entry>.js`,
  `  5. fetch_url   http://localhost:<port>/<endpoint>  for each route you expose`,
  `  6. if a probe fails: read_file the source, diagnose, write_file the fix,`,
  `     kill+respawn via a second start_node_server call. Up to 4 iterations.`,
  `  7. return JSON {"output": <url or summary>, "summary": "<one sentence>"}`,
  ``,
  `HARD RULE on the LISTENING_ON_PORT marker: your server MUST print the`,
  `literal line "LISTENING_ON_PORT=<N>" on stdout after it has successfully`,
  `bound the port. start_node_server parses this marker to discover the`,
  `OS-assigned port — without it the tool times out and the iteration is`,
  `wasted. Example (Express):`,
  `  const srv = app.listen(Number(process.env.PORT) || 0, () => {`,
  `    const p = srv.address().port;`,
  `    console.log('LISTENING_ON_PORT=' + p);`,
  `  });`,
  ``,
  `Scope boundary: if the subtask seems to require coordinating with other`,
  `subtasks (reading their outputs, sharing state) — that is a planning bug`,
  `at L2/L3, not an excuse to expand scope. Surface it in your summary.`,
];

export const CANONICAL_HTTP_L2_SYSTEM_PROMPT_LINES: readonly string[] = [
  `You are a domain-neutral L2 orchestrator for Node HTTP server builds.`,
  `DELEGATION DISCIPLINE: you NEVER call tools yourself. Decompose the task`,
  `into orthogonal L1 leaves (server code, client stub, schema file, etc.)`,
  `and delegate each to a tier-1 atom.`,
  `Prefer reusing the existing canonical HTTP L1 via prefilter — only`,
  `request a new L1 when the toolset genuinely diverges.`,
  ``,
  `Scope boundary: task-specific nouns (endpoint paths, request shapes,`,
  `database names) belong in the SUBTASK DESCRIPTION you pass down, never`,
  `in the L1's registry metadata. Keep the catalog reusable.`,
];

export const CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES: readonly string[] = [
  `You are an L1 element specialised for static-file authoring: JSON,`,
  `markdown, YAML, text, configuration files, documentation — anything`,
  `that is NOT a runnable server, NOT a browser-rendered page.`,
  ``,
  `Typical tool sequence:`,
  `  1. write_file  <path>        (the file the subtask asks for)`,
  `  2. read_file   <path>        (optional, echo-back verification)`,
  `  3. run_shell   (optional)    (quick structural validation, e.g.`,
  `                                \`node -e 'JSON.parse(require("fs").readFileSync("config.json","utf8"))'\``,
  `                                or \`python3 -c 'import json; json.load(open("config.json"))'\`)`,
  `  4. return JSON {"output": {"path": "<path>"}, "summary": "<one sentence>"}`,
  ``,
  `Scope boundary — this is a NARROW bucket:`,
  `  - You do NOT start servers (no start_node_server, no start_static_server).`,
  `  - You do NOT probe HTTP endpoints (no fetch_url).`,
  `  - You do NOT render HTML in a browser (no validate_html).`,
  `  Those are the HTTP and web buckets' responsibility; a planner that`,
  `  routes one of those to you is wrong — surface it in your summary`,
  `  and return whatever file you legitimately wrote. Do NOT grow your`,
  `  remit silently.`,
  ``,
  `The output JSON envelope is mandatory — {"output", "summary"} — even`,
  `if the file is a single byte. The supervisor validator reads it.`,
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
  const scoped = pickTools(tools, WEB_L1_TOOL_SCOPE);
  const existing = registry
    .listByTier(1)
    .find((t) => t.createdBy === CANONICAL_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: scoped },
      'build-app-bootstrap',
      'refresh canonical L1 tools'
    );
  }
  const systemPrompt = [...CANONICAL_L1_SYSTEM_PROMPT_LINES, ``, smokeGuidance].join('\n');
  return registry.create(1, {
    description: capabilityDescription(scoped, 1),
    systemPrompt,
    tools: scoped,
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
  const scoped = pickTools(tools, WEB_L1_TOOL_SCOPE);
  const existing = registry
    .listByTier(2)
    .find((t) => t.createdBy === CANONICAL_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: scoped },
      'build-app-bootstrap',
      'refresh canonical L2 tools'
    );
  }
  return registry.create(2, {
    description: capabilityDescription(scoped, 2),
    systemPrompt: CANONICAL_L2_SYSTEM_PROMPT_LINES.join('\n'),
    tools: scoped,
    params: {},
    createdBy: CANONICAL_BOOTSTRAP_MARKER,
  });
}

/**
 * Canonical Node HTTP L1 — the tier-1 counterpart to the web canonical
 * for builds that expose an HTTP API instead of a browser-runnable
 * single-file page. Tool signature is scoped to the HTTP bucket
 * (write_file + run_shell + start_node_server + fetch_url, plus
 * read_file / list_files as universal auxiliaries) so the registry
 * description lands on the "Node HTTP server builder" label and
 * prefilter can cleanly discriminate it from the web canonical.
 *
 * Idempotency and tool refresh follow the same pattern as
 * `ensureCanonicalL1`. Marker: CANONICAL_HTTP_BOOTSTRAP_MARKER (distinct
 * from the web marker so the two canonicals coexist without
 * overwriting each other's registry row).
 */
export function ensureCanonicalHttpL1(
  registry: AtomRegistry,
  tools: readonly Tool[]
): AtomType {
  const scoped = pickTools(tools, HTTP_L1_TOOL_SCOPE);
  const existing = registry
    .listByTier(1)
    .find((t) => t.createdBy === CANONICAL_HTTP_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: scoped },
      'build-app-bootstrap',
      'refresh canonical HTTP L1 tools'
    );
  }
  return registry.create(1, {
    description: capabilityDescription(scoped, 1),
    systemPrompt: CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES.join('\n'),
    tools: scoped,
    params: {},
    createdBy: CANONICAL_HTTP_BOOTSTRAP_MARKER,
  });
}

/**
 * Canonical Node HTTP L2 — tier-2 counterpart. Its description names
 * "Node HTTP server orchestrator" so L3.prefilter can route
 * HTTP-flavoured tasks to it without having to create a fresh L2 every
 * time (the behaviour we saw on the Methane/Hydrogen Node/REST run that
 * triggered this whole fix series).
 */
export function ensureCanonicalHttpL2(
  registry: AtomRegistry,
  tools: readonly Tool[]
): AtomType {
  const scoped = pickTools(tools, HTTP_L1_TOOL_SCOPE);
  const existing = registry
    .listByTier(2)
    .find((t) => t.createdBy === CANONICAL_HTTP_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: scoped },
      'build-app-bootstrap',
      'refresh canonical HTTP L2 tools'
    );
  }
  return registry.create(2, {
    description: capabilityDescription(scoped, 2),
    systemPrompt: CANONICAL_HTTP_L2_SYSTEM_PROMPT_LINES.join('\n'),
    tools: scoped,
    params: {},
    createdBy: CANONICAL_HTTP_BOOTSTRAP_MARKER,
  });
}

/**
 * Canonical file-scribe L1 — the tier-1 bucket for static-file
 * authoring (JSON, markdown, config, text). Mirror of
 * `ensureCanonicalL1` (web) and `ensureCanonicalHttpL1` (http), scoped
 * to the `file-scribe` bucket: `write_file`, `read_file`, `list_files`,
 * `run_shell`. No server startup, no browser rendering — those are
 * the other buckets.
 *
 * Why this exists: the Node/REST fan-out run (task = "server.js +
 * config.json + README.md") exposed a routing gap. Opus at L3
 * decomposes the task into three L2 subtasks and routes them all to
 * Methane (HTTP L2, the only non-web L2). Methane's prefilter then
 * tried to route the README / config subtasks to Helium — the only
 * non-web L1 — and got correctly rejected as a domain mismatch
 * ("Helium's capability is HTTP server building, not documentation
 * authoring"). Without a file-scribe canonical in the L1 catalog,
 * the only options were (a) create a fresh ad-hoc L1 (wasteful and
 * prefilter-blind on the next run) or (b) escalate to Methane
 * fallback. Adding this canonical closes that gap: Methane.prefilter
 * now picks it cleanly for file-authoring subtasks, the fan-out hits
 * 100% happy path on repeat runs.
 *
 * No file-scribe L2 counterpart — the existing HTTP L2 (Methane)
 * happily orchestrates to this L1 via prefilter. An L2 file-scribe
 * would only matter if L3 needed to discriminate at the L2 level,
 * and for the observed tasks that layer already works: the L3
 * Neuron picks Methane for the whole task, Methane decomposes and
 * routes each sub-subtask to the right L1 bucket.
 */
export function ensureCanonicalFileScribeL1(
  registry: AtomRegistry,
  tools: readonly Tool[]
): AtomType {
  const scoped = pickTools(tools, FILESCRIBE_L1_TOOL_SCOPE);
  const existing = registry
    .listByTier(1)
    .find((t) => t.createdBy === CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER);
  if (existing) {
    return registry.patch(
      existing.name,
      { addTools: scoped },
      'build-app-bootstrap',
      'refresh canonical file-scribe L1 tools'
    );
  }
  return registry.create(1, {
    description: capabilityDescription(scoped, 1),
    systemPrompt: CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n'),
    tools: scoped,
    params: {},
    createdBy: CANONICAL_FILESCRIBE_BOOTSTRAP_MARKER,
  });
}
