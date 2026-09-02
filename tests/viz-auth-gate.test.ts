import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_COPY } from '../src/auth/copy.js';
import { AuthStore, sha256Hex, type OrgRole } from '../src/auth/store.js';
import { pkceChallenge } from '../src/auth/oidc.js';
import { MAX_LOGOUT_SESSION_CANDIDATES } from '../src/auth/values.js';
import { GITHUB_COPY } from '../src/github/http.js';
import { ProjectStore } from '../src/projects/store.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { sleepInhibitorHint } from '../src/sentinel/resident.js';

/**
 * Process-level contract: real viz server, real SQLite and a local OAuth app.
 * The fake rejects a wrong PKCE verifier and records the canonical redirect,
 * so a passing test proves the boundaries rather than just the final status.
 */

// Every test here boots at least one real tsx server, and the internal
// watchdogs below (waitReady, waitForExit) are sized at 30s for a fully
// parallel suite. The repo default of 15s would fire FIRST — a generic
// "Test timed out" that swallows the child's stderr — so the file default
// must sit comfortably above the watchdogs. The one test that boots four
// servers in sequence carries its own larger budget.
vi.setConfig({ testTimeout: 60_000 });

const children: RunningChild[] = [];
const servers: Server[] = [];
const roots: string[] = [];

interface RunningChild {
  process: ChildProcess;
  stdout: string[];
  stderr: string[];
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill('SIGTERM');
      }
      await waitForExit(child.process);
    })
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface StoredCookie {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
}

class CookieJar {
  private readonly cookies: StoredCookie[] = [];

  absorb(response: Response, requestUrl: string): void {
    const request = new URL(requestUrl);
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const segments = line.split(';').map((segment) => segment.trim());
      const pair = segments[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      const path = segments.find((segment) => segment.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const secure = segments.some((segment) => segment.toLowerCase() === 'secure');
      const expired = segments.some((segment) => segment.toLowerCase() === 'max-age=0');
      const index = this.cookies.findIndex(
        (cookie) => cookie.name === name && cookie.host === request.hostname && cookie.path === path
      );
      if (index >= 0) this.cookies.splice(index, 1);
      if (!expired) this.cookies.push({ name, value, host: request.hostname, path, secure });
    }
  }

  header(targetUrl: string): string | null {
    const target = new URL(targetUrl);
    const matching = this.cookies.filter(
      (cookie) =>
        cookie.host === target.hostname &&
        target.pathname.startsWith(cookie.path) &&
        (!cookie.secure || target.protocol === 'https:')
    );
    return matching.length > 0
      ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      : null;
  }

  value(name: string, targetUrl: string): string | null {
    const header = this.header(targetUrl);
    if (!header) return null;
    for (const segment of header.split(';')) {
      const [candidate, ...rest] = segment.trim().split('=');
      if (candidate === name) return rest.join('=');
    }
    return null;
  }
}

async function fetchWithJar(
  jar: CookieJar,
  startUrl: string,
  init: RequestInit = {},
  maxRedirects = 8
): Promise<Response> {
  let currentUrl = startUrl;
  let method = init.method ?? 'GET';
  let body = init.body;
  let extraHeaders = init.headers;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const cookie = jar.header(currentUrl);
    const response = await fetch(currentUrl, {
      method,
      body,
      redirect: 'manual',
      headers: { ...(extraHeaders ?? {}), ...(cookie ? { cookie } : {}) },
    });
    jar.absorb(response, currentUrl);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).href;
    method = 'GET';
    body = undefined;
    extraHeaders = undefined;
  }
  throw new Error('too many redirects');
}

interface FakeProviderStats {
  authorizeRedirectUris: string[];
  tokenRedirectUris: string[];
  tokenClientSecrets: Array<string | null>;
  verifiedPkce: number;
}

interface FakeProvider {
  baseUrl: string;
  stats: FakeProviderStats;
}

async function startFakeProvider(input: {
  port: number;
  subject: number;
  displayName?: string;
}): Promise<FakeProvider> {
  const challenges = new Map<string, string>();
  const redirectUris = new Map<string, string>();
  const stats: FakeProviderStats = {
    authorizeRedirectUris: [],
    tokenRedirectUris: [],
    tokenClientSecrets: [],
    verifiedPkce: 0,
  };
  let nextCode = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${input.port}`);
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const challenge = url.searchParams.get('code_challenge');
      const method = url.searchParams.get('code_challenge_method');
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      if (!challenge || method !== 'S256' || !redirectUri || !state) {
        res.writeHead(400).end();
        return;
      }
      const code = `fake-code-${++nextCode}`;
      challenges.set(code, challenge);
      redirectUris.set(code, redirectUri);
      stats.authorizeRedirectUris.push(redirectUri);
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      res.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 32_000) req.destroy();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const redirectUri = params.get('redirect_uri');
        stats.tokenRedirectUris.push(redirectUri ?? '');
        stats.tokenClientSecrets.push(params.get('client_secret'));
        if (
          challenges.get(code) !== pkceChallenge(verifier) ||
          redirectUris.get(code) !== redirectUri ||
          params.get('client_id') !== 'test-client' ||
          params.get('client_secret') !== 'test-secret'
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid exchange' }));
          return;
        }
        stats.verifiedPkce++;
        res.writeHead(200, { 'content-type': 'application/json' });
        // EXPIRING TOKENS, because that is the only supported GitHub App
        // configuration: with "Expire user authorization tokens" disabled
        // GitHub sends no `expires_in` and no refresh token, and
        // `persistGitHubUserTokens` throws on every callback
        // (src/github/tokens.ts). A fake that omits them modelled a
        // deployment that cannot work, and silently left every logged-in
        // viewer without the stored authorization the connect flow needs.
        res.end(JSON.stringify({
          access_token: 'fake-access-token',
          expires_in: 28_800,
          refresh_token: 'fake-refresh-token',
          refresh_token_expires_in: 15_811_200,
        }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer fake-access-token') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: input.subject,
        name: input.displayName ?? 'Fake User',
        email: 'fake@example.com',
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port, '127.0.0.1', resolve);
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${input.port}`, stats };
}

function cleanChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
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
    // The watch reads these, and a developer's real values must not reach a
    // spawned harness: `ATOMA_RUNS_DIR` would point a resident journal writer
    // at the operator's live corpus, and the sentinel switches would decide
    // whether these children watch at all.
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

function startViz(args: string[], env: Record<string, string>): RunningChild {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/viz/server.ts', ...args],
    { cwd: process.cwd(), env: cleanChildEnv(env), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const running: RunningChild = { process: child, stdout: [], stderr: [] };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => running.stdout.push(chunk));
  child.stderr?.on('data', (chunk: string) => running.stderr.push(chunk));
  children.push(running);
  return running;
}

// 30s, not 5s: this is a WATCHDOG, not an expected duration. A healthy child
// exits in well under a second; the budget only binds when 238 test files
// compete for the machine and a tsx boot alone takes longer than the old 5s
// (measured 2026-08-30: this file needed 53.6s under full parallelism while
// passing in isolation), so a green run pays nothing for the headroom.
function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

/**
 * The exit code of a child that must die BY ITSELF. The watchdog's SIGKILL
 * surfaces as code null, which `expect(code).not.toBe(0)` happily accepts —
 * under a fully parallel suite that turned a hung boot into a silent pass of
 * the fail-closed assertion, with only a confusing empty-stderr mismatch
 * left behind. Refuse the kill loudly instead.
 */
async function ownExitCode(running: RunningChild): Promise<number> {
  const code = await waitForExit(running.process);
  if (running.process.signalCode !== null || code === null) {
    throw new Error(
      `child did not exit by itself (signal ${String(running.process.signalCode)}); ` +
        `stderr: ${running.stderr.join('')}`
    );
  }
  return code;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitReady(running: RunningChild, url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (running.process.exitCode !== null) {
      throw new Error(`server exited ${running.process.exitCode}: ${running.stderr.join('')}`);
    }
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`server not ready: ${url}\n${running.stderr.join('')}`);
}

function tempInstance(): { root: string; dbPath: string; runsDir: string; args: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-viz-auth-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  return {
    root,
    dbPath,
    runsDir: join(root, 'runs'),
    args: [
      '--host', '127.0.0.1',
      '--dir', join(root, 'runs'),
      '--db', dbPath,
      '--skills-dir', join(root, 'skills'),
    ],
  };
}

function createInvitation(dbPath: string, token: string, role: OrgRole = 'org:owner'): void {
  const db = new Database(dbPath);
  try {
    const store = new AuthStore(db);
    const bootstrap = store.completeLogin({
      provider: 'github',
      subject: `bootstrap-${token}`,
      displayName: 'Bootstrap Owner',
      email: null,
      emailVerified: false,
    }, null);
    if (!bootstrap) throw new Error('failed to bootstrap invitation organisation');
    store.createInvitation({
      orgId: bootstrap.viewer.orgId,
      token,
      role,
      ttlMs: 60_000,
    });
  } finally {
    db.close();
  }
}

function providerEnv(provider: FakeProvider, publicOrigin: string): Record<string, string> {
  return {
    ATOMA_VIZ_AUTH: '1',
    ATOMA_VIZ_PUBLIC_ORIGIN: publicOrigin,
    ATOMA_AUTH_GITHUB_CLIENT_ID: 'test-client',
    ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'test-secret',
    ATOMA_AUTH_GITHUB_AUTHORIZE_URL: `${provider.baseUrl}/authorize`,
    ATOMA_AUTH_GITHUB_TOKEN_URL: `${provider.baseUrl}/token`,
    ATOMA_AUTH_GITHUB_USERINFO_URL: `${provider.baseUrl}/userinfo`,
  };
}

function githubAppEnv(root: string): Record<string, string> {
  const pemPath = join(root, 'github-app.pem');
  writeFileSync(
    pemPath,
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString()
  );
  return {
    ATOMA_GITHUB_APP_ID: '123456',
    ATOMA_GITHUB_APP_SLUG: 'atoma-test',
    ATOMA_GITHUB_APP_PRIVATE_KEY_PATH: pemPath,
    ATOMA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
    ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
}

describe('viz auth gate (process level)', () => {
  it.each([
    [['--db'], '--db requires a non-empty value'],
    [['--db', '--port', '4123'], '--db requires a non-empty value'],
    [['--port', 'not-a-port'], '--port must be an integer'],
    [['--unknown', 'value'], 'unknown viz argument'],
  ])('rejects malformed server arguments before opening a fallback store', async (tail, message) => {
    const instance = tempInstance();
    const fallback = join(instance.root, 'ambient-fallback.db');
    const running = startViz([...instance.args, ...tail], { ATOMA_DB_PATH: fallback });
    expect(await ownExitCode(running)).not.toBe(0);
    expect(running.stderr.join('')).toContain(message);
    expect(existsSync(fallback)).toBe(false);
    expect(existsSync(instance.dbPath)).toBe(false);
  }, 60_000);

  it('leaves the localhost developer path open when auth is disabled', async () => {
    const instance = tempInstance();
    const port = await freePort();
    const running = startViz([...instance.args, '--port', String(port)], {});
    const base = `http://127.0.0.1:${port}`;
    await waitReady(running, `${base}/api/runs`);
    expect((await fetch(`${base}/api/runs`)).status).toBe(200);
    const who = await fetch(`${base}/auth/whoami`);
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ enabled: false, authenticated: false });
  });

  it('fails closed with an ambiguous switch, no provider, or no canonical public origin', async () => {
    const invalid = tempInstance();
    const invalidPort = await freePort();
    const ambiguousSwitch = startViz(
      [...invalid.args, '--port', String(invalidPort)],
      { ATOMA_VIZ_AUTH: 'TRUE' }
    );
    expect(await ownExitCode(ambiguousSwitch)).not.toBe(0);
    expect(ambiguousSwitch.stderr.join('')).toContain(
      'ATOMA_VIZ_AUTH must be one of: 0, false, 1, true'
    );

    const first = tempInstance();
    const portA = await freePort();
    const noProvider = startViz([...first.args, '--port', String(portA)], {
      ATOMA_VIZ_AUTH: '1',
      ATOMA_VIZ_PUBLIC_ORIGIN: `http://127.0.0.1:${portA}`,
    });
    expect(await ownExitCode(noProvider)).not.toBe(0);
    expect(noProvider.stderr.join('')).toContain('no complete login provider');

    const second = tempInstance();
    const portB = await freePort();
    const noOrigin = startViz([...second.args, '--port', String(portB)], {
      ATOMA_VIZ_AUTH: '1',
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'id',
      ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'secret',
    });
    expect(await ownExitCode(noOrigin)).not.toBe(0);
    expect(noOrigin.stderr.join('')).toContain('ATOMA_VIZ_PUBLIC_ORIGIN is required');

    const third = tempInstance();
    const portC = await freePort();
    const unsafeProxy = startViz([...third.args, '--port', String(portC)], {
      ATOMA_VIZ_AUTH: '1',
      ATOMA_VIZ_PUBLIC_ORIGIN: `http://127.0.0.1:${portC}`,
      ATOMA_VIZ_TRUSTED_PROXIES: 'proxy.internal',
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'id',
      ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'secret',
    });
    expect(await ownExitCode(unsafeProxy)).not.toBe(0);
    expect(unsafeProxy.stderr.join('')).toContain(
      'ATOMA_VIZ_TRUSTED_PROXIES must contain at most 32 comma-separated IP literals'
    );
  }, 120_000);

  it('creates an owner organisation for an unknown identity without an invitation', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 101 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    const response = await fetchWithJar(jar, `${base}/auth/login?provider=github`);
    expect(response.status).toBe(200);
    expect(jar.value('atoma_session', base)).not.toBeNull();

    mkdirSync(join(instance.root, 'runs'), { recursive: true });
    writeFileSync(
      join(instance.root, 'runs', 'decoy.json'),
      JSON.stringify({
        id: 'decoy-cli-run',
        label: 'must not leak into a gated organisation',
        startedAt: '2026-08-20T00:00:00.000Z',
      })
    );
    const runs = await fetch(`${base}/api/runs`, { headers: { cookie: jar.header(base)! } });
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);

    const db = new Database(instance.dbPath, { readonly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS count FROM auth_principals').get() as { count: number }).count).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS count FROM auth_organisations').get() as { count: number }).count).toBe(1);
      expect(db.prepare('SELECT role FROM auth_memberships').pluck().get()).toBe('org:owner');
    } finally {
      db.close();
    }
  });

  it('names the project run behind every project-corpus entry of /api/runs', async () => {
    // THE PREVIEW IS KEYED BY (project, project run); the Runs view is keyed
    // by trace id. The client used to join the two through the SELECTED
    // project's run list — which is empty after a reload or an arrival through
    // the Runs tab, so a live run showed its summary card and no Preview
    // control (measured 2026-09-02). The index entry now names its own project
    // AND project run, and this is the seam that proves it: a real server, a
    // real login, and the JSON a browser receives.
    const instance = tempInstance();
    // 43 canonical base64url characters, the only shape the login accepts.
    const invitation = 'R'.repeat(43);
    createInvitation(instance.dbPath, invitation, 'org:member');

    // Seed one delivered project run into the bootstrapped organisation, the
    // way the coordinator writes it: a row whose recorded paths are where the
    // trace actually is.
    const projectsRoot = join(instance.root, 'projects');
    const seeded = (() => {
      const db = new Database(instance.dbPath);
      try {
        const orgId = db.prepare('SELECT org_id FROM auth_organisations').pluck().get() as string;
        const principalId = db.prepare('SELECT principal_id FROM auth_principals').pluck().get() as string;
        const projects = new ProjectStore(db);
        const project = projects.createProject({
          orgId,
          principalId,
          project: {
            name: 'Index carries the run',
            slug: 'index-carries-the-run',
            initialPrompt: '',
            family: 'build',
            repositoryTarget: { installationId: '999000002', owner: 'local', name: 'x', visibility: 'private' },
          },
        });
        const projectRunId = randomUUID();
        const layout = projectRunHostLayout(projectsRoot, orgId, project.projectId, projectRunId);
        const created = projects.createProjectRun({
          orgId,
          projectId: project.projectId,
          principalId,
          projectRunId,
          request: { goal: 'a run the index must attribute', idempotencyKey: 'k-index' },
          hostPaths: {
            workspacePath: layout.workspacePath,
            runsPath: layout.runsPath,
            logPath: layout.logPath,
          },
        });
        if (!created) throw new Error('seed refused');
        mkdirSync(layout.runsPath, { recursive: true });
        writeFileSync(
          join(layout.runsPath, `${projectRunId}.json`),
          JSON.stringify({
            id: projectRunId,
            label: 'a run the index must attribute',
            startedAt: '2026-09-02T12:00:00.000Z',
            events: [],
          })
        );
        return { projectId: project.projectId, projectRunId };
      } finally {
        db.close();
      }
    })();

    const provider = await startFakeProvider({ port: await freePort(), subject: 303 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // Teardown is the suite's: `startViz` and `startFakeProvider` register
    // what they start, and `afterEach` reaps it.
    const running = startViz([...instance.args, '--port', String(port)], providerEnv(provider, base));
    await waitReady(running, `${base}/auth/whoami`);
    const jar = new CookieJar();
    const login = await fetchWithJar(jar, `${base}/auth/login?provider=github&invite=${invitation}`);
    expect(login.status).toBe(200);

    const runs = await fetch(`${base}/api/runs`, { headers: { cookie: jar.header(base)! } });
    expect(runs.status).toBe(200);
    const entries = (await runs.json()) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: seeded.projectRunId,
      projectId: seeded.projectId,
      projectRunId: seeded.projectRunId,
    });
  }, 120_000);

  it('reserves operator surfaces and the admin control plane to a CLI-granted platform admin', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 202 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };

    // Before the grant: an ordinary org owner is NOT the platform operator.
    const whoamiBefore = await fetch(`${base}/auth/whoami`, { headers: cookie });
    expect(await whoamiBefore.json()).toMatchObject({ authenticated: true, platformAdmin: false });
    for (const path of ['/api/registries', '/api/skills', '/api/burnin', '/api/admin/organisations']) {
      const refused = await fetch(`${base}${path}`, { headers: cookie });
      expect(refused.status).toBe(403);
    }

    // A second organisation exists (created directly against the store, the
    // way any other login would): the admin must see it, its owner must not
    // see the admin's.
    const otherDb = new Database(instance.dbPath);
    try {
      const store = new AuthStore(otherDb);
      expect(
        store.completeLogin({
          provider: 'github',
          subject: 'other-org-owner',
          displayName: 'Other Owner',
          email: 'other@example.com',
          emailVerified: false,
        }, null)
      ).not.toBeNull();
    } finally {
      otherDb.close();
    }

    // The grant is CLI-only, by unique identity email, against the store on
    // disk — the exact operator gesture the feature specifies.
    const { runAuthCli } = await import('../src/cli/auth.js');
    expect(
      runAuthCli(['node', 'auth', 'grant-admin', '--principal', 'fake@example.com', '--db', instance.dbPath], {})
    ).toBe(0);

    // The flag rides the very next request: no re-login, no session refresh.
    const whoamiAfter = await fetch(`${base}/auth/whoami`, { headers: cookie });
    expect(await whoamiAfter.json()).toMatchObject({ authenticated: true, platformAdmin: true });
    expect((await fetch(`${base}/api/registries`, { headers: cookie })).status).toBe(200);

    const organisations = await fetch(`${base}/api/admin/organisations`, { headers: cookie });
    expect(organisations.status).toBe(200);
    const listed = await organisations.json() as Array<{
      orgId: string;
      name: string;
      members: unknown[];
    }>;
    expect(listed).toHaveLength(2);
    for (const organisation of listed) expect(organisation.members).toHaveLength(1);

    // Invitations from the admin plane: same-origin enforced, token minted
    // once, bound to the named organisation and role.
    const targetOrg = listed[1]!.orgId;
    const crossSite = await fetch(`${base}/api/admin/invitations`, {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ orgId: targetOrg, role: 'org:member' }),
    });
    expect(crossSite.status).toBe(403);
    const minted = await fetch(`${base}/api/admin/invitations`, {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ orgId: targetOrg, role: 'org:member', ttlHours: 1 }),
    });
    expect(minted.status).toBe(200);
    const invitation = await minted.json() as { token: string; url: string; orgId: string; role: string };
    expect(invitation.orgId).toBe(targetOrg);
    expect(invitation.role).toBe('org:member');
    expect(invitation.url).toContain(`invite=${encodeURIComponent(invitation.token)}`);

    // Revocation closes the door again on the next request.
    expect(
      runAuthCli(['node', 'auth', 'revoke-admin', '--principal', 'fake@example.com', '--db', instance.dbPath], {})
    ).toBe(0);
    expect((await fetch(`${base}/api/registries`, { headers: cookie })).status).toBe(403);
    expect((await fetch(`${base}/api/admin/organisations`, { headers: cookie })).status).toBe(403);
  });


  it('serves the account surfaces: name, avatar bytes, tier pins and the org card', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 909 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      {
        ...providerEnv(provider, base),
        ATOMA_SECRET_ENCRYPTION_KEY: 'k'.repeat(32),
      }
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };

    // ---- whoami carries what the account UI needs.
    const whoami = await (await fetch(`${base}/auth/whoami`, { headers: cookie })).json() as {
      principalId: string;
      displayName: string;
      displayNameSource: string;
      avatarUrl: string | null;
    };
    expect(whoami.displayName).toBe('Fake User');
    expect(whoami.displayNameSource).toBe('provider');
    expect(whoami.principalId).toMatch(/^[0-9a-f-]{36}$/);
    // The fake provider serves no picture, and a loopback one would be refused
    // by the SSRF rule anyway — so there is nothing to serve yet.
    expect(whoami.avatarUrl).toBeNull();
    expect((await fetch(`${base}/auth/avatar/${whoami.principalId}`, { headers: cookie })).status)
      .toBe(404);

    // ---- rename: same-origin only, and it sticks in whoami.
    const crossSiteRename = await fetch(`${base}/api/account`, {
      method: 'PATCH',
      headers: { ...cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ displayName: 'Attacker' }),
    });
    expect(crossSiteRename.status).toBe(403);
    const badRename = await fetch(`${base}/api/account`, {
      method: 'PATCH',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ displayName: '   ' }),
    });
    expect(badRename.status).toBe(400);
    const renamed = await fetch(`${base}/api/account`, {
      method: 'PATCH',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ displayName: 'Ada Lovelace' }),
    });
    expect(renamed.status).toBe(200);
    expect(await (await fetch(`${base}/auth/whoami`, { headers: cookie })).json())
      .toMatchObject({ displayName: 'Ada Lovelace', displayNameSource: 'user' });
    // GET is not a rename.
    expect((await fetch(`${base}/api/account`, { headers: cookie })).status).toBe(405);

    // ---- tier pins: the catalogue, then the run environment. `choices` was
    // dropped from this payload on 2026-08-28: a closed list left over from
    // the pre-catalogue design that nothing in the client had read since.
    const defaults = await (await fetch(`${base}/api/account/models`, { headers: cookie })).json() as {
      pins: Record<string, string | null>;
      defaults: Record<string, string>;
      catalog: Array<{ id: string; models: Array<{ id: string }> }>;
      hostSubscription?: unknown;
    };
    expect(defaults.pins).toEqual({ l1: null, l2: null, l3: null });
    expect(defaults.defaults['l3']).toContain('opus');
    expect(defaults).not.toHaveProperty('choices');
    const anthropic = defaults.catalog.find((entry) => entry.id === 'anthropic')!;
    const catalogueChoice = anthropic.models[1]!.id;
    // This viewer is not a platform admin, so the operator's own login is not
    // named to them at all — an offer a viewer cannot use is a payer they
    // should never see.
    expect(defaults.hostSubscription).toBeUndefined();
    // And they cannot arm it by hand either.
    const refusedSubscription = await fetch(`${base}/api/account/models`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ pins: { l1: 'host-subscription:opus', l2: null, l3: null } }),
    });
    expect(refusedSubscription.status).toBe(403);

    const refusedPin = await fetch(`${base}/api/account/models`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ pins: { l1: 'ollama:llama3', l2: null, l3: null } }),
    });
    expect(refusedPin.status).toBe(400);
    const savedPin = await fetch(`${base}/api/account/models`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ pins: { l1: catalogueChoice, l2: null, l3: null } }),
    });
    expect(savedPin.status).toBe(200);
    expect(await (await fetch(`${base}/api/account/models`, { headers: cookie })).json())
      .toMatchObject({ pins: { l1: catalogueChoice, l2: null, l3: null } });

    const prefixedPin = await fetch(`${base}/api/account/models`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ pins: { l1: 'anthropic:claude-sonnet-5', l2: null, l3: null } }),
    });
    expect(prefixedPin.status).toBe(200);

    const orgModels = await fetch(`${base}/api/org/models`, { headers: cookie });
    expect(orgModels.status).toBe(200);
    const orgModelsBody = await orgModels.json() as {
      models: Record<string, string | null>;
      catalog: Array<{ id: string; models: Array<{ id: string }> }>;
      encryptionReady: boolean;
      keys: Array<{ provider: string }>;
    };
    expect(orgModelsBody.encryptionReady).toBe(true);
    expect(orgModelsBody.catalog.some((entry) => entry.id === 'anthropic')).toBe(true);
    const savedOrg = await fetch(`${base}/api/org/models`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ models: { l1: 'anthropic:claude-haiku-4-5', l2: null, l3: null } }),
    });
    expect(savedOrg.status).toBe(200);
    const zaiMaterial = `sk-test-${'z'.repeat(24)}`;
    const savedKey = await fetch(`${base}/api/org/provider-keys/zai`, {
      method: 'PUT',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ key: zaiMaterial }),
    });
    expect(savedKey.status).toBe(200);
    const keyBody = await savedKey.json() as { keys: Array<{ provider: string; configuredAt: string }> };
    expect(keyBody.keys.some((row) => row.provider === 'zai')).toBe(true);
    expect(JSON.stringify(keyBody)).not.toContain(zaiMaterial);

    // ---- the viewer's own organisation, with no email anywhere in it.
    const org = await fetch(`${base}/api/org`, { headers: cookie });
    expect(org.status).toBe(200);
    const orgBody = await org.json() as {
      id: string;
      name: string;
      viewerRole: string;
      members: Array<{ principalId: string; displayName: string; role: string; avatarUrl: string | null }>;
      projectCount: number;
      pendingInvitations: number | null;
    };
    expect(orgBody.viewerRole).toBe('org:owner');
    expect(orgBody.members).toHaveLength(1);
    expect(orgBody.members[0]).toMatchObject({
      principalId: whoami.principalId,
      displayName: 'Ada Lovelace',
      role: 'org:owner',
      avatarUrl: null,
    });
    expect(orgBody.projectCount).toBe(0);
    // Owner, so the count is a number rather than withheld.
    expect(orgBody.pendingInvitations).toBe(0);
    expect(JSON.stringify(orgBody)).not.toContain('fake@example.com');

    // ---- avatar bytes: stored out of band (the login path cannot reach a
    // loopback picture), then served same-origin with a validator.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const strangerDb = new Database(instance.dbPath);
    let strangerId: string;
    let etag: string;
    try {
      const store = new AuthStore(strangerDb);
      etag = store.saveAvatar({
        principalId: whoami.principalId,
        mime: 'image/png',
        bytes: png,
        sourceUrl: 'https://avatars.example/a.png',
      });
      // A principal in ANOTHER organisation: their avatar must be invisible.
      const stranger = store.completeLogin({
        provider: 'github',
        subject: 'stranger-org-owner',
        displayName: 'Stranger',
        email: 'stranger@example.com',
        emailVerified: false,
      }, null);
      strangerId = stranger!.viewer.principalId;
      store.saveAvatar({
        principalId: strangerId,
        mime: 'image/png',
        bytes: png,
        sourceUrl: null,
      });
    } finally {
      strangerDb.close();
    }

    const versioned = await (await fetch(`${base}/auth/whoami`, { headers: cookie })).json() as {
      avatarUrl: string;
    };
    expect(versioned.avatarUrl).toBe(
      `/auth/avatar/${whoami.principalId}?v=${etag.slice(0, 16)}`
    );
    const served = await fetch(`${base}${versioned.avatarUrl}`, { headers: cookie });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('private, max-age=300');
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    const validator = served.headers.get('etag')!;
    const revalidated = await fetch(`${base}${versioned.avatarUrl}`, {
      headers: { ...cookie, 'if-none-match': validator },
    });
    expect(revalidated.status).toBe(304);

    // Cross-organisation read: a 404, not a 403 — an outsider learns nothing
    // about which principals exist.
    expect((await fetch(`${base}/auth/avatar/${strangerId}`, { headers: cookie })).status).toBe(404);
    // ...and no session at all reads nothing.
    expect((await fetch(`${base}/auth/avatar/${whoami.principalId}`)).status).toBe(401);
    // Account routes are self-scoped, never operator-scoped: no platform admin
    // grant happened above, and every one of them answered.
    expect((await fetch(`${base}/api/registries`, { headers: cookie })).status).toBe(403);
  });

  it('serves the platform audit journal to the admin alone, newest first', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 303 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    // The login itself founds an organisation, which is the journal's first
    // row — written by the SERVER process.
    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };

    // Before the grant the journal is operator-level state, like the registry.
    for (const path of ['/api/admin/events', '/api/admin/ledger', '/api/admin/sentinel']) {
      expect((await fetch(`${base}${path}`, { headers: cookie })).status).toBe(403);
    }

    const { runAuthCli } = await import('../src/cli/auth.js');
    expect(
      runAuthCli(
        ['node', 'auth', 'grant-admin', '--principal', 'fake@example.com', '--db', instance.dbPath],
        {}
      )
    ).toBe(0);

    interface JournalPage {
      events: Array<{
        seq: number;
        kind: string;
        severity: string;
        actorType: string;
        orgId: string | null;
        summary: string;
        detail?: Record<string, unknown>;
      }>;
      nextBefore: number | null;
    }
    const read = async (query = ''): Promise<JournalPage> => {
      const response = await fetch(`${base}/api/admin/events${query}`, { headers: cookie });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return (await response.json()) as JournalPage;
    };

    const page = await read();
    const kinds = page.events.map((event) => event.kind);
    // `org.created` came from the server; `admin.granted` came from a
    // SEPARATE PROCESS writing the same table. Seeing both here is the proof
    // that the CLI's audit rows are not lost to the server.
    expect(kinds).toContain('org.created');
    expect(kinds).toContain('admin.granted');
    // Newest first: the CLI grant happened after the login.
    expect(kinds.indexOf('admin.granted')).toBeLessThan(kinds.indexOf('org.created'));
    expect(page.events.map((event) => event.seq)).toEqual(
      [...page.events.map((event) => event.seq)].sort((a, b) => b - a)
    );
    const granted = page.events.find((event) => event.kind === 'admin.granted')!;
    expect(granted).toMatchObject({ actorType: 'cli', severity: 'security' });

    // Minting an invitation is journaled — but a bearer credential must never
    // become an audit row, not even hashed.
    const orgId = page.events.find((event) => event.kind === 'org.created')!.orgId!;
    const minted = await fetch(`${base}/api/admin/invitations`, {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ orgId, role: 'org:member', ttlHours: 1 }),
    });
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    const afterMint = await read();
    expect(afterMint.events[0]).toMatchObject({
      kind: 'invitation.created',
      actorType: 'principal',
    });
    expect(JSON.stringify(afterMint.events)).not.toContain(token);
    expect(JSON.stringify(afterMint.events)).not.toContain(sha256Hex(token));

    // Filters and the exclusive newest-first cursor.
    expect((await read('?kind=org.created')).events.map((event) => event.kind)).toEqual([
      'org.created',
    ]);
    expect(
      (await read('?severity=security')).events.every((event) => event.severity === 'security')
    ).toBe(true);
    const firstPage = await read('?limit=1');
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.nextBefore).toBe(firstPage.events[0]!.seq);
    const secondPage = await read(`?limit=1&before=${firstPage.nextBefore!}`);
    expect(secondPage.events[0]!.seq).toBeLessThan(firstPage.events[0]!.seq);
    // Out-of-range limits clamp instead of erroring.
    expect((await read('?limit=99999')).events.length).toBeGreaterThan(0);
    expect((await read('?limit=notanumber')).events.length).toBeGreaterThan(0);

    // FAMILY, the filter the journal screen actually offers: 28 kinds is not a
    // chip row. It is a prefix match over a CLOSED vocabulary, so an unknown
    // family is ignored rather than reaching SQL as a pattern.
    const byFamily = await read('?family=org');
    expect(byFamily.events.length).toBeGreaterThan(0);
    expect(byFamily.events.every((event) => event.kind.startsWith('org.'))).toBe(true);
    expect(
      (await read('?family=admin')).events.every((event) => event.kind.startsWith('admin.'))
    ).toBe(true);
    expect((await read("?family=%25")).events.length).toBeGreaterThan(0);
    expect((await read('?family=nonsense')).events.length).toBeGreaterThan(0);

    // The product ledger is a SEPARATE read from the journal, never a merge.
    const ledger = await fetch(`${base}/api/admin/ledger?limit=5`, { headers: cookie });
    expect(ledger.status).toBe(200);
    const ledgerBody = (await ledger.json()) as { events: unknown[] };
    expect(Array.isArray(ledgerBody.events)).toBe(true);
    expect(ledgerBody).not.toHaveProperty('nextBefore');

    // THE SENTINEL READ. Rule table, runs in flight across both corpora, and
    // findings — and NOTHING that claims the watch process is running, which
    // this server cannot know.
    const sentinel = await fetch(`${base}/api/admin/sentinel`, { headers: cookie });
    expect(sentinel.status).toBe(200);
    const sentinelBody = (await sentinel.json()) as {
      rules: { id: string; kind: string }[];
      live: { runId: string; corpus: string }[];
      skipped: { runId: string | null; reason: string }[];
      findings: { kind: string }[];
    };
    expect(sentinelBody.rules.length).toBeGreaterThan(0);
    expect(sentinelBody.rules.map((rule) => rule.id)).toContain('injection-signature');
    expect(
      sentinelBody.rules.every(
        (rule) => rule.kind === 'run.anomaly' || rule.kind === 'security.flagged'
      )
    ).toBe(true);
    expect(Array.isArray(sentinelBody.live)).toBe(true);
    expect(Array.isArray(sentinelBody.skipped)).toBe(true);
    // Findings are journal rows of exactly the two sentinel kinds; this
    // instance has none, and an empty list is the answer, not an error.
    expect(
      sentinelBody.findings.every(
        (finding) => finding.kind === 'run.anomaly' || finding.kind === 'security.flagged'
      )
    ).toBe(true);
    // A rule's `check` is not something a reader may hold.
    expect(JSON.stringify(sentinelBody.rules)).not.toContain('check');
  });

  it('serves each member their own notification tray through the push routing table', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 909 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    // No session, no tray: the route lives behind the gate.
    expect((await fetch(`${base}/api/notifications`)).status).toBe(401);

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };
    const whoami = (await (await fetch(`${base}/auth/whoami`, { headers: cookie })).json()) as {
      principalId: string;
    };

    interface TrayPage {
      notifications: Array<{
        seq: number;
        at: string;
        kind: string;
        severity: string;
        title: string;
        body: string;
        orgId: string | null;
        projectId: string | null;
        runId: string | null;
        traceId: string | null;
      }>;
      nextBefore: number | null;
    }
    const read = async (query = ''): Promise<TrayPage> => {
      const response = await fetch(`${base}/api/notifications${query}`, { headers: cookie });
      expect(response.status).toBe(200);
      return (await response.json()) as TrayPage;
    };

    // The login journaled `org.created`, but its audience is platform admins:
    // a fresh member's tray is empty, not a mirror of the journal.
    expect((await read()).notifications).toEqual([]);

    // Journal facts from ANOTHER process, exactly like the operator CLI: the
    // tray is a projection of the table, not of this server's memory.
    const { PlatformEventLog } = await import('../src/platform/events.js');
    const log = PlatformEventLog.open(instance.dbPath);
    expect(
      log.append({
        kind: 'run.finished',
        actorType: 'principal',
        actorId: whoami.principalId,
        orgId: 'org-tray',
        // A well-formed project-run id with NO project_runs row behind it:
        // the trace resolution must answer null, never invent or crash.
        runId: 'b7a0c9d2-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
        summary: 'their own run SECRET-SUMMARY',
        detail: { status: 'delivered', goal: 'Ship the tray' },
      })
    ).not.toBeNull();
    expect(
      log.append({
        kind: 'run.finished',
        actorType: 'principal',
        actorId: 'somebody-else',
        summary: 'another requester run',
        detail: { status: 'failed', goal: 'Not yours' },
      })
    ).not.toBeNull();
    expect(
      log.append({
        kind: 'platform.announcement',
        actorType: 'principal',
        actorId: 'operator-admin',
        summary: 'announcement',
        detail: {
          texts: {
            en: { title: 'Maintenance window', body: 'Tonight at 22:00 UTC' },
            fr: { title: 'Fenêtre de maintenance', body: 'Ce soir à 22:00 UTC' },
          },
        },
      })
    ).not.toBeNull();

    // Newest first: the announcement, then the viewer's own run — and never
    // the run somebody else asked for. Copy arrives RENDERED; the row's
    // operator-facing summary never leaves the journal.
    const page = await read();
    expect(page.notifications.map((row) => row.kind)).toEqual([
      'platform.announcement',
      'run.finished',
    ]);
    expect(page.notifications[0]).toMatchObject({
      title: 'Maintenance window',
      body: 'Tonight at 22:00 UTC',
    });
    expect(page.notifications[1]).toMatchObject({
      title: 'Atoma — run delivered',
      body: 'Ship the tray',
      // The event's scope ids ride the row so the client can link the run;
      // the trace resolves to null when no project run carries that id.
      orgId: 'org-tray',
      runId: 'b7a0c9d2-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
      projectId: null,
      traceId: null,
    });
    expect(page.notifications[0]).toMatchObject({ orgId: null, traceId: null });
    expect(page.notifications.map((row) => row.seq)).toEqual(
      [...page.notifications.map((row) => row.seq)].sort((a, b) => b - a)
    );
    expect(JSON.stringify(page)).not.toContain('SECRET-SUMMARY');

    // The copy follows the requested language, rendered by the same frozen
    // templates a push subscription reads.
    const french = await read('?locale=fr');
    expect(french.notifications[0]!.title).toBe('Fenêtre de maintenance');
    expect(french.notifications[1]!.title).toBe('Atoma — run livré');

    // The exclusive cursor pages without repeating or skipping.
    const first = await read('?limit=1');
    expect(first.notifications).toHaveLength(1);
    expect(first.nextBefore).toBe(first.notifications[0]!.seq);
    const second = await read(`?limit=1&before=${first.nextBefore!}`);
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]!.seq).toBeLessThan(first.notifications[0]!.seq);
    expect(second.notifications[0]!.kind).toBe('run.finished');
  });

  it('hosts the watch itself, armed by default, and says so honestly', async () => {
    // THE PLACEMENT, at the boundary that matters: a real gated server process,
    // not a unit. `npm run viz`, `viz:dev` and `viz:serve` are all this file,
    // so arming it here is what arms all three.
    const instance = tempInstance();
    const provider = await startFakeProvider({
      port: await freePort(),
      subject: 9111,
      displayName: 'Watcher',
    });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      ['--host', '127.0.0.1', '--port', String(port), '--db', instance.dbPath, '--dir', instance.runsDir],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    // The banner is the honest substitute for a whole-stack command: one
    // command, and it says what it started.
    const banner = running.stdout.join('');
    expect(banner).toMatch(/sentinel: watching every \d+s/);
    // The stay-awake advice is the HOST's own command, so this asserts against
    // the one definition rather than a literal — it used to pin macOS's
    // `caffeinate`, which was wrong on the very platform CI runs on. Where the
    // host has nothing to say the line is absent, and the absence is the
    // assertion.
    const inhibitor = sleepInhibitorHint();
    if (inhibitor) expect(banner).toContain(inhibitor);
    else expect(banner).not.toMatch(/keep this machine awake/);

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };
    const { runAuthCli } = await import('../src/cli/auth.js');
    expect(
      runAuthCli(
        ['node', 'auth', 'grant-admin', '--principal', 'fake@example.com', '--db', instance.dbPath],
        {}
      )
    ).toBe(0);

    const response = await fetch(`${base}/api/admin/sentinel`, { headers: cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      watch: {
        armed: boolean;
        reason: string;
        source: string;
        intervalMs: number;
        incumbent: unknown;
      };
    };
    expect(body.watch.armed).toBe(true);
    expect(body.watch.reason).toBe('armed');
    // A fact about THIS process — which is the only reason it may be reported.
    expect(body.watch.source).toBe('viz-server');
    expect(body.watch.intervalMs).toBeGreaterThan(0);
    expect(body.watch.incumbent).toBeNull();

    // And the watch is not why the server refuses to die. `waitForExit`
    // escalates to SIGKILL after thirty seconds, so the signal it actually
    // died from is the assertion: SIGTERM means the term worked, SIGKILL
    // would mean something held the loop open.
    running.process.kill('SIGTERM');
    await waitForExit(running.process);
    expect(running.process.signalCode).toBe('SIGTERM');
  });

  it('lets an operator switch the watch off without losing the visualizer', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({
      port: await freePort(),
      subject: 9112,
      displayName: 'No Watch',
    });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      ['--host', '127.0.0.1', '--port', String(port), '--db', instance.dbPath, '--dir', instance.runsDir],
      { ...providerEnv(provider, base), ATOMA_VIZ_SENTINEL: '0' }
    );
    await waitReady(running, `${base}/auth/whoami`);
    expect(running.stdout.join('')).toContain('sentinel: off (disabled)');

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = { cookie: jar.header(base)! };
    const { runAuthCli } = await import('../src/cli/auth.js');
    runAuthCli(
      ['node', 'auth', 'grant-admin', '--principal', 'fake@example.com', '--db', instance.dbPath],
      {}
    );
    const body = (await (
      await fetch(`${base}/api/admin/sentinel`, { headers: cookie })
    ).json()) as { watch: { armed: boolean; reason: string } };
    expect(body.watch).toMatchObject({ armed: false, reason: 'disabled' });
  });

  it('lets an org member READ the BYO surfaces and refuses every write with 403', async () => {
    // 2026-08-27, finding 3.3. The role ladder on `/api/org/models` and
    // `/api/org/provider-keys` is the most sensitive surface of that window —
    // it decides who can spend an organisation's money — and the only
    // process-level walk over it ran as `org:owner`, so the refusal half was
    // never executed. Members READ the defaults on purpose: their own Settings
    // must show what they inherit.
    const instance = tempInstance();
    const invitation = 'M'.repeat(43);
    createInvitation(instance.dbPath, invitation, 'org:member');
    const provider = await startFakeProvider({ port: await freePort(), subject: 7788, displayName: 'Member' });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      { ...providerEnv(provider, base), ATOMA_SECRET_ENCRYPTION_KEY: 'k'.repeat(64) }
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    const login = await fetchWithJar(jar, `${base}/auth/login?provider=github&invite=${invitation}`);
    expect(login.status).toBe(200);
    const cookie = { cookie: jar.header(base)! };
    expect(await (await fetch(`${base}/auth/whoami`, { headers: cookie })).json()).toMatchObject({
      authenticated: true,
      role: 'org:member',
    });

    // READ: allowed, and never carrying key material.
    const read = await fetch(`${base}/api/org/models`, { headers: cookie });
    expect(read.status).toBe(200);
    const readBody = await read.json() as { keys: Array<{ provider: string }>; models: unknown };
    expect(Array.isArray(readBody.keys)).toBe(true);
    const keysRead = await fetch(`${base}/api/org/provider-keys`, { headers: cookie });
    expect(keysRead.status).toBe(200);

    // WRITE: refused, on every verb of both surfaces.
    const json = { ...cookie, 'content-type': 'application/json', origin: base };
    const savedModels = await fetch(`${base}/api/org/models`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ models: { l1: 'anthropic:claude-haiku-4-5', l2: null, l3: null } }),
    });
    expect(savedModels.status).toBe(403);
    const savedKey = await fetch(`${base}/api/org/provider-keys/zai`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ key: `sk-test-${'z'.repeat(24)}` }),
    });
    expect(savedKey.status).toBe(403);
    const deletedKey = await fetch(`${base}/api/org/provider-keys/zai`, {
      method: 'DELETE',
      headers: json,
    });
    expect(deletedKey.status).toBe(403);

    // And nothing was written by the refusals.
    const after = await fetch(`${base}/api/org/models`, { headers: cookie });
    expect((await after.json() as { keys: unknown[] }).keys).toHaveLength(0);

  });

  it('completes invited login, ignores hostile forwarded headers, and revokes on POST logout', async () => {
    const instance = tempInstance();
    const invitation = 'A'.repeat(43);
    createInvitation(instance.dbPath, invitation);
    const provider = await startFakeProvider({ port: await freePort(), subject: 4242, displayName: 'Fake User' });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const decoyDb = join(instance.root, 'ambient-decoy.db');
    const running = startViz(
      [...instance.args, '--port', String(port)],
      { ...providerEnv(provider, base), ATOMA_DB_PATH: decoyDb }
    );
    await waitReady(running, `${base}/auth/whoami`);

    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
    // A new visitor's first touch is the APP SHELL — the arrival gate is the
    // login (crystal, tagline, provider buttons), not a bare server form.
    // The login-capable shell still pins that it cannot be framed.
    const root = await fetch(`${base}/?invite=${invitation}`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(root.headers.get('referrer-policy')).toBe('no-referrer');
    const shell = await root.text();
    expect(shell).not.toContain(AUTH_COPY.pageTitle);
    expect(shell).toContain('<script');
    // The capability probe tells the shell which providers to offer, without
    // a session and without a 401 that would loop it back here.
    const anonWhoami = await fetch(`${base}/auth/whoami`);
    expect(anonWhoami.status).toBe(200);
    expect(await anonWhoami.json()).toEqual({
      enabled: true,
      authenticated: false,
      providers: [{ id: 'github', label: 'GitHub' }],
    });
    // The no-JS fallback selector stays server-rendered at /auth/login.
    const fallback = await fetch(`${base}/auth/login?invite=${invitation}`);
    expect(fallback.status).toBe(200);
    const fallbackPage = await fallback.text();
    expect(fallbackPage).toContain(`<title>${AUTH_COPY.pageTitle}</title>`);
    expect(fallbackPage).toContain(`invite=${invitation}`);

    const poisoned = await fetch(`${base}/auth/login?provider=github`, {
      redirect: 'manual',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(poisoned.status).toBe(302);
    const poisonedTarget = new URL(poisoned.headers.get('location')!);
    expect(poisonedTarget.searchParams.get('redirect_uri')).toBe(`${base}/auth/callback`);
    expect(poisoned.headers.get('set-cookie')).toContain('Path=/auth');
    expect(poisoned.headers.get('set-cookie')).not.toContain('Secure');

    const jar = new CookieJar();
    const after = await fetchWithJar(
      jar,
      `${base}/auth/login?provider=github&invite=${invitation}`
    );
    expect(after.status).toBe(200);
    const session = jar.value('atoma_session', base);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(provider.stats.verifiedPkce).toBe(1);
    expect(provider.stats.authorizeRedirectUris.at(-1)).toBe(`${base}/auth/callback`);
    expect(provider.stats.tokenRedirectUris).toEqual([`${base}/auth/callback`]);
    expect(provider.stats.tokenClientSecrets).toEqual(['test-secret']);

    const api = await fetch(`${base}/api/runs`, { headers: { cookie: jar.header(base)! } });
    expect(api.status).toBe(200);
    const who = await fetch(`${base}/auth/whoami`, { headers: { cookie: jar.header(base)! } });
    expect(await who.json()).toMatchObject({
      authenticated: true,
      displayName: 'Fake User',
      role: 'org:owner',
    });

    expect((await fetch(`${base}/auth/logout`, { redirect: 'manual' })).status).toBe(405);
    expect(
      (await fetch(`${base}/auth/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: jar.header(base)!, origin: 'https://evil.example' },
      })).status
    ).toBe(403);
    expect((await fetch(`${base}/api/runs`, { headers: { cookie: jar.header(base)! } })).status).toBe(200);

    const overflowCookie = [
      `atoma_session=${session}`,
      ...Array.from(
        { length: MAX_LOGOUT_SESSION_CANDIDATES },
        (_, index) => `atoma_session=${String(index).padStart(2, '0')}${'Z'.repeat(41)}`
      ),
    ].join('; ');
    const overflowLogout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: overflowCookie, origin: base },
    });
    expect(overflowLogout.status).toBe(431);
    expect(overflowLogout.headers.get('cache-control')).toBe('no-store');
    expect(overflowLogout.headers.get('set-cookie')).toBeNull();
    expect(
      (await fetch(`${base}/api/runs`, { headers: { cookie: `atoma_session=${session}` } })).status
    ).toBe(200);

    const logout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: jar.header(base)!, origin: base },
    });
    jar.absorb(logout, `${base}/auth/logout`);
    expect(logout.status).toBe(302);
    expect(jar.value('atoma_session', base)).toBe('logged_out');
    expect(
      (await fetch(`${base}/api/runs`, { headers: { cookie: `atoma_session=${session}` } })).status
    ).toBe(401);

    // The known provider subject can now re-authenticate without another invite.
    const relogin = await fetchWithJar(jar, `${base}/auth/login?provider=github`);
    expect(relogin.status).toBe(200);
    const reloginSession = jar.value('atoma_session', base);
    expect(reloginSession).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const duplicateCookie = `atoma_session=${'Y'.repeat(43)}; atoma_session=${reloginSession}`;
    expect(
      (await fetch(`${base}/api/runs`, { headers: { cookie: duplicateCookie } })).status
    ).toBe(401);
    const duplicateLogout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: duplicateCookie, origin: base },
    });
    expect(duplicateLogout.status).toBe(302);
    expect(
      (await fetch(`${base}/api/runs`, {
        headers: { cookie: `atoma_session=${reloginSession}` },
      })).status
    ).toBe(401);

    // A narrower Path=/api cookie is not sent to /auth/logout. The inert
    // host-only root tombstone must keep that still-valid bearer ambiguous
    // after logout instead of exposing it as the sole session cookie.
    const victimJar = new CookieJar();
    const narrowJar = new CookieJar();
    expect((await fetchWithJar(victimJar, `${base}/auth/login?provider=github`)).status).toBe(200);
    expect((await fetchWithJar(narrowJar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const victimSession = victimJar.value('atoma_session', base)!;
    const narrowSession = narrowJar.value('atoma_session', base)!;
    expect(
      (await fetch(`${base}/api/runs`, {
        headers: { cookie: `atoma_session=${narrowSession}; atoma_session=${victimSession}` },
      })).status
    ).toBe(401);

    const shadowedLogout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `atoma_session=${victimSession}`, origin: base },
    });
    victimJar.absorb(shadowedLogout, `${base}/auth/logout`);
    expect(victimJar.value('atoma_session', base)).toBe('logged_out');
    expect(
      (await fetch(`${base}/api/runs`, {
        headers: { cookie: `${victimJar.header(base)!}; atoma_session=${narrowSession}` },
      })).status
    ).toBe(401);
    // The hidden bearer was deliberately absent from logout and remains a
    // valid server-side session; the tombstone is what makes the browser fail closed.
    expect(
      (await fetch(`${base}/api/runs`, {
        headers: { cookie: `atoma_session=${narrowSession}` },
      })).status
    ).toBe(200);
    expect(
      (await fetch(`${base}/auth/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: `atoma_session=${narrowSession}`, origin: base },
      })).status
    ).toBe(302);

    const selected = new Database(instance.dbPath, { readonly: true });
    try {
      expect((selected.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count).toBe(0);
    } finally {
      selected.close();
    }
    expect(() => new Database(decoyDb, { readonly: true, fileMustExist: true })).toThrow();
  });

  it('tells an invited user how to retry after the provider refuses login', async () => {
    const instance = tempInstance();
    const invitation = 'R'.repeat(43);
    createInvitation(instance.dbPath, invitation);
    const provider = await startFakeProvider({ port: await freePort(), subject: 19 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    const loginUrl = `${base}/auth/login?provider=github&invite=${invitation}`;
    const login = await fetch(loginUrl, { redirect: 'manual' });
    jar.absorb(login, loginUrl);
    const providerTarget = new URL(login.headers.get('location')!);
    const state = providerTarget.searchParams.get('state')!;
    const callback = `${base}/auth/callback?error=access_denied&state=${state}`;
    const refused = await fetch(callback, {
      redirect: 'manual',
      headers: { cookie: jar.header(callback)! },
    });

    // Failures bounce back to the app shell's arrival gate with a bounded
    // notice code — the GL welcome renders the message from its catalogs —
    // and the transaction cookie is CLEARED, never re-issued.
    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toBe('/?authNotice=providerRefused');
    const clearedTx = (refused.headers.getSetCookie?.() ?? []).find((line) =>
      line.startsWith('atoma_oauth_tx=')
    );
    expect(clearedTx).toContain('Max-Age=0');
  });

  it('consumes OAuth state exactly once even if the original transaction cookie is replayed', async () => {
    const instance = tempInstance();
    const invitation = 'B'.repeat(43);
    createInvitation(instance.dbPath, invitation);
    const provider = await startFakeProvider({ port: await freePort(), subject: 7 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    const jar = new CookieJar();
    const loginUrl = `${base}/auth/login?provider=github&invite=${invitation}`;
    const login = await fetch(loginUrl, { redirect: 'manual' });
    jar.absorb(login, loginUrl);
    const providerTarget = login.headers.get('location')!;
    const providerResponse = await fetch(providerTarget, { redirect: 'manual' });
    const callback = providerResponse.headers.get('location')!;
    const originalTransactionCookie = jar.header(callback)!;

    const completed = await fetchWithJar(jar, callback);
    expect(completed.status).toBe(200);
    const replay = await fetch(callback, {
      redirect: 'manual',
      headers: { cookie: originalTransactionCookie },
    });
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe('/?authNotice=expiredState');
  });

  it('derives Secure and redirect_uri only from the configured HTTPS public origin', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 8 });
    const port = await freePort();
    const localBase = `http://127.0.0.1:${port}`;
    const publicOrigin = 'https://viz.example';
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, publicOrigin)
    );
    await waitReady(running, `${localBase}/auth/whoami`);

    const response = await fetch(`${localBase}/auth/login?provider=github`, {
      redirect: 'manual',
      headers: { host: 'evil.example', 'x-forwarded-proto': 'http' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('Secure');
    const target = new URL(response.headers.get('location')!);
    expect(target.searchParams.get('redirect_uri')).toBe('https://viz.example/auth/callback');
  });

  it('rate-limits public login starts before the database cap is reached', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 9 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);

    const statuses: number[] = [];
    for (let index = 0; index < 21; index++) {
      statuses.push((await fetch(`${base}/auth/login?provider=github`, {
        redirect: 'manual',
        headers: { 'x-forwarded-for': `198.51.100.${index + 1}` },
      })).status);
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 302));
    expect(statuses[20]).toBe(429);
  });

  it('uses X-Forwarded-For only behind an explicitly trusted direct proxy', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 10 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      {
        ...providerEnv(provider, base),
        ATOMA_VIZ_TRUSTED_PROXIES: '127.0.0.1',
      }
    );
    await waitReady(running, `${base}/auth/whoami`);

    for (let index = 0; index < 20; index++) {
      const response = await fetch(`${base}/auth/login?provider=github`, {
        redirect: 'manual',
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });
      expect(response.status).toBe(302);
    }
    const otherClient = await fetch(`${base}/auth/login?provider=github`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    expect(otherClient.status).toBe(302);
  });

  it('returns 503 for GitHub connect when the App is not configured', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 33 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      providerEnv(provider, base)
    );
    await waitReady(running, `${base}/auth/whoami`);
    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);

    const connect = await fetch(`${base}/auth/github/connect`, {
      redirect: 'manual',
      headers: { cookie: jar.header(base)! },
    });
    expect(connect.status).toBe(503);
    expect(await connect.json()).toEqual({ error: GITHUB_COPY.notConfigured });
    expect((await fetch(`${base}/webhooks/github`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('routes GitHub App connect, CSRF and webhook boundaries', async () => {
    const instance = tempInstance();
    const provider = await startFakeProvider({ port: await freePort(), subject: 44 });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const running = startViz(
      [...instance.args, '--port', String(port)],
      { ...providerEnv(provider, base), ...githubAppEnv(instance.root) }
    );
    await waitReady(running, `${base}/auth/whoami`);
    expect(running.stderr.join('') + running.stdout.join('')).toContain('github app: atoma-test');

    const jar = new CookieJar();
    expect((await fetchWithJar(jar, `${base}/auth/login?provider=github`)).status).toBe(200);
    const cookie = jar.header(base)!;

    const connect = await fetch(`${base}/auth/github/connect`, {
      redirect: 'manual',
      headers: { cookie },
    });
    expect(connect.status).toBe(302);
    const location = new URL(connect.headers.get('location')!);
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/apps/atoma-test/installations/new');
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    expect(
      (await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      })).status
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      })).status
    ).toBe(403);

    const webhook = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: {
        'x-hub-signature-256': `sha256=${'ab'.repeat(32)}`,
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'ping',
      },
      body: '{}',
    });
    expect(webhook.status).toBe(401);

    const db = new Database(instance.dbPath);
    try {
      db.prepare("UPDATE auth_memberships SET role = 'org:viewer'").run();
    } finally {
      db.close();
    }
    const forbidden = await fetch(`${base}/auth/github/connect`, {
      redirect: 'manual',
      headers: { cookie },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: GITHUB_COPY.adminRequired });

    const listed = await fetch(`${base}/api/github/installations`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);
  });
});
