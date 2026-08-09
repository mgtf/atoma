/**
 * atoma curriculum generator — write the NEXT burn-in batch from the
 * lifecycle state instead of a hand-picked task list (Voyager's
 * curriculum idea mapped onto atoma's counters: propose tasks from what
 * the system has and hasn't mastered, and re-propose what failed).
 *
 *   npm run curriculum                       # → burnin/tasks-curriculum.json
 *   npm run curriculum -- --dry-run          # show targets, no LLM call
 *   npm run curriculum -- --count 6 --out my-batch.json
 *
 * Selection is CODE (which skills are one nudge from a lifecycle
 * transition), generation is ONE Sonnet-tier call (novel task statements
 * whose workflow shape matches each target — judgment). Four target
 * categories, in priority order:
 *   1. script-maturation   — kind:script below the trust threshold: each
 *      clean validated run brings the zero-LLM dispatch closer.
 *   2. stale-refusal-retry — llm skills parked by a refusal stamp from an
 *      OLDER compiler generation: one clean success re-attempts compile.
 *   3. promotion-push      — llm skills with 1..promote-1 clean successes:
 *      armed runs toward the compile trigger.
 *   4. failed-family-retry — burn-in families with failed rows (Voyager
 *      re-proposes failures; a family that never delivered is exactly the
 *      signal worth another shot).
 * Skills with failures > 0 are SKIPPED — they need `skills reset` (an
 * operator judgment), not more runs.
 *
 * The generated goals must be NOVEL: the point is to mature counters on
 * fresh-but-shape-matching tasks, not to replay the task the skill was
 * learned on (replaying would inflate trust on memorised specifics — the
 * generalisation rule's evil twin).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SkillRegistry } from '../skills/registry.js';
import { skillsDirPath } from '../core/stores.js';
import { trustThreshold, promoteThreshold } from '../atoms/cost.js';
import { refusalStampIsCurrent } from '../skills/generations.js';
import { extractJson } from '../atoms/json.js';
import { modelForTier } from '../core/models.js';
import { AnthropicLlmClient } from '../core/llm.js';
import { OllamaLlmClient } from '../core/llmOllama.js';
import { ClaudeCliLlmClient } from '../core/llmClaudeCli.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { makeAnthropicClient } from '../run/auth.js';
import { buildReferencedProviders } from '../run/providers.js';
import type { LlmClient } from '../core/types.js';
import type { Skill } from '../skills/types.js';
import type { BurninTask } from './burnin.js';

export type CurriculumCategory =
  | 'script-maturation'
  | 'stale-refusal-retry'
  | 'promotion-push'
  | 'failed-family-retry';

export interface CurriculumTarget {
  readonly category: CurriculumCategory;
  /** L1 namespace for skill targets; empty for family retries. */
  readonly l1: string;
  readonly skillId?: string;
  readonly family?: string;
  /** LLM-facing rationale + workflow shape to exercise. */
  readonly hint: string;
}

const CATEGORY_PRIORITY: Record<CurriculumCategory, number> = {
  'script-maturation': 0,
  'stale-refusal-retry': 1,
  'promotion-push': 2,
  'failed-family-retry': 3,
};

/** Default cap on targets per batch — one task per target downstream. */
export const DEFAULT_TARGET_CAP = 8;

/**
 * Pick the lifecycle targets worth spending a burn-in run on. Pure:
 * skills in, targets out, thresholds injected (operator env config).
 */
export function selectCurriculumTargets(args: {
  byL1: ReadonlyMap<string, readonly Skill[]>;
  trust: number;
  promote: number;
  /** Refusal-stamp currency check — pass `refusalStampIsCurrent` (generations.ts). */
  stampIsCurrent: (gen: string | undefined) => boolean;
  failedFamilies?: readonly { family: string; failed: number; total: number }[];
  cap?: number;
}): CurriculumTarget[] {
  const scored: { target: CurriculumTarget; priority: number; distance: number }[] = [];
  for (const [l1, skills] of args.byL1) {
    for (const s of skills) {
      // failures > 0 is a dead-end only `skills reset` clears — more runs
      // cannot move these, so proposing tasks for them wastes the batch.
      if (s.failures > 0) continue;
      const shape = `${s.description} — when to use: ${s.whenToUse}`;
      if (s.kind === 'script' && s.successes < args.trust) {
        const n = args.trust - s.successes;
        scored.push({
          priority: CATEGORY_PRIORITY['script-maturation'],
          distance: n,
          target: {
            category: 'script-maturation',
            l1,
            skillId: s.id,
            hint: `compiled script "${s.id}" on ${l1} needs ${n} more clean validated run(s) to unlock zero-LLM dispatch. Workflow shape: ${shape}`,
          },
        });
      } else if (
        s.kind === 'llm' &&
        s.promotionRefusedAt &&
        !args.stampIsCurrent(s.promotionRefusedGeneration)
      ) {
        scored.push({
          priority: CATEGORY_PRIORITY['stale-refusal-retry'],
          distance: 1,
          target: {
            category: 'stale-refusal-retry',
            l1,
            skillId: s.id,
            hint: `skill "${s.id}" on ${l1} was refused compilation by an OLDER compiler generation; one clean success gives the evolved compiler its shot. Workflow shape: ${shape}`,
          },
        });
      } else if (
        s.kind === 'llm' &&
        !s.promotionRefusedAt &&
        s.successes >= 1 &&
        s.successes < args.promote
      ) {
        const n = args.promote - s.successes;
        scored.push({
          priority: CATEGORY_PRIORITY['promotion-push'],
          distance: n,
          target: {
            category: 'promotion-push',
            l1,
            skillId: s.id,
            hint: `skill "${s.id}" on ${l1} is ${n} clean success(es) from the llm→script compile attempt (${s.successes}/${args.promote}). Workflow shape: ${shape}`,
          },
        });
      }
    }
  }
  for (const f of args.failedFamilies ?? []) {
    if (f.failed === 0) continue;
    scored.push({
      priority: CATEGORY_PRIORITY['failed-family-retry'],
      distance: -f.failed,
      target: {
        category: 'failed-family-retry',
        l1: '',
        family: f.family,
        hint: `burn-in family "${f.family}" has ${f.failed}/${f.total} failed run(s) — propose a FRESH task of this family so the failure class gets another shot`,
      },
    });
  }
  scored.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
  return scored.slice(0, args.cap ?? DEFAULT_TARGET_CAP).map((s) => s.target);
}

/**
 * Family failure profile from a burn-in results CSV (position-based on
 * the stable leading columns: timestamp,task_id,family,outcome,…).
 * Tolerant: malformed rows are skipped.
 */
export function parseBurninCsvFamilies(
  csv: string
): { family: string; failed: number; total: number }[] {
  const acc = new Map<string, { failed: number; total: number }>();
  const lines = csv.split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const family = cols[2]?.trim();
    const outcome = cols[3]?.trim();
    if (!family || !outcome) continue;
    const cur = acc.get(family) ?? { failed: 0, total: 0 };
    cur.total++;
    if (outcome !== 'delivered') cur.failed++;
    acc.set(family, cur);
  }
  return [...acc.entries()]
    .map(([family, v]) => ({ family, ...v }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

export const CURRICULUM_SYSTEM_PROMPT = [
  'You write burn-in task batches for an autonomous three-tier LLM build framework.',
  'Each task is a realistic end-user build request the framework will execute for real.',
  'Respond with ONLY a JSON object of shape:',
  '  {"tasks": [{"id": "<kebab-slug>", "family": "<family>", "goal": "<one-sentence build request>"}, ...]}',
  'Rules:',
  '  - ONE task per numbered target, in the given order, unless told otherwise.',
  '  - Each goal must EXERCISE the target\'s workflow shape so the framework\'s',
  '    skill prefilter matches it naturally — but it must be a NOVEL theme,',
  '    never a paraphrase of the workflow description itself and never a',
  '    replay of an earlier task. Vary the domain (different data, different',
  '    subject matter), keep the shape.',
  '  - Goals are SMALL: one deliverable, buildable and verifiable in a single',
  '    unattended run (a CLI tool, a single-page web artefact, a small HTTP',
  '    API, a documented config/data file...). No multi-service systems, no',
  '    external accounts or paid APIs, no GUI frameworks.',
  '  - SELF-CONTAINED — MANDATORY. Every run starts in an EMPTY workspace.',
  '    Never write a goal that presupposes existing files ("test MY CLI",',
  '    "index the notes in MY workspace", "document MY server"): there is',
  '    nothing there and the run either flounders or has to improvise the',
  '    missing artefact. When the target workflow CONSUMES an artefact',
  '    (verifying, documenting, indexing, packaging), the goal must ask for',
  '    that artefact to be BUILT first and then for the target workflow to',
  '    run over it AS A FINAL SEPARATE PHASE — that phase boundary is also',
  '    what lets the prefilter match the targeted recipe. Shape to follow:',
  '    "<build the artefact, with the concrete details>. As a FINAL SEPARATE',
  '    PHASE, <the target workflow over what was just built>."',
  '  - NEVER name the skill, the framework, or the L1 in the goal — goals read',
  '    like a user request, not like test instrumentation.',
  '  - "family" must come from the provided family list.',
  '  - "id" is a short unique kebab-case slug derived from the goal.',
].join('\n');

export function buildCurriculumUserContent(
  targets: readonly CurriculumTarget[],
  families: readonly string[]
): string {
  const lines: string[] = [
    `Known families: ${families.join(', ')}`,
    `Generate exactly ${targets.length} task(s), one per target below, same order.`,
    '',
  ];
  targets.forEach((t, i) => {
    lines.push(`${i + 1}. [${t.category}] ${t.hint}`);
  });
  return lines.join('\n');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Tolerant parse of the generation response: fenced/prose-wrapped JSON
 * accepted (extractJson), malformed entries skipped, ids slugified and
 * de-duplicated, family defaulted to the first known one. Never throws on
 * shape problems — returns what could be salvaged.
 */
export function parseCurriculumTasks(text: string, families: readonly string[]): BurninTask[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  const tasksRaw = (raw as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasksRaw)) return [];
  const fallbackFamily = families[0] ?? 'misc';
  const seen = new Set<string>();
  const out: BurninTask[] = [];
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const goal = typeof e['goal'] === 'string' ? e['goal'].trim() : '';
    if (!goal) continue;
    let id = slugify(typeof e['id'] === 'string' ? e['id'] : goal);
    if (!id) id = slugify(goal);
    if (!id) continue;
    let unique = id;
    for (let n = 2; seen.has(unique); n++) unique = `${id}-${n}`;
    seen.add(unique);
    const familyRaw = typeof e['family'] === 'string' ? e['family'].trim() : '';
    const family = families.includes(familyRaw) ? familyRaw : fallbackFamily;
    out.push({ id: unique, family, goal });
  }
  return out;
}

/** Same provider switch as build-app (ATOMA_LLM), + cross-vendor routing parity. */
function makeClient(): LlmClient {
  const provider = (process.env['ATOMA_LLM'] ?? 'anthropic').toLowerCase();
  const base: LlmClient =
    provider === 'ollama'
      ? new OllamaLlmClient({
          baseUrl: process.env['OLLAMA_BASE_URL'],
          defaultModel: process.env['OLLAMA_MODEL'],
        })
      : // The bare `claude` alias too — build-app.ts has accepted both since
        // it was written, this copy only ever matched the long form, and the
        // docstring above claims parity. The failure is SILENT and expensive:
        // with ATOMA_LLM=claude the curriculum falls through to the Anthropic
        // branch and hits the dead API key, so the one Sonnet call that
        // generates the whole task batch fails for a reason that looks like
        // an auth problem rather than a typo.
        provider === 'claude-cli' || provider === 'claude'
        ? new ClaudeCliLlmClient()
        : new AnthropicLlmClient(makeAnthropicClient());
  const providers = buildReferencedProviders();
  return Object.keys(providers).length > 0 ? new RoutingLlmClient(base, providers) : base;
}

function knownFamilies(csvPath: string, defaultTasksPath: string): string[] {
  const fams = new Set<string>();
  try {
    if (existsSync(resolve(defaultTasksPath))) {
      const file = JSON.parse(readFileSync(resolve(defaultTasksPath), 'utf8')) as {
        tasks?: { family?: string }[];
      };
      for (const t of file.tasks ?? []) if (t.family) fams.add(t.family);
    }
  } catch {
    /* tolerated — families fall back to CSV / defaults */
  }
  try {
    if (existsSync(resolve(csvPath))) {
      for (const f of parseBurninCsvFamilies(readFileSync(resolve(csvPath), 'utf8'))) {
        fams.add(f.family);
      }
    }
  } catch {
    /* tolerated */
  }
  if (fams.size === 0) ['web', 'http', 'cli', 'files'].forEach((f) => fams.add(f));
  return [...fams].sort();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outPath = 'burnin/tasks-curriculum.json';
  let csvPath = 'burnin/results.csv';
  let skillsDir = skillsDirPath();
  let cap = DEFAULT_TARGET_CAP;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out') outPath = argv[++i] ?? outPath;
    else if (a === '--csv') csvPath = argv[++i] ?? csvPath;
    else if (a === '--dir') skillsDir = argv[++i] ?? skillsDir;
    else if (a === '--count') cap = Number(argv[++i] ?? cap) || cap;
    else if (a === '--dry-run') dryRun = true;
  }

  const registry = new SkillRegistry(skillsDir);
  const byL1 = new Map(registry.listNamespaces().map((ns) => [ns, registry.loadFor(ns)]));
  const failedFamilies = existsSync(resolve(csvPath))
    ? parseBurninCsvFamilies(readFileSync(resolve(csvPath), 'utf8'))
    : [];
  const targets = selectCurriculumTargets({
    byL1,
    trust: trustThreshold(),
    promote: promoteThreshold(),
    stampIsCurrent: refusalStampIsCurrent,
    failedFamilies,
    cap,
  });

  if (targets.length === 0) {
    console.log(
      'no curriculum targets: no skill is one nudge from a lifecycle transition and no burn-in family has failures.'
    );
    console.log('(skills with failures > 0 need `skills reset` first — runs cannot move them.)');
    return;
  }

  console.log(`curriculum targets (${targets.length}):`);
  for (const t of targets) {
    console.log(`  [${t.category}] ${t.skillId ? `${t.l1}/${t.skillId}` : `family ${t.family}`}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: no LLM call, no file written. Full hints:');
    targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.hint}`));
    return;
  }

  const families = knownFamilies(csvPath, 'burnin/tasks-default.json');
  const client = makeClient();
  const model = modelForTier(2);
  console.log(`\ngenerating ${targets.length} task(s) via ${model}…`);
  const resp = await client.complete({
    model,
    systemPrompt: CURRICULUM_SYSTEM_PROMPT,
    userContent: buildCurriculumUserContent(targets, families),
    params: { maxTokens: 8000, effort: 'medium' },
  });
  const tasks = parseCurriculumTasks(resp.text, families);
  if (tasks.length === 0) {
    console.error('generation returned no parseable tasks — raw response follows:\n');
    console.error(resp.text);
    process.exit(1);
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify({ tasks }, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${tasks.length} task(s) to ${outPath}:`);
  for (const t of tasks) console.log(`  ${t.id} (${t.family}): ${t.goal}`);
  console.log(`\nrun the batch:\n  npm run burnin -- ${outPath}`);
}

// Only run as a CLI, never on import (tests import the pure helpers).
if (process.argv[1] && /curriculum\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
