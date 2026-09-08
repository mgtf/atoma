import { randomUUID } from 'node:crypto';
import type { ContextBlock, ContextBlockInput, LlmCallRole } from '../contracts/llmTrace.js';
import { foldContextBlocks } from '../contracts/llmTrace.js';
import type {
  AtomModifications,
  GenerationParams,
  LlmCompletionRequest,
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  Tool,
  Verdict,
} from './types.js';
import { newAtomId } from './atomId.js';

export abstract class Atom {
  abstract readonly tier: Tier;
  abstract readonly model: string;
  /**
   * Surrogate identity (T4), carried so the layers that must key on identity
   * rather than on a display label — the skill namespace and ledger
   * attribution — can reach it without a registry lookup.
   *
   * OPTIONAL AT CONSTRUCTION, and deliberately so. `fromType` threads the
   * registry's id, which is the case that matters: an atom rehydrated from a
   * persisted type keeps the identity its skills and counters are filed
   * under. An atom built ad hoc has no registry row and therefore no
   * persistent identity to preserve, so a fresh id is the CORRECT value for
   * it rather than a gap — `tests/atom-identity.test.ts` pins the
   * preservation property instead of relying on the argument being required.
   */
  readonly atomId: string;
  readonly name: string;
  readonly ordinal: number;

  protected systemPrompt: string;
  protected tools: Tool[];
  protected params: GenerationParams;
  protected injectedContext: ContextBlock[] = [];
  protected fallbackMode = false;

  constructor(args: {
    atomId?: string;
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: Tool[];
    params: GenerationParams;
  }) {
    this.atomId = args.atomId ?? newAtomId();
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
      this.injectContext({ source: 'coaching', text: mods.additionalContext });
    }
  }

  injectContext(input: ContextBlockInput): ContextBlock {
    const block: ContextBlock = {
      id: input.id ?? randomUUID(),
      source: input.source,
      text: input.text,
      ...(input.skillId !== undefined ? { skillId: input.skillId } : {}),
    };
    this.injectedContext.push(block);
    return block;
  }

  contextBlocks(): readonly ContextBlock[] {
    return this.injectedContext;
  }

  /**
   * Build the request envelope so every atom `complete()` carries role,
   * actor, the folded prompt, and the cited injects. Call sites pass only
   * the per-call fields (userContent, tools, signal, …).
   */
  toLlmRequest(
    role: LlmCallRole,
    args: Omit<LlmCompletionRequest, 'systemPrompt' | 'role' | 'actor' | 'context' | 'model'> & {
      model?: string;
      systemPromptOverride?: string;
    }
  ): LlmCompletionRequest {
    const { model, systemPromptOverride, ...rest } = args;
    const context = this.injectedContext;
    return {
      ...rest,
      model: model ?? this.model,
      systemPrompt: systemPromptOverride === undefined
        ? this.effectiveSystemPrompt()
        : foldContextBlocks(systemPromptOverride, context),
      role,
      actor: { name: this.name, tier: this.tier },
      ...(context.length > 0 ? { context: [...context] } : {}),
    };
  }

  /**
   * Public view of the atom's declared tool NAMES (not the tool objects,
   * which carry closures). Used by cross-cutting concerns (supervisor
   * ground-truth probes, tracing) that need to know what the atom can
   * legitimately invoke without exposing the mutable tools array.
   */
  toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  setFallbackMode(on: boolean): void {
    this.fallbackMode = on;
  }

  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  protected effectiveSystemPrompt(): string {
    return foldContextBlocks(this.systemPrompt, this.injectedContext);
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
