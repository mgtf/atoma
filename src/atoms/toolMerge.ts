import type { Tool } from '../core/types.js';

/**
 * Merge the parent atom's tool declarations with any the LLM seed supplied.
 * Parent tools win on name collision so that system-provided tools (e.g. the
 * real file/shell/server executors) can't be shadowed by LLM-hallucinated
 * declarations.
 */
export function mergeTools(parentTools: readonly Tool[], seedTools: Tool[]): Tool[] {
  const byName = new Map<string, Tool>();
  for (const t of seedTools) byName.set(t.name, t);
  for (const t of parentTools) byName.set(t.name, t);
  return [...byName.values()];
}
