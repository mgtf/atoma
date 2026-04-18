import { Atom } from '../core/atom.js';
import type { Plan, Result, RunContext, Task, Tier } from '../core/types.js';
import type { AtomType } from '../registry/atomRegistry.js';
import { PIN_HAIKU } from '../core/models.js';
import { parseWith, planSchema, resultPayloadSchema } from './json.js';

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
      `Respond with JSON matching this shape:`,
      `{"reasoning": "...", "proposedAction": "...", "expectedOutput": "...", "toolCalls": [{"name": "...", "args": {...}}]?}`,
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
        ? `- If your output is a web artifact, you MUST call validate_html on the`
        : null,
      hasValidator
        ? `  server URL. If errors are reported, read the offending file, fix the`
        : null,
      hasValidator
        ? `  issue, rewrite it with write_file, and call validate_html again.`
        : null,
      hasValidator
        ? `  Keep looping (max ~3 attempts) until validate_html returns no errors.`
        : null,
      hasValidator
        ? `  Only then respond with your final JSON result.`
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
    });

    const payload = parseWith(resultPayloadSchema, resp.text);

    return {
      output: payload.output,
      summary: payload.summary,
      trace: [],
      producedBy: { tier: 1, name: this.name, viaFallback: false },
    };
  }
}
