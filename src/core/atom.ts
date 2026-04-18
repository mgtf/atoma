import type {
  AtomModifications,
  GenerationParams,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Tool,
  Verdict,
} from './types.js';

export abstract class Atom {
  abstract readonly tier: Tier;
  abstract readonly model: string;
  readonly name: string;
  readonly ordinal: number;

  protected systemPrompt: string;
  protected tools: Tool[];
  protected params: GenerationParams;
  protected injectedContext: string[] = [];
  protected fallbackMode = false;

  constructor(args: {
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: Tool[];
    params: GenerationParams;
  }) {
    this.name = args.name;
    this.ordinal = args.ordinal;
    this.systemPrompt = args.systemPrompt;
    this.tools = [...args.tools];
    this.params = { ...args.params };
  }

  abstract plan(task: Task, ctx: RunContext): Promise<Plan>;
  abstract execute(task: Task, plan: Plan, ctx: RunContext): Promise<Result>;

  applyModifications(mods: AtomModifications): void {
    if (mods.systemPromptReplace !== undefined) {
      this.systemPrompt = mods.systemPromptReplace;
    } else if (mods.systemPromptAppend !== undefined) {
      this.systemPrompt = `${this.systemPrompt}\n\n${mods.systemPromptAppend}`;
    }
    if (mods.removeTools && mods.removeTools.length > 0) {
      const rm = new Set(mods.removeTools);
      this.tools = this.tools.filter((t) => !rm.has(t.name));
    }
    if (mods.addTools && mods.addTools.length > 0) {
      const known = new Set(this.tools.map((t) => t.name));
      for (const t of mods.addTools) if (!known.has(t.name)) this.tools.push(t);
    }
    if (mods.params) {
      this.params = { ...this.params, ...mods.params };
    }
    if (mods.additionalContext) {
      this.injectedContext.push(mods.additionalContext);
    }
  }

  injectContext(text: string): void {
    this.injectedContext.push(text);
  }

  setFallbackMode(on: boolean): void {
    this.fallbackMode = on;
  }

  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  protected effectiveSystemPrompt(): string {
    if (this.injectedContext.length === 0) return this.systemPrompt;
    return `${this.systemPrompt}\n\n${this.injectedContext
      .map((c, i) => `<!-- context ${i + 1} -->\n${c}`)
      .join('\n\n')}`;
  }
}

export interface Supervisor<Child extends Atom> {
  readonly tier: Tier;
  validatePlan(child: Child, plan: Plan, task: Task, ctx: RunContext): Promise<Verdict>;
  validateResult(child: Child, result: Result, task: Task, ctx: RunContext): Promise<Verdict>;
}

export interface Peerable<Self extends Atom> {
  readonly peers: Self[];
  mutualize(task: Task, ctx: RunContext): Promise<Result>;
}
