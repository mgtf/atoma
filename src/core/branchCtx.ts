import type {
  CacheHitInfo,
  LlmClient,
  LlmCompletionRequest,
  RunContext,
  SkillEventInfo,
  TrustFastPathInfo,
} from './types.js';

/**
 * Derive a child RunContext that tags every observable event (LLM call,
 * tool invocation, trust fast-path) with the given `branchId`. Used by
 * L2/L3 for every subtask (parallel OR sequential): each subtask runs with
 * its own branch ctx, while `recordBranch` carries the aggregation mode so
 * the viz can distinguish a fan-out lane from a sequential phase.
 *
 * What gets wrapped:
 *   - `llm.complete(req)` → injects `branchId` on `req` unless the
 *     caller already supplied one (honours existing explicit value).
 *     RecordingLlmClient reads `req.branchId` and propagates it to
 *     both the LLM event AND any tool events from the tool-use loop.
 *   - `recordTrust(info)` → caller's callback is wrapped so we can
 *     stamp `branchId` before handing the info on. Since
 *     `TrustFastPathInfo` is the narrow contract the recorder uses,
 *     we extend it with the branch id via a cast-free pattern: we
 *     simply spread the branchId into the object we forward.
 *   - `currentBranchId` → the field itself, in case any downstream
 *     consumer reads ctx directly.
 *   - `recordBranch` → forwarded unchanged; nested dispatchers provide
 *     their own id plus `currentBranchId` as the exact parent.
 *   - `recordRunStat` → forwarded unchanged; it is run-scoped accounting,
 *     not a branch-labelled viz event.
 */
export function forkBranch(ctx: RunContext, branchId: string): RunContext {
  const wrappedLlm: LlmClient = {
    complete: (req: LlmCompletionRequest) =>
      ctx.llm.complete({
        ...req,
        branchId: req.branchId ?? branchId,
      }),
  };
  const wrappedRecordTrust = ctx.recordTrust
    ? (info: TrustFastPathInfo) => {
        ctx.recordTrust!({ ...info, branchId });
      }
    : undefined;
  const wrappedRecordSkill = ctx.recordSkill
    ? (info: SkillEventInfo) => {
        ctx.recordSkill!({ ...info, branchId });
      }
    : undefined;
  // Prefilter cache hits happen INSIDE subtasks too (the skill prefilter
  // runs per subtask), so the hook must be forwarded like the other two
  // — a fork that dropped it would silently lose every cached decision
  // made under fan-out, which is where most of them happen.
  const wrappedRecordCacheHit = ctx.recordCacheHit
    ? (info: CacheHitInfo) => {
        ctx.recordCacheHit!({ ...info, branchId });
      }
    : undefined;

  // Run-scoped memos must be the SAME reference on every fork, or their
  // documented semantics silently narrow to branch-scoped: the memos are
  // lazily initialised by whichever fork first touches them, and a lazy
  // init on a child never reaches the root or sibling branches. Initialise
  // them on the PARENT here (the field is mutable by design) so the root,
  // this fork and every future fork share one map/set.
  const dispatchedScriptSignatures = (ctx.dispatchedScriptSignatures ??= new Map<
    string,
    string[]
  >());
  const mechanicalPlanRejections = (ctx.mechanicalPlanRejections ??= new Set<string>());
  const mechanicalResultRejections = (ctx.mechanicalResultRejections ??= new Set<string>());

  const out: RunContext = {
    logger: ctx.logger,
    signal: ctx.signal,
    ...(ctx.deadlineAt !== undefined ? { deadlineAt: ctx.deadlineAt } : {}),
    llm: wrappedLlm,
    limits: ctx.limits,
    dispatchedScriptSignatures,
    mechanicalPlanRejections,
    mechanicalResultRejections,
    ...(ctx.tools !== undefined ? { tools: ctx.tools } : {}),
    // Field-enumeration hazard, measured: this rebuild once dropped
    // `requireObservedToolAction`, and because the flag is only SET on the
    // root ctx while L2.validateResult reads it through a double fork, the
    // fabricated-work gate was inert on every production run while its
    // tests (which never fork) stayed green. Optional fields get no
    // typecheck protection here — every RunContext field added later MUST
    // be forwarded explicitly, and needs a fork-propagation test.
    ...(ctx.requireObservedToolAction !== undefined
      ? { requireObservedToolAction: ctx.requireObservedToolAction }
      : {}),
    ...(wrappedRecordTrust !== undefined ? { recordTrust: wrappedRecordTrust } : {}),
    ...(wrappedRecordSkill !== undefined ? { recordSkill: wrappedRecordSkill } : {}),
    ...(ctx.recordRunStat !== undefined ? { recordRunStat: ctx.recordRunStat } : {}),
    ...(wrappedRecordCacheHit !== undefined ? { recordCacheHit: wrappedRecordCacheHit } : {}),
    ...(ctx.recordBranch !== undefined ? { recordBranch: ctx.recordBranch } : {}),
    currentBranchId: branchId,
  };
  return out;
}
