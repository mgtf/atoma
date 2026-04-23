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
    if (typeof v === 'object') return `${k}={${Object.keys(v as object).length}}`;
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
    lines.push('L1 tool usage: (no tool invocations recorded)');
    return lines;
  }
  for (const entry of entries) {
    const header = `L1 ${entry.actorName} — ${entry.total} tool call(s)${
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
  lines.push(...formatTierBlock('L3', l3));
  lines.push('');
  lines.push(...formatTierBlock('L2', l2));
  lines.push('');
  lines.push(...formatToolBlock(tools, excerptLimit));
  return lines.join('\n');
}
