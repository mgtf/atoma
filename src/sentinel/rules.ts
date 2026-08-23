import { createHash } from 'node:crypto';
import type { VizEvent, VizToolEvent } from '../viz/trace.js';

/**
 * THE SENTINEL RULE TABLE.
 * ======================
 * One declarative table, one explicit kind per rule, never an inline `if` —
 * the shape `src/atoms/resultGates.ts` settled on after the same accretion
 * problem. A new incident adds a row; it does not add a philosophy.
 *
 * These rules are PURE functions over a bounded window of trace events. No
 * filesystem, no LLM, no clock of their own, no power: a rule's entire output
 * is a finding, and a finding's entire effect is a journal row. The standing
 * rule that a heuristic flags and never judges alone is why the table cannot
 * express a disposition at all — there is nothing here for it to decide.
 *
 * TWO THINGS THE DESIGN ASSUMED AND THE CODE HAD TO SETTLE:
 *
 * 1. `supervisor-design.md` lists "cumulative cost vs budget" first, but the
 *    product has no per-run cost budget — `Limits` bounds ITERATIONS and the
 *    runner bounds WALL CLOCK. So the rule below is an alert THRESHOLD the
 *    operator configures, and it is named that way. Calling a threshold a
 *    budget would invent a contract that nothing enforces.
 * 2. The sentinel polls a run in flight, so the same anomaly is visible on
 *    every tick. Every finding therefore carries a `dedupeKey`, and the
 *    caller is required to emit each key at most once per run. Without it the
 *    journal would fill with one row per poll and the channel would be
 *    useless within a single run.
 */

/** The two journal kinds the sentinel may write. Nothing else. */
export type SentinelKind = 'run.anomaly' | 'security.flagged';

export interface SentinelFinding {
  readonly ruleId: string;
  readonly kind: SentinelKind;
  /** One line for the journal `summary`. Never carries untrusted content. */
  readonly summary: string;
  /** Bounded structured facts for the journal `detail`. */
  readonly detail: Record<string, unknown>;
  /**
   * Emit-once identity. The caller keeps the set; the rule decides the
   * granularity — once per run for a threshold, once per (tool, digest) for a
   * streak, once per event for a content match.
   */
  readonly dedupeKey: string;
}

export interface SentinelEnv {
  readonly runId: string;
  /** A bounded window of the run's events, oldest first. */
  readonly events: readonly VizEvent[];
  /**
   * Cost at which to raise an alert, in USD, or null to disable the rule.
   * An operator threshold, NOT a budget — nothing refuses to spend past it.
   */
  readonly costAlertUsd: number | null;
}

interface SentinelRule {
  readonly id: string;
  readonly kind: SentinelKind;
  readonly check: (env: SentinelEnv) => SentinelFinding[];
}

/* ─────────────────────────── shared helpers ─────────────────────────── */

function toolEvents(env: SentinelEnv): VizToolEvent[] {
  return env.events.filter((event): event is VizToolEvent => event.kind === 'tool');
}

/** Stable identity of one tool invocation's arguments. */
function argsDigest(event: VizToolEvent): string {
  try {
    return createHash('sha256').update(JSON.stringify(event.args ?? {})).digest('hex').slice(0, 16);
  } catch {
    return 'unserialisable';
  }
}

/**
 * A bounded, neutralised excerpt. Untrusted content reaches an operator's
 * screen through this function and nowhere else: newlines collapse so a
 * payload cannot forge journal structure, and the length is hard-capped well
 * under the journal's own detail limit.
 */
export function excerpt(value: string, max = 200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * How this tool call FAILED, from either place a failure lives.
 *
 * Measured on the cold `web-counter` trace (2026-08-22): 23 tool events, ONE
 * with `event.error` and FOUR with `result.ok === false` — three of them the
 * same pre-flight smoke rejection. Reading only `event.error` is reading the
 * transport's exceptions and missing the tool's own verdict, which is where
 * atoma's elements report almost everything. The rule saw nothing on the run
 * it existed for.
 */
function errorMessages(event: VizToolEvent): string | null {
  if (typeof event.error === 'string' && event.error.trim()) return event.error;
  const result = event.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const row = result as Record<string, unknown>;
  if (row['ok'] !== false) return null;
  const errors = row['errors'];
  if (Array.isArray(errors)) {
    const first = errors.find((entry): entry is string => typeof entry === 'string');
    if (first) return first;
  }
  // A tool that says `ok: false` and nothing else still failed, and a run
  // repeating that is still a pattern worth a row.
  return 'reported ok: false';
}

/** The first `max` characters of every string inside a tool result. */
function resultText(event: VizToolEvent): string {
  if (event.result === undefined) return '';
  try {
    return JSON.stringify(event.result).slice(0, 20_000);
  } catch {
    return '';
  }
}

/* ────────────────────────────── the table ────────────────────────────── */

/** ≥ this many consecutive identical calls is a stall, not a retry. */
export const IDENTICAL_STREAK_THRESHOLD = 4;
/** ≥ this many occurrences of one (tool, error) pair is a pattern. */
export const RECURRING_ERROR_THRESHOLD = 3;
/** A smoke call slower than this AND than the outlier factor is an outlier. */
export const SLOW_TOOL_FLOOR_MS = 30_000;
export const SLOW_TOOL_FACTOR = 3;

const RULES: readonly SentinelRule[] = [
  {
    id: 'cost-alert',
    kind: 'run.anomaly',
    check: (env) => {
      if (env.costAlertUsd === null) return [];
      const spent = env.events.reduce(
        (total, event) => total + (event.kind === 'llm' ? event.costUsd : 0),
        0
      );
      if (spent < env.costAlertUsd) return [];
      return [
        {
          ruleId: 'cost-alert',
          kind: 'run.anomaly',
          summary: `Run passed the ${env.costAlertUsd.toFixed(2)} USD alert threshold`,
          detail: { spentUsd: Number(spent.toFixed(4)), thresholdUsd: env.costAlertUsd },
          // Once per run: a threshold crossed stays crossed.
          dedupeKey: 'cost-alert',
        },
      ];
    },
  },
  {
    id: 'identical-tool-streak',
    kind: 'run.anomaly',
    check: (env) => {
      // The measured pattern (burn-in batch 5): seven calls against one
      // unreachable check. A retry is normal; a byte-identical retry that
      // keeps producing the same nothing is a stall the operator can end.
      const calls = toolEvents(env);
      const out: SentinelFinding[] = [];
      let streakKey: string | null = null;
      let streak = 0;
      let reported = false;
      for (const call of calls) {
        const key = `${call.name}:${argsDigest(call)}`;
        if (key === streakKey) {
          streak += 1;
        } else {
          streakKey = key;
          streak = 1;
          reported = false;
        }
        if (streak >= IDENTICAL_STREAK_THRESHOLD && !reported) {
          reported = true;
          out.push({
            ruleId: 'identical-tool-streak',
            kind: 'run.anomaly',
            summary: `${call.name} called ${streak}× with identical arguments`,
            detail: { tool: call.name, argsDigest: argsDigest(call), streak },
            dedupeKey: `identical-tool-streak:${key}`,
          });
        }
      }
      return out;
    },
  },
  {
    id: 'recurring-tool-error',
    kind: 'run.anomaly',
    check: (env) => {
      const counts = new Map<string, { tool: string; message: string; count: number }>();
      for (const call of toolEvents(env)) {
        const message = errorMessages(call);
        if (!message) continue;
        // Normalised so run-varying detail (ports, temp paths) does not split
        // one recurring failure into several singletons.
        const normalised = excerpt(message.replace(/\d+/g, 'N'), 120);
        const key = `${call.name}:${normalised}`;
        const row = counts.get(key) ?? { tool: call.name, message: normalised, count: 0 };
        row.count += 1;
        counts.set(key, row);
      }
      return [...counts.entries()]
        .filter(([, row]) => row.count >= RECURRING_ERROR_THRESHOLD)
        .map(([key, row]) => ({
          ruleId: 'recurring-tool-error',
          kind: 'run.anomaly' as const,
          summary: `${row.tool} failed ${row.count}× with the same error`,
          detail: { tool: row.tool, count: row.count, error: row.message },
          dedupeKey: `recurring-tool-error:${key}`,
        }));
    },
  },
  {
    id: 'slow-tool-outlier',
    kind: 'run.anomaly',
    check: (env) => {
      // Per tool NAME, because a browser validation and a file read have no
      // shared scale. Needs three samples before it will call anything an
      // outlier — with two, the slower one is always "3× the median".
      const byTool = new Map<string, VizToolEvent[]>();
      for (const call of toolEvents(env)) {
        byTool.set(call.name, [...(byTool.get(call.name) ?? []), call]);
      }
      const out: SentinelFinding[] = [];
      for (const [tool, calls] of byTool) {
        if (calls.length < 3) continue;
        const sorted = [...calls].map((c) => c.durationMs).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        if (median <= 0) continue;
        for (const call of calls) {
          if (call.durationMs < SLOW_TOOL_FLOOR_MS) continue;
          if (call.durationMs < median * SLOW_TOOL_FACTOR) continue;
          out.push({
            ruleId: 'slow-tool-outlier',
            kind: 'run.anomaly',
            summary: `${tool} took ${Math.round(call.durationMs / 1000)}s, ${Math.round(call.durationMs / median)}× its median`,
            detail: { tool, durationMs: call.durationMs, medianMs: median },
            dedupeKey: `slow-tool-outlier:${call.id}`,
          });
        }
      }
      return out;
    },
  },
  {
    id: 'injection-signature',
    kind: 'security.flagged',
    check: (env) => {
      // ELEMENT RESULTS ONLY. That is where content the system did not author
      // enters it: a fetched page, a file written by someone else, a shell
      // command's output. Arguments are model-authored and belong to the
      // anomaly rules, not to this one.
      const out: SentinelFinding[] = [];
      for (const call of toolEvents(env)) {
        const text = resultText(call);
        if (!text) continue;
        for (const signature of INJECTION_SIGNATURES) {
          const match = signature.pattern.exec(text);
          if (!match) continue;
          out.push({
            ruleId: `injection-signature:${signature.id}`,
            kind: 'security.flagged',
            summary: `${signature.id} signature in a ${call.name} result`,
            detail: {
              ruleId: signature.id,
              tool: call.name,
              eventId: call.id,
              // The one place untrusted bytes reach an operator, bounded and
              // flattened. It is evidence to read, never an instruction.
              untrustedExcerpt: excerpt(match[0]),
            },
            dedupeKey: `injection-signature:${signature.id}:${call.id}`,
          });
          break;
        }
      }
      return out;
    },
  },
];

/**
 * Deliberately few, deliberately literal. This is a screen that tells an
 * operator where to look, and `src/skills/scriptScan.ts` already records what
 * happens to a pattern list mistaken for a boundary: 8 of 9 obfuscated
 * payloads passed it. Adding a pattern here buys a look, never a guarantee.
 */
const INJECTION_SIGNATURES: readonly { id: string; pattern: RegExp }[] = [
  {
    id: 'instruction-override',
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  },
  {
    id: 'role-reassignment',
    pattern: /\byou\s+are\s+now\s+(?:a|an|the)\b[^"]{0,60}/i,
  },
  {
    id: 'exfiltration-shaped-url',
    // A URL whose query or body carries something that looks like harvested
    // material. Loopback is excluded: that is the run's own server.
    pattern: /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"']{4,80}[?&](?:data|payload|dump|exfil|token|key)=/i,
  },
  {
    id: 'long-base64-blob',
    pattern: /[A-Za-z0-9+/]{240,}={0,2}/,
  },
];

/**
 * Run every rule over one window. Pure, total, and order-stable: the caller
 * gets findings in table order so a journal reads the same way twice.
 *
 * A rule that throws is contained and skipped: the sentinel is an observer,
 * and one bad regex must not stop the screen that follows it.
 */
export function runSentinelRules(
  env: SentinelEnv,
  onRuleError?: (ruleId: string, error: unknown) => void
): SentinelFinding[] {
  const findings: SentinelFinding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule.check(env));
    } catch (error) {
      onRuleError?.(rule.id, error);
    }
  }
  return findings;
}

/** Rule ids in table order — for tests and for operator-facing listings. */
export function sentinelRuleIds(): string[] {
  return RULES.map((rule) => rule.id);
}

/**
 * The table as DATA, for a reader that wants to show what is being screened
 * for. Ids and kinds only: a rule's prose belongs to the UI catalog, not
 * beside its predicate, and its `check` is not something a reader may hold.
 */
export function sentinelRuleTable(): { id: string; kind: SentinelKind }[] {
  return RULES.map((rule) => ({ id: rule.id, kind: rule.kind }));
}
