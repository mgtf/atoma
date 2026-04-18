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
    const userContent = [
      `You are atom "${this.name}" (tier 1 / element ordinal ${this.ordinal}).`,
      `You cannot delegate. Produce a concise plan of how YOU will accomplish the task.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      task.constraints?.length ? `Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ``,
      `Respond with JSON matching this shape:`,
      `{"reasoning": "...", "proposedAction": "...", "expectedOutput": "...", "toolCalls": [{"name": "...", "args": {...}}]?}`,
    ]
      .filter(Boolean)
      .join('\n');

    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      tools: this.tools,
      params: this.params,
    });

    return parseWith(planSchema, resp.text);
  }

  async execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result> {
    const userContent = [
      `You are atom "${this.name}" (tier 1). Your plan has been APPROVED. Execute it now.`,
      ``,
      `Task: ${task.description}`,
      task.inputs ? `Inputs: ${JSON.stringify(task.inputs)}` : '',
      ``,
      `Approved plan:`,
      JSON.stringify(plan, null, 2),
      ``,
      `Produce the final result as JSON:`,
      `{"output": <any>, "summary": "<one sentence>"}`,
    ]
      .filter(Boolean)
      .join('\n');

    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      tools: this.tools,
      params: this.params,
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
