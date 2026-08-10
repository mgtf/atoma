import { modelForTier } from '../core/models.js';
import type { Result, RunContext, Task, Tool } from '../core/types.js';

/**
 * SINGLE-AGENT FRONTIER BASELINE — the control arm of the cost experiment.
 *
 * WHAT IT IS: one frontier-model agent, given the same nine tools, the same
 * sandbox, the same task text and the same run budget as atoma, running a
 * plain tool-use loop until it declares itself done. No tiering, no
 * supervision, no learned recipes, no independent verification — it
 * self-certifies. That is deliberate: it is what a competent engineer gets
 * from a from-scratch agent, and therefore the number atoma has to beat.
 *
 * WHY IT LIVES INSIDE `runTask` RATHER THAN IN ITS OWN CLI. A separate
 * entrypoint would have to re-create the sandbox, the tool wiring, the
 * metrics wrapper, the trace recorder, the abort budget and the watchdog —
 * and this repo has measured, twice, what happens to a second copy of that
 * scaffolding: `research-brief.ts` drifted away from every safety guarantee
 * the build path gained, and `curriculum.ts`'s duplicated provider switch
 * stopped matching the original. Here the baseline swaps exactly ONE line of
 * `runTask` (the `l3.handle` call). Everything that could bias a cost
 * comparison — the price table, the token accounting, the cache behaviour,
 * the tool implementations, the timeout — is therefore not merely "the same
 * by intention" but literally the same code on both arms.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch the atom registry or the skill
 * store. The baseline has no taxonomy to seed and nothing to learn, and a
 * control arm that mutated the treatment arm's state would invalidate the
 * whole experiment. `runTask` skips seeding entirely in this mode.
 */

/**
 * Tool-loop budget. atoma's L1 gets 24 rounds (40 with a browser) but only
 * ever handles ONE subtask; the baseline does the entire job in a single
 * loop, so the same number would cap the control arm on iteration count
 * rather than on capability and quietly manufacture the result we are
 * testing for. Set high enough that the run budget — identical on both arms
 * — is what actually stops it.
 */
export const BASELINE_MAX_TOOL_ITERATIONS = 80;

/** Room for a full build turn; the frontier tiers count thinking against this. */
export const BASELINE_MAX_TOKENS = 16000;

export const BASELINE_ATOM_NAME = 'BaselineFrontierDirect';

/**
 * A competent, unremarkable engineer prompt — no atoma-specific technique,
 * no evidence contract, no probe manifest. Adding any of those would be
 * importing atoma's learned practice into its own control group.
 *
 * It DOES state the environment honestly (available tools, sandboxed cwd,
 * no network assumptions) because a baseline that fails from not knowing
 * what a tool is called measures our prompt, not the model.
 */
export const BASELINE_SYSTEM_PROMPT = [
  'You are a senior software engineer working directly in a sandboxed project directory.',
  '',
  'You have tools to read, write, edit and list files, to run shell commands, to start a',
  'static or Node HTTP server, to fetch a URL, and to load a page in a headless browser.',
  'Your working directory is the project directory; write all deliverables there.',
  '',
  'Complete the task end to end:',
  '  - write the files the task asks for;',
  '  - actually run what you build and check it behaves as specified;',
  '  - fix what does not work and re-check.',
  '',
  'Work until the task is genuinely done, then reply with a short plain-text report of',
  'what you built, how you verified it, and anything you could not complete.',
].join('\n');

export function renderBaselineUserContent(task: Task): string {
  const lines = [`TASK:\n${task.description}`];
  if (task.constraints && task.constraints.length > 0) {
    lines.push('', 'CONSTRAINTS:', ...task.constraints.map((c) => `- ${c}`));
  }
  return lines.join('\n');
}

/**
 * Run the control arm. Signature mirrors `Atom.handle` so `runTask` can swap
 * it in without touching anything downstream (the recorder, the console
 * report and the metrics table all consume a `Result`).
 */
export async function runFrontierBaseline(
  task: Task,
  ctx: RunContext,
  tools: readonly Tool[]
): Promise<Result> {
  // The SAME resolver the top tier uses, so "frontier" means the same model
  // on both arms and an operator pin (ATOMA_MODEL_L3) moves them together.
  const model = modelForTier(3);

  const res = await ctx.llm.complete({
    model,
    systemPrompt: BASELINE_SYSTEM_PROMPT,
    userContent: renderBaselineUserContent(task),
    tools: [...tools],
    executor: ctx.tools,
    signal: ctx.signal,
    maxToolIterations: BASELINE_MAX_TOOL_ITERATIONS,
    params: { maxTokens: BASELINE_MAX_TOKENS },
  });

  const text = (res.text ?? '').trim();
  return {
    output: text,
    // One line, so the console report and the trace stay readable. The full
    // report is the `output`.
    summary: text.split('\n').find((l) => l.trim().length > 0)?.slice(0, 300) ?? 'baseline run produced no text',
    trace: [],
    producedBy: { tier: 3, name: BASELINE_ATOM_NAME, viaFallback: false },
  };
}
