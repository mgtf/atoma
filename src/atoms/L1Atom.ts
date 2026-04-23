import { Atom } from '../core/atom.js';
import type { Plan, Result, RunContext, Task, Tier } from '../core/types.js';
import type { AtomType } from '../registry/atomRegistry.js';
import { PIN_HAIKU } from '../core/models.js';
import { parsePayloadTolerant, parseWith, planSchema } from './json.js';

export class L1Atom extends Atom {
  readonly tier: Tier = 1;
  readonly model: string;

  constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly import('../core/types.js').Tool[];
    params: import('../core/types.js').GenerationParams;
    model?: string;
  }) {
    super({
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model ?? PIN_HAIKU;
  }

  static fromType(type: AtomType, model: string = PIN_HAIKU): L1Atom {
    if (type.tier !== 1) {
      throw new Error(`L1Atom.fromType requires tier=1, got tier=${type.tier}`);
    }
    return new L1Atom({
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      model,
    });
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    const toolCatalog =
      this.tools.length === 0
        ? '(no tools available — describe your output in the plan text)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
    const userContent = [
      `You are atom "${this.name}" (tier 1 / element ordinal ${this.ordinal}).`,
      `You are the ONLY tier allowed to execute tools. You cannot delegate further.`,
      `Produce a concise plan of how YOU will accomplish the task by calling the`,
      `tools below during the execute phase. Do not invent tools; use only those listed.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `Tools available at execute time:`,
      toolCatalog,
      ``,
      `If the task produces a web artifact (HTML / JS) AND a validate_html tool is`,
      `available, your plan MUST include a final validation step: after writing`,
      `files and starting the server, call validate_html on the server URL; if it`,
      `returns errors, read the offending file, fix it, rewrite, and re-validate`,
      `until validate_html reports no errors. Only then return success.`,
      ``,
      `CRITICAL — plan shape (aspirational, no literal payloads):`,
      `Describe your intended tool sequence in the "proposedAction" field as PROSE`,
      `("first I will write_file server.js with a native-http GET /health handler, then`,
      `start_node_server, then fetch_url /health to verify"). Do NOT embed the literal`,
      `file content, JSON body, or full args into the plan — that belongs in the`,
      `execute phase. Short plans are reliably validated; long plans that paste file`,
      `contents get truncated mid-string by the model's output cap and the validator`,
      `rejects the incomplete payload (observed as a cascade of escalations in earlier`,
      `runs).`,
      ``,
      `Respond with JSON matching this shape (no "toolCalls" field — the execute`,
      `phase handles actual tool calls):`,
      `{"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Plan is pure reasoning — don't pass the executor here or the LLM may
    // perform the work during planning and return prose instead of a plan JSON.
    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      params: this.params,
      signal: ctx.signal,
    });

    return parseWith(planSchema, resp.text);
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    const hasValidator = this.tools.some((t) => t.name === 'validate_html');
    const userContent = [
      `You are atom "${this.name}" (tier 1). Your plan has been APPROVED. Execute it now.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Approved plan:`,
      JSON.stringify(plan, null, 2),
      ``,
      `EXECUTION DISCIPLINE:`,
      `- You MUST use the tools you were given to actually perform the work.`,
      `  Do not just describe what you would do — call the tools.`,
      `- Use RELATIVE paths for file tools (e.g. "index.html", not "/abs/index.html").`,
      `- After every tool call, read the result before deciding the next step.`,
      hasValidator
        ? `- For ANY web artifact you produce, call validate_html on the server URL.`
        : null,
      hasValidator
        ? `  "No console errors" is NOT sufficient — a broken app that silently`
        : null,
      hasValidator
        ? `  does nothing has no errors either. If the app is interactive (clicks,`
        : null,
      hasValidator
        ? `  forms, keys), you MUST pass an "interactions" array that exercises the`
        : null,
      hasValidator
        ? `  main user flow AND a "smoke" JS expression that asserts the state`
        : null,
      hasValidator
        ? `  actually changed. Example smoke for a clickable grid:`
        : null,
      hasValidator
        ? `    "document.body.innerText.includes('Mine') || document.querySelectorAll('.revealed').length > 0 || (window.revealed && window.revealed.flat().some(v=>v))"`
        : null,
      hasValidator
        ? `  To expose internal game state to your smoke test, attach it to window`
        : null,
      hasValidator
        ? `  (e.g. "window.__game = { revealed, flagged, grid };") inside the HTML.`
        : null,
      hasValidator
        ? `  If validate_html returns ok:false, read the file, diagnose the exact`
        : null,
      hasValidator
        ? `  cause (stacking contexts, pointer-events, missing listeners, wrong`
        : null,
      hasValidator
        ? `  coords, shader version mismatch...), rewrite with write_file, and`
        : null,
      hasValidator
        ? `  re-validate. Loop up to 5 times. Only return success when ok:true.`
        : null,
      ``,
      `When and only when the work is truly done, produce the final result as JSON:`,
      `{"output": <any>, "summary": "<one sentence>"}`,
    ]
      .filter((l): l is string => typeof l === 'string' && l.length > 0)
      .join('\n');

    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      tools: this.tools,
      params: this.params,
      executor: ctx.tools,
      signal: ctx.signal,
      // Iterative build-app style tasks (write_file → start_server →
      // validate_html → read_file → rewrite → re-validate, up to 5 loops)
      // burn through tool-use slots fast. The default (24) covers the
      // no-validator path; when we've wired a validator into the tool set,
      // give the loop enough room to actually converge before falling back
      // to the tools-disabled finalization round-trip.
      maxToolIterations: hasValidator ? 40 : undefined,
    });

    // Tolerant parse: `parseWith(resultPayloadSchema,…)` now already scans
    // every balanced {…} candidate in the text, so a narrative with one
    // embedded pseudo-JSON (e.g. `{ score, level, state }` as a window
    // shape inside markdown prose) no longer traps us on the first `{`.
    // If every candidate still fails the schema, fall back to wrapping
    // the prose as `output` + a diagnostic `summary` instead of crashing
    // the whole run — the supervisor's RESULT validator can then flag
    // the degenerate payload via its normal rejection path, giving the
    // loop a chance to retry.
    const { output, summary } = parsePayloadTolerant(resp.text);

    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 1, name: this.name, viaFallback: false },
    };
  }
}
