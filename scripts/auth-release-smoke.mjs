#!/usr/bin/env node

import { smokeMcpOAuth } from './mcp-oauth-smoke.mjs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vizEntry = resolve(root, 'dist/viz/server.js');
const authCliEntry = resolve(root, 'dist/cli/auth.js');
for (const entry of [vizEntry, authCliEntry]) {
  if (!existsSync(entry)) throw new Error(`compiled auth release entry missing: ${entry}`);
}
const scratch = mkdtempSync(join(tmpdir(), 'atoma-auth-release-'));
const dbPath = join(scratch, 'atoma.db');
const runsPath = join(scratch, 'runs');

const freePort = async () =>
  await new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });

const readBody = async (request, limit = 32_000) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new Error('fake provider request body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const pkceChallenge = (verifier) =>
  createHash('sha256').update(verifier).digest('base64url');

async function startProvider() {
  const codes = new Map();
  let verifiedPkce = 0;
  let baseUrl = '';
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        const challenge = url.searchParams.get('code_challenge');
        if (
          !redirectUri ||
          !state ||
          !challenge ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          url.searchParams.get('client_id') !== 'release-client'
        ) {
          response.writeHead(400).end();
          return;
        }
        const code = `release-code-${codes.size + 1}`;
        codes.set(code, { redirectUri, challenge });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.writeHead(302, { location: callback.href }).end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const params = new URLSearchParams(await readBody(request));
        const record = codes.get(params.get('code') ?? '');
        if (
          !record ||
          params.get('client_id') !== 'release-client' ||
          params.get('client_secret') !== 'release-secret' ||
          params.get('redirect_uri') !== record.redirectUri ||
          pkceChallenge(params.get('code_verifier') ?? '') !== record.challenge
        ) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid exchange' }));
          return;
        }
        verifiedPkce += 1;
        // One distinct token per exchange, so the smoke can drive TWO
        // identities through one provider: the first login founds the
        // organisation, the second is admitted by invitation.
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: `release-access-token-${verifiedPkce}` }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/userinfo') {
        const bearer = /^Bearer release-access-token-(\d+)$/.exec(
          request.headers.authorization ?? ''
        );
        if (!bearer) {
          response.writeHead(401).end();
          return;
        }
        const identity = bearer[1] === '1'
          ? { id: 4242, name: 'Release Smoke Owner' }
          : { id: 4300, name: 'Release Smoke Member' };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(identity));
        return;
      }
      response.writeHead(404).end();
    })().catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('fake provider has no TCP address'));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  return {
    baseUrl,
    verifiedPkce: () => verifiedPkce,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

class CookieJar {
  #cookies = [];

  absorb(response, requestUrl) {
    const request = new URL(requestUrl);
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const segments = line.split(';').map((segment) => segment.trim());
      const [pair = ''] = segments;
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      const path = segments.find((segment) => segment.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const secure = segments.some((segment) => segment.toLowerCase() === 'secure');
      const expired = segments.some((segment) => segment.toLowerCase() === 'max-age=0');
      this.#cookies = this.#cookies.filter(
        (cookie) => !(cookie.name === name && cookie.host === request.hostname && cookie.path === path)
      );
      if (!expired) this.#cookies.push({ name, value, host: request.hostname, path, secure });
    }
  }

  header(targetUrl) {
    const target = new URL(targetUrl);
    const matching = this.#cookies.filter(
      (cookie) =>
        cookie.host === target.hostname &&
        (target.pathname === cookie.path ||
          (target.pathname.startsWith(cookie.path) &&
            (cookie.path.endsWith('/') || target.pathname[cookie.path.length] === '/'))) &&
        (!cookie.secure || target.protocol === 'https:')
    );
    return matching.length > 0
      ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      : null;
  }
}

async function request(jar, url, init = {}) {
  const cookie = jar.header(url);
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  jar.absorb(response, url);
  return response;
}

function cleanEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATOMA_AUTH_') || key.startsWith('ATOMA_GITHUB_')) delete env[key];
  }
  for (const key of [
    'ATOMA_VIZ_AUTH',
    'ATOMA_VIZ_PUBLIC_ORIGIN',
    'ATOMA_VIZ_TRUSTED_PROXIES',
    'ATOMA_VIZ_DEV_URL',
    'ATOMA_DB_PATH',
    // The compiled server hosts the mechanical watch. A developer's own
    // ATOMA_RUNS_DIR would point a resident journal writer at their live
    // corpus, and the sentinel switches would decide whether this smoke's
    // children watch at all.
    'ATOMA_RUNS_DIR',
    'ATOMA_VIZ_SENTINEL',
    'ATOMA_VIZ_SENTINEL_INTERVAL_MS',
    'ATOMA_SENTINEL_COST_ALERT_USD',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'CHATGPT_CLIENT_ID',
    'CHATGPT_CLIENT_SECRET',
  ]) delete env[key];
  return { ...env, ...overrides };
}

/**
 * The organisation the FIRST login founded, read back through the compiled
 * CLI — the same list surface an operator uses to find the id.
 */
function listedOrganisationId() {
  const result = spawnSync(
    process.execPath,
    [authCliEntry, 'list', '--db', dbPath],
    { cwd: root, env: cleanEnv({}), encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `compiled auth list exited ${result.status ?? result.signal}: ${result.stderr.slice(-800)}`
    );
  }
  const match = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/.exec(
    result.stdout
  );
  if (!match) throw new Error('compiled auth list did not print an organisation id');
  return match[1];
}

function createInvitationUrl(baseUrl, orgId) {
  const result = spawnSync(
    process.execPath,
    [
      authCliEntry,
      'invite',
      '--db', dbPath,
      '--org', orgId,
      '--role', 'org:member',
      '--ttl-hours', '1',
    ],
    {
      cwd: root,
      env: cleanEnv({ ATOMA_VIZ_PUBLIC_ORIGIN: baseUrl }),
      encoding: 'utf8',
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `compiled auth invite exited ${result.status ?? result.signal}: ${result.stderr.slice(-800)}`
    );
  }
  const openLines = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Open: '));
  if (openLines.length !== 1) {
    throw new Error(`compiled auth invite printed ${openLines.length} Open: lines`);
  }
  const invitationUrl = new URL(openLines[0].slice('Open: '.length));
  const invitationTokens = invitationUrl.searchParams.getAll('invite');
  if (
    invitationUrl.origin !== new URL(baseUrl).origin ||
    invitationUrl.pathname !== '/' ||
    invitationUrl.hash !== '' ||
    [...invitationUrl.searchParams.keys()].some((key) => key !== 'invite') ||
    invitationTokens.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(invitationTokens[0])
  ) {
    throw new Error(`compiled auth invite printed an invalid root URL: ${invitationUrl.href}`);
  }
  return { invitationUrl, invitationToken: invitationTokens[0] };
}

function providerLoginUrl(selectorHtml, pageUrl, invitationToken) {
  const hrefs = [...selectorHtml.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)]
    .map((match) => match[1].replaceAll('&amp;', '&'));
  for (const href of hrefs) {
    const candidate = new URL(href, pageUrl);
    if (
      candidate.origin === new URL(pageUrl).origin &&
      candidate.pathname === '/auth/login' &&
      candidate.searchParams.get('provider') === 'github'
    ) {
      const inviteValues = candidate.searchParams.getAll('invite');
      if (invitationToken === null) {
        if (inviteValues.length !== 0) {
          throw new Error('compiled auth selector attached an invitation nobody supplied');
        }
      } else if (inviteValues.length !== 1 || inviteValues[0] !== invitationToken) {
        throw new Error('compiled auth provider href did not preserve the CLI invitation');
      }
      return candidate;
    }
  }
  throw new Error('compiled auth selector did not expose the GitHub provider href');
}

async function waitForServer(baseUrl, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`compiled auth viz exited ${child.exitCode}: ${stderr().slice(-800)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
      if (response.ok) return;
    } catch {
      // The compiled server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`compiled auth viz did not become ready: ${stderr().slice(-800)}`);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timeout;
    const onExit = () => {
      if (timeout) clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.off('exit', onExit);
        resolveExit(false);
      }, timeoutMs);
    }
  });
}

async function stopChild(child) {
  if (childExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child);
}

let provider;
let viz;
try {
  provider = await startProvider();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = '';
  viz = spawn(
    process.execPath,
    [vizEntry, '--host', '127.0.0.1', '--port', String(port), '--db', dbPath, '--dir', runsPath],
    {
      cwd: root,
      env: cleanEnv({
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: baseUrl,
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'release-client',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'release-secret',
        ATOMA_AUTH_GITHUB_AUTHORIZE_URL: `${provider.baseUrl}/authorize`,
        ATOMA_AUTH_GITHUB_TOKEN_URL: `${provider.baseUrl}/token`,
        ATOMA_AUTH_GITHUB_USERINFO_URL: `${provider.baseUrl}/userinfo`,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  viz.stderr.setEncoding('utf8');
  viz.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitForServer(baseUrl, viz, () => stderr);

  const anonymousApi = await fetch(`${baseUrl}/api/runs`, { redirect: 'manual' });
  if (anonymousApi.status !== 401) {
    throw new Error(`compiled auth gate exposed /api/runs with HTTP ${anonymousApi.status}`);
  }

  // A new visitor's first touch is the APP SHELL: the arrival gate is the
  // login. The shell carries no data; whoami names the providers to offer.
  const anonymousRoot = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  const anonymousHtml = await anonymousRoot.text();
  if (!anonymousRoot.ok || !/<script[^>]+src="\/[^"]+\.js"/.test(anonymousHtml)) {
    throw new Error('compiled unauthenticated root did not serve the GPU app shell');
  }
  const anonymousWhoami = await fetch(`${baseUrl}/auth/whoami`, { redirect: 'manual' });
  const anonymousCapabilities = await anonymousWhoami.json();
  if (
    !anonymousWhoami.ok ||
    anonymousCapabilities.enabled !== true ||
    anonymousCapabilities.authenticated !== false ||
    !Array.isArray(anonymousCapabilities.providers) ||
    !anonymousCapabilities.providers.some((entry) => entry?.id === 'github')
  ) {
    throw new Error('compiled anonymous whoami did not offer the configured providers');
  }

  // FIRST admission: no invitation exists yet — the first sign-in founds the
  // owner's organisation. The no-JS selector at /auth/login provides the
  // provider href the shell would otherwise build itself.
  const jar = new CookieJar();
  const selector = await request(jar, `${baseUrl}/auth/login`);
  const selectorHtml = await selector.text();
  if (!selector.ok) throw new Error(`compiled auth selector failed with HTTP ${selector.status}`);
  const loginUrl = providerLoginUrl(selectorHtml, baseUrl, null);

  const started = await request(jar, loginUrl.href);
  const authorizeUrl = started.headers.get('location');
  if (started.status !== 302 || !authorizeUrl) throw new Error('compiled auth login did not redirect');
  const transactionSetCookie = (started.headers.getSetCookie?.() ?? []).find((line) =>
    line.startsWith('atoma_oauth_tx=')
  );
  if (
    !transactionSetCookie ||
    !transactionSetCookie.includes('Path=/auth') ||
    !transactionSetCookie.includes('HttpOnly') ||
    !transactionSetCookie.includes('SameSite=Lax') ||
    transactionSetCookie.includes('Secure')
  ) {
    throw new Error('compiled auth login did not issue the expected path-bound transaction cookie');
  }
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state || jar.header(`${baseUrl}/auth/callback`) !== `atoma_oauth_tx=${state}`) {
    throw new Error('compiled auth transaction cookie did not bind the callback state');
  }
  if (jar.header(`${baseUrl}/api/runs`) || jar.header(authorizeUrl)) {
    throw new Error('compiled auth transaction cookie escaped its /auth path boundary');
  }

  const authorized = await request(jar, authorizeUrl);
  const callbackUrl = authorized.headers.get('location');
  if (authorized.status !== 302 || !callbackUrl) throw new Error('fake provider did not authorize');

  const callback = await request(jar, callbackUrl);
  if (callback.status !== 302 || callback.headers.get('location') !== '/') {
    throw new Error(`compiled auth callback failed with HTTP ${callback.status}`);
  }
  const callbackCookies = callback.headers.getSetCookie?.() ?? [];
  const clearedTransaction = callbackCookies.find((line) => line.startsWith('atoma_oauth_tx='));
  if (
    !clearedTransaction ||
    !clearedTransaction.includes('Path=/auth') ||
    !clearedTransaction.includes('Max-Age=0') ||
    jar.header(`${baseUrl}/auth/callback`)?.includes('atoma_oauth_tx=')
  ) {
    throw new Error('compiled auth callback did not clear the transaction cookie');
  }
  const authenticatedCookie = jar.header(`${baseUrl}/api/runs`);
  if (!/^atoma_session=[A-Za-z0-9_-]{43}$/.test(authenticatedCookie ?? '')) {
    throw new Error('compiled auth callback did not issue a session cookie');
  }
  if (provider.verifiedPkce() !== 1) throw new Error('compiled auth flow did not verify PKCE');

  const whoami = await request(jar, `${baseUrl}/auth/whoami`);
  const viewer = await whoami.json();
  if (!whoami.ok || viewer.displayName !== 'Release Smoke Owner' || viewer.role !== 'org:owner') {
    throw new Error('compiled auth session did not resolve the admitted owner');
  }
  const runs = await request(jar, `${baseUrl}/api/runs`);
  if (!runs.ok || !Array.isArray(await runs.json())) {
    throw new Error('compiled authenticated API did not return runs');
  }
  const app = await request(jar, `${baseUrl}/`);
  const appHtml = await app.text();
  if (!app.ok || !/<script[^>]+src="\/[^"]+\.js"/.test(appHtml)) {
    throw new Error('compiled authenticated root did not serve the GPU app');
  }

  await smokeMcpOAuth(baseUrl, authenticatedCookie);

  const logout = await request(jar, `${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { origin: baseUrl },
  });
  if (logout.status !== 302) throw new Error(`compiled logout failed with HTTP ${logout.status}`);
  const revoked = await fetch(`${baseUrl}/api/runs`, {
    redirect: 'manual',
    headers: { cookie: authenticatedCookie },
  });
  if (revoked.status !== 401) throw new Error('compiled logout did not revoke the server session');

  // SECOND admission: the operator mints a one-use invitation for the
  // founded organisation through the compiled CLI, and a NEW identity joins
  // with the invited role.
  const orgId = listedOrganisationId();
  const { invitationUrl, invitationToken } = createInvitationUrl(baseUrl, orgId);
  if (invitationUrl.origin !== baseUrl) {
    throw new Error('compiled auth invite did not target the public origin');
  }
  const memberJar = new CookieJar();
  const memberSelector = await request(
    memberJar,
    `${baseUrl}/auth/login?invite=${encodeURIComponent(invitationToken)}`
  );
  const memberSelectorHtml = await memberSelector.text();
  if (!memberSelector.ok) {
    throw new Error(`compiled invited selector failed with HTTP ${memberSelector.status}`);
  }
  const memberLoginUrl = providerLoginUrl(memberSelectorHtml, baseUrl, invitationToken);
  const memberStarted = await request(memberJar, memberLoginUrl.href);
  const memberAuthorizeUrl = memberStarted.headers.get('location');
  if (memberStarted.status !== 302 || !memberAuthorizeUrl) {
    throw new Error('compiled invited login did not redirect to the provider');
  }
  const memberAuthorized = await request(memberJar, memberAuthorizeUrl);
  const memberCallbackUrl = memberAuthorized.headers.get('location');
  if (memberAuthorized.status !== 302 || !memberCallbackUrl) {
    throw new Error('fake provider did not authorize the invited login');
  }
  const memberCallback = await request(memberJar, memberCallbackUrl);
  if (memberCallback.status !== 302 || memberCallback.headers.get('location') !== '/') {
    throw new Error(`compiled invited callback failed with HTTP ${memberCallback.status}`);
  }
  const memberWhoami = await request(memberJar, `${baseUrl}/auth/whoami`);
  const member = await memberWhoami.json();
  if (
    !memberWhoami.ok ||
    member.displayName !== 'Release Smoke Member' ||
    member.role !== 'org:member' ||
    // The invitation must admit into the FOUNDER's organisation — the right
    // role in a wrong or freshly minted organisation is still a failure.
    member.activeOrganisation?.id !== orgId
  ) {
    throw new Error('compiled invitation did not admit the member into the founded organisation');
  }
  if (provider.verifiedPkce() !== 2) {
    throw new Error('compiled invited flow did not verify a second PKCE exchange');
  }

  process.stdout.write(
    'auth release smoke ok: shell login, founder admission, CLI invite, member admission, PKCE, MCP OAuth, session gate, logout\n'
  );
} finally {
  if (viz) await stopChild(viz);
  if (provider) await provider.close();
  rmSync(scratch, { recursive: true, force: true });
}
