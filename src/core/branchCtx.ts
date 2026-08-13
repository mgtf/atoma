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

  const out: RunContext = {
    logger: ctx.logger,
    signal: ctx.signal,
    llm: wrappedLlm,
    limits: ctx.limits,
    ...(ctx.tools !== undefined ? { tools: ctx.tools } : {}),
    ...(wrappedRecordTrust !== undefined ? { recordTrust: wrappedRecordTrust } : {}),
    ...(wrappedRecordSkill !== undefined ? { recordSkill: wrappedRecordSkill } : {}),
    ...(wrappedRecordCacheHit !== undefined ? { recordCacheHit: wrappedRecordCacheHit } : {}),
    ...(ctx.recordBranch !== undefined ? { recordBranch: ctx.recordBranch } : {}),
    currentBranchId: branchId,
  };
  return out;
}
