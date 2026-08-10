import type { GenerationParams, Result, RunContext, Task } from '../core/types.js';
import type { L1Atom } from '../atoms/L1Atom.js';
import type { Skill } from './types.js';
import { SkillRegistry } from './registry.js';
import {
  demoteAfter,
  postApprovalSignal,
  prefilterStrategy,
  promoteThreshold,
  SKILL_PREFILTER_SYSTEM_PROMPT,
} from '../atoms/cost.js';
import { parseScriptEnvelope, scriptDeclaresEnvelope } from '../contracts/scriptEnvelope.js';
import { extractJson } from '../atoms/json.js';
import { extractResultFilePaths } from '../atoms/groundTruth.js';
import { buildCompileSkillPrompt, COMPILE_PROMPT_GENERATION } from './compilePrompt.js';
import { scriptInterpreter, scriptScratchFilename } from './abi.js';
import { hostAllowsLoopbackNetwork, scanScriptBody } from './scriptScan.js';
import { LEARNED_CONTENT_TRUST_BOUNDARY_LINES } from './events.js';
import { REFUSAL_GENERATION, refusalStampIsCurrent } from './generations.js';
import { undeclaredToolMentions } from '../atoms/verdict.js';

// Historical export home — the generation machinery lives in generations.ts
// (stats/curriculum need the predicate without importing this whole engine).
export { REFUSAL_GENERATION, refusalStampIsCurrent } from './generations.js';

/**
 * SKILL LIFECYCLE ENGINE — extracted from L2Atom (structural slice 2).
 * ====================================================================
 * Everything a supervisor does to its L1 children's persistent skills:
 * match (prefilter) → inject, learn (distill on approved novel runs),
 * revise (on escalation), promote llm→script (compile at trust), dispatch
 * a trusted script with ZERO LLM calls, and demote on deterministic-
 * failure streaks. The behaviour, prompts and guards are verbatim from
 * L2Atom — the move gives the ~600-line engine its own module boundary,
 * its own import surface (auditable: which LLM calls it can make), and a
 * host interface instead of supervisor internals.
 *
 * The HOST is the supervising atom: the engine needs its identity (log
 * prefix), its model (distill/compile/revise ride the supervisor tier),
 * its params and its effective system prompt. It deliberately does NOT
 * get the atom itself — the engine cannot reach the registry, the tools
 * or the supervise loop.
 */
export interface SkillLifecycleHost {
  readonly name: string;
  readonly model: string;
  readonly params: GenerationParams;
  effectiveSystemPrompt(): string;
}

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
  const id = typeof obj['id'] === 'string' ? (obj['id']).trim() : null;
  const description =
    typeof obj['description'] === 'string' ? (obj['description']).trim() : null;
  const whenToUseRaw =
    typeof obj['when_to_use'] === 'string'
      ? (obj['when_to_use'])
      : typeof obj['whenToUse'] === 'string'
        ? (obj['whenToUse'])
        : null;
  const whenToUse = whenToUseRaw ? whenToUseRaw.trim() : null;
  const body = typeof obj['body'] === 'string' ? (obj['body']).trim() : null;
  if (!id || !description || !whenToUse || !body) return null;
  return { id, description, whenToUse, body };
}

export function parseSkillDraft(text: string): SkillDraft | null {
  const obj = extractDraftObject(text);
  return obj ? coerceSkillDraft(obj) : null;
}

/**
 * Shared extraction for the draft parsers, on the house parser instead of
 * a greedy first-{-to-last-} regex. The regex slice failed exactly where
 * distillation output gets interesting — a fenced payload followed by any
 * trailing brace in prose, or a response truncated mid-string — and each
 * failure silently discarded a PAID Sonnet learning event (debug-log +
 * skip is the documented policy, but the parser should not manufacture
 * skips). extractJson is fence-aware, prefers the last candidate, and
 * repairs truncation.
 */
function extractDraftObject(text: string): Record<string, unknown> | null {
  if (!text || text.trim().length === 0) return null;
  try {
    const value = extractJson(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // extractJson throws on JSON-free text; the draft contract is
    // tolerant — a malformed distillation is debug-log + skip upstream.
    return null;
  }
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
/**
 * Draft shape for EVENT-DRIVEN skill distillation: same contract as
 * `SkillDraft` plus the mandatory `trigger` (event signature the runtime
 * matcher keys on). `when_to_use` is optional in the response and
 * defaults to the trigger — for an event skill the activation condition
 * IS the event.
 */
export interface EventSkillDraft extends SkillDraft {
  trigger: string;
}

export function parseEventSkillDraft(text: string): EventSkillDraft | null {
  const obj = extractDraftObject(text);
  if (!obj) return null;
  const trigger = typeof obj['trigger'] === 'string' ? (obj['trigger']).trim() : null;
  if (!trigger) return null;
  const base = coerceSkillDraft({
    ...obj,
    ...(!obj['when_to_use'] && !obj['whenToUse'] ? { when_to_use: trigger } : {}),
  });
  if (!base) return null;
  return { ...base, trigger };
}

export function parseSkillDrafts(text: string): SkillDraft[] {
  const obj = extractDraftObject(text);
  if (!obj) return [];
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
    const interpreter = scriptInterpreter(skill.language ?? 'node');
    const filename = scriptScratchFilename(skill.id, skill.language ?? 'node');
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
    ...LEARNED_CONTENT_TRUST_BOUNDARY_LINES,
    ``,
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

export class SkillLifecycle {
  constructor(
    private readonly host: SkillLifecycleHost,
    private readonly skills: SkillRegistry
  ) {}

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
  async learnSkillFromRun(args: {
    l1Name: string;
    subTask: Task;
    result: Result;
    child: L1Atom;
    ctx: RunContext;
    /**
     * Visibility-lattice list (home first). The no-overwrite guard extends
     * across it (commit C): an id owned by a VISIBLE donor is never
     * re-created at home — under the lattice the existing recipe would
     * have matched, so a same-id draft is a twin in the making.
     */
    visibleNamespaces?: readonly string[];
  }): Promise<void> {
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
      `DECLARED TOOLS (this atom's ONLY executable surface): ${args.child.toolNames().join(', ') || '(none)'}`,
      ``,
      `== SUBTASK THAT WAS COMPLETED ==`,
      args.subTask.description,
      ``,
      `== L1 SUMMARY OF WHAT IT DID ==`,
      args.result.summary,
      ``,
      `HARD RULE — TOOLSET SCOPE: every step of every draft must be executable`,
      `with the DECLARED TOOLS above and nothing else. Distil what the run's`,
      `ACTIONS demonstrate, never what the subtask text or the summary merely`,
      `INTENDED: a recipe teaching a tool this atom cannot call is a recipe`,
      `for a phase that silently never happens (observed: two skills taught`,
      `"validate_html" on an HTTP-bucket atom that cannot declare it — the`,
      `plan had demanded it, the run never did it, the recipes encoded the`,
      `phantom). If the run's real verification happened over fetch_url,`,
      `teach THAT.`,
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
      `workspace alone (the entry file, the .atoma-probes.json manifest when`,
      `the run wrote one, fixture files present on disk).`,
      `INPUT PRECEDENCE — this decides whether the recipe can ever compile:`,
      `when the run wrote .atoma-probes.json, step 1 of the verification`,
      `recipe MUST read THAT. A README is at best a named fallback, never the`,
      `authority. A recipe whose first step extracts expectations from`,
      `free-form markdown is refused at compile time as irreducible judgment`,
      `— correctly, and twice measured. Never name an input the run did not`,
      `actually produce.`,
      `Do NOT emit "verification" when checking`,
      `was a single trivial read-back, or when it cannot be described without`,
      `design judgment. The primary skill keeps its own inline verification`,
      `steps regardless — the split copy is the standalone, reusable version.`,
      ``,
      `Skip the JSON entirely (return empty) if the run was too task-specific to`,
      `generalise (e.g. it depended on hard-coded numbers a future run wouldn't`,
      `share).`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.host.model,
      systemPrompt: this.host.effectiveSystemPrompt(),
      userContent,
      // 1600, not 800: the optional verification split can double the JSON,
      // and on 5-series models adaptive thinking shares this cap with the
      // response — a truncated draft is a silently lost learning event.
      params: { ...this.host.params, maxTokens: 1600, temperature: 0 },
      // Post-approval bookkeeping: own budget, never the run deadline.
      signal: postApprovalSignal(),
    });
    const drafts = parseSkillDrafts(resp.text);
    if (drafts.length === 0) {
      args.ctx.logger.debug(
        `[${this.host.name}] skill draft did not parse, skipping; raw=${resp.text.slice(0, 120)}`
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
          `[${this.host.name}] skill auto-creation rejected: unsafe id "${draft.id}"`
        );
        continue;
      }
      const guardNs = args.visibleNamespaces?.length
        ? args.visibleNamespaces
        : [args.l1Name];
      const existingNs = guardNs.find((ns) =>
        this.skills.loadFor(ns).some((s) => s.id === draft.id)
      );
      if (existingNs) {
        args.ctx.logger.debug(
          `[${this.host.name}] skill ${draft.id} already exists in visible namespace ${existingNs}, not overwriting`
        );
        continue;
      }
      // Mechanical toolset filter — the code half of the F2 fix (the prompt
      // rule above is the persuasion half). A draft teaching a tool the host
      // cannot call encodes an intention the run never executed; skipping it
      // is fail-open (a missed skill is cheap, a phantom recipe measured
      // expensive: it matches, injects an unexecutable step, and farms
      // counters toward compiling a workflow that never demonstrably ran).
      const outOfScope = undeclaredToolMentions(draft.body, args.child.toolNames());
      if (outOfScope.length > 0) {
        args.ctx.logger.warn(
          `[${this.host.name}] skill draft "${draft.id}" rejected: body teaches undeclared tool(s) ${outOfScope.join(', ')} (host ${args.l1Name} declares: ${args.child.toolNames().join(', ')})`
        );
        continue;
      }
      this.skills.save(args.l1Name, {
        id: draft.id,
        description: draft.description,
        whenToUse: draft.whenToUse,
        kind: 'llm',
        body: draft.body,
      }, { mechanism: 'distilled', model: this.host.model });
      args.ctx.logger.info(
        `[${this.host.name}] learned new skill "${draft.id}" for ${args.l1Name}`
      );
      args.ctx.recordSkill?.({
        op: 'learn',
        l1Name: args.l1Name,
        skillId: draft.id,
        actorName: this.host.name,
        actorTier: 2,
        reasoning: draft.description,
      });
    }
  }

  /**
   * Distill an EVENT-DRIVEN recovery skill from a RECOVERED run (#E1):
   * the supervise loop rejected at least one attempt, the child adapted,
   * and the result was ultimately approved without parent fallback. The
   * delta between the rejection diagnosis and the eventually-approved
   * attempt IS the recovery pattern — keyed on the EVENT signature
   * (trigger) so future runs hitting the same complaint get the guidance
   * injected mid-loop instead of rediscovering the fix.
   *
   * Called from `L2.runSubtask` AFTER the loop returns (the hooks never
   * see the trace); gated by the caller on ATOMA_SKILL_LEARN, on the run
   * NOT being a fallback deliverable, and on NO event skill having been
   * injected during the run (novel event — mirrors the C3 "we looked and
   * found nothing" rule). Same guards as task-skill distillation: unsafe
   * id → skip, existing id → never overwrite, malformed JSON → skip.
   * Costs one Sonnet call per learning event.
   */
  async learnEventSkillFromRecovery(args: {
    l1Name: string;
    subTask: Task;
    /** Verbatim rejection diagnosis (extractBranchDiagnostic output). */
    diagnostic: string;
    /** Summary of the eventually-approved attempt. */
    recoverySummary: string;
    ctx: RunContext;
  }): Promise<void> {
    const userContent = [
      `You are distilling a RECOVERED run into an EVENT-DRIVEN recovery skill —`,
      `a short guidance note injected into future retry attempts when the same`,
      `failure pattern appears, so the next run fixes it on the FIRST retry.`,
      ``,
      `A tier-1 element's attempt was rejected by the validator, the element`,
      `adapted, and the reworked result was approved. Extract the general`,
      `recovery pattern.`,
      ``,
      `== VALIDATOR REJECTION (verbatim) ==`,
      args.diagnostic,
      ``,
      `== SUBTASK ==`,
      args.subTask.description,
      ``,
      `== SUMMARY OF THE EVENTUALLY-APPROVED ATTEMPT ==`,
      args.recoverySummary,
      ``,
      `Output ONLY a JSON object — no fences, no preamble. The first character`,
      `must be "{". Required fields:`,
      `  "id":          kebab-case identifier starting with "recover-", like`,
      `                 "recover-missing-ground-truth-evidence".`,
      `  "trigger":     compact signature of the EVENT, ≤120 chars — the words a`,
      `                 future validator complaint about the SAME failure class`,
      `                 would contain. Describe the COMPLAINT, not this task.`,
      `  "description": one-line summary of the recovery, ≤90 chars.`,
      `  "body":        recovery guidance, ≤400 chars. What to do DIFFERENTLY on`,
      `                 the retry when this complaint appears — concrete steps,`,
      `                 not prose.`,
      ``,
      `THE TRIGGER AND BODY MUST GENERALISE. Use placeholders for anything`,
      `specific to this run (file names, argument values, themes). The trigger`,
      `must describe the failure CLASS ("validator rejects narrative-only`,
      `summaries lacking pasted evidence"), never this task's subject matter —`,
      `a task-themed trigger will never match a future event text.`,
      ``,
      `Skip the JSON entirely (return empty) when the failure was environmental`,
      `(timeout, port collision, transient tool error) or too task-specific to`,
      `recur — a recovery note for a one-off is catalog noise.`,
    ].join('\n');

    const resp = await args.ctx.llm.complete({
      model: this.host.model,
      systemPrompt: this.host.effectiveSystemPrompt(),
      userContent,
      params: { ...this.host.params, maxTokens: 1200, temperature: 0 },
      // Post-approval bookkeeping: own budget, never the run deadline.
      signal: postApprovalSignal(),
    });
    const draft = parseEventSkillDraft(resp.text);
    if (!draft) {
      args.ctx.logger.debug(
        `[${this.host.name}] event-skill draft did not parse, skipping; raw=${resp.text.slice(0, 120)}`
      );
      return;
    }
    if (!isSafeSkillId(draft.id)) {
      args.ctx.logger.warn(
        `[${this.host.name}] event-skill creation rejected: unsafe id "${draft.id}"`
      );
      return;
    }
    if (this.skills.loadFor(args.l1Name).some((s) => s.id === draft.id)) {
      args.ctx.logger.debug(
        `[${this.host.name}] event skill ${draft.id} already exists for ${args.l1Name}, not overwriting`
      );
      return;
    }
    this.skills.save(
      args.l1Name,
      {
        id: draft.id,
        description: draft.description,
        whenToUse: draft.whenToUse,
        kind: 'llm',
        trigger: draft.trigger,
        body: draft.body,
      },
      { mechanism: 'distilled', model: this.host.model }
    );
    args.ctx.logger.info(
      `[${this.host.name}] learned event skill "${draft.id}" for ${args.l1Name} (trigger: ${draft.trigger})`
    );
    args.ctx.recordSkill?.({
      op: 'learn',
      l1Name: args.l1Name,
      skillId: draft.id,
      actorName: this.host.name,
      actorTier: 2,
      reasoning: `event-driven; trigger: ${draft.trigger}`,
    });
  }

  /**
   * Generate an improved skill body via a Sonnet call (this.host.model).
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
   * Sonnet (this.host.model) is the right model here:
   *  - the task is real reasoning (synthesise a fix from a
   *    diagnostic), not yes/no validation;
   *  - Haiku would routinely flatten the body or miss the precise
   *    diagnostic detail;
   *  - Opus would be overkill for the bounded context.
   */
  async improveSkillBody(args: {
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
      model: this.host.model,
      systemPrompt: this.host.effectiveSystemPrompt(),
      userContent,
      params: { ...this.host.params, maxTokens: 1500, temperature: 0 },
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
  async tryPromoteSkill(args: {
    l1Name: string;
    skillId: string;
    subTask: Task;
    result: Result;
    ctx: RunContext;
    /**
     * DECLARED tools of the host L1. The static scan reads them to decide
     * whether network primitives are legitimate for this skill's family —
     * an atom handed `fetch_url` / `start_node_server` was built to probe
     * servers, so a compiled prober using fetch is correct, not suspect.
     */
    hostTools?: readonly string[];
  }): Promise<void> {
    if (process.env['ATOMA_SKILL_PROMOTE'] !== '1') return;
    const skills = this.skills.loadFor(args.l1Name);
    const skill = skills.find((s) => s.id === args.skillId);
    if (!skill) return;
    if (skill.kind !== 'llm') return;
    if (skill.failures > 0) return;
    if (skill.successes < promoteThreshold()) return;
    if (skill.promotionRefusedAt && !refusalStampIsCurrent(skill.promotionRefusedGeneration)) {
      // The stamp predates the CURRENT compiler. Its premise ("recompiling
      // this body reproduces the same script") is false once the compile
      // prompt itself changed, so give the evolved compiler exactly one
      // shot — this is what used to require a manual operator reset when a
      // new contract (e.g. the probe manifest) landed. The predicate knows
      // both stamp currencies — see generations.ts; strict comparison
      // against REFUSAL_GENERATION alone treated every demotion stamp
      // (compile-only currency) as stale, defeating the anti-thrash guard
      // for freshly-compiled scripts that fail deterministically.
      args.ctx.logger.info(
        `[${this.host.name}] skill "${args.skillId}" refusal stamp is from an older compiler/scan generation (${skill.promotionRefusedGeneration ?? 'legacy'} → ${REFUSAL_GENERATION}); retrying the compile`
      );
      this.skills.clearPromotionRefusal(args.l1Name, args.skillId);
    } else if (skill.promotionRefusedAt) {
      // Sonnet already declined to compile this body. Skip the call
      // until the body changes (which clears the stamp via save) or
      // the operator manually clears it. Without this gate every
      // future success on a structurally non-promotable skill burns
      // ~$0.005 (1 Sonnet call returning the same refusal).
      args.ctx.logger.debug(
        `[${this.host.name}] skill "${args.skillId}" promotion previously refused at ${skill.promotionRefusedAt}; skipping`
      );
      return;
    }
    args.ctx.logger.info(
      `[${this.host.name}] skill "${args.skillId}" eligible for promotion (${skill.successes} successes / 0 failures); attempting compile`
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
        `[${this.host.name}] skill compile errored: ${(err as Error).message}; leaving as kind:llm`
      );
      return;
    }
    if (!compiled.promotable) {
      args.ctx.logger.info(
        `[${this.host.name}] skill "${args.skillId}" not promotable: ${compiled.reason}`
      );
      // Stamp the refusal so the gate above short-circuits on every
      // subsequent success until the body changes. This is the
      // anti-thrash guard: in the LoL-SSR run we observed Sonnet
      // refuse a structurally non-promotable recipe (schema design,
      // API shape choice) — we don't want to pay $0.005 to learn
      // the same fact on every future success of the same recipe.
      this.skills.markPromotionRefused(
        args.l1Name,
        args.skillId,
        compiled.reason,
        REFUSAL_GENERATION
      );
      args.ctx.recordSkill?.({
        op: 'promote',
        l1Name: args.l1Name,
        skillId: args.skillId,
        actorName: this.host.name,
        actorTier: 2,
        reasoning: `refused: ${compiled.reason}`,
      });
      return;
    }
    // STATIC SCAN GATE — a compiled body that reaches for the network,
    // dynamic code or credential paths is refused BEFORE it ever becomes
    // a kind:script skill (see src/skills/scriptScan.ts). The refusal
    // rides the existing anti-thrash stamp: generation-scoped, so an
    // evolved compiler gets one fresh shot, and `skills reset` remains
    // the operator override after review.
    const scanFlags = scanScriptBody(compiled.body, {
      allowLoopbackNetwork: hostAllowsLoopbackNetwork(args.hostTools ?? []),
    });
    if (scanFlags.length > 0) {
      const reason = `static scan flagged the compiled body: ${scanFlags.join(', ')}`;
      args.ctx.logger.warn(
        `[${this.host.name}] skill "${args.skillId}" promotion BLOCKED — ${reason}`
      );
      this.skills.markPromotionRefused(
        args.l1Name,
        args.skillId,
        reason,
        REFUSAL_GENERATION
      );
      args.ctx.recordSkill?.({
        op: 'promote',
        l1Name: args.l1Name,
        skillId: args.skillId,
        actorName: this.host.name,
        actorTier: 2,
        reasoning: `refused: ${reason}`,
      });
      return;
    }
    this.skills.promoteToScript({
      l1Name: args.l1Name,
      skillId: args.skillId,
      language: compiled.language,
      scriptBody: compiled.body,
      compiledGeneration: COMPILE_PROMPT_GENERATION,
      compiledBy: this.host.model,
    });
    args.ctx.logger.info(
      `[${this.host.name}] skill "${args.skillId}" promoted to kind:script (${compiled.language}, ${compiled.body.length} chars)`
    );
    args.ctx.recordSkill?.({
      op: 'promote',
      l1Name: args.l1Name,
      skillId: args.skillId,
      actorName: this.host.name,
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
      model: this.host.model,
      systemPrompt: this.host.effectiveSystemPrompt(),
      userContent,
      // `effort: 'medium'` is load-bearing on the claude-cli transport,
      // where maxTokens is advisory-only: at the default 'high' a compile
      // ran ~7 minutes / ~20k thinking+output tokens through the subprocess
      // and was killed by the run deadline twice (rehearsal runs 4 and 5).
      params: { ...this.host.params, maxTokens: 4000, temperature: 0, effort: 'medium' },
      // Post-approval bookkeeping: own budget, never the run deadline.
      signal: postApprovalSignal(),
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
  async matchSkill(
    namespaces: readonly string[],
    readerToolNames: readonly string[],
    subTask: Task,
    ctx: RunContext
  ): Promise<{ skill: Skill; ownerNs: string; reasoning: string } | null> {
    // Event-driven skills (trigger set) are recovery guidance matched
    // against MID-RUN events, not task recipes — offering them to the
    // task prefilter would let Haiku "reuse" a rejection-recovery hint
    // as the driving recipe for a whole subtask.
    //
    // SHARED CATALOG (commit B): `namespaces` is the visibility-lattice
    // list — home FIRST (its entries are policed at birth and never
    // filtered here, keeping the home path byte-identical to the per-L1
    // world), then executable donor namespaces in deterministic order.
    const home = namespaces[0]!;
    const readerSet = new Set(readerToolNames);
    const tagged: { skill: Skill; ownerNs: string }[] = [];
    const seenIds = new Set<string>();
    for (const ns of namespaces) {
      for (const s of this.skills.loadFor(ns)) {
        if (s.trigger) continue;
        if (ns !== home) {
          // Donor per-skill filters — the lattice's third leg:
          // (a) kind:script bodies are Node source the text scan cannot
          //     read; their executability is the invocation ABI itself
          //     (write scratch file + run it) — review change R1. Without
          //     this, a web reader lacking run_shell could trigger shell
          //     execution through trusted dispatch, or brick a donor's
          //     earned counters by failing runs it can never drive.
          // (b) kind:llm recipes teaching a tool the reader cannot call
          //     are phantoms for THIS reader (the F2 machinery, reused).
          if (s.kind === 'script') {
            if (!readerSet.has('write_file') || !readerSet.has('run_shell')) continue;
          } else if (undeclaredToolMentions(s.body, readerToolNames).length > 0) {
            continue;
          }
          // Id collision: home wins; among donors, first in sorted order
          // wins. Catalog lines keep the bare id (prompt stability), so
          // duplicates would be ambiguous anyway.
          if (seenIds.has(s.id)) {
            ctx.logger.debug(
              `[${this.host.name}] shared-catalog collision on skill id "${s.id}" — keeping the earlier namespace's entry, dropping ${ns}'s`
            );
            continue;
          }
        }
        if (seenIds.has(s.id)) continue;
        seenIds.add(s.id);
        tagged.push({ skill: s, ownerNs: ns });
      }
    }
    if (tagged.length === 0) return null;
    const outcome = await prefilterStrategy({
      ctx,
      task: subTask,
      catalog: tagged.map(({ skill: s }) => ({
        name: s.id,
        description: `${s.description}. When to use: ${s.whenToUse}`,
      })),
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
      actor: { name: this.host.name, tier: 2 },
    });
    if (!outcome || outcome.kind !== 'reuse') return null;
    const matched = tagged.find(({ skill: s }) => s.id === outcome.target);
    if (!matched) return null;
    return { skill: matched.skill, ownerNs: matched.ownerNs, reasoning: outcome.reasoning };
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
  async runScriptSkillDirect(
    skill: Skill,
    l1Name: string,
    subTask: Task,
    ctx: RunContext
  ): Promise<Result | null> {
    if (!skill.language) return null;
    if (!scriptDeclaresEnvelope(skill.body)) {
      ctx.logger.debug(
        `[${this.host.name}] direct dispatch of ${skill.id} skipped: body never emits an {"output","summary"} envelope — running the LLM loop instead (no side effects)`
      );
      return null;
    }
    const filename = scriptScratchFilename(skill.id, skill.language);
    const interpreter = scriptInterpreter(skill.language);
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
          `[${this.host.name}] direct dispatch of ${skill.id} failed (exit=${res?.exitCode ?? '?'}; stderr=${(res?.stderr ?? '').slice(0, 200)}) — falling back to the LLM loop`
        );
        this.noteDirectFailure(l1Name, skill, ctx);
        return null;
      }
      const envelope = parseScriptEnvelope(res.stdout);
      if (!envelope) {
        ctx.logger.debug(
          `[${this.host.name}] direct dispatch of ${skill.id}: stdout carried no {"output","summary"} envelope — falling back to the LLM loop`
        );
        this.noteDirectFailure(l1Name, skill, ctx);
        return null;
      }
      // DELIVERABLE GATE. The envelope parse is the only thing standing
      // between a script's self-report and a recorded success — and a
      // script cannot know what subtask it was matched to. MEASURED: the
      // compiled CLI verifier, handed the subtask "Write a README.md
      // documenting the CLI usage", replayed the manifest, printed a valid
      // envelope, exited 0, and wrote NO README — and because this path
      // returns before superviseLoop, no validator ever saw it, the skill
      // was credited, and the phantom success entrenched the script. So:
      // any file the SUBTASK names (not the result — that is the claim we
      // distrust) must exist afterwards, or the deliverable was not
      // produced and the validated LLM loop takes over. Costs zero tokens
      // (local fs reads) and no counter moves either way. Deliberately
      // strict: a false positive only pays for the LLM loop, a false
      // negative entrenches a broken script.
      const namedPaths = extractResultFilePaths({ summary: subTask.description });
      if (namedPaths.length > 0 && ctx.tools?.has('read_file')) {
        const missing: string[] = [];
        for (const path of namedPaths) {
          if (ctx.signal?.aborted) break;
          try {
            const got = await ctx.tools.execute('read_file', { path });
            const content =
              got && typeof got === 'object'
                ? (got as Record<string, unknown>)['content']
                : got;
            if (typeof content !== 'string') missing.push(path);
          } catch {
            missing.push(path);
          }
        }
        if (missing.length > 0) {
          ctx.logger.info(
            `[${this.host.name}] direct dispatch of ${skill.id} produced no ${missing.join(', ')} — the subtask names ${missing.length === 1 ? 'that file' : 'those files'} as its deliverable, so the script did not do this job; routing through the validated LLM loop (no counter moved)`
          );
          return null;
        }
      }
      this.skills?.clearDirectFailures(l1Name, skill.id);
      this.skills?.recordSuccess(l1Name, skill.id);
      ctx.recordSkill?.({
        op: 'direct',
        l1Name,
        skillId: skill.id,
        actorName: this.host.name,
        actorTier: 2,
        reasoning: `deterministic ${skill.language} run: exit 0, envelope ok (${res.stdout.length} chars stdout)`,
      });
      ctx.recordSkill?.({
        op: 'success',
        l1Name,
        skillId: skill.id,
        actorName: this.host.name,
        actorTier: 2,
        reasoning: 'direct dispatch succeeded',
      });
      ctx.logger.debug(
        `[${this.host.name}] skill ${skill.id} ran via deterministic dispatch (0 LLM calls)`
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
        `[${this.host.name}] direct dispatch of ${skill.id} threw: ${(err as Error).message} — falling back to the LLM loop`
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
  noteDirectFailure(l1Name: string, skill: Skill, ctx: RunContext): void {
    const streak = this.skills.markDirectFailure(l1Name, skill.id);
    if (streak < demoteAfter()) return;
    const demoted = this.skills.demoteToLlm(l1Name, skill.id);
    if (!demoted) {
      // No _fallback.md (hand-authored script) — nothing to restore. The
      // pre-flight envelope gate is what keeps such skills mostly harmless.
      ctx.logger.warn(
        `[${this.host.name}] script skill "${skill.id}" hit ${streak} deterministic failures but has no llm fallback — leaving as-is`
      );
      return;
    }
    ctx.logger.warn(
      `[${this.host.name}] script skill "${skill.id}" demoted to llm after ${streak} consecutive deterministic failures (fallback recipe restored)`
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
    this.skills.markPromotionRefused(
      l1Name,
      skill.id,
      `auto-demoted: compiled form failed ${streak} consecutive deterministic dispatches — recompiling the SAME body with the SAME compiler would reproduce it; revise the body or wait for a compiler change`,
      skill.compiledGeneration ?? COMPILE_PROMPT_GENERATION
    );
    ctx.recordSkill?.({
      op: 'demote',
      l1Name,
      skillId: skill.id,
      actorName: this.host.name,
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
}
