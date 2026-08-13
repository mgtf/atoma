import type { VizEvent, VizLlmEvent, VizRun, VizToolEvent } from './trace.js';
import type { Tier } from '../core/types.js';
import { parseTwoJson, planSchema, l3StrategySchema, l2StrategySchema } from '../atoms/json.js';

/**
 * Human-readable post-run report describing HOW the three tiers broke the
 * task down:
 *   - L3 prefilter pick or LLM-planned subtasks (per subtask: description +
 *     chosen L2 + reasoning).
 *   - L2 prefilter pick or LLM-planned subtasks (per subtask: description +
 *     chosen L1 + reasoning).
 *   - L1 tool invocations grouped per L1 actor (counts + error counts), plus
 *     a short chronological excerpt of the first few calls so readers can
 *     see the actual tool sequence without wading through the full trace.
 *
 * This is rendered at the very end of a build-app run so the terminal output
 * answers "what did each tier actually do?" without needing to open the viz.
 * The formatter is fully data-driven: it relies only on the events captured
 * by `TraceRecorder`, so running it after the fact on any persisted
 * `runs/*.json` produces the same report.
 */

export interface DecompositionReportOptions {
  /**
   * Cap on the chronological tool-call excerpt shown per L1 actor. The full
   * counts (by tool name) are always included regardless of this cap.
   */
  toolExcerptLimit?: number;
}

const DEFAULT_TOOL_EXCERPT_LIMIT = 8;

interface SubtaskSummary {
  description: string;
  preferredChild?: string;
}

interface PlanSummary {
  reasoning?: string;
  subtasks: SubtaskSummary[];
  strategy?: { kind: 'reuse' | 'create' | 'mutualize'; target?: string; reasoning?: string };
}

function tryParsePlanPair(responseText: string): PlanSummary | null {
  if (!responseText || responseText.trim().length === 0) return null;
  try {
    const [rawStrategy, rawPlan] = parseTwoJson(responseText);
    const plan = planSchema.parse(rawPlan);
    let strategy: PlanSummary['strategy'] | undefined;
    // Both L2 and L3 strategy schemas share the {strategy, target, reasoning}
    // base — try L2's (broader enum) first, fall back to L3's, and give up
    // gracefully when neither fits instead of aborting the whole report.
    const s2 = l2StrategySchema.safeParse(rawStrategy);
    if (s2.success) {
      strategy = {
        kind: s2.data.strategy,
        ...(s2.data.target ? { target: s2.data.target } : {}),
        reasoning: s2.data.reasoning,
      };
    } else {
      const s3 = l3StrategySchema.safeParse(rawStrategy);
      if (s3.success) {
        strategy = {
          kind: s3.data.strategy,
          ...(s3.data.target ? { target: s3.data.target } : {}),
          reasoning: s3.data.reasoning,
        };
      }
    }
    return {
      reasoning: plan.reasoning,
      subtasks: plan.subtasks.map((st) => ({
        description: st.description,
        ...(st.preferredChild ? { preferredChild: st.preferredChild } : {}),
      })),
      ...(strategy ? { strategy } : {}),
    };
  } catch {
    return null;
  }
}

interface PrefilterPick {
  kind: 'reuse' | 'escalate';
  target?: string;
  reasoning?: string;
}

function tryParsePrefilter(responseText: string): PrefilterPick | null {
  if (!responseText || responseText.trim().length === 0) return null;
  try {
    // Prefilter responses are small `{"kind":"reuse","target":"...", ...}`
    // or `{"kind":"escalate","reasoning":"..."}`. We don't want to pull in
    // the full schema here (circular-ish via cost.ts) so parse tolerantly.
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const kind = obj['kind'];
    if (kind !== 'reuse' && kind !== 'escalate') return null;
    const pick: PrefilterPick = { kind };
    if (typeof obj['target'] === 'string') pick.target = obj['target'];
    if (typeof obj['reasoning'] === 'string') pick.reasoning = obj['reasoning'];
    return pick;
  } catch {
    return null;
  }
}

/**
 * Truncate a string to `max` chars, appending "…" if shortened. Used for
 * subtask descriptions + tool arg echoes so the report stays terminal-wide
 * friendly without losing the signal of long strings entirely.
 */
function clip(s: string | undefined, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isLlm(ev: VizEvent): ev is VizLlmEvent {
  return ev.kind === 'llm';
}

function isTool(ev: VizEvent): ev is VizToolEvent {
  return ev.kind === 'tool';
}

interface TierSummary {
  actorName: string;
  kind: 'prefilter' | 'plan' | 'fallback-plan' | 'self-plan-only';
  plan?: PlanSummary;
  prefilter?: PrefilterPick;
  errorExcerpt?: string;
  /**
   * For fan-out L2s the same `actorName` can plan multiple branches (one
   * per L3 subtask). Keep each separately so the report shows every branch.
   */
  branchId?: string;
}

function collectTierActivity(run: VizRun, tier: Tier): TierSummary[] {
  const out: TierSummary[] = [];
  for (const ev of run.events) {
    if (!isLlm(ev)) continue;
    if (ev.actor?.tier !== tier) continue;
    const actorName = ev.actor?.name ?? '(unknown)';
    const branchId = ev.branchId;
    if (ev.role === 'prefilter') {
      const pre = tryParsePrefilter(ev.response);
      if (pre) {
        out.push({
          actorName,
          kind: 'prefilter',
          prefilter: pre,
          ...(branchId !== undefined ? { branchId } : {}),
        });
      } else if (ev.error) {
        out.push({
          actorName,
          kind: 'prefilter',
          errorExcerpt: ev.error,
          ...(branchId !== undefined ? { branchId } : {}),
        });
      }
      continue;
    }
    if (ev.role === 'plan') {
      const plan = tryParsePlanPair(ev.response);
      if (plan) {
        out.push({
          actorName,
          kind: 'plan',
          plan,
          ...(branchId !== undefined ? { branchId } : {}),
        });
      } else if (ev.error) {
        out.push({
          actorName,
          kind: 'plan',
          errorExcerpt: ev.error,
          ...(branchId !== undefined ? { branchId } : {}),
        });
      }
      continue;
    }
    if (ev.role === 'fallback-plan') {
      out.push({
        actorName,
        kind: 'fallback-plan',
        errorExcerpt: ev.error,
        ...(branchId !== undefined ? { branchId } : {}),
      });
    }
  }
  return out;
}

interface ToolActivity {
  actorName: string;
  total: number;
  errorCount: number;
  byName: Map<string, { count: number; errors: number }>;
  /** First few chronological invocations kept for the excerpt. */
  sample: Array<{ name: string; args: Record<string, unknown>; error?: string }>;
}

function collectL1ToolUsage(run: VizRun, limit: number): ToolActivity[] {
  const byActor = new Map<string, ToolActivity>();
  for (const ev of run.events) {
    if (!isTool(ev)) continue;
    const actorName = ev.actor?.name ?? '(unknown)';
    // Some tool events come with tier set via classify() echoing the owning
    // LLM call; when the actor tier is missing we still group by name.
    if (ev.actor && ev.actor.tier !== undefined && ev.actor.tier !== 1) {
      continue;
    }
    let entry = byActor.get(actorName);
    if (!entry) {
      entry = {
        actorName,
        total: 0,
        errorCount: 0,
        byName: new Map(),
        sample: [],
      };
      byActor.set(actorName, entry);
    }
    entry.total++;
    const had = entry.byName.get(ev.name) ?? { count: 0, errors: 0 };
    had.count++;
    if (ev.error !== undefined && ev.error !== null) {
      had.errors++;
      entry.errorCount++;
    }
    entry.byName.set(ev.name, had);
    if (entry.sample.length < limit) {
      const entrySample: ToolActivity['sample'][number] = { name: ev.name, args: ev.args };
      if (ev.error !== undefined && ev.error !== null) entrySample.error = ev.error;
      entry.sample.push(entrySample);
    }
  }
  return [...byActor.values()].sort((a, b) => b.total - a.total);
}

function formatArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '{}';
  const pairs = keys.map((k) => {
    const v = args[k];
    if (typeof v === 'string') return `${k}=${JSON.stringify(clip(v, 50))}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
    if (v === null) return `${k}=null`;
    // Arrays / objects: signal presence and size, not full dump.
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    if (typeof v === 'object') return `${k}={${Object.keys(v).length}}`;
    return `${k}=?`;
  });
  return `{${pairs.join(', ')}}`;
}

function formatTierBlock(label: string, entries: TierSummary[]): string[] {
  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push(`${label}: (no planning activity recorded)`);
    return lines;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const header =
      entries.length === 1
        ? `${label} ${e.actorName}`
        : `${label} ${e.actorName}${e.branchId ? ` [branch ${e.branchId.slice(0, 8)}]` : ` [#${i + 1}]`}`;
    if (e.kind === 'prefilter' && e.prefilter) {
      const pre = e.prefilter;
      lines.push(
        pre.kind === 'reuse' && pre.target
          ? `${header} — prefilter ➜ reuse ${pre.target}`
          : `${header} — prefilter ➜ escalate`
      );
      if (pre.reasoning) lines.push(`    reasoning: ${clip(pre.reasoning, 240)}`);
      continue;
    }
    if (e.kind === 'plan' && e.plan) {
      const strat = e.plan.strategy;
      const stratLine = strat
        ? ` (strategy: ${strat.kind}${strat.target ? ` → ${strat.target}` : ''})`
        : '';
      lines.push(`${header} — planned ${e.plan.subtasks.length} subtask(s)${stratLine}`);
      if (e.plan.reasoning) lines.push(`    reasoning: ${clip(e.plan.reasoning, 240)}`);
      if (strat?.reasoning) lines.push(`    strategy reasoning: ${clip(strat.reasoning, 240)}`);
      e.plan.subtasks.forEach((st, idx) => {
        const tail = st.preferredChild ? `  ➜ ${st.preferredChild}` : '';
        lines.push(`    #${idx + 1} ${clip(st.description, 180)}${tail}`);
      });
      continue;
    }
    if (e.kind === 'fallback-plan') {
      lines.push(`${header} — fallback plan (parent self-executed)`);
      if (e.errorExcerpt) lines.push(`    note: ${clip(e.errorExcerpt, 240)}`);
      continue;
    }
    if (e.errorExcerpt) {
      lines.push(`${header} — ${e.kind} (unparseable)`);
      lines.push(`    note: ${clip(e.errorExcerpt, 240)}`);
    } else {
      lines.push(`${header} — ${e.kind} (no usable response)`);
    }
  }
  return lines;
}

function formatToolBlock(entries: ToolActivity[], excerptLimit: number): string[] {
  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push('L1 molecule element usage: (no element invocations recorded)');
    return lines;
  }
  for (const entry of entries) {
    const header = `L1 molecule ${entry.actorName} — ${entry.total} element call(s)${
      entry.errorCount > 0 ? `, ${entry.errorCount} errored` : ''
    }`;
    lines.push(header);
    const byName = [...entry.byName.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [name, stats] of byName) {
      const err = stats.errors > 0 ? ` (${stats.errors} errored)` : '';
      lines.push(`    - ${name} × ${stats.count}${err}`);
    }
    if (entry.sample.length > 0) {
      lines.push(`    first ${entry.sample.length} call(s):`);
      entry.sample.forEach((call, idx) => {
        const marker = call.error ? 'x' : '·';
        lines.push(
          `      ${marker} #${idx + 1} ${call.name} ${formatArgs(call.args)}${
            call.error ? `  !! ${clip(call.error, 80)}` : ''
          }`
        );
      });
      if (entry.total > entry.sample.length) {
        lines.push(`      … ${entry.total - entry.sample.length} more omitted (${excerptLimit} cap)`);
      }
    }
  }
  return lines;
}

export function formatDecompositionReport(
  run: VizRun,
  opts: DecompositionReportOptions = {}
): string {
  const excerptLimit = opts.toolExcerptLimit ?? DEFAULT_TOOL_EXCERPT_LIMIT;
  const l3 = collectTierActivity(run, 3);
  const l2 = collectTierActivity(run, 2);
  const tools = collectL1ToolUsage(run, excerptLimit);

  const lines: string[] = [];
  lines.push('--- decomposition ---');
  lines.push(...formatTierBlock('L3 tissue', l3));
  lines.push('');
  lines.push(...formatTierBlock('L2 cell', l2));
  lines.push('');
  lines.push(...formatToolBlock(tools, excerptLimit));
  return lines.join('\n');
}

/**
 * Post-mortem rendered when a run aborts (timeout or thrown error).
 * Different focus from the decomposition report: that one answers
 * "what did each tier do?" across a clean run, the post-mortem
 * answers "where did the budget go and what was the last failure
 * mode before we gave up?". Designed to be actionable from the
 * terminal alone, so a user can decide their next move (raise the
 * budget, fix a guidance issue, retry) without opening the viz.
 *
 * Sections surfaced:
 *   1. An at-a-glance summary: total tool calls broken down by name,
 *      latest atom active before the abort.
 *   2. The tool call bloat signal: if one tool (typically
 *      validate_html or fetch_url) dominated the budget, call that
 *      out — "40 validate_html calls consumed the budget" is far
 *      more actionable than "timeout at 10min".
 *   3. The last 2 NEGATIVE validator verdicts (the same shape used
 *      by extractBranchDiagnostic) — Haiku's reasoning usually cites
 *      the concrete signal the run couldn't escape (e.g. a 404, a
 *      parse error, a smoke oscillation).
 *
 * Fails silently on missing data — the post-mortem is strictly
 * additive to the existing error-path output; a malformed trace
 * must not mask the original error.
 */
export function formatTimeoutPostMortem(
  run: VizRun,
  opts: { budgetMs: number; isTimeout: boolean }
): string {
  const lines: string[] = [];
  const totalLlm = run.events.filter(isLlm).length;
  const totalTool = run.events.filter(isTool).length;
  lines.push(`== post-mortem ==`);
  lines.push(
    `events captured : ${run.events.length} total — ${totalLlm} LLM call(s), ${totalTool} tool call(s)`
  );

  // Last active atom (most recent event with an actor).
  const lastActive = [...run.events]
    .reverse()
    .find((e) => 'actor' in e && e.actor?.name);
  if (lastActive && 'actor' in lastActive && lastActive.actor) {
    const a = lastActive.actor;
    lines.push(
      `last active agent: ${a.name ?? '?'}` +
        (a.tier !== undefined ? ` (tier ${a.tier})` : '') +
        (lastActive.kind === 'tool' ? ` — last event was a \`${lastActive.name}\` tool call` : '')
    );
  }

  // Tool call dominance: a single tool (validate_html, fetch_url,
  // write_file, etc.) eating most of the budget is the #1 signal of
  // a stuck fix-loop. Surface the top-3 by count.
  const toolCounts = new Map<string, number>();
  for (const ev of run.events) {
    if (!isTool(ev)) continue;
    toolCounts.set(ev.name, (toolCounts.get(ev.name) ?? 0) + 1);
  }
  if (toolCounts.size > 0) {
    const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const domShare = top[0]![1] / totalTool;
    lines.push(
      `tool call bloat : ${top
        .map(([n, c]) => `${n} ×${c}`)
        .join(', ')}` + (domShare >= 0.5 && totalTool >= 5
        ? `  [⚠ ${top[0]![0]} dominated — ${Math.round(domShare * 100)}% of tool budget]`
        : '')
    );
  }

  // Last 2 negative validator verdicts with their reasoning — the
  // concrete rejection Haiku / the fallback validator couldn't
  // escape. Same extraction pattern as extractBranchDiagnostic, but
  // scoped to the whole run rather than a single supervise-loop
  // trace.
  const negVerdicts: Array<{ phase: string; atom: string; reasoning: string }> = [];
  for (let i = run.events.length - 1; i >= 0 && negVerdicts.length < 2; i--) {
    const ev = run.events[i];
    if (!ev || !isLlm(ev)) continue;
    if (ev.role !== 'validate-plan' && ev.role !== 'validate-result') continue;
    const parsed = tryParseVerdict(ev.response);
    if (!parsed || parsed.approved !== false) continue;
    negVerdicts.push({
      phase: ev.role === 'validate-plan' ? 'PLAN' : 'RESULT',
      atom: ev.actor?.name ?? '?',
      reasoning: clip(parsed.reasoning, 400),
    });
  }
  if (negVerdicts.length > 0) {
    lines.push('');
    lines.push('last validator rejections (newest first):');
    for (const v of negVerdicts) {
      lines.push(`  [${v.phase} by ${v.atom}] ${v.reasoning}`);
    }
  }

  // Actionable suggestion bar.
  lines.push('');
  if (opts.isTimeout) {
    lines.push(
      `next steps: (a) raise ATOMA_BUILD_TIMEOUT_MS above ${Math.round(opts.budgetMs / 1000)}s ` +
        `for ambitious tasks; (b) open the viz on this run (npm run viz) to see ` +
        `the exact tool loop that consumed the budget; (c) simplify the task to ` +
        `a smaller first-pass deliverable.`
    );
  } else {
    lines.push(
      `next steps: open the viz on this run (npm run viz) and inspect the last LLM ` +
        `call for the actual parse / validation error.`
    );
  }

  return lines.join('\n');
}

function tryParseVerdict(text: string): { approved: boolean; reasoning: string } | null {
  if (!text || text.trim().length === 0) return null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof obj['approved'] !== 'boolean') return null;
    return {
      approved: obj['approved'],
      reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '',
    };
  } catch {
    return null;
  }
}
