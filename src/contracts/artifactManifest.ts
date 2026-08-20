import { z } from 'zod';

export const DECLARED_ARTIFACT_MANIFEST_VERSION = 1;

export const declaredArtifactManifestSchema = z.object({
  version: z.literal(DECLARED_ARTIFACT_MANIFEST_VERSION),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  generatedAt: z.string().datetime(),
  outputs: z.array(z.string().min(1).max(1_024)).max(1_000),
});

export type DeclaredArtifactManifest = z.infer<typeof declaredArtifactManifestSchema>;
