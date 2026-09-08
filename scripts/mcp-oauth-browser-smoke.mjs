// Real browser coverage: fetch-based clients do not apply Referrer-Policy to form Origin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer';
import { AuthStore } from '../dist/auth/store.js';
import { McpOAuth } from '../dist/auth/mcpOAuth.js';
import { issueSession, parseCookieHeader, SESSION_COOKIE } from '../dist/auth/sessions.js';

const db = new Database(':memory:');
const store = new AuthStore(db);
const { viewer } = store.completeLogin({ provider: 'github', subject: 'browser-smoke', displayName: 'Browser smoke', email: null, emailVerified: false }, null);
const session = issueSession(store, viewer, { secure: false }).token;
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Desktop clients receive the callback on a separate loopback port.
const receiver = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('Callback'));
await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${receiver.address().port}/callback`;
const oauth = new McpOAuth({ origin: new URL(base), clientAddress: () => 'local', emit: () => {},
  gate: { enabled: true, store, resolve: req => {
    const cookie = parseCookieHeader(req.headers.cookie).find(c => c.name === SESSION_COOKIE);
    return cookie ? store.resolveSession(cookie.value) : null;
  } },
});
let submittedOrigin;
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/oauth/authorize') submittedOrigin = req.headers.origin;
  void oauth.handle(req, res, new URL(req.url, base)).then(handled => {
    if (!handled) res.writeHead(200, { 'content-type': 'text/plain' }).end('Callback');
  }).catch(() => res.writeHead(500).end('Unexpected server error'));
});
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await browser.setCookie({ name: SESSION_COOKIE, value: session, url: base });
  const registered = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Browser smoke', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = await registered.json();
  const verifier = 'v'.repeat(43);
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    resource: `${base}/mcp`, scope: 'mcp', state: 'browser-state' });
  await page.goto(`${base}/oauth/authorize?${query}`);
  await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('button[value="allow"]')]);
  assert.equal(submittedOrigin, base, 'Browser form must retain its same-origin Origin');
  const callback = new URL(page.url());
  assert.equal(callback.origin, new URL(redirectUri).origin);
  assert.equal(callback.pathname, '/callback');
  assert.equal(callback.searchParams.get('state'), 'browser-state');
  assert.ok(callback.searchParams.get('code'));
  const exchange = await fetch(`${base}/oauth/token`, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
    code: callback.searchParams.get('code'), code_verifier: verifier, resource: `${base}/mcp`,
  }) });
  assert.equal(exchange.status, 200);
  assert.ok(store.resolveApiToken((await exchange.json()).access_token));
  await page.goto(`${base}/oauth/authorize?${query}`);
  await Promise.all([page.waitForNavigation({ timeout: 5000 }), page.click('button[value="deny"]')]);
  const denied = new URL(page.url());
  assert.equal(denied.origin, new URL(redirectUri).origin);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.has('code'), false);
  console.log('MCP OAuth browser consent and token exchange passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  receiver.closeAllConnections();
  await new Promise(resolve => receiver.close(resolve));
  db.close();
}
