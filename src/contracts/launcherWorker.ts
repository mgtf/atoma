import { projectWorkspaceIdentitySchema } from './launcherVolumes.js';
import { z } from 'zod';
import { launcherOwnerIdSchema } from './launcher.js';

/** Workspace keys are operator-configured capabilities, never caller paths. */
export const workerWorkspaceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const launcherWorkerSpecSchema = z.object({
  ownerId: launcherOwnerIdSchema,
  workspaceId: workerWorkspaceIdSchema.optional(),
  project: projectWorkspaceIdentitySchema.optional(),
  egress: z.boolean(),
}).strict();
export type LauncherWorkerSpec = z.infer<typeof launcherWorkerSpecSchema>;
export const launcherWorkerHandleSchema = z.object({
  id: z.string().uuid(), ownerId: launcherOwnerIdSchema,
  socketPath: z.string().min(1), workspaceHostPath: z.string().min(1), volume: z.string().optional(),
}).strict();
export type LauncherWorkerHandle = z.infer<typeof launcherWorkerHandleSchema>;
export interface WorkerLauncher {
  startWorker(spec: LauncherWorkerSpec): Promise<LauncherWorkerHandle>;
  stopWorker(id: string): Promise<void>;
}
