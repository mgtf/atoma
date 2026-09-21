import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { CookieJar, request as browserRequest, providerLoginUrl } from './auth-smoke-fixture.mjs';

/** Follow the compiled login selector and callback after an explicit account switch. */
export async function smokeMcpAccountSwitch(base, cookie) {
  const redirectUri = 'http://127.0.0.1:54545/callback';
  const verifier = randomBytes(32).toString('base64url');
  const registration = await fetch(`${base}/oauth/register`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_name: 'Account switch smoke', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    }) });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${base}/mcp`, scope: 'mcp', state: 'switch-state' });
  const page = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie } });
  const requestId = /name="request" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(requestId);
  const switched = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, decision: 'switch' }) });
  assert.equal(switched.status, 302);
  const jar = new CookieJar();
  jar.absorb(switched, `${base}/oauth/authorize`);
  const selectorUrl = new URL(switched.headers.get('location'), base);
  const selector = await browserRequest(jar, selectorUrl.href);
  const login = providerLoginUrl(await selector.text(), base, null);
  assert.equal(login.searchParams.get('select_account'), '1');
  const started = await browserRequest(jar, login.href);
  const upstream = new URL(started.headers.get('location'));
  assert.equal(upstream.searchParams.get('prompt'), 'select_account');
  const authorized = await browserRequest(jar, upstream.href);
  const callback = await browserRequest(jar, authorized.headers.get('location'));
  const returned = new URL(callback.headers.get('location'), base);
  assert.equal(returned.pathname, '/oauth/authorize');
  assert.notEqual(returned.searchParams.get('request'), requestId);
  const consent = await browserRequest(jar, returned.href);
  assert.equal(consent.status, 200);
  const nextId = /name="request" value="([^"]+)"/.exec(await consent.text())?.[1];
  assert.ok(nextId);
  const approved = await browserRequest(jar, `${base}/oauth/authorize`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: nextId, decision: 'allow' }) });
  const result = new URL(approved.headers.get('location'));
  assert.equal(result.searchParams.get('state'), 'switch-state');
  assert.ok(result.searchParams.get('code'));
}

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
