/**
 * The three selectors `tests/setup-tier-pins.ts` gives the suite, named the
 * way the tests always named the built-in Anthropic pins. Every value is a
 * full `api:anthropic:<model>` selector: that is what `modelForTier` returns
 * and what a mocked `LlmClient` receives as `req.model`.
 */
export const PIN_HAIKU = 'api:anthropic:claude-haiku-4-5-20251001';
export const PIN_SONNET = 'api:anthropic:claude-sonnet-5';
export const FALLBACK_OPUS = 'api:anthropic:claude-opus-5';

/** The three `sub:anthropic:` aliases — a developer's own Claude Code login. */
export const CLAUDE_CLI_PINS = {
  ATOMA_MODEL_L1: 'sub:anthropic:haiku',
  ATOMA_MODEL_L2: 'sub:anthropic:sonnet',
  ATOMA_MODEL_L3: 'sub:anthropic:opus',
} as const;

export const ANTHROPIC_PINS = {
  ATOMA_MODEL_L1: PIN_HAIKU,
  ATOMA_MODEL_L2: PIN_SONNET,
  ATOMA_MODEL_L3: FALLBACK_OPUS,
} as const;

export const OLLAMA_PINS = {
  ATOMA_MODEL_L1: 'api:ollama:qwen3:8b',
  ATOMA_MODEL_L2: 'api:ollama:qwen3:8b',
  ATOMA_MODEL_L3: 'api:ollama:qwen3:8b',
} as const;
