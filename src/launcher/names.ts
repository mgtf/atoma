import { createHash } from 'node:crypto';
import type { LauncherNetworkSpec, LauncherOwnerId, LauncherUnitKind } from '../contracts/launcher.js';

/** Stable wire identities shared by the local backend and socket client. */
export function launcherObjectId(ownerId: string): string {
  const readable = ownerId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 30) || 'run';
  const hash = createHash('sha256').update(ownerId).digest('hex').slice(0, 10);
  return `${readable}-${hash}`;
}

export function launcherNetworkName(spec: LauncherNetworkSpec): string {
  const id = launcherObjectId(spec.ownerId);
  if (spec.family === 'preview') {
    return spec.kind === 'internal' ? `atoma-preview-net-${id}` : `atoma-preview-pub-${id}`;
  }
  return spec.kind === 'internal' ? `atoma-egress-${id}` : `atoma-uplink-${id}`;
}

export function launcherUnitName(kind: LauncherUnitKind, ownerId: LauncherOwnerId): string {
  const id = launcherObjectId(ownerId);
  if (kind === 'egress-proxy') return `atoma-proxy-${id}`;
  if (kind === 'preview-egress-proxy') return `atoma-preview-proxy-${id}`;
  if (kind === 'preview-app') return `atoma-preview-app-${id}`;
  return `atoma-preview-relay-${id}`;
}
