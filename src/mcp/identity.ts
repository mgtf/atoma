import type { Viewer } from '../auth/store.js';

/**
 * WHO IS CALLING THE MCP, and what tier of the catalogue they may see.
 *
 * One MCP for everyone (decision 2026-09-05, `docs/mcp-one-surface-2026-09-05.md`):
 * the same server, the same tool names, and a catalogue whose visibility is
 * decided by the caller's tier. `tools/list` shows a caller only the tools
 * their tier admits, and every `tools/call` re-checks the tier, so hiding a
 * tool is never the only thing standing between a viewer and an admin action.
 *
 * TWO KINDS OF CALLER, ONE LADDER:
 *   - `operator`: the ungated local server, reached over loopback by whoever
 *     possesses the machine. Possession is the credential, exactly as it is
 *     for the operator CLI, so the operator sits at the top of the ladder.
 *   - `principal`: a bearer API token minted by a signed-in principal for one
 *     organisation. Its tier is the principal's role in that organisation,
 *     lifted to `platform` when the principal carries the platform-admin flag
 *     — the flag the CLI mints and no OAuth claim can.
 */
export type McpTier = 'viewer' | 'member' | 'admin' | 'platform';

const TIER_RANK: Record<McpTier, number> = { viewer: 0, member: 1, admin: 2, platform: 3 };

export type McpCaller =
  | { readonly kind: 'operator' }
  | { readonly kind: 'principal'; readonly viewer: Viewer; readonly tokenId: string };

export function callerTier(caller: McpCaller): McpTier {
  if (caller.kind === 'operator') return 'platform';
  const { viewer } = caller;
  if (viewer.platformAdmin) return 'platform';
  if (viewer.role === 'org:owner' || viewer.role === 'org:admin') return 'admin';
  if (viewer.role === 'org:member') return 'member';
  return 'viewer';
}

export function tierAllows(actual: McpTier, minimum: McpTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[minimum];
}

/** A stable identity for a session: a token never outlives its principal's tier. */
export function callerKey(caller: McpCaller): string {
  if (caller.kind === 'operator') return 'operator';
  return `${caller.viewer.principalId}:${caller.viewer.orgId}:${caller.tokenId}:${callerTier(caller)}`;
}

/** Operator-facing label, secret-free. */
export function describeCaller(caller: McpCaller): string {
  if (caller.kind === 'operator') return 'operator (loopback, ungated)';
  const { viewer } = caller;
  return `${viewer.displayName} · ${viewer.orgName} · ${viewer.role}${viewer.platformAdmin ? ' · platform admin' : ''}`;
}
