import { z } from 'zod';
import { projectRetrievalScopeSchema } from './projectRetrieval.js';
import { projectRetrievalManifestSchema } from './projectRetrievalCorpus.js';
import { projectRunIdSchema, sha256Schema } from './projects.js';

/** Host rollout switch. The coordinator emits a receipt; the switch alone grants nothing. */
export const PROJECT_RETRIEVAL_ENV = 'ATOMA_PROJECT_RETRIEVAL';
export function projectRetrievalEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[PROJECT_RETRIEVAL_ENV];
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('ATOMA_PROJECT_RETRIEVAL must be 0 or 1');
}

/** Immutable host receipt, keyed by the existing run id; never a worker/model input. */
export const projectRetrievalLaunchSchema = z.object({
  version: z.literal(1),
  scope: projectRetrievalScopeSchema.refine(s => s.kind === 'tenant', 'expected tenant scope'),
  manifest: projectRetrievalManifestSchema,
  sourceRunId: projectRunIdSchema.nullable(),
  sourceManifestHash: sha256Schema.nullable(),
  sourceRoot: z.string().min(1),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.scope.corpusId !== receipt.manifest.corpusId ||
      receipt.scope.snapshotId !== receipt.manifest.snapshotId ||
      receipt.scope.snapshotSha256 !== receipt.manifest.snapshotSha256 ||
      (receipt.sourceRunId === null && receipt.sourceManifestHash !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'inconsistent retrieval receipt' });
  }
}).readonly();
export type ProjectRetrievalLaunch = z.infer<typeof projectRetrievalLaunchSchema>;
