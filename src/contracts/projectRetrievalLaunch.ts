import { z } from 'zod';
import { projectRetrievalScopeSchema } from './projectRetrieval.js';
import { projectRetrievalManifestSchema } from './projectRetrievalCorpus.js';
import { projectRunIdSchema, sha256Schema } from './projects.js';

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
