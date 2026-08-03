import { Atom, type Peerable, type Supervisor } from '../core/atom.js';
import type {
  GenerationParams,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Tool,
  Verdict,
} from '../core/types.js';
import {
  stripBranchProvenance,
  type AtomRegistry,
  type AtomType,
} from '../registry/atomRegistry.js';
import { modelForTier } from '../core/models.js';
import { L1Atom } from './L1Atom.js';
import {
  type L2Strategy,
  l2StrategySchema,
  parsePayloadTolerant,
  parsePlanWithFallback,
  parseTwoJson,
  parseVerdict,
  planSchema,
} from './json.js';
import { superviseLoop, type SupervisionHooks } from '../core/supervisor.js';
import { forkBranch } from '../core/branchCtx.js';
import { randomUUID } from 'node:crypto';
import { RegistryNotFoundError } from '../core/errors.js';
import { mergeTools } from './toolMerge.js';
import {
  prefilterStrategy,
  shouldTrustSkill,
  shouldTrustType,
  trustedApproval,
  SKILL_PREFILTER_SYSTEM_PROMPT,
  STRATEGY_MAX_TOKENS,
  TaskChildrenMemo,
  TRUST_PROMOTE_THRESHOLD_SUCCESSES,
  promoteThreshold,
  demoteAfter,
  DIRECT_DISPATCH_DEMOTE_AFTER,
  POST_APPROVAL_LLM_TIMEOUT_MS,
} from './cost.js';
import {
  bucketIdForTools,
  CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES,
  extractBranchDiagnostic,
  GROUND_TRUTH_EVIDENCE_LINES,
  PROBE_MANIFEST_FILENAME,
  resolveCreationDescription,
} from './capability.js';
import type { Skill } from '../skills/types.js';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Shared smoke-test design guidance. Appended to every L1 system
 * prompt that the supervisor controls — both the one `createSubtaskL1`
 * emits on fresh-L1 creation and the one `buildNarrowL1Prompt` emits
 * on escalation branches. Keeping this block identical in both paths
 * means a new L1 starts with the same smoke discipline as a branched
 * one: IIFE-only, `window.__test` hooks for state-heavy apps, no
 * simulated-input cargo-culting.
 *
 * Earlier runs ran into two persistent pain points that this block
 * addresses:
 *   (1) smokes written as top-level statements (`const x = ...; x > 0`)
 *       which don't parse inside the tool's `(${smoke})` wrapper and
 *       cost a full Puppeteer round-trip per mistake;
 *   (2) smokes that try to reproduce domain-specific winning paths via
 *       simulated clicks — observed burning 15+ rounds on a chess
 *       puzzle asserting `statusText.includes('Checkmate')` after
 *       random clicks that could not produce a mate.
 */
export const SMOKE_DESIGN_GUIDANCE = [
  `== SMOKE-TEST DESIGN (read carefully — this is where runs go wrong) ==`,
  `The \`smoke\` arg of validate_html is evaluated inside`,
  `  (() => { const __r = (YOUR_CODE); return __r; })()`,
  `so YOUR_CODE must be a pure EXPRESSION. These ALL break parsing:`,
  `    const x = 1; x > 0         // top-level \`const\``,
  `    return x > 0               // top-level \`return\``,
  `    if (cond) { return true }  // top-level \`if\``,
  `Wrap any logic in an IIFE when you need locals or statements:`,
  `    (() => { const x = compute(); return x > 0 })()`,
  `    (function(){ /* ... */ return result })()`,
  ``,
  `== STATE-HEAVY APPS: expose a __test hook, do NOT simulate inputs ==`,
  `For games with rules (chess, minesweeper, roguelikes), for`,
  `multi-step flows (wizards, forms with validation), or for any app`,
  `whose success criterion needs domain-specific knowledge — DO NOT`,
  `try to reproduce the winning path via simulated clicks/keypresses.`,
  `Random clicks on a chess board will never produce a checkmate, and`,
  `the smoke loop will grind for many rounds with the same false`,
  `assertion (observed in production: 15+ wasted Puppeteer rounds`,
  `asserting \`statusText.includes('Checkmate')\` after arbitrary`,
  `clicks).`,
  `Instead, EXPOSE a deterministic test hook from the app code:`,
  `    window.__test = {`,
  `      forceState(scenario) { /* seed the exact position */ },`,
  `      checkInvariant() { /* return bool for the claim you verify */ },`,
  `    };`,
  `Then the smoke becomes trivial and reliable:`,
  `    (() => { window.__test.forceState('mate-in-1-back-rank');`,
  `             return window.__test.checkInvariant(); })()`,
  `The hook is production-harmless (guarded by a flag, or simply`,
  `always-on — it adds <1KB). Validate_html output will also echo`,
  `coaching hints back to you when it rejects a smoke pre-flight or`,
  `detects the same smoke failing repeatedly; read and act on them.`,
  ``,
  `== SMOKE-LOOP DISCIPLINE ==`,
  `If the SAME smoke assertion fails more than twice, STOP retrying`,
  `it — the assertion is structurally unreachable with the current`,
  `inputs. Switch to either: a \`window.__test\` hook (see above), a`,
  `simpler invariant (element exists + renders), OR accept the`,
  `functionality as verified and return your final JSON output.`,
  `Interleaving a trivially-passing sanity smoke between real-retry`,
  `smokes does NOT reset the stuck detector — it is cumulative over`,
  `a sliding window.`,
].join('\n');

/** Kebab-case id check (lowercase letters, digits, single dashes). */
export function isSafeSkillId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length >= 3 && id.length <= 60;
}

/**
 * Parse a Sonnet skill-draft response. The model is instructed to
 * emit ONE JSON object; we tolerate prose-with-fenced-json the
 * same way `extractJson` does for plan parsing. Returns null for
 * unparseable / structurally-incomplete drafts so the caller can
 * skip silently — auto-creation is best-effort.
 *
 * Accepts both `when_to_use` (snake-case, what the prompt asks for)
 * and `whenToUse` (camelCase, in case the model normalises) so a
 * minor naming drift does not throw away the draft.
 */
export interface SkillDraft {
  id: string;
  description: string;
  whenToUse: string;
  body: string;
}

function coerceSkillDraft(obj: Record<string, unknown>): SkillDraft | null {
  const id = typeof obj['id'] === 'string' ? (obj['id'] as string).trim() : null;
  const description =
    typeof obj['description'] === 'string' ? (obj['description'] as string).trim() : null;
  const whenToUseRaw =
    typeof obj['when_to_use'] === 'string'
      ? (obj['when_to_use'] as string)
      : typeof obj['whenToUse'] === 'string'
        ? (obj['whenToUse'] as string)
        : null;
  const whenToUse = whenToUseRaw ? whenToUseRaw.trim() : null;
  const body = typeof obj['body'] === 'string' ? (obj['body'] as string).trim() : null;
  if (!id || !description || !whenToUse || !body) return null;
  return { id, description, whenToUse, body };
}

export function parseSkillDraft(text: string): SkillDraft | null {
  if (!text || text.trim().length === 0) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  return coerceSkillDraft(obj);
}

/**
 * Multi-draft variant used by `learnSkillFromRun`: the primary draft is the
 * top-level object (same contract as `parseSkillDraft`), plus an OPTIONAL
 * standalone verification skill nested under a `"verification"` key — the
 * distillation prompt asks for the split when the run contained a purely
 * MECHANICAL verification sub-workflow. Rationale: monolithic build+verify
 * recipes get refused at promotion time because the build half is
 * irreducible LLM reasoning ("designing bespoke CLI business logic … is an
 * irreducible LLM reasoning step" — Sonnet, on scaffold-node-cli-tool at
 * 5✓), while the verification half alone is exactly what compiles into a
 * deterministic zero-token script. Splitting at LEARN time is what lets the
 * catalog accumulate script-shaped skills at all.
 *
 * Best-effort per draft: a malformed primary does not discard a valid
 * verification draft (and vice versa). A verification draft reusing the
 * primary's id is dropped — two skills may not share a folder.
 */
export function parseSkillDrafts(text: string): SkillDraft[] {
  if (!text || text.trim().length === 0) return [];
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return [];
  }
  const drafts: SkillDraft[] = [];
  const primary = coerceSkillDraft(obj);
  if (primary) drafts.push(primary);
  const nested = obj['verification'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const verification = coerceSkillDraft(nested as Record<string, unknown>);
    if (verification && (!primary || verification.id !== primary.id)) {
      drafts.push(verification);
    }
  }
  return drafts;
}

/**
 * Render a skill body as a context block injected into the L1's
 * effective system prompt. Branch on kind:
 *
 *   - `kind: 'llm'` (default): the body is a recipe of natural-
 *     language steps; the L1 follows them with its normal tool-use
 *     loop. Same shape we've shipped since C2a.
 *
 *   - `kind: 'script'`: the body IS executable code in `language`.
 *     The injected block instructs the L1 to write_file the body
 *     verbatim to a sandbox-local `_skill_<id>.<ext>`, run it via
 *     `run_shell <interpreter> <file> [args...]`, capture stdout,
 *     and return that as its result. Single LLM call + 2 tool
 *     calls regardless of script length — strictly cheaper than
 *     an LLM-driven recipe on tasks whose deliverable is fully
 *     deterministic.
 *
 * The clear delimiters help the model parse "this is a recipe to
 * follow" vs the rest of its prompt, and they also make traces
 * easier to grep when debugging which skill was active on a given
 * run.
 */
export function skillContextBlock(skill: {
  id: string;
  body: string;
  kind?: 'llm' | 'script';
  language?: 'node' | 'python' | 'bash';
}): string {
  if (skill.kind === 'script') {
    if (!skill.language) {
      throw new Error(`skillContextBlock: kind:"script" requires language`);
    }
    const ext = scriptExtension(skill.language);
    const interpreter = skill.language === 'python' ? 'python3' : skill.language;
    const filename = `_skill_${skill.id}.${ext}`;
    return [
      `== ACTIVE SKILL: ${skill.id} (kind: script, language: ${skill.language}) ==`,
      `This skill ships an EXECUTABLE script (below). Your task is NOT to`,
      `interpret the script — it is to RUN IT. Concretely:`,
      ``,
      `  1. The script's CLI argument is the current subtask description as`,
      `     a JSON-encoded string. Pass it verbatim as argv[2].`,
      `  2. write_file ${filename} with the script body VERBATIM (do not`,
      `     edit, summarise, or paraphrase — the body is canonical).`,
      `  3. run_shell { command: "${interpreter}", args: ["${filename}",`,
      `       <JSON.stringify(subtaskDescription)>] }`,
      `  4. Read the run_shell result.`,
      `     - On success: stdout is the script's deliverable. If the LAST`,
      `       non-empty line of stdout parses as a JSON object with`,
      `       {"output", "summary"} fields, RETURN THOSE VERBATIM as your`,
      `       own envelope — do not re-summarise. This preserves the`,
      `       embedded "== GROUND TRUTH ==" block the script emitted, which`,
      `       the supervisor's validator credits as evidence.`,
      `     - If stdout is plain text, wrap it: {"output": "<stdout>",`,
      `       "summary": "ran ${skill.id}; stdout: <first 200 chars>"}.`,
      `     - On error (non-zero exit / stderr non-empty): return the`,
      `       stderr in summary so the supervisor can diagnose.`,
      `  5. DELETE the scratch file once you have its output:`,
      `     run_shell { command: "node", args: ["-e",`,
      `       "require(\\"fs\\").rmSync(process.argv[1],{force:true})",`,
      `       "${filename}"] }`,
      `     It is scaffolding, NOT part of the deliverable — subtasks often end`,
      `     with "list_files to confirm exactly <these files> exist", and a`,
      `     leftover ${filename} makes that check fail.`,
      `  6. Do NOT improvise additional tool calls beyond those. The script`,
      `     body is canonical; your role is to wire CLI args, run it, clean up,`,
      `     and forward its envelope.`,
      ``,
      `== SCRIPT BODY ==`,
      skill.body.trim(),
      ``,
      `== END ACTIVE SKILL ==`,
    ].join('\n');
  }
  return [
    `== ACTIVE SKILL: ${skill.id} ==`,
    `Follow this recipe step-by-step for the current subtask. The recipe was`,
    `learned from prior successful runs and is the FASTEST path to a clean`,
    `result. Deviate only when the subtask explicitly asks for something the`,
    `recipe does not cover.`,
    ``,
    skill.body.trim(),
    ``,
    `== END ACTIVE SKILL ==`,
  ].join('\n');
}

function scriptExtension(language: 'node' | 'python' | 'bash'): string {
  // 'mjs', NEVER bare 'js': the scratch file lands in the WORKSPACE, whose
  // `.js` semantics belong to the deliverable — a task-authored root
  // package.json with `"type": "module"` flipped a `.js` scratch to ESM and
  // a CommonJS script died with "require is not defined in ES module
  // scope" (observed live, triov batch 2026-08-02: two dispatch failures →
  // natural #C4b demotion of a logically sound script). The invariant is
  // the EXPLICIT extension; `.mjs` (over `.cjs`) is the house choice —
  // the repo itself is ESM (`"type": "module"`, NodeNext) and compiled
  // skills follow the same dialect. The compile prompt pins ESM (import,
  // no __dirname); a legacy CommonJS body written to `.mjs` crashes
  // cleanly on first dispatch and the directFailures streak demotes it —
  // the self-healing path covers stragglers.
  if (language === 'node') return 'mjs';
  if (language === 'python') return 'py';
  return 'sh';
}

/**
 * Strict parse of the script-skill stdout contract: the LAST non-empty
 * line must be a JSON object with an `output` field and a string
 * `summary`. Anything else returns null — the deterministic dispatch
 * treats a missing envelope as "script off-contract" and falls back to
 * the LLM loop rather than guessing at a wrap. (The LLM path stays
 * tolerant: `skillContextBlock` tells the L1 how to wrap plain stdout.)
 */
function parseScriptEnvelope(stdout: string): { output: unknown; summary: string } | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const obj = JSON.parse(last) as Record<string, unknown>;
    if (
      obj !== null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      'output' in obj &&
      typeof obj['summary'] === 'string'
    ) {
      // SELF-REPORTED FAILURE GUARD. The deterministic path has no validator
      // downstream (it returns before the supervise loop), so this parse is
      // the ONLY gate between a script's stdout and a result the parent
      // treats as a success — and the exit code cannot be trusted alone:
      // measured on the freshly-promoted `document-cli-from-source`, a run in
      // a workspace without the CLI printed
      //   {"output":null,"summary":"FAILED: index.js ... not found ..."}
      // with EXIT=0, which the old check accepted and then credited with
      // `recordSuccess` — entrenching a broken script at 6/0, 7/0, …
      // A null/absent output or a summary that announces its own failure is
      // therefore treated as OFF-CONTRACT: returning null sends the subtask
      // back through the normal (validated) LLM loop.
      if (obj['output'] === null || obj['output'] === undefined) return null;
      if (/^\s*(FAILED|ERROR)\b/i.test(obj['summary'])) return null;
      return { output: obj['output'], summary: obj['summary'] };
    }
  } catch {
    // not JSON — off-contract
  }
  return null;
}

/**
 * PRE-FLIGHT gate for deterministic dispatch: does this script body even
 * attempt the `{"output", "summary"}` stdout envelope?
 *
 * `parseScriptEnvelope` already catches an off-contract script AFTER the
 * fact — but by then the script has run, and a script written against a
 * different calling convention has already had its side effects. Concrete
 * case: a hand-authored `scaffold-package-json` reads argv positionally
 * (`name`, `version`, `description...`) while direct dispatch passes ONE
 * arg — the JSON-encoded subtask description. Dispatching it writes a
 * `package.json` whose `name` is the whole task sentence, exits 0, prints
 * prose, fails the envelope parse, and hands the LLM loop a workspace
 * already polluted with a bogus artefact.
 *
 * A script that never names `output`/`summary` cannot satisfy the envelope,
 * so refusing to run it costs nothing and skips straight to the (validated)
 * LLM tool-loop path — which handles these scripts correctly, because there
 * the L1 derives the positional args from the subtask itself.
 *
 * Deliberately a cheap token check rather than a parse: false negatives only
 * fall back to the LLM loop (safe), whereas the failure we are closing is a
 * false positive. Keep it that way.
 */
export function scriptDeclaresEnvelope(body: string): boolean {
  return /\boutput\b/.test(body) && /\bsummary\b/.test(body);
}

/**
 * Fresh narrow-responsibility system prompt used when `branchOnEscalation`
 * spawns a new L1 after the parent type couldn't solve a task. The parent
 * is kept intact; the NEW branch gets this prompt written fresh so it
 * doesn't carry forward any domain bias (e.g. "You are Nitrogen, a WebGL
 * platformer builder" bleeding into a dashboard task). The branched
 * atom's rebrandPersona pass at `registry.branch` time will then swap in
 * the branch's actual taxonomy name on the "You are {Name}" line.
 *
 * BUCKET-AWARE: the tool-sequence body is keyed on the child's tool
 * signature. A branch of an HTTP L1 (start_node_server + fetch_url) no
 * longer gets the web/validate_html flow + SMOKE_DESIGN_GUIDANCE —
 * because the guidance taught the model to REACH FOR validate_html as
 * a "smoke primitive" even when the atom's declared tools didn't
 * include it, then the executor happily ran it (observed in the
 * Node/REST run: Helium-branch atoms calling validate_html against a
 * JSON API, result rejection, cascade of escalations). The branch of
 * an HTTP atom now gets the HTTP canonical sequence; the branch of a
 * web atom still gets the validate_html loop + smoke guidance; an
 * unknown-bucket branch falls back to a domain-neutral tools-only
 * template.
 */
export function buildNarrowL1Prompt(
  subtaskDescription: string,
  childTools: readonly Tool[] = [],
  diagnostic: string = ''
): string {
  const header: string[] = [
    `You are an L1 element builder with ONE narrow responsibility.`,
    `Your current subtask: ${subtaskDescription}`,
    ``,
    `Do NOT import assumptions from other domains — the parent type you`,
    `were branched from may have been narrowly specialised for a`,
    `different problem (platformer, minesweeper, HTTP API, etc.);`,
    `IGNORE its domain and focus SOLELY on this subtask as stated.`,
    ``,
  ];
  // Diagnostic injection (#1): when the supervise loop passes us the
  // parent's trace, surface the validator's last rejection reasoning(s)
  // verbatim so the branched L1 knows the CONCRETE fix it has to land
  // (e.g. "GROUND-TRUTH EVIDENCE: validate_html reported 404 on URL"),
  // rather than retrying the whole deliverable from scratch.
  if (diagnostic.length > 0) {
    header.push(`== PRIOR ATTEMPT DIAGNOSIS (act on this, do NOT ignore) ==`);
    header.push(diagnostic);
    header.push(``);
    header.push(
      `Your first move should diagnose and fix the exact issue cited above.`
    );
    header.push(
      `Do NOT rewrite the entire deliverable until you have verified the root`
    );
    header.push(`cause of that specific failure.`);
    header.push(``);
  }

  const bucket = bucketIdForTools(childTools);
  let bucketBody: string[];
  if (bucket === 'http-server-build+probe') {
    // HTTP sequence + LISTENING_ON_PORT contract, mirror of the
    // canonical HTTP L1 prompt (single source of truth).
    bucketBody = [...CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES];
  } else if (bucket === 'web-artefact-build+validate') {
    bucketBody = [
      `Call tools sequentially to produce the deliverable:`,
      `  1. write_file the complete source`,
      `  2. start_static_server to serve it (port 0 = OS-assigned is fine)`,
      `  3. validate_html on the returned URL with appropriate interactions`,
      `     and a smoke check that asserts the key state transitions`,
      `  4. if validation fails: read_file, diagnose, apply the fix with`,
      `     edit_file (exact str_replace — no whole-file rewrite), re-validate.`,
      `     Up to 4 iterations.`,
      `  5. return JSON {"output": <url or summary>, "summary": "<one sentence>"}`,
      ``,
      SMOKE_DESIGN_GUIDANCE,
    ];
  } else {
    // Unknown bucket — keep a generic tools-only template. DO NOT append
    // SMOKE_DESIGN_GUIDANCE here: the smoke discipline is web-bucket
    // specific and leaking it teaches the model to invoke validate_html
    // even when the atom's declared tools don't include it. The generic
    // GROUND-TRUTH evidence contract, however, is bucket-neutral and
    // REQUIRED: without it, non-web/http L1s return narrative-only
    // summaries that the validator correctly rejects as unverifiable
    // (the wc-cli README rejection loop).
    bucketBody = [
      `Call tools sequentially to produce the deliverable. Use ONLY the`,
      `tools you were handed — do NOT invoke anything that isn't in your`,
      `declared tool list.`,
      ``,
      ...GROUND_TRUTH_EVIDENCE_LINES,
    ];
  }

  return [...header, ...bucketBody].join('\n');
}

/**
 * The compile-prompt TEMPLATE, extracted so its GENERATION can be hashed.
 * Any edit to these static lines changes COMPILE_PROMPT_GENERATION, which
 * refusal/demotion stamps record — a stamp from an older generation must NOT
 * keep blocking recompilation, because its premise ("recompiling the same
 * body reproduces the same script") is false once the COMPILER itself
 * evolved. Observed live: the probe-manifest contract landed and a stamped
 * skill needed a manual operator reset to benefit from it.
 */
export function buildCompileSkillPrompt(args: {
  skillId: string;
  skillDescription: string;
  skillWhenToUse: string;
  skillBody: string;
  subTaskDescription: string;
  resultSummary: string;
}): string {
  return [
      `You are PROMOTING a SKILL — a reusable how-to recipe attached to a tier-1`,
      `element — from kind:llm (markdown instructions for the LLM tool-loop) to`,
      `kind:script (a deterministic Node.js program). The L1 atom will execute`,
      `the script via write_file + run_shell on every future match instead of`,
      `re-discovering the steps with an LLM tool-loop. That cuts Haiku`,
      `tool-loop spend on stable patterns to ~zero.`,
      ``,
      `RUNTIME CONTRACT — your script will be invoked as:`,
      `  node _skill_<id>.mjs '<json-encoded-subtask-description>'`,
      `MODULE SEMANTICS — the scratch file is .mjs, so write ESM: import`,
      `built-ins via \`import fs from 'node:fs'\` (never require()). ESM has`,
      `no __dirname/__filename — derive paths from process.cwd(). The .mjs`,
      `extension shields the script from the workspace's own package.json`,
      `(a task-authored "type" field must never change how this script runs).`,
      `i.e. process.argv[2] is a JSON-encoded string carrying the natural-language`,
      `subtask. Your script may parse hints from it (regex / string contains) but`,
      `should mostly rely on the deterministic steps the recipe encodes. The`,
      `script's final stdout MUST be a single JSON line of shape`,
      `{"output": <deliverable>, "summary": "<one sentence including a verbatim`,
      `\\"== GROUND TRUTH ==\\" block as the L1 result-reporting contract requires>"}.`,
      ``,
      `NO TASK-SPECIFIC LITERALS — MANDATORY. The script is reused across every`,
      `future task in its class, so it must DERIVE everything task-specific from`,
      `the workspace and from argv[2]. Never hardcode a filename, an argument`,
      `value, a CLI flag or an expected output that came from the ONE example`,
      `run below. Observed failure: a promoted documentation script carried`,
      `\`invocations = ['node index.js sample.txt']\` from the file-analyzer task`,
      `it was learned on, so a later Caesar-cipher CLI shipped a README whose`,
      `documented examples printed the usage message instead of ciphering —`,
      `and every validator approved it, because the artefact itself was fine.`,
      `Derive invocations by reading the entry file's argument handling and its`,
      `usage string; if you cannot derive them, exit NON-ZERO rather than`,
      `inventing a plausible-looking example. A script that fabricates`,
      `documentation is worse than one that refuses.`,
      ``,
      `INPUT VARIANCE — MANDATORY. Model-authored artefacts the script reads`,
      `(READMEs, docs, configs) vary in formatting between runs: fenced blocks`,
      `vs inline code, "$ " prompt prefixes, prose annotations, different`,
      `heading levels. Extraction logic must tolerate that variance, and a`,
      `command's ARGUMENTS ARE PART OF THE COMMAND — capture the complete`,
      `command line (e.g. the full fenced line), never a prefix truncated at a`,
      `quote or punctuation. Observed failure: a compiled reverify script`,
      `matched commands with a character class that excluded quotes, so`,
      `\`node index.js "Hello World"\` was amputated to \`node index.js\`, four`,
      `documented invocations deduped into one bare command, and the script`,
      `reported a phantom mismatch on a correct deliverable. When extraction`,
      `finds nothing where the recipe expects something, exit NON-ZERO.`,
      ``,
      `PROBE MANIFEST — PREFER MACHINE INPUT OVER PROSE. The workspace may`,
      `contain "${PROBE_MANIFEST_FILENAME}": {"version": 1, "entries": [...]}`,
      `— the record of what earlier phases already executed and verified.`,
      `Entries come in TWO SHAPES and a manifest may MIX them; dispatch on`,
      `the fields present, never assume one shape:`,
      `  SHELL:  {"cmd": "node x.js a", "exitCode": 0, "stdout": "...",`,
      `           "stderr": "..."}         → re-run cmd, compare exit/stdout/stderr`,
      `  HTTP:   {"probe": "http", "method": "GET", "path": "/status",`,
      `           "status": 200, "body": "..."}  → boot the server, request`,
      `           method+path against the bound port, compare status + body`,
      `  WEB:    {"probe": "web", "file": "index.html", "interactions": [...],`,
      `           "smoke": "<expr>", "expected": "<json>", "consoleErrors": 0}`,
      `           → serve the workspace, replay interactions + smoke, compare.`,
      `           NOTE: a compiled script has NO browser tooling, so a WEB`,
      `           entry is verifiable only in the LLM tool-loop (validate_html)`,
      `           — if the recipe's core work is web validation, REFUSE`,
      `           promotion rather than shipping a script that fakes it.`,
      `Skip (do not crash on) any entry whose shape you don't recognise, and`,
      `treat entry ORDER as significant — state-dependent HTTP probes (PUT`,
      `then GET) are recorded in the sequence that made them pass.`,
      `When the recipe involves re-running / verifying / documenting`,
      `invocations, the script MUST read this manifest as its PRIMARY input`,
      `and fall back to prose parsing only when the manifest is absent. Two`,
      `compile generations of prose-parsing verification failed offline`,
      `regression on 6/6 real workspaces — free-form markdown is not a`,
      `parseable interface; the manifest is. A THIRD generation then crashed`,
      `reading \`entry.cmd\` on http-shaped entries (undefined) — hence the`,
      `explicit two-shape contract above. Conversely, when the script itself`,
      `executes and verifies invocations, it MUST write/merge this manifest`,
      `in the matching shape so later passes inherit a machine-readable`,
      `record.`,
      ``,
      `FAILURE SIGNALLING — MANDATORY. There is NO validator downstream of a`,
      `trusted script: whatever you print is taken as the deliverable. So if a`,
      `precondition is missing or a step fails, you MUST:`,
      `  - write the diagnosis to stderr, AND`,
      `  - exit with a NON-ZERO code (process.exit(1)).`,
      `Do NOT print a success-shaped envelope carrying a "FAILED …" summary and`,
      `then exit 0 — the supervisor reads the exit code, and a zero exit means`,
      `"the deliverable is done". Never emit "output": null.`,
      ``,
      `If the recipe has irreducible LLM steps — 'pick the right SQL helpers',`,
      `'design a schema', 'reason about the API shape' — you cannot promote it.`,
      `In that case return {"promotable": false, "reason": "<one sentence>"}.`,
      `Don't force a fragile script just to satisfy the request.`,
      ``,
      `== SKILL ID ==`,
      args.skillId,
      ``,
      `== SKILL DESCRIPTION ==`,
      args.skillDescription,
      ``,
      `== SKILL when_to_use ==`,
      args.skillWhenToUse,
      ``,
      `== CURRENT (kind:llm) BODY ==`,
      args.skillBody,
      ``,
      `== EXAMPLE SUBTASK THAT THIS SKILL JUST HANDLED ==`,
      args.subTaskDescription,
      ``,
      `== EXAMPLE L1 SUMMARY OF THAT RUN ==`,
      args.resultSummary,
      ``,
      `Output ONLY a JSON object — no fences, no preamble, first character "{":`,
      `  Promotable case: {"promotable": true, "language": "node", "body": "<full script source>"}`,
      `  Refusal case:    {"promotable": false, "reason": "<one sentence>"}`,
      `The script body MUST be the COMPLETE source — do not truncate, do not`,
      `paste placeholders. Use only stdlib + the dependencies the recipe`,
      `already names (e.g. better-sqlite3); install via npm at runtime when`,
      `needed; emit LISTENING_ON_PORT=<n> on stdout if you spawn a server.`,
    ].join('\n');
}

/** djb2 over the template rendered with fixed placeholders → 8-hex id. */
function hashGeneration(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const COMPILE_PROMPT_GENERATION = hashGeneration(
  buildCompileSkillPrompt({
    skillId: '_gen_',
    skillDescription: '_gen_',
    skillWhenToUse: '_gen_',
    skillBody: '_gen_',
    subTaskDescription: '_gen_',
    resultSummary: '_gen_',
  })
);

export class L2Atom extends Atom implements Supervisor<L1Atom>, Peerable<L2Atom> {
  readonly tier: Tier = 2;
  readonly model: string;
  readonly validationModel: string;
  readonly peers: L2Atom[] = [];

  private registry: AtomRegistry;
  private pendingStrategy: L2Strategy | null = null;
  private triedChildren = new TaskChildrenMemo();
  /**
   * Optional skill store — when present, every runSubtask runs a
   * skill-prefilter against the resolved L1's skills before entering
   * the supervise loop. The L1's effective system prompt is augmented
   * with the matched skill body via injectContext, and trust counters
   * on the skill are bumped via the onApproved / onFailed hooks. When
   * absent, the supervise loop runs as before — skill matching is
   * strictly opt-in. Threaded from L3.fromType down through
   * L2Atom.fromType so a single SkillRegistry instance is shared
   * across every atom in a run.
   */
  readonly skillRegistry: SkillRegistry | null;

  constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly Tool[];
    params: GenerationParams;
    registry: AtomRegistry;
    peers?: L2Atom[];
    model?: string;
    validationModel?: string;
    skillRegistry?: SkillRegistry | null;
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model ?? modelForTier(2);
    this.validationModel = args.validationModel ?? modelForTier(1);
    this.registry = args.registry;
    this.skillRegistry = args.skillRegistry ?? null;
    if (args.peers) this.peers.push(...args.peers);
  }

  static fromType(
    type: AtomType,
    registry: AtomRegistry,
    peers: L2Atom[] = [],
    skillRegistry: SkillRegistry | null = null
  ): L2Atom {
    if (type.tier !== 2) throw new Error(`L2Atom.fromType requires tier=2`);
    return new L2Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      registry,
      peers,
      skillRegistry,
    });
  }

  addPeer(p: L2Atom): void {
    if (p === this) return;
    if (!this.peers.includes(p)) this.peers.push(p);
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    if (this.isFallbackMode()) {
      return this.selfPlan(task, ctx);
    }

    this.triedChildren.beginTask(task.description);
    const catalog = this.registry.listByTier(1);

    // Prefilter may either short-circuit the plan (single-subtask reuse)
    // or drop a hint that survives into the Sonnet plan call. The
    // "decomposable" flag controls which: if Haiku sees a composite
    // task, it picks a reusable child AND flags the task as needing
    // decomposition — we then fall through to Sonnet with the target
    // as a preferred-child hint, so Sonnet can emit a multi-subtask
    // plan that routes each leaf to the same reused child instead of
    // collapsing the whole task onto one L1 run.
    let prefilterHint: { target: string; reasoning: string } | null = null;
    if (catalog.length > 0) {
      const prefilter = await prefilterStrategy({
        ctx,
        task,
        // Strip the "(branched from X)" provenance tail — it carries no
        // useful signal for routing (the catalog listing already implies
        // the tier) and just pads the prompt with repetitive noise.
        catalog: catalog.map((t) => ({
          name: t.name,
          description: stripBranchProvenance(t.description),
        })),
        exclude: this.triedChildren.excluded(),
        actor: { name: this.name, tier: 2 },
      });
      if (prefilter && prefilter.kind === 'reuse') {
        if (!prefilter.decomposable) {
          this.pendingStrategy = {
            strategy: 'reuse',
            target: prefilter.target,
            reasoning: `prefilter: ${prefilter.reasoning}`,
          };
          this.triedChildren.mark(prefilter.target);
          ctx.logger.debug(
            `[${this.name}] prefilter picked L1 ${prefilter.target}`,
            { reasoning: prefilter.reasoning }
          );
          // Prefilter degenerate case: one subtask, one preferred child.
          // The fan-out loop collapses to a single child run.
          //
          // viaPrefilter=true marks this plan as Haiku-synthesised so the
          // supervisor's validatePlan skips the redundant second Haiku
          // vet on it (see validatePlan + planSchema docs for why).
          return {
            reasoning: `prefilter selected ${prefilter.target}`,
            proposedAction: `delegate leaf task to L1 "${prefilter.target}"`,
            subtasks: [
              {
                description: task.description,
                preferredChild: prefilter.target,
                ...(task.inputs ? { inputs: task.inputs } : {}),
              },
            ],
            aggregation: { mode: 'concat' as const },
            expectedOutput: task.description,
            viaPrefilter: true,
          };
        }
        // Decomposable reuse: fall through to the Sonnet plan with
        // the target as a hint. Do NOT mark triedChildren — the child
        // hasn't been consumed yet, and we want Sonnet to freely set
        // it as preferredChild on the decomposed subtasks.
        prefilterHint = { target: prefilter.target, reasoning: prefilter.reasoning };
        ctx.logger.debug(
          `[${this.name}] prefilter flagged decomposable reuse of ${prefilter.target} — deferring to Sonnet plan`,
          { reasoning: prefilter.reasoning }
        );
      }
    }

    const peerCatalog = this.peers.map((p) => ({ name: p.name, ordinal: p.ordinal }));

    const userContent = [
      `You are atom "${this.name}" (tier 2 / molecule).`,
      ``,
      `HARD RULE: You NEVER execute tools yourself. You do NOT write files, run`,
      `shells, start servers, or validate anything. Your role is to DECOMPOSE the`,
      `task into orthogonal subtasks and route each to an L1 element (the only`,
      `tier that can call tools).`,
      ``,
      `== DECOMPOSITION DISCIPLINE ==`,
      `Split the task into a LIST of subtasks. Each subtask:`,
      `  - has ONE single-responsibility description ("write the HTML layout",`,
      `    "implement game state machine", "start server + run validation")`,
      `  - is ORTHOGONAL to every other subtask — no subtask reads or depends on`,
      `    another subtask's output. Subtasks run in PARALLEL.`,
      `  - targets a specific L1 element via "preferredChild" (required for N>1,`,
      `    optional for N=1 where your strategy field still drives selection).`,
      `A single-responsibility task is still valid: emit a list with exactly ONE`,
      `subtask. Do NOT force decomposition when the task is genuinely atomic.`,
      ``,
      `== AGGREGATION ==`,
      `Pick how the N sub-results combine into one deliverable:`,
      `  - "concat": mechanical array-join (cheap, no extra LLM call). Use when`,
      `    sub-results are independent artefacts or a list is the natural output.`,
      `  - "llm-synthesize": you run one more LLM call to merge the sub-results`,
      `    into a single coherent artefact. Use when the final deliverable is a`,
      `    COMBINED product (e.g. L1s produce layout/logic/render fragments, an`,
      `    aggregation step assembles them into one file). Provide a short`,
      `    "instruction" describing how to merge.`,
      `  - "sequential": phases run ONE AT A TIME on the SAME workspace. Each`,
      `    step receives "previousStepSummary" automatically in its inputs. Use`,
      `    when phases share an evolving artefact (build → extend → smoke). The`,
      `    final phase's output is the deliverable; no extra LLM merge call.`,
      `    Rare at L2 (one L1 usually carries a leaf task end-to-end), but`,
      `    valid when a parent L3 already split into a phase you must yourself`,
      `    chain (e.g. "build artefact then run review"); usually L3 owns this.`,
      ``,
      `== VERIFICATION MATCHES THE ARTEFACT ==`,
      `When a subtask verifies work, its description must name the probe`,
      `matching the deliverable: browser-rendered pages → start_static_server`,
      `+ validate_html; HTTP servers/APIs → start_node_server + fetch_url;`,
      `CLI tools / scripts / configs / docs → run_shell executing the`,
      `artefact (node/npm) plus reading files back. NEVER send a non-browser`,
      `artefact into a serve+validate_html loop — the worker would fabricate`,
      `an index.html just to have something to serve.`,
      ``,
      `== STRATEGY OPTIONS (picks the L1 baseline) ==`,
      `  - "reuse": pick an existing L1 element from the catalog that fits`,
      `  - "create": design a new L1 element and register it (provide a seed)`,
      `  - "mutualize": delegate to a peer L2 molecule when their specialty fits better`,
      `Prefer "reuse" over "create" whenever possible.`,
      ``,
      `CRITICAL — domain-match rule:`,
      `  ONLY "reuse" an L1 whose catalog description matches the task's domain.`,
      `  If the best candidate's description names a DIFFERENT domain than the`,
      `  task (e.g. you need a "dashboard builder" and the candidate is described`,
      `  as a "Mario-like platformer builder"), DO NOT reuse it — even if its`,
      `  toolset is the same and its workflow "looks similar". That atom's system`,
      `  prompt is domain-biased and will fight your task for 5 iterations before`,
      `  escalating. Use "create" with a fresh narrow seed instead. Cross-domain`,
      `  reuse is the #1 failure mode in the training trace.`,
      ``,
      `CRITICAL — "preferredChild" naming rule:`,
      `  - If you set "preferredChild" on a subtask, it MUST be the EXACT name of`,
      `    an L1 already listed in the catalog below. Do NOT invent new names.`,
      `    Do NOT use chemical-element names like "Carbon" or "Oxygen" unless they`,
      `    are literally listed in the catalog.`,
      `  - If none of the existing L1s fit a subtask, OMIT "preferredChild" entirely`,
      `    and set strategy="create" — the supervisor will auto-spawn a fresh L1`,
      `    whose narrow responsibility matches your subtask.description.`,
      `  - Never mix: do not set "preferredChild" to an uncatalogued name "hoping"`,
      `    it will be created. The supervisor does auto-create on miss but you`,
      `    lose the ability to control its description and seed.`,
      ``,
      `L1 catalog (elements):`,
      catalog.length === 0
        ? '  (empty — no elements exist yet; "reuse" is not possible)'
        : catalog.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      // Prefilter hint from the decomposable short-circuit. Haiku has
      // already identified a reusable child but flagged the task as
      // multi-artefact — we preserve that signal so Sonnet sets
      // preferredChild on each leaf subtask instead of picking an
      // unrelated child or minting a new one.
      prefilterHint
        ? [
            `== PREFILTER HINT ==`,
            `A lightweight prefilter identified "${prefilterHint.target}" as the reusable L1`,
            `for the leaf work (${prefilterHint.reasoning}). It also flagged this task as`,
            `decomposable. Prefer setting "preferredChild": "${prefilterHint.target}" on each`,
            `leaf subtask, unless one subtask genuinely needs a different capability — in`,
            `which case still split, but use a different child there.`,
            ``,
          ].join('\n')
        : '',
      `Peer L2 catalog (molecules you can mutualize with):`,
      peerCatalog.length === 0
        ? '  (no peers available)'
        : peerCatalog.map((p) => `  - ${p.name}`).join('\n'),
      ``,
      `Tools the L1 you spawn will inherit automatically (for context only — do`,
      `NOT call them yourself):`,
      this.tools.length === 0
        ? '  (none)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n'),
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `CRITICAL OUTPUT FORMAT: your entire response MUST be exactly one JSON array`,
      `of TWO objects, with no prose before or after, no markdown fences, no tool calls.`,
      `Shape:`,
      `[`,
      `  {"strategy": "reuse"|"create"|"mutualize", "target": "<name>"?, "seed"?: {"description": "...", "systemPrompt": "...", "tools": [], "params": {}}, "reasoning": "..."},`,
      `  {"reasoning": "...", "subtasks": [{"description": "...", "preferredChild": "<L1-name>"?, "inputs": {}?}, ...], "aggregation": {"mode": "concat"|"llm-synthesize"|"sequential", "instruction": "..."?}, "expectedOutput": "..."}`,
      `]`,
      `The first character of your response MUST be "[". Do NOT call any tools.`,
    ]
      .filter(Boolean)
      .join('\n');

    // L2 is a pure reasoning / routing tier: no executor, no tool declarations.
    // Only L1 may actually execute tools. Cap output at STRATEGY_MAX_TOKENS —
    // the response is a routing JSON pair, not content.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: STRATEGY_MAX_TOKENS, effort: 'medium' },
      signal: ctx.signal,
    });

    const pair = parseTwoJson(resp.text);
    this.pendingStrategy = l2StrategySchema.parse(pair[0]);
    const plan = planSchema.parse(pair[1]);
    return plan;
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    if (this.isFallbackMode()) {
      return this.selfExecute(task, plan, ctx);
    }

    const strategy = this.pendingStrategy;
    this.pendingStrategy = null;
    if (!strategy) {
      return this.selfExecute(task, plan, ctx);
    }

    if (strategy.strategy === 'mutualize') {
      const peer = this.peers.find((p) => p.name === strategy.target);
      if (!peer) throw new RegistryNotFoundError(strategy.target ?? 'unknown peer');
      return peer.handleDirect(task, ctx);
    }

    const subtasks = plan.subtasks;
    const subResults = await this.dispatchSubtasks(subtasks, plan, strategy, task, ctx);
    return this.aggregate(subResults, plan.aggregation, task, ctx);
  }

  /**
   * Mirror of L3Atom.dispatchSubtasks. See that comment for the full
   * rationale; the logic is identical at this tier — sequential phases
   * thread `previousStepSummary` into each next subtask's `inputs`,
   * concat / llm-synthesize fan out via Promise.all. Hooks are created
   * INSIDE runSubtask (after the skill prefilter attempt) so they know
   * whether a skill drove the run — that info gates the C3 skill
   * auto-creation path on the onApproved hook.
   */
  private async dispatchSubtasks(
    subtasks: readonly Plan['subtasks'][number][],
    plan: Plan,
    strategy: L2Strategy,
    task: Task,
    ctx: RunContext
  ): Promise<Result[]> {
    if (plan.aggregation.mode === 'sequential') {
      const out: Result[] = [];
      let previousSummary: string | undefined;
      for (let idx = 0; idx < subtasks.length; idx++) {
        const baseSubtask = subtasks[idx]!;
        const subtask = previousSummary !== undefined
          ? {
              ...baseSubtask,
              inputs: {
                ...(baseSubtask.inputs ?? {}),
                previousStepSummary: previousSummary,
                previousStepIndex: idx - 1,
              },
            }
          : baseSubtask;
        const r = await this.runSubtask({ subtask, strategy, parentTask: task, idx, ctx });
        out.push(r);
        previousSummary = r.summary;
      }
      return out;
    }
    return Promise.all(
      subtasks.map((subtask, idx) =>
        this.runSubtask({ subtask, strategy, parentTask: task, idx, ctx })
      )
    );
  }

  /**
   * Run one subtask through a supervise-loop on the appropriate L1 child.
   * Child resolution order:
   *   1. subtask.preferredChild → registry lookup (must exist)
   *   2. degenerate single-subtask fan-out → fall back to the strategy
   *      resolved at plan-time (reuse/create)
   *   3. multi-subtask fan-out without preferredChild → error (the
   *      planner is expected to label each subtask with its target L1)
   */
  private async runSubtask(args: {
    subtask: Plan['subtasks'][number];
    strategy: L2Strategy;
    parentTask: Task;
    idx: number;
    ctx: RunContext;
  }): Promise<Result> {
    const { subtask, strategy, parentTask, idx, ctx } = args;
    const l1Type = this.resolveL1ForSubtask(subtask, strategy, parentTask, idx, ctx);
    this.triedChildren.mark(l1Type.name);
    const l1 = L1Atom.fromType(l1Type);
    const subTask: Task = subtask.inputs
      ? { description: subtask.description, inputs: subtask.inputs }
      : { description: subtask.description };

    // Skill prefilter (C2a). When a SkillRegistry is wired and the
    // child has at least one persisted skill, run a Haiku
    // prefilter call against the skill catalog. If it picks one
    // with high confidence, inject the skill body into the L1's
    // effective system prompt via injectContext and tag the
    // instance via setActiveSkill so the hooks can bump the
    // skill's own trust counters on approve / fail.
    //
    // Skill prefilter REUSES `prefilterStrategy` from cost.ts so
    // the prompt + caching + confidence-guard semantics stay
    // identical to the existing tier prefilter — the only change
    // is the catalog (skills instead of children).
    let skillMatchAttempted = false;
    if (this.skillRegistry) {
      skillMatchAttempted = true;
      const skills = await this.matchSkill(l1Type.name, subTask, ctx);
      if (skills) {
        ctx.logger.debug(
          `[${this.name}] skill matched: ${skills.skill.id} (kind=${skills.skill.kind}; ${skills.reasoning})`
        );
        ctx.recordSkill?.({
          op: 'match',
          l1Name: l1Type.name,
          skillId: skills.skill.id,
          actorName: this.name,
          actorTier: 2,
          reasoning: skills.reasoning,
        });

        // Deterministic dispatch (#C4). A TRUSTED `kind: 'script'` skill
        // (3+ clean runs, zero failures — every freshly promoted script
        // qualifies since promotion requires 5/0) is executed DIRECTLY
        // via write_file + run_shell: zero LLM calls, no L1 plan/execute,
        // no validators. The script's exit code + envelope contract
        // ({"output", "summary"} as the last stdout line) IS the ground
        // truth. Any deviation — non-zero exit, missing envelope, tool
        // error — falls through to the normal inject-and-supervise path
        // below, so the fast-path can never make a run fail that the LLM
        // loop would have saved. Kill switch: ATOMA_SKILL_DIRECT=0.
        if (
          skills.skill.kind === 'script' &&
          shouldTrustSkill(skills.skill) &&
          ctx.tools &&
          process.env['ATOMA_SKILL_DIRECT'] !== '0'
        ) {
          const direct = await this.runScriptSkillDirect(
            skills.skill,
            l1Type.name,
            subTask,
            ctx
          );
          if (direct) return direct;
        }

        l1.injectContext(
          skillContextBlock({
            id: skills.skill.id,
            body: skills.skill.body,
            kind: skills.skill.kind,
            ...(skills.skill.language ? { language: skills.skill.language } : {}),
          })
        );
        l1.setActiveSkill(skills.skill.id);
        // Match + inject are emitted as a paired event sequence so the
        // viz can render either the match decision alone (rare) or the
        // full inject side-effect (common). Keeping them separate also
        // lets a future replay engine elide the inject if it wants to
        // re-run the model with a fresh body.
        ctx.recordSkill?.({
          op: 'inject',
          l1Name: l1Type.name,
          skillId: skills.skill.id,
          actorName: this.name,
          actorTier: 2,
          reasoning: `kind=${skills.skill.kind}${skills.skill.language ? `; language=${skills.skill.language}` : ''}`,
        });
      }
    }

    // Hooks are built HERE (after the match attempt) so the
    // onApproved hook can decide whether to run the C3 skill-
    // learning path: only fire when the prefilter saw skills but
    // none matched, AND the env flag is on, AND the run succeeded
    // without escalation.
    const hooks = this.makeL1Hooks(ctx, subtask.description, {
      l1Name: l1Type.name,
      subTask,
      skillMatchAttempted,
    });

    // Fork a branch-scoped ctx so every LLM/tool/trust event recorded
    // inside this supervise loop carries a unique branchId. Viz renders
    // each branch as its own lane instead of interleaving them.
    const branchCtx = forkBranch(ctx, randomUUID());
    return superviseLoop<L1Atom>(this, l1, subTask, branchCtx, hooks);
  }

  /**
   * Distill a successful run into a new skill (#3). Called from the
   * onApproved hook when ATOMA_SKILL_LEARN is on, the L1 had no
   * skill matched at prefilter time, and the supervise loop
   * approved the result without escalation. We ask Sonnet to
   * extract a kebab-case skill id, a short description, an
   * activation hint, and a body — all designed to feed back into
   * the skill prefilter on the NEXT run on a similar task.
   *
   * Guardrails:
   *  - Pre-existing skill with the same id: SKIP. The original
   *    skill carries its own trust counters and possibly hand-edits;
   *    auto-creation must not clobber it.
   *  - Malformed JSON: warn + skip. The run is already approved;
   *    the failure to learn isn't a run failure.
   *  - id sanity check: kebab-case, alphanum + dash only. Anything
   *    else is rejected to keep the on-disk filesystem layout safe.
   */
  private async learnSkillFromRun(args: {
    l1Name: string;
    subTask: Task;
    result: Result;
    child: L1Atom;
    ctx: RunContext;
  }): Promise<void> {
    if (!this.skillRegistry) return;
    const userContent = [
      `You are distilling a successful run into a reusable SKILL — a markdown`,
      `recipe attached to a tier-1 element so future runs on a similar task can`,
      `follow it instead of re-discovering the steps.`,
      ``,
      `An L1 element just completed a subtask without escalation. Look at the`,
      `subtask description and the L1's summary, infer the GENERAL PATTERN, and`,
      `output a skill draft.`,
      ``,
      `== L1 ATOM ==`,
      `${args.child.name} (tier 1)`,
      ``,
      `== SUBTASK THAT WAS COMPLETED ==`,
      args.subTask.description,
      ``,
      `== L1 SUMMARY OF WHAT IT DID ==`,
      args.result.summary,
      ``,
      `Output ONLY a JSON object — no fences, no preamble. The first character`,
      `must be "{". Required fields:`,
      `  "id":            kebab-case identifier, 3-6 words, like "write-package-json".`,
      `  "description":   one-line summary, ≤90 chars.`,
      `  "when_to_use":   one-line activation hint, ≤140 chars. Should describe`,
      `                   the SHAPE of the matching task, not its specific theme.`,
      `  "body":          markdown recipe, ≤500 chars total. Concrete steps the`,
      `                   L1 should take, NOT prose. Example shape:`,
      `                     "1. write_file <name>.\\n2. start_static_server.\\n3. validate_html with smoke."`,
      ``,
      `THE BODY MUST GENERALISE. Every step describes what to do for the CLASS of`,
      `task, using PLACEHOLDERS (<entry>, <file>, <arg>) for anything specific to`,
      `THIS run. Never copy a concrete filename, argument value, flag or expected`,
      `output out of the run above. Where a step needs a task-specific value, say`,
      `how to DERIVE it ("read the entry file's usage string to get its real`,
      `arguments"), not what it happened to be this time.`,
      `Observed failure: a documentation recipe learned on a file-analyzer task`,
      `kept the literal step "run node index.js sample.txt", so a later`,
      `Caesar-cipher CLI shipped a README documenting an invocation that just`,
      `prints the usage message — and it passed every validator, because the`,
      `artefact itself was fine.`,
      ``,
      `== OPTIONAL SECOND SKILL: SPLIT OUT MECHANICAL VERIFICATION ==`,
      `If the run included a verification sub-workflow that is purely MECHANICAL`,
      `— running the artefact's real invocations, comparing exit codes / stdout /`,
      `stderr against what is documented or expected, reading files back — ALSO`,
      `emit it as a standalone skill under a "verification" key on the same JSON`,
      `object (same four fields, a DIFFERENT id). Verification recipes are the`,
      `ones that can later compile into deterministic zero-cost scripts, but only`,
      `if they carry no design steps: every step must be DERIVABLE from the`,
      `workspace alone (the entry file, invocations documented in the README,`,
      `fixture files present on disk). Do NOT emit "verification" when checking`,
      `was a single trivial read-back, or when it cannot be described without`,
      `design judgment. The primary skill keeps its own inline verification`,
      `steps regardless — the split copy is the standalone, reusable version.`,
      ``,
      `Skip the JSON entirely (return empty) if the run was too task-specific to`,
      `generalise (e.g. it depended on hard-coded numbers a future run wouldn't`,
      `share).`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      // 1600, not 800: the optional verification split can double the JSON,
      // and on 5-series models adaptive thinking shares this cap with the
      // response — a truncated draft is a silently lost learning event.
      params: { ...this.params, maxTokens: 1600, temperature: 0 },
      // Post-approval bookkeeping: own budget, never the run deadline.
      signal: AbortSignal.timeout(POST_APPROVAL_LLM_TIMEOUT_MS),
    });
    const drafts = parseSkillDrafts(resp.text);
    if (drafts.length === 0) {
      args.ctx.logger.debug(
        `[${this.name}] skill draft did not parse, skipping; raw=${resp.text.slice(0, 120)}`
      );
      return;
    }
    // Guards apply PER DRAFT: a bad primary must not discard a good
    // verification skill, and vice versa. The existence check re-reads the
    // registry inside the loop so a duplicate id later in the same response
    // hits the no-overwrite guard like any other duplicate.
    for (const draft of drafts) {
      if (!isSafeSkillId(draft.id)) {
        args.ctx.logger.warn(
          `[${this.name}] skill auto-creation rejected: unsafe id "${draft.id}"`
        );
        continue;
      }
      const existing = this.skillRegistry.loadFor(args.l1Name).find((s) => s.id === draft.id);
      if (existing) {
        args.ctx.logger.debug(
          `[${this.name}] skill ${draft.id} already exists for ${args.l1Name}, not overwriting`
        );
        continue;
      }
      this.skillRegistry.save(args.l1Name, {
        id: draft.id,
        description: draft.description,
        whenToUse: draft.whenToUse,
        kind: 'llm',
        body: draft.body,
      });
      args.ctx.logger.info(
        `[${this.name}] learned new skill "${draft.id}" for ${args.l1Name}`
      );
      args.ctx.recordSkill?.({
        op: 'learn',
        l1Name: args.l1Name,
        skillId: draft.id,
        actorName: this.name,
        actorTier: 2,
        reasoning: draft.description,
      });
    }
  }

  /**
   * Generate an improved skill body via a Sonnet call (this.model).
   * Inputs:
   *   - the failing skill's current body,
   *   - the verbatim validator diagnosis (extractBranchDiagnostic
   *     output) explaining WHY the prior run was rejected,
   *   - the subtask description.
   *
   * The model is instructed to produce a TARGETED revision — fix
   * the cited failure, keep the rest of the recipe stable, do not
   * balloon the length. Output is plain markdown; we trim and
   * return the raw text. A blank or whitespace-only response
   * returns null so the caller can fall back to the legacy branch
   * path instead of saving an empty body.
   *
   * Sonnet (this.model) is the right model here:
   *  - the task is real reasoning (synthesise a fix from a
   *    diagnostic), not yes/no validation;
   *  - Haiku would routinely flatten the body or miss the precise
   *    diagnostic detail;
   *  - Opus would be overkill for the bounded context.
   */
  private async improveSkillBody(args: {
    skill: import('../skills/types.js').Skill;
    diagnostic: string;
    subtaskDescription: string;
    ctx: RunContext;
  }): Promise<string | null> {
    const userContent = [
      `You are revising a SKILL — a reusable how-to recipe attached to a tier-1 element.`,
      `The skill drove a recent run that the supervisor REJECTED. Your job: produce an`,
      `IMPROVED body for the skill that fixes the specific failure, while keeping the`,
      `skill applicable to its general task class. Do NOT rewrite the whole recipe.`,
      ``,
      `== SKILL ID ==`,
      args.skill.id,
      ``,
      `== SKILL DESCRIPTION ==`,
      args.skill.description,
      ``,
      `== CURRENT SKILL BODY ==`,
      args.skill.body,
      ``,
      `== SUBTASK THAT TRIGGERED THE FAILURE ==`,
      args.subtaskDescription,
      ``,
      `== VALIDATOR DIAGNOSIS ==`,
      args.diagnostic,
      ``,
      `KEEP IT GENERAL. The body is reused across the whole CLASS of task, so use`,
      `PLACEHOLDERS (<entry>, <file>, <arg>) for anything specific to the run that`,
      `just failed, and never bake in a concrete filename, argument value or`,
      `expected output. Where a step needs a task-specific value, say how to DERIVE`,
      `it rather than what it was this time. Fixing one run by hardcoding its`,
      `details breaks every later task in the class.`,
      ``,
      `Output ONLY the new skill body as plain markdown — no JSON envelope, no fences,`,
      `no preamble. Aim for the same length as the current body, slightly longer at most.`,
      `If the current body already addresses the diagnosis correctly and the failure was`,
      `due to something the recipe cannot fix (e.g. environment issue), return the body`,
      `unchanged.`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: { ...this.params, maxTokens: 1500, temperature: 0 },
      signal: args.ctx.signal,
    });
    const text = (resp.text ?? '').trim();
    if (!text) return null;
    return text;
  }

  /**
   * Try to PROMOTE a `kind: 'llm'` skill to `kind: 'script'` after a
   * successful run. The eligibility gate runs first (cheap local
   * check); only if it passes do we make the Sonnet compile call. The
   * compile asks the model to either produce a deterministic Node
   * script body OR refuse with a reason. On a clean compile we call
   * `registry.promoteToScript` which stashes the original llm body in
   * `_fallback.md` so demotion can restore it.
   *
   * The trigger condition is `successes >= TRUST_PROMOTE_THRESHOLD &&
   * failures === 0 && kind === 'llm'`. The `failures === 0` clause
   * also blocks RE-promotion after a demotion (which bumps `failures`
   * via `recordFailure` upstream), so a script that broke and got
   * rolled back doesn't immediately get re-compiled on the next
   * success — the operator has to reset the counter to invite
   * another attempt.
   *
   * Cost: ONE Sonnet call (~$0.01) per promotion attempt. If the model
   * declines (returns `promotable: false`), no script is saved and the
   * skill stays as `kind: 'llm'`. We do NOT retry on the next success
   * either — the eligibility gate (`successes >= threshold`) keeps
   * firing forever once the threshold is crossed, so to prevent
   * Sonnet-call thrash on un-promotable skills we mark the attempt in
   * a sidecar `_meta.json` field. Future runs see it and skip.
   */
  private async tryPromoteSkill(args: {
    l1Name: string;
    skillId: string;
    subTask: Task;
    result: Result;
    ctx: RunContext;
  }): Promise<void> {
    if (!this.skillRegistry) return;
    if (process.env['ATOMA_SKILL_PROMOTE'] !== '1') return;
    const skills = this.skillRegistry.loadFor(args.l1Name);
    const skill = skills.find((s) => s.id === args.skillId);
    if (!skill) return;
    if (skill.kind !== 'llm') return;
    if (skill.failures > 0) return;
    if (skill.successes < promoteThreshold()) return;
    if (skill.promotionRefusedAt && skill.promotionRefusedGeneration !== COMPILE_PROMPT_GENERATION) {
      // The stamp predates the CURRENT compiler. Its premise ("recompiling
      // this body reproduces the same script") is false once the compile
      // prompt itself changed, so give the evolved compiler exactly one
      // shot — this is what used to require a manual operator reset when a
      // new contract (e.g. the probe manifest) landed.
      args.ctx.logger.info(
        `[${this.name}] skill "${args.skillId}" refusal stamp is from an older compile-prompt generation (${skill.promotionRefusedGeneration ?? 'legacy'} → ${COMPILE_PROMPT_GENERATION}); retrying the compile`
      );
      this.skillRegistry.clearPromotionRefusal(args.l1Name, args.skillId);
    } else if (skill.promotionRefusedAt) {
      // Sonnet already declined to compile this body. Skip the call
      // until the body changes (which clears the stamp via save) or
      // the operator manually clears it. Without this gate every
      // future success on a structurally non-promotable skill burns
      // ~$0.005 (1 Sonnet call returning the same refusal).
      args.ctx.logger.debug(
        `[${this.name}] skill "${args.skillId}" promotion previously refused at ${skill.promotionRefusedAt}; skipping`
      );
      return;
    }
    args.ctx.logger.info(
      `[${this.name}] skill "${args.skillId}" eligible for promotion (${skill.successes} successes / 0 failures); attempting compile`
    );
    let compiled: { promotable: true; language: 'node'; body: string } | { promotable: false; reason: string };
    try {
      compiled = await this.compileSkillToScript({
        skill,
        subTask: args.subTask,
        result: args.result,
        ctx: args.ctx,
      });
    } catch (err) {
      args.ctx.logger.warn(
        `[${this.name}] skill compile errored: ${(err as Error).message}; leaving as kind:llm`
      );
      return;
    }
    if (!compiled.promotable) {
      args.ctx.logger.info(
        `[${this.name}] skill "${args.skillId}" not promotable: ${compiled.reason}`
      );
      // Stamp the refusal so the gate above short-circuits on every
      // subsequent success until the body changes. This is the
      // anti-thrash guard: in the LoL-SSR run we observed Sonnet
      // refuse a structurally non-promotable recipe (schema design,
      // API shape choice) — we don't want to pay $0.005 to learn
      // the same fact on every future success of the same recipe.
      this.skillRegistry.markPromotionRefused(
        args.l1Name,
        args.skillId,
        compiled.reason,
        COMPILE_PROMPT_GENERATION
      );
      args.ctx.recordSkill?.({
        op: 'promote',
        l1Name: args.l1Name,
        skillId: args.skillId,
        actorName: this.name,
        actorTier: 2,
        reasoning: `refused: ${compiled.reason}`,
      });
      return;
    }
    this.skillRegistry.promoteToScript({
      l1Name: args.l1Name,
      skillId: args.skillId,
      language: compiled.language,
      scriptBody: compiled.body,
      compiledGeneration: COMPILE_PROMPT_GENERATION,
    });
    args.ctx.logger.info(
      `[${this.name}] skill "${args.skillId}" promoted to kind:script (${compiled.language}, ${compiled.body.length} chars)`
    );
    args.ctx.recordSkill?.({
      op: 'promote',
      l1Name: args.l1Name,
      skillId: args.skillId,
      actorName: this.name,
      actorTier: 2,
      reasoning: `compiled to ${compiled.language} after ${skill.successes} successes`,
    });
  }

  /**
   * Sonnet compile of a `kind: 'llm'` recipe into a parameterised Node
   * script. Returns either a script body the L1 can run via
   * write_file + run_shell with a JSON-encoded subtask description as
   * argv[2], OR a refusal with a reason (when the recipe has
   * branching that doesn't reduce cleanly to deterministic steps).
   *
   * The prompt deliberately includes the most recent successful
   * subtask + result summary as a CONCRETE example: gives the model
   * the actual shape of inputs the script will see at runtime, so it
   * doesn't over-generalise the parameter surface.
   */
  private async compileSkillToScript(args: {
    skill: import('../skills/types.js').Skill;
    subTask: Task;
    result: Result;
    ctx: RunContext;
  }): Promise<
    | { promotable: true; language: 'node'; body: string }
    | { promotable: false; reason: string }
  > {
    const userContent = buildCompileSkillPrompt({
      skillId: args.skill.id,
      skillDescription: args.skill.description,
      skillWhenToUse: args.skill.whenToUse,
      skillBody: args.skill.body,
      subTaskDescription: args.subTask.description,
      resultSummary: args.result.summary,
    });

    const resp = await args.ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      // `effort: 'medium'` is load-bearing on the claude-cli transport,
      // where maxTokens is advisory-only: at the default 'high' a compile
      // ran ~7 minutes / ~20k thinking+output tokens through the subprocess
      // and was killed by the run deadline twice (rehearsal runs 4 and 5).
      params: { ...this.params, maxTokens: 4000, temperature: 0, effort: 'medium' },
      // Post-approval bookkeeping: own budget, never the run deadline.
      signal: AbortSignal.timeout(POST_APPROVAL_LLM_TIMEOUT_MS),
    });
    const raw = (resp.text ?? '').trim();
    if (!raw) return { promotable: false, reason: 'empty model response' };
    let parsed: unknown;
    try {
      // Tolerate surrounding fences just in case Sonnet wraps despite
      // the explicit instruction.
      const stripped = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      parsed = JSON.parse(stripped);
    } catch {
      return { promotable: false, reason: 'malformed JSON in compile response' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { promotable: false, reason: 'compile response was not an object' };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj['promotable'] === false) {
      return {
        promotable: false,
        reason: typeof obj['reason'] === 'string' ? obj['reason'] : 'unspecified',
      };
    }
    if (obj['promotable'] !== true) {
      return { promotable: false, reason: 'compile response missing promotable=true|false' };
    }
    const language = obj['language'];
    const body = obj['body'];
    if (language !== 'node' || typeof body !== 'string' || body.trim().length === 0) {
      return {
        promotable: false,
        reason: `compile response has invalid language=${String(language)} or empty body`,
      };
    }
    return { promotable: true, language: 'node', body };
  }

  /**
   * Run a Haiku skill-prefilter for the L1 named `l1Name` and the
   * given subtask. Returns the matched skill + the model's reasoning
   * when a confident match exists, null otherwise (no skills, no
   * registry, or prefilter escalated). The prefilter reuses the tier
   * prefilter MACHINERY (schema + low-confidence guard) but with the
   * dedicated SKILL_PREFILTER_SYSTEM_PROMPT — the atom-catalog prompt
   * carries a HARD RULE against single-candidate force-matching that
   * made Haiku escalate on one-skill catalogs, which both lost the
   * injection AND triggered a redundant Sonnet learn call for a
   * pattern that was already on disk.
   *
   * The injected userContent labels each catalog entry as
   * "<skillId>: <description>. When to use: <whenToUse>" so Haiku
   * sees BOTH the capability summary and the activation hint.
   */
  private async matchSkill(
    l1Name: string,
    subTask: Task,
    ctx: RunContext
  ): Promise<{ skill: Skill; reasoning: string } | null> {
    if (!this.skillRegistry) return null;
    const skills = this.skillRegistry.loadFor(l1Name);
    if (skills.length === 0) return null;
    const outcome = await prefilterStrategy({
      ctx,
      task: subTask,
      catalog: skills.map((s) => ({
        name: s.id,
        description: `${s.description}. When to use: ${s.whenToUse}`,
      })),
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
      actor: { name: this.name, tier: 2 },
    });
    if (!outcome || outcome.kind !== 'reuse') return null;
    const matched = skills.find((s) => s.id === outcome.target);
    if (!matched) return null;
    return { skill: matched, reasoning: outcome.reasoning };
  }

  /**
   * #C4 — deterministic dispatch of a trusted `kind: 'script'` skill.
   *
   * Mirrors the exact calling convention `skillContextBlock` teaches the
   * L1 (same filename, same interpreter, same argv[2] = JSON-encoded
   * subtask description, same last-stdout-line envelope), but performs
   * the two tool calls DIRECTLY instead of paying an LLM round-trip to
   * have Haiku wire them. Returns null on ANY deviation — tool error,
   * non-zero exit, missing/invalid envelope — so the caller falls back
   * to the normal inject-and-supervise path. A deterministic failure
   * deliberately does NOT bump the skill's failure counter: the LLM
   * loop gets its shot first, and only a full supervise-loop escalation
   * counts as a skill failure (existing onFailed semantics, which also
   * drive script→llm demotion).
   *
   * On success the skill's success counter bumps here (the supervise
   * loop never runs, so its onApproved hook can't). Atom-type counters
   * are intentionally NOT touched — the L1 model never executed, so the
   * run proves nothing about the atom type.
   */
  private async runScriptSkillDirect(
    skill: Skill,
    l1Name: string,
    subTask: Task,
    ctx: RunContext
  ): Promise<Result | null> {
    if (!skill.language) return null;
    if (!scriptDeclaresEnvelope(skill.body)) {
      ctx.logger.debug(
        `[${this.name}] direct dispatch of ${skill.id} skipped: body never emits an {"output","summary"} envelope — running the LLM loop instead (no side effects)`
      );
      return null;
    }
    const filename = `_skill_${skill.id}.${scriptExtension(skill.language)}`;
    const interpreter = skill.language === 'python' ? 'python3' : skill.language;
    try {
      await ctx.tools!.execute('write_file', { path: filename, content: skill.body });
      const res = (await ctx.tools!.execute('run_shell', {
        command: interpreter,
        args: [filename, JSON.stringify(subTask.description)],
      })) as { exitCode?: number; stdout?: string; stderr?: string } | null;
      // The scratch script is NOT part of the deliverable: subtasks routinely
      // end with "list_files to confirm exactly <these files> exist", and a
      // stray `_skill_*.js` makes that check fail (or worse, ships in the
      // artefact). Clean it up on every exit path — see the `finally` below.
      // Kept as a separate call rather than folded into the run so a cleanup
      // failure can never mask the script's own result.
      if (!res || res.exitCode !== 0 || typeof res.stdout !== 'string') {
        ctx.logger.debug(
          `[${this.name}] direct dispatch of ${skill.id} failed (exit=${res?.exitCode ?? '?'}; stderr=${(res?.stderr ?? '').slice(0, 200)}) — falling back to the LLM loop`
        );
        this.noteDirectFailure(l1Name, skill, ctx);
        return null;
      }
      const envelope = parseScriptEnvelope(res.stdout);
      if (!envelope) {
        ctx.logger.debug(
          `[${this.name}] direct dispatch of ${skill.id}: stdout carried no {"output","summary"} envelope — falling back to the LLM loop`
        );
        this.noteDirectFailure(l1Name, skill, ctx);
        return null;
      }
      this.skillRegistry?.clearDirectFailures(l1Name, skill.id);
      this.skillRegistry?.recordSuccess(l1Name, skill.id);
      ctx.recordSkill?.({
        op: 'direct',
        l1Name,
        skillId: skill.id,
        actorName: this.name,
        actorTier: 2,
        reasoning: `deterministic ${skill.language} run: exit 0, envelope ok (${res.stdout.length} chars stdout)`,
      });
      ctx.recordSkill?.({
        op: 'success',
        l1Name,
        skillId: skill.id,
        actorName: this.name,
        actorTier: 2,
        reasoning: 'direct dispatch succeeded',
      });
      ctx.logger.debug(
        `[${this.name}] skill ${skill.id} ran via deterministic dispatch (0 LLM calls)`
      );
      return {
        output: envelope.output,
        summary: envelope.summary,
        trace: [
          {
            kind: 'execute',
            ts: new Date().toISOString(),
            atom: l1Name,
            payload: { directSkillDispatch: skill.id, interpreter, filename },
          },
        ],
        producedBy: { tier: 1, name: l1Name, viaFallback: false },
      };
    } catch (err) {
      ctx.logger.debug(
        `[${this.name}] direct dispatch of ${skill.id} threw: ${(err as Error).message} — falling back to the LLM loop`
      );
      return null;
    } finally {
      await this.removeScratchScript(filename, ctx);
    }
  }

  /**
   * Best-effort removal of the scratch script written by the deterministic
   * dispatch. Uses `node -e` because the sandbox toolbox has no delete tool
   * and `rm` is not on `run_shell`'s allowlist; `node` is. Note the `-e` argv
   * offset: with `node -e <code> <arg>` the argument lands at `process.argv[1]`
   * (NOT [2] as in a script invocation) — verified, and the reason the script
   * itself cannot simply be passed inline via `-e`.
   *
   * Swallows every failure: cleanup must never turn a successful dispatch
   * into a fallback, nor mask the script's own error.
   */
  /**
   * Record a deterministic-dispatch contract failure and demote the script
   * back to its llm fallback once the streak reaches
   * DIRECT_DISPATCH_DEMOTE_AFTER. Deterministic failures never bump the
   * trust failure counter (the LLM fallback usually still delivers), so
   * without this a structurally brittle script fails on every match
   * forever — it never escalates, so the onFailed demotion path is
   * unreachable from here. Environmental failures (tool executor threw)
   * deliberately do NOT come through this method; only the two contract
   * branches (non-zero exit / missing envelope) do.
   */
  private noteDirectFailure(l1Name: string, skill: Skill, ctx: RunContext): void {
    if (!this.skillRegistry) return;
    const streak = this.skillRegistry.markDirectFailure(l1Name, skill.id);
    if (streak < demoteAfter()) return;
    const demoted = this.skillRegistry.demoteToLlm(l1Name, skill.id);
    if (!demoted) {
      // No _fallback.md (hand-authored script) — nothing to restore. The
      // pre-flight envelope gate is what keeps such skills mostly harmless.
      ctx.logger.warn(
        `[${this.name}] script skill "${skill.id}" hit ${streak} deterministic failures but has no llm fallback — leaving as-is`
      );
      return;
    }
    ctx.logger.warn(
      `[${this.name}] script skill "${skill.id}" demoted to llm after ${streak} consecutive deterministic failures (fallback recipe restored)`
    );
    // Stamp the refusal too, or the demotion OSCILLATES: the restored llm
    // form re-earns 5/0, the compile re-runs on the same body, produces the
    // same structurally brittle script, and the cycle repeats forever — one
    // Sonnet call plus two wasted dispatches per lap. The stamp parks
    // re-compilation until the BODY changes (save() clears it), which is the
    // only event that could change the compile's outcome. NOTE: demoteToLlm
    // just rewrote SKILL.md via save(), so the stamp must be set AFTER it.
    // Stamp the generation that COMPILED the failing script — not the one in
    // force now. If the compiler has since evolved, iteration-1's gate treats
    // this stamp as stale and lets the new compiler try (a script produced by
    // compiler A failing says nothing about compiler B's output).
    this.skillRegistry.markPromotionRefused(
      l1Name,
      skill.id,
      `auto-demoted: compiled form failed ${streak} consecutive deterministic dispatches — recompiling the SAME body with the SAME compiler would reproduce it; revise the body or wait for a compiler change`,
      skill.compiledGeneration ?? COMPILE_PROMPT_GENERATION
    );
    ctx.recordSkill?.({
      op: 'demote',
      l1Name,
      skillId: skill.id,
      actorName: this.name,
      actorTier: 2,
      reasoning: `${streak} consecutive deterministic dispatch failures — compiled script is structurally brittle, llm fallback restored`,
    });
  }

  private async removeScratchScript(filename: string, ctx: RunContext): Promise<void> {
    try {
      await ctx.tools?.execute('run_shell', {
        command: 'node',
        args: ['-e', 'require("fs").rmSync(process.argv[1],{force:true})', filename],
      });
    } catch {
      /* best effort — the deliverable check may still see the file */
    }
  }

  private resolveL1ForSubtask(
    subtask: Plan['subtasks'][number],
    strategy: L2Strategy,
    parentTask: Task,
    idx: number,
    ctx: RunContext
  ): AtomType {
    if (subtask.preferredChild) {
      const found = this.registry.getByName(subtask.preferredChild);
      if (found) {
        if (found.tier !== 1) {
          throw new Error(
            `subtask preferredChild "${subtask.preferredChild}" is tier ${found.tier}, expected L1`
          );
        }
        return found;
      }
      // Planner hallucination: preferredChild does not exist. Sonnet
      // sometimes invents chemical-element names ("Carbon") that AREN'T
      // in the catalog yet. Rather than crash the whole fan-out (killing
      // N-1 healthy subtasks via Promise.all), create a NEW L1 on the fly
      // whose description takes the subtask's own description — that way
      // future runs can prefilter to it. The auto-assigned taxonomy name
      // will differ from the hallucinated one; we log the mismatch.
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} preferredChild "${subtask.preferredChild}" not in registry — auto-creating a fresh L1`
      );
      return this.createSubtaskL1(subtask, strategy, parentTask);
    }
    // No preferredChild: the single-subtask path uses the strategy
    // resolved at plan-time. For idx > 0 we still auto-create to
    // avoid the same "kill the whole fan-out" failure mode — the
    // planner is mis-behaving but the run can still produce SOME
    // output rather than none.
    if (idx > 0) {
      ctx.logger.warn(
        `[${this.name}] subtask #${idx} has no preferredChild — auto-creating a fresh L1 (planner should have labeled this subtask)`
      );
      return this.createSubtaskL1(subtask, strategy, parentTask);
    }
    if (strategy.strategy === 'reuse') {
      if (!strategy.target) throw new Error('reuse requires target');
      const found = this.registry.getByName(strategy.target);
      if (!found) throw new RegistryNotFoundError(strategy.target);
      return found;
    }
    // create with explicit strategy seed
    return this.createSubtaskL1(subtask, strategy, parentTask);
  }

  /**
   * Create a new L1 for a subtask that couldn't be routed to an existing
   * catalog entry. Used both for explicit `strategy: "create"` plans and
   * for the fallback paths above (hallucinated preferredChild, missing
   * preferredChild in multi-subtask plan). Description defaults to the
   * subtask's own description, so the new L1's catalog entry is
   * prefilter-friendly on future runs.
   */
  private createSubtaskL1(
    subtask: Plan['subtasks'][number],
    strategy: L2Strategy,
    parentTask: Task
  ): AtomType {
    const seed: NonNullable<typeof strategy.seed> =
      strategy.seed ?? ({ tools: [], params: {} } as NonNullable<typeof strategy.seed>);
    const mergedTools = mergeTools(this.tools, (seed.tools ?? []) as Tool[]);
    // IMPORTANT: the registry description is the prefilter key on future
    // runs. Early versions echoed the full task narrative here ("L1 for
    // subtask: build a chess puzzle with 8x8 board + drag-and-drop + …"),
    // which locked each new L1 to a single theme and polluted the catalog
    // with task-bound singletons that prefilter could never re-use
    // cross-domain. We now force a capability-first label derived from
    // the tool signature; task-specific info still flows to the atom via
    // `handle(task, ctx)` at runtime. See `src/atoms/capability.ts` for
    // the full rationale.
    // BUCKET-AWARE system prompt: only append SMOKE_DESIGN_GUIDANCE when
    // the merged toolset includes validate_html (the web bucket). An HTTP
    // L1 or a custom-bucket L1 that doesn't own validate_html should not
    // be told about smoke primitives it can't use — that guidance taught
    // earlier runs to INVOKE validate_html anyway via the shared executor
    // (fix #8b). See buildNarrowL1Prompt for the mirror logic on the
    // escalation branch path.
    const hasValidateHtml = mergedTools.some((t) => t.name === 'validate_html');
    // The GROUND-TRUTH evidence contract is appended to BOTH prompt
    // sources — the planner-authored seed AND the default template. A
    // seed prompt written by Sonnet/Opus never spells out the reporting
    // contract, and an L1 that omits pasted tool outputs gets its
    // (otherwise correct) results rejected by the validator as
    // unverifiable self-reporting (the wc-cli README rejection loop).
    const basePrompt =
      seed.systemPrompt ??
      [
        `You are an L1 element with ONE narrow responsibility.`,
        `DO NOT attempt to solve the whole task — only the specific subtask you are handed.`,
        `Call tools sequentially to produce your single output. Return a structured`,
        `{"output", "summary"} JSON at the end.`,
        ``,
        `Scope boundary: if the subtask seems to require coordinating with other`,
        `subtasks (reading their outputs, sharing state) — that's a planning bug at`,
        `a higher tier. You still execute YOUR subtask in isolation; do NOT invent`,
        `cross-subtask side effects.`,
        ``,
        `Subtask you were handed: ${subtask.description}`,
        `Parent task (for context only): ${parentTask.description}`,
      ].join('\n');
    return this.registry.create(1, {
      description: resolveCreationDescription(seed.description, mergedTools, 1),
      // Default system prompt emphasises SINGLE-RESPONSIBILITY. A freshly
      // created L1 should be a narrow specialist — one concern, one output
      // shape — not a Swiss-army knife that tries to solve the whole task.
      systemPrompt: [
        basePrompt,
        ``,
        ...GROUND_TRUTH_EVIDENCE_LINES,
        ...(hasValidateHtml ? [``, SMOKE_DESIGN_GUIDANCE] : []),
      ].join('\n'),
      tools: mergedTools,
      params: (seed.params ?? this.params) as GenerationParams,
      createdBy: this.name,
    });
  }

  private makeL1Hooks(
    ctx: RunContext,
    subtaskDescription: string,
    skillCtx: {
      /** L1 atom-type name for this subtask (skills are namespaced by it). */
      l1Name: string;
      /** The actual subtask Task, needed by skill-learning prompts. */
      subTask: Task;
      /**
       * True when L2 ran a skill-prefilter for this subtask. False
       * when no SkillRegistry was wired (skills disabled). Gates the
       * C3 skill auto-creation path: we only learn a new skill when
       * we DID look for one and didn't find a match — never when
       * skills are disabled wholesale.
       */
      skillMatchAttempted: boolean;
    }
  ): SupervisionHooks<L1Atom> {
    return {
      applyByScope: async (child, verdict) => {
        if (verdict.scope === 'ephemeral') {
          child.applyModifications(verdict.modifications);
          return child;
        }
        if (verdict.scope === 'patch') {
          const patched = this.registry.patch(
            child.name,
            verdict.modifications,
            this.name,
            verdict.reasoning
          );
          return L1Atom.fromType(patched);
        }
        const branched = this.registry.branch(
          child.name,
          verdict.modifications,
          this.name,
          verdict.branchName
        );
        ctx.logger.info(`[${this.name}] branched L1 ${child.name} → ${branched.name}`);
        return L1Atom.fromType(branched);
      },
      branchOnEscalation: async (child, trace, reason) => {
        // Aligned system prompt: start the branch FRESH with the current
        // subtask's domain, not inherited from the parent. Without this
        // reset, a "platformer builder" parent gets branched into a
        // "dashboard builder" child that still introduces itself as a
        // platformer and keeps emitting platformer plans (Frankenstein).
        //
        // BUCKET-AWARE: buildNarrowL1Prompt reads childTools to pick
        // the tool-sequence body (HTTP vs web vs generic) — fix #8b.
        //
        // DIAGNOSTIC INJECTION (#1): we also extract the parent's last
        // validator rejection reasoning(s) from the trace and inject
        // them as a "== PRIOR ATTEMPT DIAGNOSIS ==" block in the narrow
        // prompt. Without this, a branch created after a ground-truth
        // 404 rejection had NO idea the parent hit a 404 — it just saw
        // "previous attempts failed" and re-ran the full deliverable
        // cycle (observed on the backgammon run: Beryllium did 23
        // identical validate_html calls after Hydrogen's 16, never
        // fixing the underlying server/file mismatch).
        //
        // Capability-first registry description: the task narrative
        // stays in the narrow prompt; the registry row stays tier /
        // tool scoped so prefilter cross-domain reuse stays clean.
        // Atom.tools is protected, so we re-resolve the toolset via
        // the registry — the registry is the authoritative source.
        const childType = this.registry.getByName(child.name);
        const childTools = childType?.tools ?? [];
        const diagnostic = extractBranchDiagnostic(trace);

        // Skill update path (C2b). When the failed run was driven by
        // a skill, the cleanest remediation is to UPDATE THE SKILL
        // BODY using the validator's diagnosis — not to branch the
        // atom type. The skill lives in the SkillRegistry; a save
        // here overwrites the body but PRESERVES trust counters
        // (C1's save() contract). We then return a fresh L1
        // instance with the updated body injected, and the
        // supervise-loop's `hasTriedBranch` mechanism gives that
        // instance ONE more clean cycle. If the second pass also
        // fails the loop falls through to the parent fallback path
        // — same as the legacy branch flow.
        //
        // We require BOTH activeSkillId AND a non-empty diagnostic
        // before attempting an update: re-running the same skill
        // body without anything new for the model to act on would
        // just reproduce the previous outcome.
        const activeSkillId = child.activeSkillId();
        if (activeSkillId && this.skillRegistry && diagnostic.length > 0 && childType) {
          const skills = this.skillRegistry.loadFor(child.name);
          const oldSkill = skills.find((s) => s.id === activeSkillId);
          if (oldSkill) {
            try {
              const newBody = await this.improveSkillBody({
                skill: oldSkill,
                diagnostic,
                subtaskDescription,
                ctx,
              });
              // An UNCHANGED body is a legitimate answer (the prompt tells
              // the model to return it as-is when the failure was
              // environmental) — but saving it would be actively harmful:
              // `save()` clears the promotion-refusal stamp on the premise
              // that the body changed, and retrying an identical recipe
              // against an identical diagnosis is a guaranteed-identical
              // outcome. Treat it as "no revision available" and let the
              // legacy branch path take over.
              const revised =
                newBody && newBody.trim() !== oldSkill.body.trim() ? newBody : null;
              if (!revised && newBody) {
                ctx.logger.info(
                  `[${this.name}] skill ${activeSkillId} revision returned an UNCHANGED body (environmental failure?) — skipping the save and the retry`
                );
              }
              if (revised) {
                const newBody = revised;
                this.skillRegistry.save(child.name, {
                  id: oldSkill.id,
                  description: oldSkill.description,
                  whenToUse: oldSkill.whenToUse,
                  kind: oldSkill.kind,
                  ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  body: newBody,
                });
                ctx.logger.warn(
                  `[${this.name}] skill ${activeSkillId} on ${child.name} updated after escalation (${reason}); retrying L1 with new body`
                );
                ctx.recordSkill?.({
                  op: 'update',
                  l1Name: child.name,
                  skillId: activeSkillId,
                  actorName: this.name,
                  actorTier: 2,
                  reasoning: diagnostic.slice(0, 400),
                });
                const fresh = L1Atom.fromType(childType);
                fresh.injectContext(
                  skillContextBlock({
                    id: activeSkillId,
                    body: newBody,
                    kind: oldSkill.kind,
                    ...(oldSkill.language ? { language: oldSkill.language } : {}),
                  })
                );
                fresh.setActiveSkill(activeSkillId);
                return fresh;
              }
            } catch (err) {
              // Sonnet unavailable / parse error / network blip —
              // fall through to the legacy branch path so the run
              // still has a recovery channel.
              ctx.logger.warn(
                `[${this.name}] skill update failed: ${(err as Error).message}; falling back to standard branch`
              );
            }
          }
        }

        const narrowPrompt = buildNarrowL1Prompt(
          subtaskDescription,
          childTools,
          diagnostic
        );
        const narrowDesc = resolveCreationDescription(undefined, childTools, 1);
        const branched = this.registry.branch(
          child.name,
          {
            systemPromptReplace: narrowPrompt,
            descriptionReplace: narrowDesc,
            additionalContext:
              `Branched after escalation. Previous attempts failed because the inherited prompt` +
              ` was misaligned with this task. Prompt has been reset to a narrow template focused` +
              ` on the current subtask.` +
              (diagnostic.length > 0
                ? `\nVALIDATOR DIAGNOSIS (injected into the new system prompt too):\n${diagnostic}`
                : ''),
          },
          this.name,
          undefined
        );
        ctx.logger.warn(
          `[${this.name}] escalation — branched ${child.name} → ${branched.name} (${reason})`
        );
        // Return a fresh L1 instance of the branched type so the supervise
        // loop can give it one attempt before falling back to this L2.
        // Without this, the branch was recorded in the registry but never
        // actually tried on the current task — purely a lesson for future
        // runs. By handing the new instance back we let the anti-
        // Frankenstein narrow prompt prove itself in-flight.
        return L1Atom.fromType(branched);
      },
      onApproved: async (child, result) => {
        this.registry.recordSuccess(child.name);
        // Skill trust counter bump (C2a). When the supervise loop
        // approves a result and a skill drove the run, record a
        // success on the skill itself — this is what lets future
        // runs "trust" the skill more, and (in a follow-up) lets
        // the system identify mature skills worth promoting from
        // hand-written to auto-managed.
        const skillId = child.activeSkillId();
        if (skillId && this.skillRegistry) {
          this.skillRegistry.recordSuccess(child.name, skillId);
          ctx.recordSkill?.({
            op: 'success',
            l1Name: child.name,
            skillId,
            actorName: this.name,
            actorTier: 2,
          });
          // Skill llm→script PROMOTION (#C2c). After bumping the
          // success counter, check whether this skill has crossed the
          // promotion threshold. The eligibility gate inside
          // tryPromoteSkill is cheap (counter read) and short-circuits
          // before any Sonnet call, so this is safe to run on every
          // approved skilled run. Failures inside the helper are
          // logged + swallowed — promotion is opportunistic.
          try {
            await this.tryPromoteSkill({
              l1Name: child.name,
              skillId,
              subTask: skillCtx.subTask,
              result,
              ctx,
            });
          } catch (err) {
            ctx.logger.warn(
              `[${this.name}] skill promotion attempt errored: ${(err as Error).message}`
            );
          }
        } else if (
          // Skill auto-creation (C3). Fires when ALL of:
          //   - L2 attempted a skill match for this subtask;
          //   - no skill matched (the run was novel);
          //   - the run was approved (i.e. it's a clean reusable pattern);
          //   - the env flag ATOMA_SKILL_LEARN is on (off by default
          //     because each learning event costs one Sonnet call,
          //     and not every project wants automatic mutation of
          //     its skills folder).
          !skillId &&
          skillCtx.skillMatchAttempted &&
          this.skillRegistry &&
          process.env['ATOMA_SKILL_LEARN'] === '1'
        ) {
          try {
            await this.learnSkillFromRun({
              l1Name: skillCtx.l1Name,
              subTask: skillCtx.subTask,
              result,
              child,
              ctx,
            });
          } catch (err) {
            ctx.logger.warn(
              `[${this.name}] skill auto-creation failed: ${(err as Error).message}`
            );
          }
        }
      },
      onFailed: async (child, _reason) => {
        this.registry.recordFailure(child.name);
        const skillId = child.activeSkillId();
        if (skillId && this.skillRegistry) {
          this.skillRegistry.recordFailure(child.name, skillId);
          ctx.recordSkill?.({
            op: 'failure',
            l1Name: child.name,
            skillId,
            actorName: this.name,
            actorTier: 2,
          });
          // Skill DEMOTION (#C2c). If a `kind: 'script'` skill drove
          // the run that just escalated, restore its original llm
          // body from the `_fallback.md` sidecar. The script form
          // proved fragile on this task; reverting to the LLM-driven
          // recipe lets future runs adapt where the fixed script
          // couldn't. The `failures > 0` clause inside tryPromoteSkill
          // then blocks accidental re-promotion until counters are
          // reset by the operator.
          const matched = this.skillRegistry.loadFor(child.name).find((s) => s.id === skillId);
          if (matched && matched.kind === 'script' && matched.fallbackBody) {
            const restored = this.skillRegistry.demoteToLlm(child.name, skillId);
            if (restored) {
              ctx.logger.info(
                `[${this.name}] skill "${skillId}" demoted to kind:llm after script failure`
              );
              ctx.recordSkill?.({
                op: 'demote',
                l1Name: child.name,
                skillId,
                actorName: this.name,
                actorTier: 2,
                reasoning: `script failed; restored ${matched.fallbackBody.length}-char fallback`,
              });
            }
          }
        }
      },
    };
  }

  /**
   * Combine N sub-results into the supervisor's single Result.
   *   - `concat`: mechanical array-join. Cheap, no LLM call. Output
   *     becomes `[subResults[0].output, subResults[1].output, …]`
   *     unless N=1 where we return the single result directly (same
   *     shape as pre-fan-out behaviour).
   *   - `llm-synthesize`: ask the supervisor's own model to merge the
   *     N sub-results into a final `{output, summary}` using
   *     `aggregation.instruction` as the merge prompt.
   */
  private async aggregate(
    subResults: Result[],
    aggregation: Plan['aggregation'],
    parentTask: Task,
    ctx: RunContext
  ): Promise<Result> {
    if (subResults.length === 1) {
      // Degenerate fan-out (N=1): preserve the exact pre-fan-out shape so
      // existing call sites and tests see no difference.
      return subResults[0]!;
    }
    if (aggregation.mode === 'sequential') {
      // Phased pipeline: the FINAL phase carries the deliverable. See
      // L3Atom.aggregate sequential branch for full rationale.
      const last = subResults[subResults.length - 1]!;
      const phaseSummaries = subResults
        .map((r, i) => `phase #${i + 1} (${r.producedBy.name}): ${r.summary}`)
        .join(' | ');
      return {
        output: last.output,
        summary: `${subResults.length} sequential phases — final: ${last.summary}. Trace: ${phaseSummaries}`,
        trace: [],
        producedBy: { tier: 2, name: this.name, viaFallback: false },
      };
    }
    if (aggregation.mode === 'concat') {
      const outputs = subResults.map((r) => r.output);
      const summary = `${subResults.length} subtasks aggregated (concat): ${subResults
        .map((r, i) => `#${i + 1} ${r.summary}`)
        .join(' | ')}`;
      return {
        output: outputs,
        summary,
        trace: [],
        producedBy: { tier: 2, name: this.name, viaFallback: false },
      };
    }
    // llm-synthesize
    const userContent = [
      `You are "${this.name}" (tier 2). Synthesise a single result from ${subResults.length} sub-results.`,
      `Original task: ${parentTask.description}`,
      aggregation.instruction
        ? `Merge instruction: ${aggregation.instruction}`
        : 'Merge instruction: combine the sub-results into one coherent final deliverable.',
      ``,
      `Sub-results:`,
      ...subResults.map(
        (r, i) =>
          `--- #${i + 1} (by ${r.producedBy.name}) ---\nsummary: ${r.summary}\noutput: ${
            typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
          }`
      ),
      ``,
      `Return JSON: {"output": <any>, "summary": "<one sentence>"}`,
    ].join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
      signal: ctx.signal,
    });
    const { output, summary } = parsePayloadTolerant(resp.text);
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: false },
    };
  }

  /** Mutualization target: peer runs the task end-to-end without further supervision. */
  async handleDirect(task: Task, ctx: RunContext): Promise<Result> {
    const plan = await this.plan(task, ctx);
    return this.execute(task, plan, ctx);
  }

  async mutualize(task: Task, ctx: RunContext): Promise<Result> {
    if (this.peers.length === 0) throw new Error('no peers to mutualize with');
    const peer = this.peers[0]!;
    return peer.handleDirect(task, ctx);
  }

  /**
   * L2 self-exec fallback (used when L3 escalates OR when L1 supervision bails).
   * Parallels the L3 fallback fix: if both `this.tools` and `ctx.tools` are
   * wired, the L2 IS the executor of last resort and must be allowed to call
   * tools directly. Without this, earlier runs produced a "FALLBACK_NO_TOOLS"
   * payload with just HTML source text and no file on disk — the L3 supervisor
   * rightly rejected that and the 10-minute deadline ran out.
   */
  private async selfPlan(task: Task, ctx: RunContext): Promise<Plan> {
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const toolCatalog = hasTools
      ? this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n')
      : '(no tools available — reasoning-only answer)';
    const userContent = [
      `You are atom "${this.name}" (tier 2) in FALLBACK mode: do the task yourself, no delegation.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      hasTools
        ? 'You HAVE tool access in this fallback turn (see Tools below). Plan concrete tool calls — do NOT describe work as prose when a tool can do it.'
        : 'You have NO tool access; produce a reasoning-only answer.',
      `Tools:`,
      toolCatalog,
      ``,
      `IMPORTANT: emit ONE JSON object, NOT an array. Shape exactly:`,
      `{"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
      `Your regular mode uses a [strategy, plan] array — that mode is OFF here.`,
      `The first character of your response MUST be "{".`,
    ]
      .filter(Boolean)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
      signal: ctx.signal,
    });
    // Tolerant parse WITH fallback: even with the explicit "emit ONE
    // object" hint above, Sonnet's non-fallback routing prompt is
    // heavily conditioned to emit a `[strategy, plan]` pair. When it
    // goes even more off-piste (emitting pure strategy JSON, a result
    // envelope, or free-form prose), `parsePlanWithFallback` synthesises
    // a stub plan from the task rather than crashing the whole run —
    // selfExecute can still do real work with the tools, and a missing
    // "plan text" is not a reason to throw away the fallback safety net.
    return parsePlanWithFallback(resp.text, {
      reasoning: `fallback: could not parse a plan from the LLM response; proceeding with direct execution of the task`,
      proposedAction: `execute the task directly using the available tools (${
        this.tools.map((t) => t.name).join(', ') || 'none'
      })`,
      expectedOutput: task.description,
    });
  }

  private async selfExecute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    const hasTools = this.tools.length > 0 && ctx.tools !== undefined;
    const hasValidator = hasTools && this.tools.some((t) => t.name === 'validate_html');
    const userContent = [
      `You are "${this.name}" (tier 2) in FALLBACK: L1 supervision failed, you are now the executor.`,
      hasTools
        ? 'You HAVE tool access in this fallback turn. Use the tools to actually perform the work — do NOT just describe it. Relative paths for file tools ("index.html", not "/abs/index.html").'
        : 'You have NO tool access; produce a reasoning-only answer. Do not claim to have written files or run commands.',
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Plan: ${JSON.stringify(plan)}`,
      hasValidator
        ? 'If the task produces a web artefact, call validate_html on the returned URL after write_file + start_static_server, and iterate (read_file → fix → write_file → re-validate) until ok:true. Only then return success.'
        : '',
      ``,
      `Return JSON: {"output", "summary"} once the work is done.`,
    ]
      .filter((l): l is string => typeof l === 'string' && l.length > 0)
      .join('\n');
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      ...(hasTools ? { tools: [...this.tools], executor: ctx.tools } : {}),
      params: this.params,
      signal: ctx.signal,
      maxToolIterations: hasValidator ? 40 : undefined,
    });
    const { output, summary } = parsePayloadTolerant(resp.text);
    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 2, name: this.name, viaFallback: this.isFallbackMode() },
    };
  }

  // Supervisor<L1Atom> contract — validations always run on validationModel
  // (Haiku by default), not the supervisor's own model. The job here is a
  // terse yes/no on the child's plan/result; it does not need Sonnet to answer.
  async validatePlan(child: L1Atom, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict> {
    // Prefilter fast-path: a plan synthesised by the Haiku prefilter
    // short-circuit is already the product of a capability-match
    // decision — asking another Haiku to vet "delegate leaf task to L1
    // Helium" produces no new signal and regularly rejects the
    // freshly-bootstrapped canonical picks. We short-circuit to
    // approval, which matches the semantic of validatePlan (yes/no on
    // the plan's fitness) without paying the redundant round-trip.
    // Trust counters are NOT used here: an untrusted but prefilter-
    // validated child gets the pass precisely because the prefilter
    // already did the capability-match reasoning.
    if (plan.viaPrefilter) {
      return {
        approved: true,
        reasoning: `prefilter fast-path: plan was synthesised by Haiku's capability-match decision on child "${child.name}", no separate validator pass needed`,
      };
    }
    const type = this.registry.getByName(child.name);
    if (type && shouldTrustType(type)) {
      const approval = trustedApproval(type);
      ctx.recordTrust?.({
        supervisorName: this.name,
        supervisorTier: 2,
        childName: child.name,
        childTier: child.tier,
        subject: 'PLAN',
        successes: type.successes,
        failures: type.failures,
        reasoning: approval.reasoning,
      });
      return approval;
    }
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 2,
      subject: 'PLAN',
      child,
      task,
      payload: plan,
      // Inject the description of anything the plan wants to delegate to,
      // so Haiku doesn't judge "delegate to L1 Fluorine" from the name
      // alone and hallucinate what Fluorine does.
      targetContext: buildTargetContext(plan, this.registry),
    });
  }

  async validateResult(child: L1Atom, result: Result, task: Task, ctx: RunContext): Promise<Verdict> {
    const type = this.registry.getByName(child.name);
    // The trust fast-path skips the LLM validator — but it must NOT skip the
    // ground-truth probe. The probe costs zero tokens (local fs / one page
    // load), so the cheapest path has no excuse to be the blindest one, and a
    // trusted type is precisely the one nobody is watching any more. Observed
    // on the json-cli run: Lithium at 6/0 and Ammonia at 8/0 meant ZERO
    // validation calls for the whole run, so the read-back probe never fired
    // and a RESULT claiming "exit code 1" shipped while the CLI actually
    // exits 0. On a contradiction we hand the decision to the LLM validator
    // (passing the block along so the probe doesn't run twice) rather than
    // rejecting outright — a path-extraction heuristic must never fail a run
    // on its own.
    let trustedProbe: GroundTruthCheck | null = null;
    if (type && shouldTrustType(type)) {
      trustedProbe = await checkGroundTruth({
        ctx,
        subject: 'RESULT',
        payload: result,
        child,
      });
      if (!trustedProbe.contradiction) {
        const approval = trustedApproval(type);
        ctx.recordTrust?.({
          supervisorName: this.name,
          supervisorTier: 2,
          childName: child.name,
          childTier: child.tier,
          subject: 'RESULT',
          successes: type.successes,
          failures: type.failures,
          reasoning: approval.reasoning,
        });
        return approval;
      }
      ctx.logger.warn(
        `[${this.name}] trust fast-path OVERRIDDEN for ${child.name} (${type.successes}✓/${type.failures}✗): ground-truth evidence contradicts the RESULT — falling through to a full verdict`
      );
    }
    return llmVerdict({
      ctx,
      model: this.validationModel,
      supervisorName: this.name,
      supervisorTier: 2,
      subject: 'RESULT',
      child,
      ...(trustedProbe ? { groundTruthBlock: trustedProbe.block } : {}),
      task,
      payload: { output: result.output, summary: result.summary },
    });
  }
}

/**
 * Fixed system prompt used for EVERY validation call across all tiers. It is
 * identical call-to-call, which lets prompt caching short-circuit the input
 * bill on repeat verdicts — critical since validations dominate the loop.
 */
export const VALIDATION_SYSTEM_PROMPT = [
  'You validate agent outputs in a three-tier LLM orchestration system.',
  'Your ONLY job: emit a single Verdict JSON. No prose, no markdown, no tool calls.',
  '',
  '== TIERING CONTRACT (do NOT second-guess it) ==',
  'L1 elements are the ONLY tier allowed to invoke tools (file I/O, shell, HTTP, validation).',
  'L2 molecules plan and delegate a focused leaf task to exactly ONE L1 element per step.',
  'L3 cells plan and delegate the task to exactly ONE L2 molecule per step.',
  'Delegation DOWN the tiers is the protocol, NOT a violation:',
  '  - An L3 plan whose proposedAction is "delegate to <L2-name>" is CORRECT.',
  '  - An L2 plan whose proposedAction is "delegate to <L1-name>" is CORRECT.',
  '  - A supervisor is NEVER required to execute its child\'s work itself.',
  '  - Never reject a plan for "delegating to a lower tier" or "not retaining orchestration".',
  'The concrete side-effects (file writes, server starts, HTML validation) happen ONLY at L1.',
  'If a supervisor at L2 or L3 proposes calling tools directly, THAT is the violation.',
  'L1 PLAN SHAPE (explicit — do NOT reject L1 plans for the wrong reason):',
  '  A correct L1 plan is a DIRECT execution plan. It MAY include a pre-declared',
  '  `toolCalls` array listing the intended tool sequence ("write_file then',
  '  start_node_server then fetch_url"), AND it MAY describe the same intent in',
  '  `proposedAction` prose. Both shapes are valid L1 plan outputs.',
  '  DO NOT reject an L1 plan for "proposing tool invocations directly" — that is',
  '  the L1 plan shape, not a tier violation. The rule "only L1 may invoke tools"',
  '  means L2/L3 must DELEGATE; it does NOT mean L1 plans must hide their tool',
  '  sequence from the validator. Aspirational `toolCalls` entries at plan time',
  '  ("will call fetch_url on /health") are EXPECTED — they state intent, the',
  '  executor phase carries them out. Do not demand a proof of execution at plan',
  '  time; that is the RESULT phase.',
  '  Do not reject an L1 plan because it lists tool calls that need runtime',
  '  data the plan cannot yet know (the OS-assigned port, the server URL that',
  '  start_node_server will return, the probe body echoed back). Placeholders or',
  '  references to "the bound URL from start_node_server" are acceptable — the',
  '  executor resolves them at tool-call time.',
  '',
  '== PLAN vs RESULT (they have different acceptance bars) ==',
  'The "Subject kind" field in the user message tells you which applies.',
  'The "Plan kind" field (DIRECT or DELEGATION) tells you how strict to be about',
  'visible-deliverable enumeration — see below.',
  'If Subject kind is PLAN:',
  '  The child is proposing WHAT IT INTENDS TO DO. You are NOT checking a completed',
  '  artefact yet. Approve when the plan is coherent, targets a reasonable child of',
  '  the appropriate lower tier (or describes an in-tier action when L1), and states',
  '  a verifiable expectedOutput. Reject only if the plan is structurally broken:',
  '  wrong tier target, missing a step the task explicitly demands, or contradicts',
  '  the task. Aspirational language ("will write...", "will validate...") is',
  '  EXPECTED at plan-time and is NEVER grounds for rejection — absence of executed',
  '  work is not a defect of a plan.',
  '  VISIBLE-DELIVERABLES RULE (tier-aware, narrowly scoped):',
  '    - If Plan kind is DIRECT (child tier 1, the executor, OR a supervisor acting',
  '      in fallback): reject ONLY when the plan commits to building a',
  '      materially WRONG artefact — colored shapes in place of task-named',
  '      numbers/icons, a static page in place of the task-named interactive',
  '      element, or a stand-in for a task-named affordance that clearly',
  '      cannot satisfy the task (e.g. task says "Minesweeper" and the plan',
  '      does not mention mine counts or flag icons at all).',
  '      When you reject, name the CONCRETE task-stated element that the plan',
  '      fails to cover, in one short sentence, and put it in',
  '      modifications.additionalContext. A single missing element is enough',
  '      — do not chain a checklist of optional polish items.',
  '      DO NOT reject a plan because:',
  '        * it omits prose enumeration of affordances the implementation',
  '          will naturally produce (e.g. the plan says "FPS meter with',
  '          rolling graph and numeric readout" — that IS sufficient, you',
  '          need not demand a per-pixel breakdown of axis labels, grid',
  '          lines, tick formats);',
  '        * the smoke-test snippet could be slightly more thorough — smoke',
  '          quality is a RESULT-phase concern (re-evaluate then via ground',
  '          truth), not a plan-phase blocker;',
  '        * it could "go further" on feedback polish, end-state screens,',
  '          animation detail, etc. — absence of polish is not structural',
  '          brokenness and is NOT grounds for plan rejection.',
  '      Heuristic: if the plan, executed faithfully, would plausibly pass a',
  '      validate_html + smoke-check against the task, approve it. The plan',
  '      phase is a sanity gate, not a design review.',
  '    - If Plan kind is DELEGATION (child tier 2 or 3, routing to a lower tier):',
  '      the plan is a ROUTING decision. The visible-deliverables checklist does',
  '      NOT apply here — enumerating per-affordance UX detail is the downstream',
  '      L1\'s responsibility, not the delegator\'s. APPROVE the plan when (a) the',
  '      proposedAction targets a sensible lower-tier name, AND (b) the',
  '      expectedOutput is present and preserves the task\'s intent. An',
  '      expectedOutput that restates the task verbatim is ACCEPTABLE — the task',
  '      itself already carries the implicit requirements that the downstream L1',
  '      will unpack. Reject ONLY if the delegation target is structurally wrong',
  '      OR the expectedOutput drops critical task constraints explicitly listed',
  '      in the task statement (e.g. task says "with a 10x10 grid" and',
  '      expectedOutput says "any grid").',
  '      Do NOT reject a DELEGATION plan for "missing VISIBLE deliverables" — that is the wrong tier to enforce it.',
  'If Subject kind is RESULT:',
  '  The child claims the work is DONE. Approve when the claimed output plausibly',
  '  satisfies the task\'s success criteria (e.g. a URL is present when the task',
  '  asked for one, a file path is reported, the deliverable exists). Reject if the',
  '  deliverable is obviously missing, unverifiable, or contradicts the task.',
  '  CRITICAL: do NOT accept the child\'s narration as proof of success.',
  '  Self-reported "smokeTests: all passed" or "validation successful" is NOT evidence.',
  '  If the user message contains a "GROUND-TRUTH EVIDENCE" block, that block is',
  '  the supervisor\'s OWN independent re-run of validate_html. Its console errors,',
  '  failed requests, and ok flag outrank anything the child claims. If',
  '  ground-truth shows errors or failures that contradict the child\'s summary,',
  '  reject with scope "ephemeral" and put the ground-truth errors in',
  '  modifications.additionalContext so the next attempt can fix them.',
  '  CRITICAL: absence of a GROUND-TRUTH EVIDENCE block is NOT itself grounds',
  '  for rejection. The block is a supervisor-side auto-probe; it only fires',
  '  when the RESULT contains an http(s) URL and a validate_html tool is wired',
  '  into the supervisor\'s context. When it is absent, evaluate the RESULT on',
  '  its own merits (URL present? file path reported? deliverable described?) —',
  '  do NOT demand the child produce a GROUND-TRUTH block themselves; many',
  '  children cannot. Rejecting purely for "no ground-truth block provided" is',
  '  a false negative that has starved earlier runs of progress.',
  '  EXCEPTION — embedded ground-truth: an HTTP L1 child may emit its OWN',
  '  "== GROUND TRUTH ==" block inside the RESULT (their result-reporting',
  '  contract requires it: LISTENING_ON_PORT line, bound URL, per-endpoint',
  '  "probe: METHOD path -> status body[0:200]: …" lines, and a',
  '  "schema/state: …" line). When you see such a block ANYWHERE in the',
  '  RESULT envelope — whether inside the "summary" string (the canonical',
  '  location) OR misplaced into the "output" field — treat it as',
  '  supervisor-equivalent evidence: cross-check the probes against the task\'s',
  '  required endpoints and approve when they match. Do NOT re-reject for',
  '  "self-reported" — the embedded block IS the verification artefact. Do',
  '  NOT reject SOLELY for the block being in "output" instead of "summary":',
  '  that is a placement nit, not a correctness failure, and a reject cycle',
  '  here costs a full Helium re-execute (~1 minute) for zero new signal.',
  '  Only reject if the block contradicts the task (wrong status codes, body',
  '  snippets that prove the deliverable is broken, missing endpoints the',
  '  task explicitly named).',
  '  For interactive artefacts (apps, games, UIs), when Plan kind is DIRECT (child',
  '  tier 1 or a fallback supervisor) you must also check the RESULT against the',
  '  task\'s implicit VISIBLE deliverables: are all user-perceivable affordances —',
  '  numbers, icons, state feedback — actually documented in the RESULT output? A',
  '  result that only confirms colored shapes rendered for a task needing',
  '  numbers/icons must be REJECTED even if validate_html reported zero console',
  '  errors — a visually-incomplete artefact is a failed deliverable, not a',
  '  passing one. When Plan kind is DELEGATION, trust the downstream L1\'s RESULT',
  '  subject to the ground-truth evidence block (if present); the delegator is',
  '  not expected to re-enumerate the affordances itself.',
  '',
  '== REJECT SCOPES ==',
  'When rejecting, provide actionable "modifications" and pick a "scope":',
  '  - "ephemeral": apply only to this instance for this task (pure retry OK — empty modifications allowed)',
  '  - "patch":     update the canonical child type for future reuses',
  '  - "branch":    create a new child type with the modifications applied',
  'HARD RULE: scope "patch" and scope "branch" MUST carry at least one non-empty field in "modifications"',
  '  (systemPromptAppend, systemPromptReplace, descriptionReplace, additionalContext, addTools, removeTools, or params).',
  '  If you only have a diagnostic but no concrete prescription, use scope "ephemeral" and put your',
  '  diagnostic in modifications.additionalContext so the next attempt sees it — do NOT use patch/branch.',
  '',
  '== DESCRIPTION DRIFT ==',
  'The child type\'s "description" is what the prefilter sees when choosing catalog entries.',
  'If you notice the description no longer reflects the actual system prompt — e.g. the',
  'description still says "Mario-like platformer" but the system prompt has been retargeted',
  'to Minesweeper — issue a scope "patch" with modifications.descriptionReplace set to a',
  'fresh one-sentence description of what the type ACTUALLY does now. Accurate descriptions',
  'cut routing cost; stale ones cause the prefilter to escalate unnecessarily.',
  '',
  '== FAN-OUT DECOMPOSITION ==',
  'When Subject kind is PLAN and the plan carries a "subtasks" list, the child',
  'supervisor has decomposed the task. There are TWO valid decomposition shapes,',
  'distinguished by aggregation.mode:',
  '  PARALLEL ("concat" or "llm-synthesize"): subtasks are orthogonal, run via',
  '    Promise.all, no shared state.',
  '  SEQUENTIAL ("sequential"): subtasks run ONE AT A TIME on a SHARED workspace.',
  '    Step N consumes the artefact step N-1 left behind. The runtime threads the',
  '    previous step\'s summary into step N\'s inputs.previousStepSummary',
  '    automatically — the planner does NOT have to do it manually.',
  'Verify based on which shape the plan declared:',
  '  - subtasks is a non-empty array. Single-subtask plans (N=1) are valid for',
  '    GENUINELY indivisible work (e.g. "look up the time", "write a one-line',
  '    config"). For app/game/library builds, prefer N>=2.',
  '    DO NOT reject a plan just because N=1 if the task IS atomic. DO NOT reject',
  '    because "aggregation.mode is \'concat\' for a single artefact" — concat is',
  '    the correct default for N=1.',
  '  - each subtask has a concrete "description" (not "do the next step"). The',
  '    planner must write each description precisely enough that a child can act',
  '    on it. For sequential plans, descriptions can refer to "the artefact built',
  '    in the previous phase" — that is EXPECTED, not a defect.',
  '  - PARALLEL plans (mode "concat"|"llm-synthesize"): NO subtask depends on',
  '    another\'s output. Subtasks run via Promise.all; if the planner wrote',
  '    "subtask 2 uses subtask 1\'s URL" with mode="concat", that is STRUCTURALLY',
  '    BROKEN — reject with scope "ephemeral" and additionalContext pointing at',
  '    the dependency, suggesting either mode="sequential" or true orthogonality.',
  '    Artefact-collision rule (parallel only): if two parallel subtasks both',
  '    produce side-effects on the same resource (same file path, same port,',
  '    same DB row), that is NOT parallel-safe. Reject with the colliding resources.',
  '  - SEQUENTIAL plans (mode "sequential"): inter-step dependencies are',
  '    EXPECTED and CORRECT. The whole point is step N consumes step N-1\'s',
  '    state via the shared workspace + previousStepSummary. Do NOT reject for',
  '    "subtask 2 reads the file from subtask 1" — that is the contract. DO',
  '    reject if a sequential plan has only one subtask (use concat instead) or',
  '    if a phase\'s description is too vague to produce a checkable artefact.',
  '  - for N>1, each subtask SHOULD carry "preferredChild". A missing or',
  '    invented "preferredChild" (a name not present in the "Delegation',
  '    target(s):" block) will force the supervisor to auto-create a fresh',
  '    child whose description matches subtask.description. That is',
  '    recoverable but wasteful — if "preferredChild" is set, it MUST match',
  '    an actual catalog entry. Reject plans that reference an unknown name',
  '    (e.g. "Carbon" when the catalog lists only "Hydrogen, Helium, …")',
  '    with scope "ephemeral" and an additionalContext telling the planner',
  '    to either use a real catalog name or omit preferredChild entirely.',
  '    For sequential plans it is COMMON for multiple phases to target the',
  '    same preferredChild — that is the expected pattern, not a defect.',
  '  - "aggregation.mode" is one of "concat" (mechanical join, parallel),',
  '    "llm-synthesize" (merge via an extra LLM call, parallel) or "sequential"',
  '    (phased pipeline, last phase is the deliverable). If the final deliverable',
  '    is a SINGLE COMBINED artefact (e.g. an index.html assembled from pieces in',
  '    parallel) "concat" is almost always wrong — prefer "llm-synthesize". If the',
  '    final artefact must EVOLVE through review checkpoints (build → extend →',
  '    smoke), prefer "sequential".',
  '',
  '== BRANCHING ACROSS DOMAINS ==',
  'When you set scope "branch" with a branchName, the new type INHERITS the parent\'s',
  'systemPrompt unless you override it. If the branchName signals a DIFFERENT domain',
  'than the parent (e.g. parent is "Hydrogen: WebGL platformer builder", branch is',
  '"WebGLMinesweeper"), the parent\'s platformer instructions will silently contaminate',
  'the new child — producing a Frankenstein that "knows" it must build Minesweeper but',
  'retains validation contracts, keybindings, and code patterns for a platformer.',
  'HARD RULE: whenever branchName signals a different domain from the parent\'s',
  'description, modifications MUST include a complete systemPromptReplace that fully',
  'rewrites the parent prompt for the new domain. Do NOT rely on systemPromptAppend or',
  'additionalContext to "override" the parent — inherited instructions outweigh a short',
  'appended note. In the modifications.descriptionReplace, also give the branch a fresh',
  'description matching its new purpose.',
  '',
  '== OUTPUT ==',
  'Verdict shapes:',
  '  {"approved": true, "reasoning": "..."}',
  '  {"approved": false, "reasoning": "...", "modifications": {...}, "scope": "ephemeral"|"patch"|"branch", "branchName"?: "..."}',
  'Your entire response MUST start with "{" and be ONLY the JSON object.',
  'BREVITY: keep "reasoning" under 120 words — a crisp diagnosis beats a long',
  'essay. Earlier runs saw verdicts truncated mid-sentence (stop_reason',
  '"max_tokens") because reasoning ballooned into paragraphs, losing the',
  'modifications block entirely and crashing the parser. One sharp sentence on',
  'what is wrong plus the concrete fix in "modifications" is enough.',
  '',
  '== WORKED EXAMPLES ==',
  'The following examples anchor the rules above on concrete past runs.',
  'Each one is a SHORT reconstruction: the Subject/Plan kind, a one-line',
  'summary of the child\'s output, and the CORRECT verdict. Use them as',
  'pattern-matching reference — NOT as templates to copy verbatim.',
  '',
  '-- Example 1 — DELEGATION plan, approved --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Water"',
  '  Child summary: "delegate leaf task to L1 \'Fluorine\' with',
  '  expectedOutput=\'playable WebGL Minesweeper with mine counts and',
  '  flag icons visible\'"',
  '  Correct verdict: {"approved": true, "reasoning": "DELEGATION to',
  '  Fluorine; expectedOutput preserves task-stated visible affordances',
  '  (mine counts, flag icons). Enumeration is L1\'s responsibility."}',
  '  Why: the catalog name is real (Fluorine exists), the expectedOutput',
  '  carries the task\'s implicit requirements forward, and per the',
  '  DELEGATION rule we do NOT demand per-affordance prose here.',
  '',
  '-- Example 2 — DELEGATION plan, rejected for dropped constraint --',
  '  Subject kind: PLAN | Plan kind: DELEGATION | child: L2 "Glucose"',
  '  Child summary: "delegate to L1 \'Carbon\' with expectedOutput=\'a',
  '  playable grid game\'" (task explicitly said "10x10 Minesweeper with',
  '  30 mines")',
  '  Correct verdict: {"approved": false, "reasoning": "expectedOutput',
  '  drops critical task constraints (\'10x10\', \'30 mines\'). Rewrite to',
  '  preserve them.", "modifications": {"additionalContext": "restore',
  '  \'10x10 grid with 30 mines\' in expectedOutput"}, "scope":',
  '  "ephemeral"}',
  '  Why: the delegation target is fine but the delegator threw away',
  '  information the downstream L1 needs. Ephemeral — no need to rewrite',
  '  the type, just re-emit the plan with constraints preserved.',
  '',
  '-- Example 3 — DIRECT plan, approved --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Chlorine"',
  '  Child summary: "write index.html with 3 columns (FPS canvas+numeric',
  '  readout, mouse tracker with coords/delta/trail, keystroke logger',
  '  with timestamps). Start server. validate_html with interactions +',
  '  smoke checking fpsUpdated, mouseNonZero, keyEntries>=1."',
  '  Correct verdict: {"approved": true, "reasoning": "Plan commits to',
  '  the three task-named columns, each with its required affordance.',
  '  Implementation-faithful plan would plausibly pass validate_html +',
  '  smoke. Approve."}',
  '  Why: the plan names each task-stated element and commits to a',
  '  smoke-check that would detect regression on each. No prose',
  '  enumeration of axis-ticks / pixel-level polish is required.',
  '',
  '-- Example 4 — DIRECT plan, rejected for materially wrong artefact --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Boron"',
  '  Child summary: "write index.html with 3 colored boxes (red, green,',
  '  blue) and a button" (task: "Minesweeper with mine counts and flag',
  '  icons")',
  '  Correct verdict: {"approved": false, "reasoning": "Plan produces',
  '  colored boxes; task requires Minesweeper with mine counts and flag',
  '  icons. Concrete missing element: numeric mine-count tiles.",',
  '  "modifications": {"additionalContext": "rewrite to render a grid',
  '  of tiles with numeric mine counts and clickable flag icons"},',
  '  "scope": "ephemeral"}',
  '  Why: materially wrong artefact. Name the CONCRETE missing task-',
  '  stated element once ("numeric mine-count tiles") — do not chain a',
  '  checklist of every possible polish item.',
  '',
  '-- Example 5 — RESULT, ground-truth evidence contradicts child --',
  '  Subject kind: RESULT | Plan kind: DIRECT | child: L1 "Fluorine"',
  '  Child summary: "dashboard built, all three columns working, zero',
  '  errors" — GROUND-TRUTH EVIDENCE: ok=false, errors=["Uncaught',
  '  TypeError: Cannot read properties of null"], failedRequests=0',
  '  Correct verdict: {"approved": false, "reasoning": "Ground-truth',
  '  shows a null-dereference error contradicting child\'s claim.",',
  '  "modifications": {"additionalContext": "Uncaught TypeError in',
  '  production — likely a DOM element accessed before DOMContentLoaded',
  '  or before it exists"}, "scope": "ephemeral"}',
  '  Why: self-reported success is NEVER evidence. The ground-truth',
  '  block is the supervisor\'s independent probe and outranks the',
  '  child\'s narration. Ephemeral retry with the error surfaced.',
  '',
  '-- Example 6 — RESULT, approved on own-merits (no ground-truth) --',
  '  Subject kind: RESULT | Plan kind: DELEGATION | child: L2 "Sucrose"',
  '  Child summary: "http://localhost:8181/ with the 3-column dashboard',
  '  live; L1 validated internally with zero errors" — no GROUND-TRUTH',
  '  block (the probe did not fire because the tool wasn\'t wired)',
  '  Correct verdict: {"approved": true, "reasoning": "URL present, L2',
  '  reports internal L1 validation passed. Absence of ground-truth',
  '  block is not grounds for rejection; evaluate on own merits."}',
  '  Why: the ground-truth probe is a supervisor-side convenience; when',
  '  absent the result is judged on the reported deliverable alone.',
  '  Demanding the child produce a ground-truth block themselves is a',
  '  false-rejection pattern that starves runs of progress.',
  '',
  '-- Example 7 — DESCRIPTION drift, scope "patch" --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: reasonable plan for the task (Minesweeper) — BUT',
  '  child\'s type description still says "Mario-like platformer builder"',
  '  and its systemPrompt was long ago rewritten toward Minesweeper.',
  '  Correct verdict: {"approved": false, "reasoning": "Description has',
  '  drifted from actual capability. Update for prefilter accuracy.",',
  '  "modifications": {"descriptionReplace": "L1 builder for single-',
  '  file WebGL Minesweeper: writes, serves, and iterates until',
  '  validate_html passes."}, "scope": "patch"}',
  '  Why: the description is the prefilter\'s view of the child; stale',
  '  descriptions cause misrouting on future tasks. Patch (not branch)',
  '  because the type itself is fine — only its label is wrong.',
  '',
  '-- Example 8 — BRANCH across domain, systemPromptReplace required --',
  '  Subject kind: PLAN | Plan kind: DIRECT | child: L1 "Hydrogen"',
  '  Child summary: plan for a dashboard task but the child is a',
  '  narrowly-scoped platformer-builder prompt ("You are Hydrogen, a',
  '  WebGL platformer builder"). Branch name: "DashboardBuilder".',
  '  Correct verdict: {"approved": false, "reasoning": "Branch to a',
  '  different domain requires a complete systemPromptReplace; do not',
  '  let platformer instructions contaminate the dashboard child.",',
  '  "modifications": {"systemPromptReplace": "<full fresh prompt for',
  '  dashboard builder>", "descriptionReplace": "L1 builder for single-',
  '  file interactive dashboards"}, "scope": "branch", "branchName":',
  '  "DashboardBuilder"}',
  '  Why: without systemPromptReplace the new branch inherits the',
  '  parent\'s platformer prompt — the Frankenstein pattern. Branching',
  '  across domains MUST reset the prompt.',
  '',
  '== PAD / CACHE-OPTIMISATION NOTE ==',
  'The worked examples above serve a second purpose beyond teaching:',
  'they extend the system prompt past the 4096-token minimum cacheable',
  'prompt length for Claude Haiku 4.5. Below that threshold, Anthropic',
  'silently skips prompt caching and every validator call pays full',
  'input price. Earlier runs showed cache_read=0 / cache_create=0 on',
  'every Haiku call because the prompt was ~3000 tokens — just short of',
  'the threshold. Keep this section intact even if it feels verbose:',
  'its cost is tiny (cache hit at 10% base price) and its presence is',
  'what flips caching on for the validators that dominate run cost.',
  'If you edit this prompt and shrink it below ~4100 tokens, expect',
  'validators to stop caching and run cost to roughly double.',
].join('\n');

/**
 * Compact params for validation: verdict JSON is short, be fast and
 * deterministic. We give a generous maxTokens budget so the JSON suffix
 * (`"modifications": {...}, "scope": "..."`) is never truncated even if the
 * model goes long on `reasoning` — truncation lost entire modifications
 * blocks in earlier runs. The prompt also tells the model to keep reasoning
 * under 120 words, so typical completions still stay small.
 */
const VALIDATION_PARAMS: GenerationParams = { temperature: 0, maxTokens: 2048 };

export async function llmVerdict(args: {
  ctx: RunContext;
  model: string;
  supervisorName: string;
  supervisorTier: Tier;
  subject: 'PLAN' | 'RESULT';
  child: Atom;
  task: Task;
  payload: unknown;
  /**
   * Optional pre-formatted description of the atoms the plan references
   * (usually the DELEGATION target's name + description + trust counters).
   * Injected verbatim into userContent so Haiku doesn't have to guess what
   * an atom named "Fluorine" actually does. Without this field, earlier
   * runs saw Haiku reject a valid `delegate to L1 "Fluorine"` plan with
   * hallucinated reasoning ("Fluorine's description indicates it builds
   * generic web apps/games without specialization in WebGL") even though
   * Fluorine's description literally said "WebGL Minesweeper builder".
   * The caller builds this string (it has the registry); we just inject.
   */
  targetContext?: string;
  /**
   * Ground-truth evidence block already computed by the caller. Supplied by
   * the trust fast-path when its own probe found a contradiction and it is
   * handing the decision to the LLM: without it, the probe would run a
   * second time (a wasted Puppeteer launch for the web bucket).
   */
  groundTruthBlock?: string;
}): Promise<Verdict> {
  // `Subject kind` is repeated as its own field so the validator cannot miss
  // the PLAN-vs-RESULT distinction — the bar is different between the two and
  // earlier runs showed Haiku collapsing them together (rejecting PLANs for
  // not being completed RESULTs yet).
  const subjectHint =
    args.subject === 'PLAN'
      ? 'PLAN — the child proposes what it INTENDS to do; do NOT demand execution evidence yet.'
      : "RESULT — the child claims the work is DONE; check the output against the task's success criteria.";

  // Plan kind is a structural signal so the validator applies the
  // visible-deliverables checklist to the right tier. L1 is the executor
  // (plans there are DIRECT), L2/L3 route to a lower tier (plans there are
  // DELEGATION — enumeration is the downstream L1's responsibility, not
  // theirs). Without this hint, Haiku rejected perfectly valid L2 delegation
  // plans for "missing VISIBLE deliverables", starving the run of tool calls.
  const planKind: 'DIRECT' | 'DELEGATION' = args.child.tier === 1 ? 'DIRECT' : 'DELEGATION';
  const planKindHint =
    planKind === 'DIRECT'
      ? // The checklist is scoped to the artefact KIND, not just the tier. The
        // prompt body reserves it for interactive artefacts (apps, games, UIs),
        // but this hint used to hand it to the validator for EVERY tier-1
        // child — including a file-scribe writing a README. Observed on run
        // 2026-07-25T22-10-42: the validator rejected a documentation result
        // citing "the task's visible-affordances checklist" for a markdown
        // file, which has no affordances to enumerate. Tier still selects
        // DIRECT vs DELEGATION; the artefact kind now gates the checklist.
        'DIRECT — the child IS the executor (tier 1 or fallback). Apply the VISIBLE-deliverables checklist ONLY where the task describes an interactive artefact (app, game, UI). For a static-file deliverable (docs, config, data, a CLI script), judge the plan on whether it writes and verifies THAT file — do not demand visible affordances it cannot have.'
      : 'DELEGATION — the child is routing to a lower tier; do NOT demand visible-deliverable enumeration in THIS plan — that is the downstream L1\'s job.';

  // Ground-truth probe: for RESULT verdicts that include a URL, re-run
  // validate_html ourselves (if available) with a minimal independent
  // configuration. This breaks the "child self-reports success → validator
  // rubber-stamps" loop observed in the WebGL Minesweeper run where the
  // RESULT literally said "smokeTests: all passed" and the validator simply
  // believed it. We don't invent task-specific interactions (too risky); we
  // just check the page loads cleanly. If the page throws pageerror or has
  // console errors the validator now has hard evidence the claim is false.
  const groundTruthBlock =
    args.groundTruthBlock ??
    (await probeGroundTruth({
      ctx: args.ctx,
      subject: args.subject,
      payload: args.payload,
      child: args.child,
    }));

  const userContent = [
    `Supervisor: "${args.supervisorName}" (tier ${args.supervisorTier})`,
    `Child: "${args.child.name}" (tier ${args.child.tier})`,
    `Subject kind: ${subjectHint}`,
    `Plan kind: ${planKindHint}`,
    `Task: ${args.task.description}`,
    args.targetContext ? `Delegation target(s):\n${args.targetContext}` : '',
    `${args.subject}: ${JSON.stringify(args.payload)}`,
    groundTruthBlock,
  ]
    .filter(Boolean)
    .join('\n');

  const resp = await args.ctx.llm.complete({
    model: args.model,
    systemPrompt: VALIDATION_SYSTEM_PROMPT,
    userContent,
    params: VALIDATION_PARAMS,
    signal: args.ctx.signal,
  });

  const raw = parseVerdict(resp.text);
  if (raw.approved) return raw;
  return { ...raw, branchName: raw.branchName ?? undefined };
}

/**
 * Extract likely delegation-target atom names from a PLAN payload and build
 * a compact context string with each target's description + trust counters,
 * for injection into the validator's userContent.
 *
 * Fan-out aware: first checks `subtasks[].preferredChild` (authoritative
 * for multi-subtask plans since Phase 3). Falls back to legacy heuristics
 * — `L\d "name"` patterns and whole-word catalog scan in
 * `proposedAction` + `expectedOutput` — for single-subtask legacy plans
 * or plans that skip `preferredChild`. Returns `undefined` when no target
 * can be identified or the registry has no matching entry, so the verdict
 * skips the block entirely rather than inject noise.
 */
export function buildTargetContext(
  plan: unknown,
  registry: AtomRegistry
): string | undefined {
  if (!plan || typeof plan !== 'object') return undefined;
  const planObj = plan as Record<string, unknown>;

  const found: string[] = [];
  const seen = new Set<string>();

  // Authoritative path: subtasks.preferredChild, one per subtask. This
  // is where multi-subtask fan-out plans explicitly name their targets,
  // so we rely on it first and skip the regex heuristics when present.
  const subtasks = planObj['subtasks'];
  if (Array.isArray(subtasks)) {
    for (const st of subtasks) {
      if (!st || typeof st !== 'object') continue;
      const pc = (st as Record<string, unknown>)['preferredChild'];
      if (typeof pc === 'string' && pc.length > 0 && !seen.has(pc)) {
        seen.add(pc);
        found.push(pc);
      }
    }
  }

  if (found.length === 0) {
    const haystack = [planObj['proposedAction'], planObj['expectedOutput']]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    if (haystack.length === 0 && found.length === 0) return undefined;

    // Structured hint: `L1 "Foo"` / `L2 "Bar"` — the canonical delegation shape
    // produced by L2/L3 `plan()`. Catches the common case first.
    const quoted = /\bL[123]\s+"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(haystack)) !== null) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push(name);
    }

    // Fallback scan: any catalog atom name that appears as a whole word in
    // the haystack. Keeps the set bounded by requiring registry presence.
    if (found.length === 0) {
      for (const tier of [1, 2, 3] as const) {
        for (const t of registry.listByTier(tier)) {
          const safe = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\b${safe}\\b`);
          if (re.test(haystack) && !seen.has(t.name)) {
            seen.add(t.name);
            found.push(t.name);
          }
        }
      }
    }
  }

  const lines: string[] = [];
  for (const name of found) {
    const type = registry.getByName(name);
    if (!type) continue;
    const desc = stripBranchProvenance(type.description);
    lines.push(
      `  - ${type.name} (L${type.tier}, v${type.version}, ✓${type.successes}/✗${type.failures}): ${desc}`
    );
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Extract a URL to probe from a RESULT payload. We check, in order:
 *   1. `output.url` — the canonical structured shape
 *   2. top-level `url`
 *   3. `output` as a bare URL string (the shape Haiku most often emits:
 *      `{"output":"http://localhost:8000/index.html","summary":"…"}`)
 *   4. any `http(s)://` URL embedded in `output` or `summary` as free text
 *      (regex scan — last-resort so we still auto-probe when the model
 *      narrates "the server is running at http://…" inside the summary).
 *
 * Earlier builds missed (3) and (4), which meant the ground-truth probe
 * never fired on WebGL Minesweeper runs — every RESULT verdict rejected for
 * "no GROUND-TRUTH EVIDENCE block" even though the L1 had just passed
 * validate_html. That false-negative loop burned the 10-minute deadline.
 */
export function extractResultUrl(payload: unknown): string | null {
  const urlRe = /^https?:\/\//i;
  if (typeof payload === 'string' && urlRe.test(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const output = obj['output'];
  if (output && typeof output === 'object') {
    const u = (output as Record<string, unknown>)['url'];
    if (typeof u === 'string' && urlRe.test(u)) return u;
  }

  const topLevel = obj['url'];
  if (typeof topLevel === 'string' && urlRe.test(topLevel)) return topLevel;

  if (typeof output === 'string' && urlRe.test(output)) return output;

  // Free-text fallback: scan `output` (if string) and `summary` for the
  // first http(s) URL. Stops at whitespace, quotes, or angle brackets —
  // conservative enough not to grab trailing punctuation.
  const freeTextRe = /https?:\/\/[^\s"'<>)]+/i;
  const candidates: string[] = [];
  if (typeof output === 'string') candidates.push(output);
  const summary = obj['summary'];
  if (typeof summary === 'string') candidates.push(summary);
  for (const s of candidates) {
    const m = s.match(freeTextRe);
    if (m && m[0]) return m[0];
  }
  return null;
}

/**
 * Ground-truth probe result. `contradiction` is set ONLY on hard, unambiguous
 * evidence that something the child CLAIMED does not exist:
 *   - file bucket: a claimed path is MISSING or EMPTY
 *   - web bucket: the URL could not be probed at all (unreachable)
 * Console errors / `ok: false` deliberately do NOT set it — those are judgment
 * calls that belong to the LLM validator, and tripping on them would make the
 * trust fast-path fire false alarms on working deliverables.
 *
 * Used by `checkGroundTruth`, which the trust fast-path consults before
 * rubber-stamping a trusted child (the probe costs no tokens, so there is no
 * reason for the cheapest path to be the blindest one).
 */
export interface GroundTruthCheck {
  readonly block: string;
  readonly contradiction: boolean;
}

/**
 * A probe entry the child recorded in `output.probes` (see
 * GROUND_TRUTH_EVIDENCE_LINES). Shape-tolerant: children in the wild have
 * emitted `cmd`/`command`, `stdout`/`actual_stdout`, snake and camel case, so
 * we normalise rather than demand one spelling.
 */
interface RecordedProbe {
  cmd: string;
  exitCode?: number;
  stdout?: string;
  expected?: string;
  actual?: string;
  match?: boolean;
  note?: string;
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Normalise the child's recorded probe list. Accepts `probes`,
 * `examples_verified` and `verifications` because children already emit those
 * spontaneously — formalising the field in the prompt should not invalidate
 * the shapes they were producing before it existed.
 *
 * Exported for tests.
 */
export function extractRecordedProbes(payload: unknown): RecordedProbe[] {
  if (!payload || typeof payload !== 'object') return [];
  const output = (payload as Record<string, unknown>)['output'];
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const o = output as Record<string, unknown>;
  const out: RecordedProbe[] = [];
  for (const key of ['probes', 'examples_verified', 'examplesVerified', 'verifications']) {
    const arr = o[key];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const e = raw as Record<string, unknown>;
      const cmd = pickString(e, ['cmd', 'command', 'invocation']);
      if (!cmd) continue;
      const exit = e['exitCode'] ?? e['exit_code'] ?? e['exit'];
      const probe: RecordedProbe = { cmd };
      if (typeof exit === 'number') probe.exitCode = exit;
      const stdout = pickString(e, ['stdout', 'actualStdout', 'actual_stdout', 'output']);
      if (stdout !== undefined) probe.stdout = stdout;
      const expected = pickString(e, ['expectedStdout', 'expected_stdout', 'expected']);
      if (expected !== undefined) probe.expected = expected;
      const actual = pickString(e, ['actualStdout', 'actual_stdout', 'actual']);
      if (actual !== undefined) probe.actual = actual;
      if (typeof e['match'] === 'boolean') probe.match = e['match'] as boolean;
      const note = pickString(e, ['note', 'case', 'description']);
      if (note !== undefined) probe.note = note;
      out.push(probe);
    }
  }
  return out.slice(0, 12);
}

/**
 * Render the recorded probes for the validator, and flag the ONLY two
 * mechanically unambiguous self-reported failures:
 *   - `match: false`
 *   - `expected` and `actual` both present and different
 * Nothing else is decided in code. In particular a non-zero `exitCode` is NOT
 * a failure — error-case probes are supposed to exit non-zero — and whether a
 * documented claim matches the record is a judgment left to the validator,
 * which now has both sides in front of it.
 */
function renderRecordedProbes(probes: RecordedProbe[]): {
  lines: string[];
  selfReportedFailure: boolean;
} {
  if (probes.length === 0) return { lines: [], selfReportedFailure: false };
  const lines: string[] = ['', "The child's OWN recorded probe outputs (from output.probes):"];
  let selfReportedFailure = false;
  for (const p of probes) {
    const mismatch =
      p.match === false ||
      (p.expected !== undefined && p.actual !== undefined && p.expected !== p.actual);
    if (mismatch) selfReportedFailure = true;
    const bits: string[] = [];
    if (p.exitCode !== undefined) bits.push(`exit=${p.exitCode}`);
    if (p.stdout !== undefined) bits.push(`stdout=${JSON.stringify(p.stdout.slice(0, 160))}`);
    if (p.expected !== undefined && p.actual !== undefined) {
      bits.push(
        `expected=${JSON.stringify(p.expected.slice(0, 80))} actual=${JSON.stringify(p.actual.slice(0, 80))}`
      );
    }
    if (p.note) bits.push(`note=${JSON.stringify(p.note.slice(0, 80))}`);
    lines.push(
      `- ${JSON.stringify(p.cmd.slice(0, 120))}: ${bits.join(', ') || '(no outcome recorded)'}` +
        (mismatch ? '  <-- SELF-REPORTED MISMATCH' : '')
    );
  }
  lines.push(
    'Cross-check the read-back file contents against these records: a claim',
    'documented in a file that the child\'s own probe output contradicts (e.g. a',
    'documented exit code that differs from the recorded one) is a CONTRADICTION.'
  );
  return { lines, selfReportedFailure };
}

/**
 * Probe wrapper that reports whether the evidence CONTRADICTS the child's
 * claims, not just what the evidence says. See `GroundTruthCheck`.
 */
export async function checkGroundTruth(args: {
  ctx: RunContext;
  subject: 'PLAN' | 'RESULT';
  payload: unknown;
  child: Atom;
}): Promise<GroundTruthCheck> {
  const block = await probeGroundTruth(args);
  if (!block) return { block: '', contradiction: false };
  const contradiction =
    /: MISSING or unreadable/.test(block) ||
    /WARNING: file is EMPTY/.test(block) ||
    /but the tool call failed/.test(block) ||
    // The child's own probe record says an expectation did not hold. Nothing
    // read this before, so a self-reported mismatch could sail through the
    // trust fast-path unexamined.
    /<-- SELF-REPORTED MISMATCH/.test(block);
  return { block, contradiction };
}

async function probeGroundTruth(args: {
  ctx: RunContext;
  subject: 'PLAN' | 'RESULT';
  payload: unknown;
  /**
   * The child atom whose RESULT we are validating. We inspect its
   * declared tool names to decide whether a validate_html ground-truth
   * probe even makes sense: an HTTP-bucket L1 produces a JSON REST API
   * URL, and running Puppeteer against it returns "errors" that the
   * supervisor then (incorrectly) treats as a child failure. The probe
   * is a web-bucket invariant, not a universal one — #9.
   */
  child: import('../core/atom.js').Atom;
}): Promise<string> {
  if (args.subject !== 'RESULT') return '';
  if (args.ctx.signal?.aborted) return '';
  const tools = args.ctx.tools;
  if (!tools) return '';
  // Bucket dispatch. The two probes are MUTUALLY EXCLUSIVE: a child that
  // declares validate_html gets the web load-and-look probe below; every
  // other file-producing child gets the read-back probe (#F9). Running both
  // would double the cost and, for a non-web artefact, add Puppeteer noise
  // the validator reads as contradiction.
  if (!tools.has('validate_html') || !args.child.toolNames().includes('validate_html')) {
    return probeFilesGroundTruth(args);
  }
  // (Bucket gate handled by the dispatch above: reaching here means BOTH the
  // context and the child declare validate_html, so this really is a web
  // artefact. The gate exists because Helium — HTTP-scope — once returned a
  // bound API URL, the supervisor ran Puppeteer against the JSON endpoint,
  // read the errors as a contradiction, and cascaded into escalations.)
  const url = extractResultUrl(args.payload);
  if (!url) return '';

  try {
    // Minimal load-and-look probe: no interactions, no smoke. The goal is
    // "does this URL load cleanly?", not "does gameplay work?". Invented
    // interactions could false-positive-fail a working deliverable; the
    // clean-load bar is conservative.
    const raw = await tools.execute('validate_html', { url, waitMs: 1500 });
    const summary = summarizeValidateHtml(raw);
    return [
      '',
      '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
      `Supervisor independently re-ran validate_html on ${url}.`,
      'This is OBJECTIVE evidence — weight it above the child\'s self-reported claims.',
      'If this evidence contradicts the child\'s RESULT, REJECT the verdict.',
      summary,
    ].join('\n');
  } catch (err) {
    // Probe failures are themselves signal (e.g. URL unreachable → the
    // child's deliverable isn't actually running). Surface, don't swallow.
    return [
      '',
      '== GROUND-TRUTH EVIDENCE (independent re-validation) ==',
      `Supervisor tried to re-run validate_html on ${url} but the tool call failed:`,
      `  ${(err as Error).message}`,
      'This strongly suggests the child\'s deliverable is not actually running.',
    ].join('\n');
  }
}

/** Max files the read-back probe will open, and per-file excerpt budget. */
const FILE_PROBE_MAX_FILES = 6;
const FILE_PROBE_EXCERPT_CHARS = 400;

/**
 * File extensions the FREE-TEXT sweep will accept. A closed allowlist, not a
 * shape heuristic, because dotted identifiers are everywhere in these
 * summaries and any "looks like name.ext" rule swallows them: the slug-cli
 * run had `bin.main` and `scripts.start` — package.json KEY PATHS — read as
 * filenames, reported MISSING, and that false contradiction overrode the
 * trust fast-path on a perfectly good result. Since dotted keys are ubiquitous
 * (`scripts.start`, `engines.node`, `dependencies.express`), a loose rule
 * would defeat the fast-path systematically, which is the project's central
 * saving. Failing the other way is safe: an unusual real extension just means
 * the probe gathers less evidence, never a phantom contradiction.
 */
const PROBEABLE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'markdown', 'txt',
  'html', 'htm', 'css', 'scss', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'sh', 'bash', 'py', 'rb', 'sql', 'csv', 'tsv', 'xml', 'svg', 'lock',
]);

/**
 * Runtime and library names that are structurally indistinguishable from
 * filenames (`Node.js` has the same shape as `README.md`) and appear
 * constantly in summaries and READMEs. Measured over 85 recorded runs:
 * `Node.js` was the single most frequent prose "path" at 40 payloads, twice
 * the next entry, and every hit was noise. Prose mentions are advisory so
 * these never caused a false verdict, but skipping them saves a pointless
 * read attempt and keeps a probe slot for a real file.
 */
const NON_FILE_PROSE_TOKENS = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'three.js', 'd3.js', 'express.js',
  'react.js', 'angular.js', 'jquery.js', 'socket.io',
]);

/**
 * Extract the workspace-relative file paths a RESULT claims to have produced.
 * Mirrors `extractResultUrl`'s tolerance: structured fields first, then a
 * constrained free-text scan of `output` / `summary`.
 *
 * Two tiers of trust, deliberately different:
 *   - STRUCTURED fields (`output.path`, `output.files[]`, …) are explicit
 *     claims by the child, so any plausible extension is probed.
 *   - FREE TEXT is a guess we are making on its behalf, so it must clear
 *     `PROBEABLE_EXTENSIONS`. The extension must also start with a letter, or
 *     version strings like "1.0.0" parse as filenames.
 *
 * Absolute paths and `..` segments are dropped here rather than left for
 * `sandbox.resolve` to throw on: a path escaping the workspace is not
 * evidence about the deliverable, it is noise.
 *
 * Exported for tests.
 */
export function extractResultFilePaths(payload: unknown): string[] {
  const claims = extractResultFileClaims(payload);
  return [...claims.structured, ...claims.mentioned].slice(0, FILE_PROBE_MAX_FILES);
}

/**
 * File paths a RESULT refers to, split by how much they can be trusted as an
 * EXISTENCE CLAIM:
 *
 *   - `structured` — the child put the path in a dedicated field
 *     (`output.files[]`, `output.path`, `output.readme_path`, …). That is an
 *     explicit assertion that the file was produced, so a miss here is a real
 *     contradiction.
 *   - `mentioned` — the path only appears in prose. Prose is semantically
 *     blind: it cannot tell "the file I wrote" from "the file I confirm is
 *     GONE". The pad-cli run proved the cost of ignoring that distinction —
 *     the child correctly reported "no scaffolding files
 *     (_skill_document-cli-from-source.js) present" (F3 working as designed),
 *     the sweep read that as a claim of existence, and the phantom miss
 *     overrode the trust fast-path on a flawless result.
 *
 * The probe therefore reports mentioned paths only when they EXIST (as
 * corroboration) and never lets them signal a contradiction. `list_files`
 * already covers the "what is actually in the workspace" question, which is
 * the real defence against stray files.
 *
 * `_skill_*` scaffolding is excluded outright: it is framework-generated, and
 * its ABSENCE is the desired end state (see `removeScratchScript`).
 */
export function extractResultFileClaims(payload: unknown): {
  structured: string[];
  mentioned: string[];
} {
  const structured: string[] = [];
  const mentioned: string[] = [];
  const accept = (v: unknown, into: string[], requireKnownExt: boolean): void => {
    if (typeof v !== 'string') return;
    const p = v.trim();
    if (!p || p.startsWith('/') || p.includes('..') || /^https?:\/\//i.test(p)) return;
    if (/(^|\/)_skill_/.test(p)) return;
    const m = p.match(/\.([A-Za-z][A-Za-z0-9]{0,8})$/);
    if (!m) return;
    if (requireKnownExt) {
      if (!PROBEABLE_EXTENSIONS.has(m[1]!.toLowerCase())) return;
      if (NON_FILE_PROSE_TOKENS.has(p.toLowerCase())) return;
      // URL leftovers: the sweep runs after the scheme is gone, so
      // "http://localhost:8000/index.html" surfaces as "8000/index.html".
      // A leading all-digits segment is never a real workspace path.
      if (/^\d+\//.test(p)) return;
    }
    if (structured.includes(p) || mentioned.includes(p)) return;
    into.push(p);
  };
  const claim = (v: unknown): void => accept(v, structured, false);
  const mention = (v: unknown): void => accept(v, mentioned, true);

  if (!payload || typeof payload !== 'object') return { structured, mentioned };
  const obj = payload as Record<string, unknown>;
  const output = obj['output'];

  // STRUCTURED: dedicated fields. Any plausible extension is accepted here
  // because the child chose to put the path in a field, not in a sentence.
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const o = output as Record<string, unknown>;
    for (const key of ['paths', 'files', 'written']) {
      const arr = o[key];
      if (Array.isArray(arr)) for (const item of arr) claim(item);
    }
    // Any string field whose NAME advertises a path (`path`, `entry`,
    // `readme_path`, `output_file`, …). Observed in the wild: `readme_path`.
    for (const [key, value] of Object.entries(o)) {
      if (typeof value !== 'string') continue;
      if (/(^|_)(path|file|entry)s?$/i.test(key)) claim(value);
    }
  }
  if (Array.isArray(output)) for (const item of output) claim(item);
  claim(obj['path']);
  claim(output);

  // MENTIONED: prose sweep. Informational only — never a contradiction.
  const freeText: string[] = [];
  if (typeof output === 'string') freeText.push(output);
  if (typeof obj['summary'] === 'string') freeText.push(obj['summary'] as string);
  for (const text of freeText) {
    for (const m of text.matchAll(/[\w./-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,8}\b/g)) {
      mention(m[0]);
      if (structured.length + mentioned.length >= FILE_PROBE_MAX_FILES) break;
    }
  }
  const room = Math.max(0, FILE_PROBE_MAX_FILES - structured.length);
  return {
    structured: structured.slice(0, FILE_PROBE_MAX_FILES),
    mentioned: mentioned.slice(0, room),
  };
}

/**
 * #F9 — supervisor-side READ-BACK probe for file-producing children.
 *
 * Why it exists: `probeGroundTruth`'s web probe returns '' for any child that
 * does not declare `validate_html`, so a file-scribe L1's RESULT was judged on
 * SELF-REPORTING alone. Two failure modes followed from that. A child could
 * under-report its evidence and be rejected for it (costing a full supervise
 * cycle even though the deliverable was correct), and — worse — a FABRICATED
 * claim could pass every validator: on run 2026-07-25T22-10-42 a README
 * asserted a Node version requirement that drifted 10.0.0 → 14.0.0 → 12.0
 * across cycles while `package.json` had no `engines` field at all, and three
 * validators approved it.
 *
 * The probe reads the workspace back itself and hands the validator facts
 * instead of narration: which claimed paths exist, their real sizes, a bounded
 * excerpt of each, plus a `list_files` of the root (which also surfaces debris
 * the deliverable should not contain). It needs no prompt cooperation from the
 * child and no LLM call — only local fs tool calls.
 *
 * Deliberately conservative: it reports, and tells the validator to reject
 * only on a CONTRADICTION (claimed-but-missing, claimed-but-empty). A file
 * being smaller or differently worded than described is not grounds to fail —
 * that framing is what kept the web probe from producing false rejections.
 */
/**
 * Shape check for the on-disk probe manifest. The manifest is written by
 * PROMPT (L1 evidence contracts) and read by COMPILED SCRIPTS with no
 * validator in between — a malformed one silently breaks every future
 * deterministic dispatch, and the failure surfaces far from its cause
 * (observed: a third-generation HTTP verifier crashed on entries missing
 * the fields its shape expected). Returns human-readable problems for the
 * read-back evidence block; an EMPTY list means "well-formed or absent".
 *
 * Deliberately tolerant: unknown extra fields are fine (forward
 * compatibility), and a manifest mixing shell and http entries is VALID —
 * that is the documented contract. Only structural breakage is reported.
 */
export function validateProbeManifest(raw: string): string[] {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [`${PROBE_MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}`];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [`${PROBE_MANIFEST_FILENAME} must be a JSON object with an "entries" array`];
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1) {
    problems.push(`${PROBE_MANIFEST_FILENAME}: expected "version": 1, got ${JSON.stringify(obj['version'])}`);
  }
  const entries = obj['entries'];
  if (!Array.isArray(entries)) {
    problems.push(`${PROBE_MANIFEST_FILENAME}: "entries" must be an array`);
    return problems;
  }
  if (entries.length === 0) {
    problems.push(`${PROBE_MANIFEST_FILENAME}: "entries" is empty — nothing for a later pass to re-verify`);
  }
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`${PROBE_MANIFEST_FILENAME}: entry #${i} is not an object`);
      return;
    }
    const en = e as Record<string, unknown>;
    const isHttp = en['probe'] === 'http' || typeof en['path'] === 'string';
    if (isHttp) {
      if (typeof en['method'] !== 'string') problems.push(`entry #${i} (http): missing string "method"`);
      if (typeof en['path'] !== 'string') problems.push(`entry #${i} (http): missing string "path"`);
      if (typeof en['status'] !== 'number') problems.push(`entry #${i} (http): missing numeric "status"`);
    } else if (typeof en['cmd'] === 'string') {
      if (typeof en['exitCode'] !== 'number') problems.push(`entry #${i} (shell): missing numeric "exitCode"`);
    } else {
      problems.push(
        `entry #${i}: neither shell-shaped ("cmd" + "exitCode") nor http-shaped ("method" + "path" + "status")`
      );
    }
  });
  return problems;
}

async function probeFilesGroundTruth(args: {
  ctx: RunContext;
  payload: unknown;
  child: import('../core/atom.js').Atom;
}): Promise<string> {
  const tools = args.ctx.tools;
  if (!tools || !tools.has('read_file')) return '';
  // Only for children that actually write files — otherwise there is nothing
  // to read back and the probe would just add an empty evidence block.
  if (!args.child.toolNames().includes('write_file')) return '';
  const claims = extractResultFileClaims(args.payload);
  const recorded = renderRecordedProbes(extractRecordedProbes(args.payload));
  if (
    claims.structured.length === 0 &&
    claims.mentioned.length === 0 &&
    recorded.lines.length === 0
  ) {
    return '';
  }

  const lines: string[] = [];
  // Manifest health check — it is the interface later compiled verifiers
  // depend on, and nothing else audits it (written by prompt, read by
  // script). GATED on the child having reported probes: only then is a
  // manifest expected, so a plain file-scribe deliverable pays no extra
  // tool call (the exact-call-count assertions in the #F9 tests are a
  // deliberate cost guard — respect them).
  if (recorded.lines.length > 0) try {
    const rawManifest = await tools.execute('read_file', { path: PROBE_MANIFEST_FILENAME });
    const text =
      rawManifest && typeof rawManifest === 'object' && typeof (rawManifest as Record<string, unknown>)['content'] === 'string'
        ? ((rawManifest as Record<string, unknown>)['content'] as string)
        : typeof rawManifest === 'string'
          ? rawManifest
          : '';
    if (text.trim().length > 0) {
      const problems = validateProbeManifest(text);
      lines.push(
        problems.length === 0
          ? `${PROBE_MANIFEST_FILENAME}: well-formed (machine-readable probe record present)`
          : `${PROBE_MANIFEST_FILENAME}: MALFORMED — ${problems.slice(0, 4).join('; ')}`
      );
    }
  } catch {
    // Absent manifest is normal for non-runnable deliverables — say nothing.
  }
  for (const [path, isClaim] of [
    ...claims.structured.map((p) => [p, true] as const),
    ...claims.mentioned.map((p) => [p, false] as const),
  ]) {
    if (args.ctx.signal?.aborted) return '';
    try {
      const raw = await tools.execute('read_file', { path });
      const content =
        raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['content'] === 'string'
          ? ((raw as Record<string, unknown>)['content'] as string)
          : typeof raw === 'string'
            ? raw
            : JSON.stringify(raw);
      const excerpt = content.slice(0, FILE_PROBE_EXCERPT_CHARS);
      lines.push(
        `- ${path}: EXISTS (${content.length} chars)` +
          (content.trim().length === 0 && isClaim ? ' — WARNING: file is EMPTY' : '') +
          `\n    excerpt: ${JSON.stringify(excerpt)}${content.length > excerpt.length ? ' …(truncated)' : ''}`
      );
    } catch (err) {
      // A miss is only reportable for a STRUCTURED claim. A prose mention that
      // does not resolve is usually the child saying a file is absent — which
      // is often the DESIRED state — so reporting it would invent a
      // contradiction out of a correct statement.
      if (isClaim) {
        lines.push(`- ${path}: MISSING or unreadable (${(err as Error).message})`);
      }
    }
  }
  if (lines.length === 0 && recorded.lines.length === 0) return '';

  let listing = '';
  if (tools.has('list_files') && !args.ctx.signal?.aborted) {
    try {
      const raw = (await tools.execute('list_files', { path: '.' })) as {
        entries?: Array<{ name?: string; kind?: string; size?: number }>;
      } | null;
      const entries = Array.isArray(raw?.entries) ? raw!.entries! : [];
      listing = entries
        .map((e) => `${e.name}${e.kind === 'dir' ? '/' : ''} (${e.size ?? '?'}b)`)
        .join(', ');
    } catch {
      /* listing is a bonus, not a requirement */
    }
  }

  return [
    '',
    '== GROUND-TRUTH EVIDENCE (independent file read-back) ==',
    'The supervisor re-read the workspace itself. This is OBJECTIVE evidence —',
    "weight it above the child's self-reported claims.",
    ...lines,
    listing ? `workspace root now contains: ${listing}` : '',
    ...recorded.lines,
    '',
    'REJECT only on a CONTRADICTION with this evidence — a file the RESULT',
    'claims but which is MISSING or EMPTY, a documented statement the excerpts',
    'or the recorded probe outputs refute, or a SELF-REPORTED MISMATCH above.',
    'Do NOT reject merely because an excerpt is truncated here, or because the',
    'child described a file more briefly than its contents.',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeValidateHtml(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return `result: ${JSON.stringify(raw)}`;
  const r = raw as Record<string, unknown>;
  const ok = r['ok'];
  const errors = Array.isArray(r['errors']) ? (r['errors'] as unknown[]) : [];
  const failedRequests = Array.isArray(r['failedRequests'])
    ? (r['failedRequests'] as unknown[])
    : [];
  const lines = [
    `ok: ${ok === true ? 'true' : 'false'}`,
    `consoleErrors: ${errors.length}`,
    `failedRequests: ${failedRequests.length}`,
  ];
  if (errors.length > 0) {
    lines.push(`errors: ${JSON.stringify(errors.slice(0, 5))}`);
  }
  if (failedRequests.length > 0) {
    lines.push(`failedRequests: ${JSON.stringify(failedRequests.slice(0, 5))}`);
  }
  return lines.join('\n');
}
