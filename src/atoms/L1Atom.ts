import { Atom } from '../core/atom.js';
import type {
  Plan,
  Result,
  RunContext,
  Task,
  Tier,
  ToolExecutor,
  ToolInvocationInfo,
} from '../core/types.js';
import type { AtomType } from '../registry/atomRegistry.js';
import { modelForTier } from '../core/models.js';
import { capToolIterations } from '../core/limits.js';
import { parsePayloadTolerant, parseWith, planSchema } from './json.js';
import type { Skill } from '../skills/types.js';
import { witnessesFromPayload } from '../contracts/witness.js';
import { SkillRegistry } from '../skills/registry.js';
import { namespaceOf, type SkillNamespace } from '../skills/namespace.js';

const LOOPBACK_HTTP_URL_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i;
export const INTERNAL_VALIDATION_FAILED_PREFIX = '[INTERNAL VALIDATION FAILED';

/**
 * L1-only executor view: every loopback fetch is verification of the server
 * this run just booted, so machine-record it unless the caller explicitly
 * opts out. Supervisor probes keep the original executor and remain read-only.
 */
export function withAutomaticLoopbackHttpRecording(executor: ToolExecutor): ToolExecutor {
  return {
    has: (name) => executor.has(name),
    execute: (name, args) =>
      executor.execute(
        name,
        name === 'fetch_url' &&
          typeof args['url'] === 'string' &&
          LOOPBACK_HTTP_URL_RE.test(args['url']) &&
          args['record'] !== false
          ? { ...args, record: true }
          : args
      ),
  };
}

/** A transport-level success, not merely "the executor did not throw". */
export function toolInvocationSucceeded(info: ToolInvocationInfo): boolean {
  if (info.error !== undefined) return false;
  if (!info.result || typeof info.result !== 'object') return true;
  const result = info.result as Record<string, unknown>;
  if (result['unchanged'] === true) return false;
  if ('ok' in result && result['ok'] !== true) return false;
  if (typeof result['error'] === 'string' && result['error'].length > 0) return false;
  if (typeof result['exitCode'] === 'number' && result['exitCode'] !== 0) return false;
  return true;
}

export function shellInvocationRunsFile(
  args: Record<string, unknown>,
  path: string
): boolean {
  const argv = Array.isArray(args['args']) ? args['args'] : [];
  if (
    typeof args['command'] === 'string' &&
    ['node', 'python3', 'bash'].includes(args['command']) &&
    argv[0] === path
  ) {
    return true;
  }
  const line =
    typeof args['cmd'] === 'string'
      ? args['cmd']
      : typeof args['command'] === 'string' && argv.length === 0
        ? args['command']
        : '';
  return new RegExp(`^(?:node|python3|bash)\\s+["']?${escapeRegex(path)}(?:["']?\\s|["']?$)`).test(
    line.trim()
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class L1Atom extends Atom {
  readonly tier: Tier = 1;
  readonly model: string;

  /**
   * Persistent skills the atom has accumulated across runs. Loaded
   * from a `SkillRegistry` (filesystem-backed by default at
   * `./skills/<atom-id>/`) at construction time. Empty for fresh
   * atoms; populated for canonicals that have been seeded with
   * skill files or for atoms whose past supervised runs produced
   * skills.
   *
   * Use `skills()` for the public read accessor. The array is held
   * privately so a future patch path (e.g. a `learnSkill` mutator)
   * keeps the storage encapsulated.
   */
  private readonly skillsList: Skill[];

  constructor(args: {
    atomId?: string;
    name: string;
    ordinal: number;
    systemPrompt: string;
    tools: readonly import('../core/types.js').Tool[];
    params: import('../core/types.js').GenerationParams;
    model?: string;
    skills?: readonly Skill[];
  }) {
    super({
      atomId: args.atomId,
      name: args.name,
      ordinal: args.ordinal,
      systemPrompt: args.systemPrompt,
      tools: [...args.tools],
      params: args.params,
    });
    this.model = args.model ?? modelForTier(1);
    this.skillsList = args.skills ? [...args.skills] : [];
  }

  /**
   * Read-only view of the atom's persistent skills. Called by L2 at
   * skill-prefilter time (subsequent commit) and by tracing /
   * observability paths.
   */
  skills(): readonly Skill[] {
    return this.skillsList;
  }

  /**
   * Per-instance ACTIVE skill — set by L2 when its skill-prefilter
   * matched a skill for the current subtask. Read by the L2 hooks
   * (`onApproved` / `onFailed`) so trust counters can bump on the
   * exact skill that drove the run, and by branchOnEscalation to
   * route a failed run into a skill-update path instead of the
   * registry.branch (commit 2b).
   *
   * Stored on the instance — not the type — because two parallel
   * subtasks can resolve the SAME L1 type but pick DIFFERENT skills.
   */
  private activeSkillIdField: string | null = null;
  private activeSkillOwnerField: SkillNamespace | null = null;

  /**
   * Mark this instance as currently driven by `skillId`, owned by the
   * namespace `ownerNs`. The owner pair rides the INSTANCE (not skillCtx)
   * deliberately: the registry-branch escalation path returns an untagged
   * fresh instance, and credit read from anywhere else would pay a skill
   * for a run the branch delivered without it (the R2 laundering channel
   * from the bucket-namespace adversarial review). `ownerNs` defaults to
   * null-with-id-null; callers set both together.
   */
  setActiveSkill(skillId: string | null, ownerNs: SkillNamespace | null = null): void {
    this.activeSkillIdField = skillId;
    this.activeSkillOwnerField = skillId === null ? null : ownerNs;
  }

  /** Active skill id for this run, or null if none was matched. */
  activeSkillId(): string | null {
    return this.activeSkillIdField;
  }

  /**
   * Namespace that OWNS the active skill (where its folder and counters
   * live). Under the shared-catalog lattice this can differ from the
   * executing atom's name; credit/blame/revision must all land here.
   */
  activeSkillOwner(): SkillNamespace | null {
    return this.activeSkillOwnerField;
  }

  static fromType(
    type: AtomType,
    model: string = modelForTier(1),
    skillRegistry?: SkillRegistry
  ): L1Atom {
    if (type.tier !== 1) {
      throw new Error(`L1Atom.fromType requires tier=1, got tier=${type.tier}`);
    }
    // Skill loading is OPT-IN — passing a SkillRegistry hydrates the
    // atom with its persistent skill set. Tests that don't care
    // about skills can omit the arg and get a skill-less atom.
    let skills: readonly Skill[] = [];
    if (skillRegistry) {
      try {
        skills = skillRegistry.loadFor(namespaceOf(type));
      } catch {
        // A malformed skills folder must not bring down atom
        // construction — the run should still proceed without
        // skills if the load fails.
        skills = [];
      }
    }
    return new L1Atom({
      atomId: type.atomId,
      name: type.name,
      ordinal: type.ordinal,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
      params: type.params,
      model,
      skills,
    });
  }

  async plan(task: Task, ctx: RunContext): Promise<Plan> {
    const toolCatalog =
      this.tools.length === 0
        ? '(no tools available — describe your output in the plan text)'
        : this.tools.map((t) => `  - ${t.name}: ${t.description}`).join('\n');
    const userContent = [
      `You are molecule "${this.name}" (tier 1 / molecule ordinal ${this.ordinal}).`,
      `You are the ONLY tier allowed to execute tools; in taxonomy, those tools are elements.`,
      `You cannot delegate further.`,
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
      `You are molecule "${this.name}" (tier 1). Your plan has been APPROVED. Execute it now.`,
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
      `This final JSON is ASSISTANT TEXT, not a tool call. There is no "return"`,
      `or "output" tool: stop calling tools and emit the JSON object directly.`,
    ]
      .filter((l): l is string => typeof l === 'string' && l.length > 0)
      .join('\n');

    // Track the OUTCOME of each validate_html call observed during the
    // tool loop so we can gate the final result on it (#3). The L1
    // narrow prompt tells the model "only return success when ok:true"
    // but Haiku sometimes claims a success summary after seeing an
    // ok:false last call — the result then looks green to the parser,
    // the supervisor's ground-truth probe re-validates and rejects on
    // the actual 404 / failedRequests, and we land in a cascade of
    // validator rejections the model can't reason its way out of.
    // Recording the last validate_html ok flag here lets us annotate
    // the summary so the supervisor validator sees the contradiction
    // transparently on the FIRST pass, before spiralling.
    let lastValidateHtml: { ok: boolean; summary: string } | null = null;
    const observedToolCalls: Array<{ name: string; ok: boolean }> = [];
    const writtenSkillScratchFiles = new Set<string>();
    let activeScriptSkillExecuted = false;
    const onToolInvocation = (info: ToolInvocationInfo): void => {
      // Bounded, content-free action witness for skill auto-distillation.
      // A low-capability provider produced zero tool events, claimed it had
      // built a CLI, and two recipes were learned from that fiction. Names +
      // success bits prove an action happened without retaining tool payloads.
      const succeeded = toolInvocationSucceeded(info);
      if (observedToolCalls.length < 64) {
        observedToolCalls.push({ name: info.name, ok: succeeded });
      }
      if (succeeded && info.name === 'write_file' && typeof info.args['path'] === 'string') {
        const path = info.args['path'];
        const activeScratchPrefix =
          this.activeSkillIdField !== null ? `_skill_${this.activeSkillIdField}.` : null;
        if (
          activeScratchPrefix !== null &&
          path.startsWith(activeScratchPrefix) &&
          /\.(?:mjs|py|sh)$/i.test(path)
        ) {
          writtenSkillScratchFiles.add(path);
        }
      }
      if (succeeded && info.name === 'run_shell' && writtenSkillScratchFiles.size > 0) {
        activeScriptSkillExecuted ||= [...writtenSkillScratchFiles].some((path) =>
          shellInvocationRunsFile(info.args, path)
        );
      }
      if (info.name !== 'validate_html') return;
      const r = info.result as Record<string, unknown> | undefined;
      if (!r || typeof r !== 'object') return;
      const ok = r['ok'] === true;
      const errors = Array.isArray(r['errors']) ? (r['errors'] as unknown[]) : [];
      const failedRequests = Array.isArray(r['failedRequests'])
        ? (r['failedRequests'] as unknown[])
        : [];
      const smokeResult = r['smokeResult'];
      const smokeErr =
        smokeResult && typeof smokeResult === 'object' && 'error' in smokeResult
          ? String((smokeResult as Record<string, unknown>)['error'])
          : null;
      const parts: string[] = [];
      if (errors.length > 0) parts.push(`${errors.length} console error(s)`);
      if (failedRequests.length > 0) parts.push(`${failedRequests.length} failed request(s)`);
      if (smokeErr) parts.push(`smoke: ${smokeErr.slice(0, 80)}`);
      lastValidateHtml = {
        ok,
        summary: parts.length > 0 ? parts.join(', ') : ok ? 'clean load' : 'unknown failure',
      };
    };

    const resp = await ctx.llm.complete({
      model: this.model,
      systemPrompt: this.effectiveSystemPrompt(),
      userContent,
      tools: this.tools,
      params: this.params,
      executor: ctx.tools ? withAutomaticLoopbackHttpRecording(ctx.tools) : undefined,
      signal: ctx.signal,
      onToolInvocation,
      // Iterative build-app style tasks (write_file → start_server →
      // validate_html → read_file → rewrite → re-validate, up to 5 loops)
      // burn through tool-use slots fast. The default (24) covers the
      // no-validator path; when we've wired a validator into the tool set,
      // give the loop enough room to actually converge before falling back
      // to the tools-disabled finalization round-trip.
      maxToolIterations: capToolIterations(hasValidator ? 40 : 24, ctx.deadlineAt),
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
    const { output, summary: rawSummary } = parsePayloadTolerant(resp.text);

    // Validation-gate annotation (#3). When the L1 called
    // validate_html at least once AND the LAST outcome was ok:false,
    // rewrite the summary to include an explicit INTERNAL VALIDATION
    // FAILED banner. The supervisor validator (Haiku) then sees the
    // contradiction directly in the RESULT payload — no need to wait
    // for its own ground-truth probe to re-run validate_html and
    // produce the same signal via a longer path.
    const summary =
      lastValidateHtml && !(lastValidateHtml as { ok: boolean }).ok
        ? `${INTERNAL_VALIDATION_FAILED_PREFIX} — last validate_html: ${(lastValidateHtml as { summary: string }).summary}] ${rawSummary}`
        : rawSummary;

    return {
      output,
      summary,
      trace: [],
      producedBy: { tier: 1, name: this.name, viaFallback: false },
      // Always present for production L1 results: [] is positive evidence
      // that the transport observed NO tool action. Test and library producers may
      // omit the field and remain backward-compatible at upper tiers.
      toolCallResults: observedToolCalls,
      ...(this.activeSkillIdField !== null ? { activeScriptSkillExecuted } : {}),
      // Typed witnesses, attached at production time: the child's recorded
      // probes become first-class evidence the upper tiers can weigh
      // without re-parsing the payload.
      evidence: witnessesFromPayload({ output }),
    };
  }
}
