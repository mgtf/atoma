import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import { McpOAuth } from '../src/auth/mcpOAuth.js';
import { issueSession, parseCookieHeader, SESSION_COOKIE } from '../src/auth/sessions.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { buildServer } from '../src/mcp/server.js';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

let db: Database.Database;
let auth: AuthStore;
let server: Server;
let mcp: McpHttpHost;
let base: string;
let viewer: Viewer;
let cookie: string;
let events: PlatformEventInput[];
const callback = 'http://127.0.0.1:54321/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeEach(async () => {
  db = new Database(':memory:'); auth = new AuthStore(db); events = [];
  viewer = auth.completeLogin({ provider: 'github', subject: 'oauth-test', displayName: 'OAuth Test', email: null, emailVerified: false }, null)!.viewer;
  cookie = `${SESSION_COOKIE}=${issueSession(auth, viewer, { secure: false }).token}`;
  server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const gate = { enabled: true, store: auth, resolve: (req: import('node:http').IncomingMessage) => {
    const tokens = parseCookieHeader(req.headers.cookie).filter(c => c.name === SESSION_COOKIE);
    return tokens.length === 1 ? auth.resolveSession(tokens[0]!.value) : null;
  } };
  const oauth = new McpOAuth({ gate, origin: new URL(base), clientAddress: () => 'local', emit: e => { events.push(e); } });
  mcp = new McpHttpHost({ resourceMetadataUrl: oauth.metadataUrl, allowedHosts: [new URL(base).host],
    resolveCaller: req => {
      const resolved = auth.resolveApiToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!resolved) return null;
      const { tokenId, ...identity } = resolved;
      return { kind: 'principal', viewer: identity, tokenId };
    }, buildServer: caller => buildServer(caller, { projects: null, auth, journal: null, operatorRuns: false }) });
  server.on('request', (req, res) => {
    void (async () => {
      if (await oauth.handle(req, res, new URL(req.url!, base))) return;
      if (req.url === '/mcp') { await mcp.handle(req, res); return; }
      res.writeHead(404).end();
    })().catch((error: unknown) => { res.writeHead(500).end(String(error)); });
  });
});
afterEach(async () => {
  await mcp.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve())); db.close();
});
const post = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data),
});
async function register(redirects = [callback]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Codex <test>', redirect_uris: redirects, token_endpoint_auth_method: 'none' }) });
  expect(r.status).toBe(201);
  return (await r.json() as { client_id: string }).client_id;
}
async function consent(clientId: string, changes: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback,
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'mcp', state: 'client-state', ...changes });
  return fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
}
async function code(clientId: string) {
  const page = await consent(clientId); expect(page.status).toBe(200);
  const html = await page.text(); expect(html).toContain('Codex &lt;test&gt;');
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const approved = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('client-state');
  expect(location.searchParams.get('iss')).toBe(base);
  return location.searchParams.get('code')!;
}
function exchange(clientId: string, authorizationCode: string, changes: Record<string, string> = {}) {
  return post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: authorizationCode,
    redirect_uri: callback, code_verifier: verifier, resource: `${base}/mcp`, ...changes });
}
interface Tokens { access_token: string; refresh_token: string; expires_in: number }

describe('MCP OAuth over HTTP', () => {
  it('discovers, consents, exchanges, calls the real MCP and revokes through existing API-token ownership', async () => {
    const denied = await fetch(`${base}/mcp`);
    expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=');
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then(r => r.json());
    expect(metadata).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`).then(r => r.json());
    expect(discovery).toMatchObject({ code_challenge_methods_supported: ['S256'], registration_endpoint: `${base}/oauth/register` });
    const clientId = await register();
    const response = await exchange(clientId, await code(clientId)); expect(response.status).toBe(200);
    const tokens = await response.json() as Tokens; expect(tokens.expires_in).toBeGreaterThanOrEqual(3599);
    const client = new Client({ name: 'oauth-smoke', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
      expect((await client.callTool({ name: 'atoma_families', arguments: {} })).isError).not.toBe(true);
    } finally { await client.close(); }
    const record = auth.listApiTokens(viewer.principalId)[0]!;
    expect(record.label).toBe('OAuth: Codex <test>');
    expect(events.map(e => e.kind)).toContain('token.created');
    auth.revokeApiToken(viewer.principalId, record.tokenId);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect((await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` })).status).toBe(400);
  });

  it('rejects invalid PKCE, redirect, audience and client without consuming a valid code; a valid replay revokes it', async () => {
    const clientId = await register(); const authCode = await code(clientId);
    for (const invalid of ([{ code_verifier: 'x'.repeat(43) }, { redirect_uri: 'https://evil.example/cb' },
      { resource: 'https://evil.example/mcp' }, { client_id: await register() }] as Record<string, string>[])) {
      expect((await exchange(clientId, authCode, invalid)).status).toBe(400);
    }
    const tokens = await (await exchange(clientId, authCode)).json() as Tokens;
    expect(auth.resolveApiToken(tokens.access_token)).not.toBeNull();
    expect((await exchange(clientId, authCode)).status).toBe(400);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect(events.map(e => e.kind)).toContain('token.revoked');
  });

  it('rotates refresh tokens, detects reuse and enforces access expiry and current roles', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    db.prepare('UPDATE auth_mcp_grants SET access_expires_at = 0').run();
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    db.prepare("UPDATE auth_memberships SET role = 'org:viewer'").run();
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    const refreshed = await (await post('/oauth/token', data)).json() as Tokens;
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect(auth.resolveApiToken(refreshed.access_token)?.role).toBe('org:viewer');
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(auth.resolveApiToken(refreshed.access_token)).toBeNull();
  });

  it('requires explicit consent bound to the displayed browser session, origin and organisation', async () => {
    const clientId = await register(); const html = await (await consent(clientId)).text();
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
    const otherCookie = `${SESSION_COOKIE}=${issueSession(auth, viewer, { secure: false }).token}`;
    for (const headers of [{ cookie, origin: 'https://evil.example' }, { cookie, origin: 'null' }, { cookie: otherCookie, origin: base }]) {
      expect((await post('/oauth/authorize', { request, decision: 'allow' }, headers)).status).toBe(403);
    }
    expect(auth.listApiTokens(viewer.principalId)).toHaveLength(0);
    const denied = await post('/oauth/authorize', { request, decision: 'deny' }, { cookie, origin: base });
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect((await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base })).status).toBe(400);
  });

  it('rejects unsafe redirects, duplicate parameters, plain PKCE, unregistered redirects and foreign resources', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://user:pass@example.com/cb', 'https://example.com/cb#fragment']) {
      expect((await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }) })).status).toBe(400);
    }
    const clientId = await register();
    for (const invalid of ([{ code_challenge_method: 'plain' }, { redirect_uri: 'http://127.0.0.1:123/callback' }, { resource: 'https://other.example/mcp' }] as Record<string, string>[])) {
      const r = await consent(clientId, invalid);
      if (invalid['redirect_uri']) { expect(r.status).toBe(400); expect(r.headers.get('location')).toBeNull(); }
      else { expect(r.status).toBe(302); expect(new URL(r.headers.get('location')!).searchParams.has('error')).toBe(true); }
    }
    expect((await fetch(`${base}/oauth/authorize?request=a&request=b`)).status).toBe(400);
  });

  it('interoperates with the SDK OAuth client for automatic discovery, DCR, PKCE and refresh', async () => {
    let clientInfo: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let authorizationUrl: URL | undefined;
    let savedVerifier = '';
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      clientMetadata: { client_name: 'SDK client', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => clientInfo,
      saveClientInformation: value => { clientInfo = value; },
      tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      redirectToAuthorization: value => { authorizationUrl = value; },
      saveCodeVerifier: value => { savedVerifier = value; },
      codeVerifier: () => savedVerifier,
    };
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp` })).toBe('REDIRECT');
    const page = await fetch(authorizationUrl!, { headers: { cookie }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const request = /name="request" value="([^"]+)"/.exec(await page.text())![1]!;
    const allowed = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
    const access = tokens!.access_token;
    expect(auth.resolveApiToken(access)).not.toBeNull();
    db.prepare('UPDATE auth_mcp_grants SET access_expires_at = 0').run();
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp` })).toBe('AUTHORIZED');
    expect(tokens!.access_token).not.toBe(access);
    expect(auth.resolveApiToken(tokens!.access_token)).not.toBeNull();
  });

  it('persists only credential hashes and enforces absolute renewal expiry after reopening the store', async () => {
    const clientId = await register(); const authCode = await code(clientId);
    const tokens = await (await exchange(clientId, authCode)).json() as Tokens;
    const copy = new Database(db.serialize());
    try {
      const reopened = new AuthStore(copy);
      expect(reopened.resolveApiToken(tokens.access_token)?.principalId).toBe(viewer.principalId);
      for (const table of ['auth_api_tokens', 'auth_mcp_codes', 'auth_mcp_refresh']) {
        const rows = JSON.stringify(copy.prepare(`SELECT * FROM ${table}`).all());
        for (const secret of [authCode, tokens.access_token, tokens.refresh_token]) expect(rows).not.toContain(secret);
      }
      copy.prepare('UPDATE auth_mcp_grants SET refresh_expires_at = 0').run();
      expect(reopened.mcpOAuth.refresh(reopened, { token: tokens.refresh_token, clientId, resource: `${base}/mcp` })).toBeNull();
      reopened.sweep();
      expect(copy.prepare('SELECT count(*) AS n FROM auth_mcp_refresh').get()).toEqual({ n: 0 });
    } finally { copy.close(); }
  });

  it('revokes via RFC 7009 without accepting another client’s token', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    await post('/oauth/revoke', { client_id: await register(), token: tokens.refresh_token });
    expect(auth.resolveApiToken(tokens.access_token)).not.toBeNull();
    await post('/oauth/revoke', { client_id: clientId, token: tokens.refresh_token });
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect(events.map(e => e.kind)).toContain('token.revoked');
  });
});
