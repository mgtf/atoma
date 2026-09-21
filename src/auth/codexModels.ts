import { z } from 'zod';
import {
  codexModelSchema, UNAVAILABLE_CODEX_MODELS,
  type CodexModel, type CodexModelInventory,
} from '../contracts/codexModels.js';

const pageSchema = z.object({
  data: z.array(z.object({
    model: z.string(), displayName: z.string(), hidden: z.boolean().optional(),
    isDefault: z.boolean(), defaultReasoningEffort: z.string(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
  })).max(100),
  nextCursor: z.string().max(2000).nullable().optional(),
});

/** Paginate the official app-server method, without issuing any inference calls. */
export async function readCodexModels(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<CodexModel[]> {
  const models = new Map<string, CodexModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = pageSchema.parse(await request('model/list', {
      limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
    }));
    for (const entry of result.data) {
      if (entry.hidden) continue;
      const model = codexModelSchema.parse({
        id: entry.model, label: entry.displayName, isDefault: entry.isDefault,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        supportedReasoningEfforts: entry.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      });
      models.set(model.id, model);
    }
    if (models.size > 1000) throw new Error('Codex model inventory exceeds its bound');
    if (!result.nextCursor) return [...models.values()];
    if (cursors.has(result.nextCursor)) throw new Error('Codex model pagination repeated a cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Codex model pagination exceeds its bound');
}

/** Bounded, generation-keyed cache; concurrent requests share one provider process. */
export class CodexModelCache {
  private readonly entries = new Map<string, { at: number; inventory: CodexModelInventory }>();
  private readonly pending = new Map<string, Promise<CodexModelInventory>>();
  constructor(private readonly now: () => number = Date.now) {}

  peek(key: string): CodexModelInventory {
    const entry = this.entries.get(key);
    if (!entry) return UNAVAILABLE_CODEX_MODELS;
    return this.now() - entry.at < 5 * 60_000 ? entry.inventory : { ...entry.inventory, state: 'stale' };
  }

  async get(key: string, read: () => Promise<CodexModel[]>, refresh = false): Promise<CodexModelInventory> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const cached = this.entries.get(key);
    if (!refresh && cached && this.now() - cached.at < 5 * 60_000) return cached.inventory;
    // Capacity is also bounded by the app-server's shared process budget.
    if (this.pending.size >= 16) return UNAVAILABLE_CODEX_MODELS;
    const work = (async (): Promise<CodexModelInventory> => {
      let inventory: CodexModelInventory;
      try {
        inventory = { state: 'ready', checkedAt: new Date(this.now()).toISOString(), models: await read() };
      } catch {
        inventory = cached ? { ...cached.inventory, state: 'stale' } : UNAVAILABLE_CODEX_MODELS;
      }
      if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { at: this.now(), inventory });
      return inventory;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
}
