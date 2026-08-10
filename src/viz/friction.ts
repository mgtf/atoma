import type { VizRun, VizToolEvent, VizLlmEvent } from './trace.js';
import { eventTokens } from '../skills/events.js';

/**
 * OFFLINE friction report — pure helpers over persisted run traces.
 * ==================================================================
 * Tool-loop friction the L1 recovers from in-loop sits BELOW the learning
 * machinery's event horizon: event-skill learning requires a validator
 * REJECTION and body revision requires an ESCALATION, while recovered
 * friction ends in an approved run and registers nowhere. A runtime sensor
 * was designed and adversarially REJECTED (2026-08-07): of six root-caused
 * friction classes to date, zero were learnable technique — all six were
 * harness/environment defects fixed structurally, and a sensor live during
 * the ESM-leak window would have distilled a permanent workaround skill for
 * a bug that died the next day (see CLAUDE.md, "Considered and rejected").
 *
 * What survives is the DIAGNOSTIC stage: this module reads the traces the
 * viz already persists (every tool invocation, untruncated — the runtime
 * capture point already exists) and aggregates recurring failure
 * signatures, so the next ESM-class leak is spotted after ONE batch instead
 * of by manual trace dredging. It is a READER: zero LLM calls, zero runtime
 * imports, zero effect on any call-count cost guard.
 *
 * KNOWN BLIND SPOTS (documented, accepted): off-scope tool calls under the
 * claude-cli transport never reach an executor (the MCP bridge only
 * registers declared tools) so they produce no VizToolEvent; and
 * deterministic script dispatch calls `ctx.tools.execute` outside any LLM
 * loop, so its friction is invisible here — that path has its own sensor
 * (`directFailures` → demotion).
 */

export interface FrictionEvent {
  readonly runId: string;
  readonly runFile: string;
  readonly tool: string;
  /** hard = the executor threw (is_error tool_result); soft = failure-shaped result. */
  readonly severity: 'hard' | 'soft';
  /** Original error text, bounded. */
  readonly raw: string;
  /** Normalised cross-run grouping key (`tool|normalised-text`). */
  readonly signature: string;
  /** Discriminator argument, for pseudo-recurrence detection. */
  readonly argKey: string;
  readonly runApproved: boolean;
  /** When it happened (ms). Feeds the row's recency, see `lastSeen`. */
  readonly at: number;
}

export interface FrictionRow {
  readonly signature: string;
  readonly tool: string;
  readonly severity: 'hard' | 'soft';
  readonly events: number;
  readonly runs: number;
  readonly approvedRuns: number;
  /**
   * Distinct discriminator args across the row's events. A "recurring"
   * signature whose every event carries a DIFFERENT arg (validate_html's
   * `smoke check failed: false` — one text, N unrelated assertions) is
   * task-intrinsic noise, not a cross-run pattern; this column unmasks it.
   */
  readonly distinctArgs: number;
  readonly families: string[];
  readonly sample: string;
  /** Tokens a future event-skill trigger would need — for manual inspection. */
  readonly triggerTokens: string[];
  /**
   * When this signature was FIRST and LAST seen (ms).
   *
   * Without them the report is a lifetime tally, so a defect fixed weeks ago
   * keeps topping the list and crowds out live signal — measured on the
   * favicon 404, which dominated the first four rows the morning AFTER it was
   * fixed (24 occurrences across 16 pre-fix runs, 0 after). Worse, CLAUDE.md's
   * own action rule is "act only on a signature recurring across two
   * CONSECUTIVE batches", which recency is required to evaluate at all: the
   * rule was there, the data to apply it was not.
   */
  readonly firstSeen: number;
  readonly lastSeen: number;
}

const RAW_CAP = 2000;
const SIGNATURE_CAP = 200;

/**
 * Normalise an error text into a cross-run-stable signature. The key must
 * contain ONLY what is stable across runs (same principle as the prefilter
 * cache key): workspace paths, ports, PIDs, timestamps, line numbers and
 * model-authored log prefixes all vary run to run and must collapse.
 * Refuted-and-fixed cases baked in (2026-08-07 adversarial pass):
 *  - quoted filenames vary per task ("index.html" vs ".atoma-probes.json")
 *    but the failure class is the same → collapse to `"<file.ext>"`,
 *    KEEPING the extension (a .json edit failure and a .html edit failure
 *    may still be worth telling apart);
 *  - single-digit line/column numbers (`:1`) escaped the ≥2-digit rule;
 *  - leading `[SERVER ERR]` / `[server error]` tags are model-authored
 *    harness prefixes, not part of the failure class.
 */
export function frictionSignature(tool: string, text: string): string {
  let s = text.toLowerCase();
  // Leading bracket tags, repeatedly (a line may stack them).
  s = s.replace(/^(\s*\[[^\]]{1,40}\]\s*)+/, '');
  // Quoted filename → "<file.ext>" (extension must start with a letter —
  // same rule as extractResultFilePaths, so "1.0.0" never parses as a file).
  s = s.replace(/"[^"\n]*\.([a-z][a-z0-9]{0,7})"/g, '"<file.$1>"');
  // Paths (absolute, relative, file:// URLs) → basename.
  s = s.replace(/(?:file:\/\/)?(?:[a-z0-9_.-]*\/)+([a-z0-9_.-]+)/g, '$1');
  // Line/column suffixes — single digits included (`test-api.js:1`).
  s = s.replace(/:(\d+)/g, ':#');
  // Long hex runs / UUIDs before the digit rule (mixed hex survives it).
  s = s.replace(/\b[0-9a-f]{8,}\b/g, '#');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '#');
  // Any remaining run of ≥2 digits (ports, sizes, timestamps, versions).
  s = s.replace(/\d{2,}/g, '#');
  s = s.replace(/\s+/g, ' ').trim();
  return `${tool}|${s.slice(0, SIGNATURE_CAP)}`;
}

/** Failure-shaped results per tool. `fetch_url` is deliberately EXCLUDED
 * from the soft tier: non-2xx statuses are overwhelmingly deliberate
 * error-case probes (measured: 40+ intentional 404/400/409 across the
 * burn-in window); it only counts when the executor actually threw. */
function softFailureText(name: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (name === 'fetch_url') return null;
  if (name === 'run_shell') {
    if (typeof r['exitCode'] === 'number' && r['exitCode'] !== 0) {
      const stderr = typeof r['stderr'] === 'string' ? r['stderr'].trim() : '';
      const stdout = typeof r['stdout'] === 'string' ? r['stdout'].trim() : '';
      return stderr || stdout || `exit code ${r['exitCode']}`;
    }
    return null;
  }
  if (r['ok'] === false) {
    const err = typeof r['error'] === 'string' ? r['error'] : '';
    const reason = typeof r['reason'] === 'string' ? r['reason'] : '';
    const errors = Array.isArray(r['errors']) ? r['errors'].map(String).join(' | ') : '';
    return (err || reason || errors || 'ok: false').slice(0, RAW_CAP);
  }
  return null;
}

/**
 * Stringify one tool argument for use as a discriminator.
 *
 * NOT `String(v)`. These args are model-authored, so a field the contract says
 * is a string can arrive as an object — and `String({})` is `'[object
 * Object]'` for every one of them. That collapses N unrelated failures into a
 * single signature and makes `distinctArgs` report 1, which is precisely the
 * pseudo-recurrence that column exists to expose.
 */
function argScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '[uncoercible]';
    }
  }
  // `String()` on a symbol throws under some transpiles and stringifies
  // exotics unhelpfully; the primitives are the only shapes worth keeping.
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '[' + typeof v + ']';
}

/** The argument that discriminates same-text failures from one another. */
function argKeyFor(name: string, args: Record<string, unknown>): string {
  if (name === 'validate_html') return argScalar(args['smoke'] ?? args['url']);
  if (name === 'run_shell') {
    const cmd = argScalar(args['command']);
    const rest = Array.isArray(args['args']) ? args['args'].map(argScalar).join(' ') : '';
    return `${cmd} ${rest}`.trim();
  }
  if (name === 'edit_file' || name === 'read_file' || name === 'write_file') {
    return argScalar(args['path']);
  }
  return JSON.stringify(args).slice(0, 200);
}

/**
 * A run counts as APPROVED when it completed normally AND no validator
 * verdict in its trace rejected — mirroring (in reverse) the conditions
 * `maybeLearnEventSkill` uses to call a run "recovered". `degraded` mirrors
 * its fallback-deliverable exclusion.
 */
export function runWasApproved(run: VizRun): boolean {
  if (!run.endedAt || run.cancelled === true || run.degraded === true) return false;
  if (run.error !== undefined) return false;
  for (const e of run.events) {
    if (!e || typeof e !== 'object' || (e as { kind?: string }).kind !== 'llm') continue;
    const le = e as VizLlmEvent;
    if (le.role !== 'validate-plan' && le.role !== 'validate-result') continue;
    // Tolerant probe, never a full parse — same spirit as the viz's peekJson:
    // degrade to "not a rejection", never guess.
    if (/"approved"\s*:\s*false/.test(le.response ?? '')) return false;
  }
  return true;
}

/** Extract this run's friction events (pure; input is the persisted shape). */
export function extractFrictionEvents(run: VizRun, runFile: string): FrictionEvent[] {
  const approved = runWasApproved(run);
  const out: FrictionEvent[] = [];
  for (const e of run.events) {
    if (!e || typeof e !== 'object' || (e as { kind?: string }).kind !== 'tool') continue;
    const te = e as VizToolEvent;
    let severity: 'hard' | 'soft';
    let raw: string;
    if (te.error !== undefined) {
      severity = 'hard';
      raw = String(te.error).slice(0, RAW_CAP);
    } else {
      const soft = softFailureText(te.name, te.result);
      if (soft === null) continue;
      severity = 'soft';
      raw = soft.slice(0, RAW_CAP);
    }
    out.push({
      runId: run.id,
      runFile,
      tool: te.name,
      severity,
      raw,
      signature: frictionSignature(te.name, raw),
      argKey: argKeyFor(te.name, te.args ?? {}),
      runApproved: approved,
      at: typeof te.ts === 'number' ? te.ts : Date.parse(run.startedAt),
    });
  }
  return out;
}

/** Aggregate events into report rows, most-recurrent first. */
export function computeFrictionRows(
  events: readonly FrictionEvent[],
  familyByRunFile: ReadonlyMap<string, string> = new Map()
): FrictionRow[] {
  const groups = new Map<string, FrictionEvent[]>();
  for (const ev of events) {
    const g = groups.get(ev.signature);
    if (g) g.push(ev);
    else groups.set(ev.signature, [ev]);
  }
  const rows: FrictionRow[] = [];
  for (const [signature, evs] of groups) {
    const first = evs[0]!;
    const runs = new Set(evs.map((e) => e.runId));
    const approvedRuns = new Set(evs.filter((e) => e.runApproved).map((e) => e.runId));
    const families = [
      ...new Set(evs.map((e) => familyByRunFile.get(e.runFile) ?? '?')),
    ].sort();
    rows.push({
      signature,
      tool: first.tool,
      severity: first.severity,
      events: evs.length,
      runs: runs.size,
      approvedRuns: approvedRuns.size,
      distinctArgs: new Set(evs.map((e) => e.argKey)).size,
      firstSeen: Math.min(...evs.map((e) => e.at)),
      lastSeen: Math.max(...evs.map((e) => e.at)),
      families,
      sample: first.raw.slice(0, 160),
      triggerTokens: [...eventTokens(signature)].slice(0, 12),
    });
  }
  rows.sort((a, b) => b.runs - a.runs || b.events - a.events);
  return rows;
}
