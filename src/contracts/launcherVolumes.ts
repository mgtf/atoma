import { z } from 'zod';

const component = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const projectWorkspaceIdentitySchema = z.object({ orgId: component, projectId: component, runId: component }).strict();
export type ProjectWorkspaceIdentity = z.infer<typeof projectWorkspaceIdentitySchema>;
/** One derivation shared by the coordinator and launcher; display names never enter it. */
export function projectWorkspaceRelative(identity: ProjectWorkspaceIdentity): string {
  const value = projectWorkspaceIdentitySchema.parse(identity);
  return `projects/${value.orgId}/${value.projectId}/${value.runId}/workspace`;
}
export const WORKSPACE_LEASE_MS = 10 * 60_000;
export const WORKSPACE_HARD_MS = 24 * 60 * 60_000;
export const WORKSPACE_HEARTBEAT_MS = 30_000;
export const volumeLeaseSchema = z.object({
  phase: z.enum(['reserved', 'creating', 'ready']),
  family: z.enum(['worker', 'preview']), ownerId: z.string().min(1), id: z.string().min(1),
  volume: z.string().regex(/^atoma-workspace-(worker|preview)-[a-zA-Z0-9_-]+$/),
  hostPath: z.string().min(1), expiresAt: z.number(), hardDeadline: z.number(),
}).strict();
export type VolumeLease = z.infer<typeof volumeLeaseSchema>;
export const volumeJournalSchema = z.object({ version: z.literal(1), leases: z.array(volumeLeaseSchema) }).strict();
