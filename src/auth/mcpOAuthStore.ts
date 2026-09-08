import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuthStore, Viewer } from './store.js';

export const MCP_OAUTH_SCOPE = 'mcp';
export const MCP_ACCESS_TTL_MS = 60 * 60 * 1000;
export const MCP_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_CODE_TTL_MS = 5 * 60 * 1000;
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 10_000;
const MAX_CODES = 1_024;
export const oauthHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');

/** These tables extend the primary auth store; API-token rows own grants and revocation. */
export const MCP_OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS auth_mcp_clients (
  client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_mcp_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT NOT NULL,
  principal_id TEXT NOT NULL, org_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  token_id TEXT
);
CREATE TABLE IF NOT EXISTS auth_mcp_grants (
  token_id TEXT PRIMARY KEY REFERENCES auth_api_tokens(token_id),
  client_id TEXT NOT NULL, resource TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_mcp_refresh (
  token_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES auth_mcp_grants(token_id),
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auth_mcp_refresh_grant_idx ON auth_mcp_refresh(token_id);
`;

export interface McpOAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}
interface CodeRow {
  code_hash: string; client_id: string; redirect_uri: string; challenge: string;
  resource: string; principal_id: string; org_id: string; expires_at: number; token_id: string | null;
}
type Revoked = (receipt: { tokenId: string; principalId: string; orgId: string }) => void;
interface GrantRow {
  token_id: string; client_id: string; resource: string; refresh_expires_at: number;
  principal_id: string; org_id: string; revoked_at: string | null; used: number;
}

/** Public clients use authorization code + S256 only; no client secrets or upstream token passthrough. */
export class McpOAuthStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  register(clientName: string, redirectUris: string[]): McpOAuthClient {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_mcp_clients WHERE expires_at <= ?').run(this.now());
      const { count } = this.db.prepare('SELECT count(*) AS count FROM auth_mcp_clients').get() as { count: number };
      if (count >= MAX_CLIENTS) throw new Error('OAuth client capacity reached');
      const client = { client_id: randomUUID(), client_name: clientName, redirect_uris: redirectUris };
      this.db.prepare('INSERT INTO auth_mcp_clients VALUES (?, ?, ?, ?)')
        .run(client.client_id, clientName, JSON.stringify(redirectUris), this.now() + CLIENT_TTL_MS);
      return client;
    })();
  }

  client(id: string): McpOAuthClient | null {
    const row = this.db.prepare('SELECT * FROM auth_mcp_clients WHERE client_id = ? AND expires_at > ?')
      .get(id, this.now()) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
    return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  code(input: { clientId: string; redirectUri: string; challenge: string; resource: string; viewer: Viewer }): string {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM auth_mcp_codes WHERE expires_at <= ?').run(this.now());
      const { count } = this.db.prepare('SELECT count(*) AS count FROM auth_mcp_codes').get() as { count: number };
      if (count >= MAX_CODES) throw new Error('OAuth authorization capacity reached');
      const code = secret();
      this.db.prepare(`INSERT INTO auth_mcp_codes
        (code_hash, client_id, redirect_uri, challenge, resource, principal_id, org_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(oauthHash(code), input.clientId, input.redirectUri,
        input.challenge, input.resource, input.viewer.principalId, input.viewer.orgId, this.now() + MCP_CODE_TTL_MS);
      return code;
    })();
  }

  exchange(auth: AuthStore, input: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string }, onRevoked?: Revoked) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM auth_mcp_codes WHERE code_hash = ?')
        .get(oauthHash(input.code)) as CodeRow | undefined;
      if (!row || row.expires_at <= this.now() || row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri || row.resource !== input.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
        createHash('sha256').update(input.verifier).digest('base64url') !== row.challenge) return null;
      // A valid replay revokes the authorization it previously redeemed.
      if (row.token_id) { if (auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id }); return null; }
      const client = this.client(input.clientId);
      if (!client || !this.member(row.principal_id, row.org_id)) return null;
      const minted = auth.createApiToken({ principalId: row.principal_id, orgId: row.org_id, label: `OAuth: ${client.client_name}` });
      this.db.prepare('INSERT INTO auth_mcp_grants VALUES (?, ?, ?, ?, ?)')
        .run(minted.tokenId, input.clientId, input.resource, this.now() + MCP_ACCESS_TTL_MS, this.now() + MCP_REFRESH_TTL_MS);
      this.db.prepare('UPDATE auth_mcp_codes SET token_id = ? WHERE code_hash = ?').run(minted.tokenId, row.code_hash);
      return { ...this.tokens(minted.tokenId, minted.token), principalId: row.principal_id, orgId: row.org_id };
    })();
  }

  refresh(auth: AuthStore, input: { token: string; clientId: string; resource: string }, onRevoked?: Revoked) {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT g.*, t.principal_id, t.org_id, t.revoked_at, r.used
        FROM auth_mcp_refresh r JOIN auth_mcp_grants g ON g.token_id = r.token_id
        JOIN auth_api_tokens t ON t.token_id = g.token_id WHERE r.token_hash = ?`)
        .get(oauthHash(input.token)) as GrantRow | undefined;
      if (!row || row.client_id !== input.clientId || row.resource !== input.resource || row.revoked_at ||
        row.refresh_expires_at <= this.now() || !this.client(input.clientId)) return null;
      if (row.used) { if (auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id }); return null; }
      if (!this.member(row.principal_id, row.org_id)) return null;
      this.db.prepare('UPDATE auth_mcp_refresh SET used = 1 WHERE token_hash = ?').run(oauthHash(input.token));
      const access = `atoma_${secret()}`;
      this.db.prepare('UPDATE auth_api_tokens SET token_hash = ? WHERE token_id = ?').run(oauthHash(access), row.token_id);
      this.db.prepare('UPDATE auth_mcp_grants SET access_expires_at = ? WHERE token_id = ?')
        .run(Math.min(this.now() + MCP_ACCESS_TTL_MS, row.refresh_expires_at), row.token_id);
      // Absolute 30-day grant lifetime, never extended by a refresh.
      return { ...this.tokens(row.token_id, access), principalId: row.principal_id, orgId: row.org_id };
    })();
  }

  sweep(): void {
    this.db.prepare('DELETE FROM auth_mcp_codes WHERE expires_at <= ?').run(this.now());
    this.db.prepare(`DELETE FROM auth_mcp_refresh WHERE token_id IN
      (SELECT g.token_id FROM auth_mcp_grants g JOIN auth_api_tokens t ON t.token_id = g.token_id
       WHERE g.refresh_expires_at <= ? OR t.revoked_at IS NOT NULL)`).run(this.now());
    this.db.prepare('DELETE FROM auth_mcp_clients WHERE expires_at <= ?').run(this.now());
  }

  accessCurrent(tokenId: string): boolean {
    const row = this.db.prepare('SELECT access_expires_at FROM auth_mcp_grants WHERE token_id = ?')
      .get(tokenId) as { access_expires_at: number } | undefined;
    return !row || row.access_expires_at > this.now();
  }

  revoke(auth: AuthStore, token: string, clientId: string, onRevoked?: Revoked): void {
    const row = this.db.prepare(`SELECT t.token_id, t.principal_id, t.org_id FROM auth_api_tokens t
      JOIN auth_mcp_grants g ON g.token_id = t.token_id
      WHERE g.client_id = ? AND (t.token_hash = ? OR t.token_id IN
        (SELECT token_id FROM auth_mcp_refresh WHERE token_hash = ?))`)
      .get(clientId, oauthHash(token), oauthHash(token)) as { token_id: string; principal_id: string; org_id: string } | undefined;
    if (row && auth.revokeApiToken(row.principal_id, row.token_id)) onRevoked?.({ tokenId: row.token_id, principalId: row.principal_id, orgId: row.org_id });
    return;
  }

  private member(principalId: string, orgId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auth_memberships WHERE principal_id = ? AND org_id = ?').get(principalId, orgId);
  }

  private tokens(tokenId: string, access: string) {
    const refresh = secret();
    this.db.prepare('INSERT INTO auth_mcp_refresh (token_hash, token_id) VALUES (?, ?)').run(oauthHash(refresh), tokenId);
    const expiry = this.db.prepare('SELECT access_expires_at FROM auth_mcp_grants WHERE token_id = ?')
      .get(tokenId) as { access_expires_at: number };
    return { tokenId, access_token: access, token_type: 'Bearer' as const,
      expires_in: Math.max(0, Math.floor((expiry.access_expires_at - this.now()) / 1000)), refresh_token: refresh, scope: MCP_OAUTH_SCOPE };
  }
}
