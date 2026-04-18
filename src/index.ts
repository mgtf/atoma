export * from './core/types.js';
export * from './core/errors.js';
export * from './core/limits.js';
export { Atom, type Peerable, type Supervisor } from './core/atom.js';
export { superviseLoop, type SupervisionHooks, renderTraceForContext } from './core/supervisor.js';
export { AnthropicLlmClient, MockLlmClient } from './core/llm.js';
export { resolveLatestOpus, FALLBACK_OPUS, PIN_SONNET, PIN_HAIKU } from './core/models.js';

export { openDb, type DB } from './registry/db.js';
export { AtomRegistry, type AtomType, type CreateSeed } from './registry/atomRegistry.js';
export { ELEMENTS, nextAvailableElement, type Element } from './registry/taxonomies/elements.js';
export { MOLECULES, nextAvailableMolecule, type Molecule } from './registry/taxonomies/molecules.js';
export { CELLS, nextAvailableCell, type Cell } from './registry/taxonomies/cells.js';

export { L1Atom } from './atoms/L1Atom.js';
export { L2Atom, VALIDATION_SYSTEM_PROMPT, llmVerdict } from './atoms/L2Atom.js';
export { L3Atom } from './atoms/L3Atom.js';
export { mergeTools } from './atoms/toolMerge.js';
export {
  TRUST_THRESHOLD_SUCCESSES,
  shouldTrustType,
  trustedApproval,
  PREFILTER_SYSTEM_PROMPT,
  prefilterStrategy,
  prefilterResponseSchema,
  type PrefilterOutcome,
  type CatalogEntry,
} from './atoms/cost.js';

export { ToolSandbox } from './tools/sandbox.js';
export { InMemoryToolRegistry } from './tools/registry.js';
export {
  writeFileTool,
  readFileTool,
  listFilesTool,
  runShellTool,
  startStaticServerTool,
  defaultBuiltinTools,
  type BuiltinTool,
  type BuiltinToolOptions,
} from './tools/builtin.js';
