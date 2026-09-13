import { z } from 'zod';
import { PROOF_OBLIGATIONS } from './attestation.js';

/** Runtime-owned experiment inputs and evidence. Never parsed from model prose. */
export const depthModeSchema = z.enum(['deep', 'short']);
export type DepthMode = z.infer<typeof depthModeSchema>;
export const proofFloorSchema = z.array(z.object({
  obligation: z.enum(PROOF_OBLIGATIONS),
  deliverable: z.string().min(1),
}));
export type ProofFloor = z.infer<typeof proofFloorSchema>;
const actorSchema = z.object({ name: z.string(), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]) });
export const phaseCoverageSchema = z.object({
  attempt: z.number().int().positive(),
  branchId: z.string().optional(),
  acceptor: actorSchema,
  executor: actorSchema,
  obligations: z.array(z.object({
    obligation: z.enum(PROOF_OBLIGATIONS), covered: z.boolean(), reason: z.string(), eventIds: z.array(z.string()),
  })),
});
export type PhaseCoverageRecord = z.infer<typeof phaseCoverageSchema>;
export const topologySchema = z.object({
  at: z.enum(['entry', 'deepening']), mode: depthModeSchema,
  reason: z.enum(['arm', 'fallback-moment']), attempt: z.number().int().positive(),
});
export type TopologyInfo = z.infer<typeof topologySchema>;
export const acceptanceSchema = z.object({
  attempt: z.number().int().positive(), approved: z.boolean(), reasoning: z.string(),
  acceptor: actorSchema.extend({ role: z.literal('root-acceptor') }),
  executor: actorSchema.extend({ viaFallback: z.boolean() }),
  gates: z.array(z.object({ id: z.string(), disposition: z.enum(['reject', 'reject-once', 'requires-review']) })),
  probe: z.object({ requiresReview: z.boolean(), contradiction: z.boolean() }),
  floorCoverage: z.array(z.object({
    kind: z.enum(PROOF_OBLIGATIONS), deliverable: z.string(),
    status: z.enum(['covered', 'uncovered']), observationRefs: z.array(z.string()),
  })),
  phaseCoverage: z.array(phaseCoverageSchema),
  basis: z.enum(['mechanical', 'validation-call']),
});
export type AcceptanceInfo = z.infer<typeof acceptanceSchema>;
