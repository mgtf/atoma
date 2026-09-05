import type { AuthStore, Viewer } from './store.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';

/** Both HTTP and MCP use the same authorised, journaled mutation. */
export function updateOrgModels(auth: AuthStore, viewer: Viewer, input: unknown, emit: PlatformEventSink) {
  if (!viewer.platformAdmin && viewer.role !== 'org:owner' && viewer.role !== 'org:admin') {
    throw new Error('org admin required');
  }
  const models = auth.setOrgTierModels(viewer.orgId, input);
  emit({
    kind: 'org.models_updated',
    actorType: 'principal',
    actorId: viewer.principalId,
    orgId: viewer.orgId,
    summary: `Organisation tier defaults updated (${models.l1 ?? '-'} / ${models.l2 ?? '-'} / ${models.l3 ?? '-'})`,
  });
  return models;
}
