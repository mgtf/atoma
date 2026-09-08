import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Exercise a compiled host, using the browser session established by the auth release smoke. */
export async function smokeMcpOAuth(base, cookie) {
  const callback = 'http://127.0.0.1:54545/callback';
  const verifier = randomBytes(32).toString('base64url');
  const registration = await fetch(`${base}/oauth/register`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_name: 'Release OAuth smoke', redirect_uris: [callback], token_endpoint_auth_method: 'none',
    }) });
  if (registration.status !== 201) throw new Error('compiled MCP OAuth registration failed');
  const { client_id } = await registration.json();
  const query = new URLSearchParams({ client_id, redirect_uri: callback, response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${base}/mcp`, scope: 'mcp', state: 'release-state' });
  const consent = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
  const request = /name="request" value="([^"]+)"/.exec(await consent.text())?.[1];
  if (!request) throw new Error('compiled MCP OAuth consent missing');
  const approved = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, decision: 'allow' }) });
  const location = new URL(approved.headers.get('location'));
  if (location.searchParams.get('state') !== 'release-state' || location.searchParams.get('iss') !== base) {
    throw new Error('compiled MCP OAuth callback binding failed');
  }
  const post = (path, data) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const exchange = await post('/oauth/token', { grant_type: 'authorization_code', code: location.searchParams.get('code'),
    client_id, redirect_uri: callback, code_verifier: verifier, resource: `${base}/mcp` });
  if (!exchange.ok) throw new Error('compiled MCP OAuth exchange failed');
  const tokens = await exchange.json();
  const client = new Client({ name: 'release-oauth-smoke', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }));
    const projects = await client.callTool({ name: 'atoma_projects_list', arguments: {} });
    if (projects.isError) throw new Error('compiled MCP OAuth reader failed');
  } finally { await client.close(); }
  const refresh = await post('/oauth/token', { grant_type: 'refresh_token', client_id,
    refresh_token: tokens.refresh_token, resource: `${base}/mcp` });
  if (!refresh.ok) throw new Error('compiled MCP OAuth refresh failed');
  const rotated = await refresh.json();
  await post('/oauth/revoke', { client_id, token: rotated.refresh_token });
  const denied = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${rotated.access_token}` } });
  if (denied.status !== 401) throw new Error('compiled MCP OAuth revocation failed');
}
