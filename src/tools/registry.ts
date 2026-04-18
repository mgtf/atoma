import type { Tool, ToolExecutor } from '../core/types.js';
import type { BuiltinTool } from './builtin.js';

/**
 * Maps tool names to their implementations. Declarations (serialisable schema)
 * are stored in the AtomRegistry; implementations live here, injected via
 * RunContext. This keeps the DB free of unserialisable functions while still
 * letting atoms invoke real side effects.
 */
export class InMemoryToolRegistry implements ToolExecutor {
  private readonly impls = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  private readonly decls = new Map<string, Tool>();

  register(tool: BuiltinTool): void {
    this.impls.set(tool.declaration.name, tool.execute);
    this.decls.set(tool.declaration.name, tool.declaration);
  }

  registerAll(tools: BuiltinTool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.impls.has(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.impls.get(name);
    if (!fn) throw new Error(`ToolRegistry: no executor for tool "${name}"`);
    return fn(args);
  }

  /** The declarations for all registered tools — pass these to an atom. */
  declarations(): Tool[] {
    return [...this.decls.values()];
  }
}
