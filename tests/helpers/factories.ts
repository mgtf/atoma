import type { AggregationSpec, Plan, Tool } from '../../src/core/types.js';

/**
 * Typed factories for the two shapes the suite builds most often.
 *
 * WHY THEY EXIST. `tsconfig.json` excludes `tests/` and vitest transpiles with
 * esbuild, which does not typecheck — so for the life of this project the test
 * suite was never type-checked at all. When `tsconfig.eslint.json` finally put
 * it under the compiler, 96 errors appeared, and the two biggest clusters were
 * both stale hand-written literals:
 *
 *   - `Tool` was being built as `{name, description, parameters, execute}`.
 *     The real contract is `{name, description, inputSchema}` — a DECLARATION
 *     with no executor (that lives on `BuiltinTool.execute`). The `parameters`
 *     key has not existed for a long time; nothing caught it because nothing
 *     looked.
 *   - `Plan` was being built as `{reasoning, proposedAction, expectedOutput}`,
 *     the pre-fan-out shape. `subtasks` and `aggregation` are required now.
 *
 * Using these instead of a literal means the next contract change breaks the
 * factory once rather than silently leaving thirty tests asserting against a
 * shape the code no longer produces.
 */

/** A tool DECLARATION. No executor — see `BuiltinTool` for the pair. */
export function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    ...overrides,
  };
}

export function makeTools(names: readonly string[]): Tool[] {
  return names.map((n) => makeTool(n));
}

/**
 * A minimal valid `Plan`. Defaults to a no-subtask, concat plan — the shape a
 * tier-1 atom produces — and takes overrides for everything else.
 */
export function makePlan(overrides: Partial<Plan> = {}): Plan {
  const aggregation: AggregationSpec = { mode: 'concat' };
  return {
    reasoning: 'test plan',
    subtasks: [],
    aggregation,
    expectedOutput: 'test output',
    ...overrides,
  };
}
