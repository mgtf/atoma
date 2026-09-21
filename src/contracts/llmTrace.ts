/**
 * Model-visible context that reaches `complete()`. The fold of these blocks
 * IS the system-prompt tail; the recorder cites the same ids on the llm event.
 * A new source is a new union member — do not push an untyped string.
 */
export const CONTEXT_SOURCES = [
  'skill',
  'event-skill',
  'coaching',
  'fallback-trace',
] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export const LLM_CALL_ROLES = [
  'prefilter',
  'plan',
  'validate-plan',
  'execute',
  'skill',
  'validate-result',
  'fallback-plan',
  'fallback-execute',
] as const;

export type LlmCallRole = (typeof LLM_CALL_ROLES)[number];

/**
 * How much of a context block the citation carries. 160 characters made the
 * viz pane's `context` step unreadable — a 1,167-character skill recipe was
 * cut mid-sentence, and the step exists precisely so a viewer can see what
 * the model was shown (2026-09-21). 2,000 covers a recipe or a coaching note
 * whole while keeping the citation a CITATION: a longer block is still
 * truncated with an ellipsis, and the block itself lives in the skill store.
 * One context event is recorded per distinct block per run, so the bound on a
 * trace is the run's distinct injects, not its calls.
 */
export const CONTEXT_PREVIEW_CHARS = 2000;

export interface ContextBlock {
  readonly id: string;
  readonly source: ContextSource;
  readonly text: string;
  readonly skillId?: string;
}

export type ContextBlockInput = {
  readonly source: ContextSource;
  readonly text: string;
  readonly skillId?: string;
  readonly id?: string;
};

export interface ContextCitation {
  readonly id: string;
  readonly source: ContextSource;
  readonly chars: number;
  readonly preview: string;
  readonly skillId?: string;
}

export function foldContextBlocks(
  basePrompt: string,
  blocks: readonly ContextBlock[]
): string {
  if (blocks.length === 0) return basePrompt;
  return `${basePrompt}\n\n${blocks
    .map((block) => {
      const meta = block.skillId
        ? ` source=${block.source} skill=${block.skillId}`
        : ` source=${block.source}`;
      return `<!-- context${meta} -->\n${block.text}`;
    })
    .join('\n\n')}`;
}

export function citeContext(
  block: ContextBlock,
  previewChars: number = CONTEXT_PREVIEW_CHARS
): ContextCitation {
  const preview =
    block.text.length <= previewChars
      ? block.text
      : `${block.text.slice(0, previewChars)}…`;
  return {
    id: block.id,
    source: block.source,
    chars: block.text.length,
    preview,
    ...(block.skillId !== undefined ? { skillId: block.skillId } : {}),
  };
}
