/**
 * Compatibility surface for the old registry taxonomy import path.
 *
 * Elements now classify tools rather than tier-1 agents. The source of truth
 * lives under contracts so the local and container tool runtimes consume the
 * exact same catalogue without importing the registry/storage layer.
 */
export {
  ELEMENTS,
  BUILTIN_TOOL_ELEMENTS,
  BUILTIN_TOOL_NAMES,
  elementForTool,
  nextAvailableElement,
  type Element,
  type ToolElement,
} from '../../contracts/toolTaxonomy.js';
