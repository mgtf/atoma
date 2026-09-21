import { z } from 'zod';
import { tryParseModelSelector } from './modelSelector.js';

/** Public projection only: provider account details never enter this inventory. */
export const codexModelSchema = z.object({
  id: z.string().min(1).max(160).refine((model) => {
    const selector = tryParseModelSelector(`own:openai:${model}`);
    return selector?.model === model;
  }),
  label: z.string().min(1).max(200),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().max(32),
  supportedReasoningEfforts: z.array(z.string().max(32)).max(16),
});
export type CodexModel = z.infer<typeof codexModelSchema>;
export const codexModelInventorySchema = z.object({
  state: z.enum(['ready', 'stale', 'unavailable']),
  checkedAt: z.string().nullable(),
  models: z.array(codexModelSchema).max(1000),
});
export type CodexModelInventory = z.infer<typeof codexModelInventorySchema>;
export const UNAVAILABLE_CODEX_MODELS: CodexModelInventory = {
  state: 'unavailable', checkedAt: null, models: [],
};
export const CODEX_MODEL_CAPABILITIES_ENV = 'ATOMA_CODEX_MODEL_CAPABILITIES';

/** Preserved pins may be displayed, but only a current inventory authorizes a new choice. */
export function assertPersonalCodexModels(
  selections: Iterable<string | null | undefined>, inventory: CodexModelInventory
): void {
  for (const value of selections) {
    const selector = value ? tryParseModelSelector(value) : null;
    if (selector?.mode !== 'own' || selector.vendor !== 'openai') continue;
    if (inventory.state !== 'ready') {
      throw new Error('Your ChatGPT model catalogue could not be refreshed. Refresh it in Settings before trying again.');
    }
    if (!inventory.models.some((model) => model.id === selector.model)) {
      throw new Error(`ChatGPT model ${selector.model} is unavailable for your connected account. Choose a model in Settings.`);
    }
  }
}
