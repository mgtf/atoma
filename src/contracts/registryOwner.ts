import { z } from 'zod';
import { organisationIdSchema, projectIdSchema } from './projects.js';

/** An ownership label, not an access grant. Only the host resolves project ownership. */
export const registryOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator') }).strict(),
  z.object({ kind: z.literal('project'), orgId: organisationIdSchema, projectId: projectIdSchema }).strict(),
]);
export type RegistryOwner = z.infer<typeof registryOwnerSchema>;

export function registryOwnerKey(input: RegistryOwner): string {
  const owner = registryOwnerSchema.parse(input);
  return owner.kind === 'operator' ? 'operator' : `project:${owner.orgId}:${owner.projectId}`;
}
