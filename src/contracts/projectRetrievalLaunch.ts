import { z } from 'zod';
import { projectRetrievalScopeSchema } from './projectRetrieval.js';
import { projectRetrievalManifestSchema } from './projectRetrievalCorpus.js';
import { projectRunIdSchema, sha256Schema } from './projects.js';

/** Internal child marker: the host prepared a receipt. Never forwarded from operator configuration. */
export const PROJECT_RETRIEVAL_RECEIPT_ENV = 'ATOMA_PROJECT_RETRIEVAL_RECEIPT';
export function hasProjectRetrievalReceipt(env: NodeJS.ProcessEnv): boolean {
  const value = env[PROJECT_RETRIEVAL_RECEIPT_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error('ATOMA_PROJECT_RETRIEVAL_RECEIPT must be 1 when supplied');
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
