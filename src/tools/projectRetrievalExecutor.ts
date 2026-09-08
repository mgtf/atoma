import type { Tool, ToolExecutor } from '../core/types.js';
import { PROJECT_RETRIEVAL_TOOL_NAME } from '../contracts/projectRetrieval.js';
import type { createProjectRetrievalTool } from './projectRetrieval.js';

/** Explicit host interception, never dispatch instructions found in worker results. */
export function projectRetrievalExecutor(
  worker: ToolExecutor, workerDeclarations: readonly Tool[],
  retrieval: ReturnType<typeof createProjectRetrievalTool>
): { executor: ToolExecutor; toolDecls: Tool[] } {
  const names = new Set<string>();
  for (const declaration of [...workerDeclarations, retrieval.declaration]) {
    if (names.has(declaration.name)) throw new Error('duplicate tool declaration in project retrieval backend');
    names.add(declaration.name);
  }
  if (worker.has(PROJECT_RETRIEVAL_TOOL_NAME)) throw new Error('project retrieval cannot shadow a worker tool');
  const executor: ToolExecutor = {
    has: name => !retrieval.closed && names.has(name),
    execute: async (name, args) => {
      if (retrieval.closed) throw new Error('project retrieval backend is closed');
      if (!names.has(name)) throw new Error('tool is not declared by this backend');
      return name === PROJECT_RETRIEVAL_TOOL_NAME ? retrieval.execute(args) : worker.execute(name, args);
    },
  };
  return { executor, toolDecls: structuredClone([...workerDeclarations, retrieval.declaration]) };
}
