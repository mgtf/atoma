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

export const CONTEXT_PREVIEW_CHARS = 160;

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
