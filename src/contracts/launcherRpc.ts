import { launcherWorkerSpecSchema, launcherWorkerHandleSchema } from './launcherWorker.js';
import { z } from 'zod';
import {
  launcherFamilySchema, launcherNetworkHandleSchema, launcherNetworkSpecSchema,
  launcherOwnerIdSchema, launcherPreviewOwnershipSchema, launcherStopReasonSchema,
  launcherUnitHandleSchema, launcherUnitKindSchema, launcherUnitSpecSchema,
  launcherUnitSummarySchema, launcherWorkspaceHandleSchema,
} from './launcher.js';

export const LAUNCHER_PROTOCOL_VERSION = 2;
export const LAUNCHER_FRAME_BYTES = 256 * 1024;
export const LAUNCHER_REQUEST_TIMEOUT_MS = 120_000;
const owner = { family: launcherFamilySchema, ownerId: launcherOwnerIdSchema };
const operation = <T extends string, S extends z.ZodRawShape>(op: T, shape: S) =>
  z.object({ op: z.literal(op), ...shape }).strict();

/** No engine options or configuration cross this socket. */
export const launcherRequestSchema = z.discriminatedUnion('op', [
  operation('hello', { version: z.literal(LAUNCHER_PROTOCOL_VERSION) }),
  operation('heartbeat', {}),
  operation('startWorker', { spec: launcherWorkerSpecSchema }),
  operation('stopWorker', { id: z.string().uuid() }),
  operation('purgeOwner', owner),
  operation('armHardExitCleanup', owner),
  operation('disarmHardExitCleanup', owner),
  operation('createNetwork', { spec: launcherNetworkSpecSchema }),
  operation('removeNetwork', { handle: launcherNetworkHandleSchema }),
  operation('removeNetworkBefore', {
    handle: launcherNetworkHandleSchema, deadlineMs: z.number().finite().nonnegative(),
  }),
  operation('startUnit', { spec: launcherUnitSpecSchema, networks: z.array(launcherNetworkHandleSchema).min(1).max(2) }),
  operation('awaitUnitReady', { handle: launcherUnitHandleSchema, timeoutMs: z.number().int().min(1).max(60_000).optional() }),
  operation('stopUnit', { handle: launcherUnitHandleSchema, reason: launcherStopReasonSchema }),
  operation('createWorkspace', { ownerId: launcherOwnerIdSchema }),
  operation('removeWorkspace', { handle: launcherWorkspaceHandleSchema }),
  operation('listUnits', { kind: launcherUnitKindSchema.optional() }),
  operation('reconcileOrphans', {}),
]);
export type LauncherRequest = z.infer<typeof launcherRequestSchema>;

export const launcherHelloSchema = z.object({
  version: z.literal(LAUNCHER_PROTOCOL_VERSION),
  image: z.string().min(1),
  previewImage: z.string().min(1),
  previewRuntime: z.enum(['runsc', 'runc']),
  previewOwnership: launcherPreviewOwnershipSchema,
}).strict();
export type LauncherHello = z.infer<typeof launcherHelloSchema>;
export const launcherResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['invalid-request', 'operation-failed', 'isolated-gateway-unsupported']) }).strict(),
]);

/** Per-operation response validation; void is encoded as null. */
export const launcherResults = {
  heartbeat: z.null(), hello: launcherHelloSchema, startWorker: launcherWorkerHandleSchema, stopWorker: z.null(),
  purgeOwner: z.null(), armHardExitCleanup: z.null(), disarmHardExitCleanup: z.null(),
  createNetwork: launcherNetworkHandleSchema,
  removeNetwork: z.boolean(), removeNetworkBefore: z.boolean(),
  startUnit: launcherUnitHandleSchema, awaitUnitReady: z.null(), stopUnit: z.null(),
  createWorkspace: launcherWorkspaceHandleSchema, removeWorkspace: z.null(),
  listUnits: z.array(launcherUnitSummarySchema).max(4096), reconcileOrphans: z.number().int().nonnegative(),
} as const;
