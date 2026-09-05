import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore, sha256Hex, type Viewer } from '../src/auth/store.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { callerTier, type McpCaller } from '../src/mcp/identity.js';
import { buildServer } from '../src/mcp/server.js';
import { MCP_TOOL_NAMES, MCP_TOOLS, visibleTools, type McpToolDeps } from '../src/mcp/tools.js';

/**
 * ONE MCP FOR EVERYONE, OVER HTTP. What these hold, through the real SDK
 * client against the real host on a real port:
 *   - the catalogue is filtered by tier: a viewer, a member, an org admin and
 *     the platform admin each see their ladder and nothing above it;
 *   - the ungated loopback operator sees the operator tools and nothing
 *     tenant-shaped, because the host has no organisations to honour;
 *   - no bearer is a 401, a session cannot be ridden by another caller, and a
 *     revoked token ends the session;
 *   - the API token store mints once, resolves to a fresh viewer, lists
 *     secret-free and revokes only its owner's tokens.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const hosts: McpHttpHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  closeStoreHandles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function viewer(role: Viewer['role'], platformAdmin = false): Viewer {
  return {
    principalId: `p-${role}`,
    displayName: role,
    kind: 'human',
    orgId: 'org-1',
    orgName: 'Org One',
    role,
    platformAdmin,
    displayNameSource: 'provider',
  };
}

const NO_TENANT: McpToolDeps = { projects: null, auth: null, journal: null, operatorRuns: true };
/** A host that HAS the tenant runtime, as far as the catalogue's `needs` are concerned. */
const TENANT_HOST: McpToolDeps = {
  projects: { service: {} as never, store: {} as never },
  auth: {} as never,
  journal: { list: () => ({ events: [], nextBefore: null }) },
  operatorRuns: true,
};

async function listen(resolveCaller: (req: IncomingMessage) => McpCaller | null, deps: McpToolDeps): Promise<{ url: string; host: McpHttpHost }> {
  const server = createServer((req, res) => void host.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = new McpHttpHost({
    resolveCaller,
    buildServer: (caller) => buildServer(caller, deps),
    allowedHosts: [`127.0.0.1:${port}`],
  });
  hosts.push(host);
  return { url: `http://127.0.0.1:${port}/mcp`, host };
}

async function connect(url: string, bearer?: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {},
  });
  await client.connect(transport);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

describe('the catalogue by tier', () => {
  it('shows each caller its ladder and nothing above it', () => {
    const names = (caller: McpCaller, deps: McpToolDeps) => visibleTools(caller, deps).map((t) => t.name);
    const asViewer = names({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 't' }, TENANT_HOST);
    const asMember = names({ kind: 'principal', viewer: viewer('org:member'), tokenId: 't' }, TENANT_HOST);
    const asAdmin = names({ kind: 'principal', viewer: viewer('org:admin'), tokenId: 't' }, TENANT_HOST);
    const asPlatform = names({ kind: 'principal', viewer: viewer('org:viewer', true), tokenId: 't' }, TENANT_HOST);
    expect(asViewer).toEqual(['atoma_families', 'atoma_projects_list', 'atoma_project_runs', 'atoma_run_status', 'atoma_run_trace']);
    expect(asMember).toEqual([...asViewer, 'atoma_project_create', 'atoma_run_start', 'atoma_run_cancel', 'atoma_publication_retry']);
    expect(asAdmin).toEqual([...asMember, 'atoma_org_members', 'atoma_org_models']);
    expect(asPlatform).toEqual(MCP_TOOL_NAMES); // a platform admin's ladder is the whole table
    expect(callerTier({ kind: 'operator' })).toBe('platform');
    // The ungated operator: no organisations to honour, no journal.
    const asOperator = names({ kind: 'operator' }, NO_TENANT);
    expect(asOperator).not.toContain('atoma_projects_list');
    expect(asOperator).not.toContain('atoma_journal_tail');
    expect(asOperator).toContain('atoma_operator_run_start');
    expect(asOperator).toContain('atoma_registry_list');
    expect(asOperator).toContain('atoma_run_trace');
  });

  it('names every tool once and states a tier for each', () => {
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOLS.length);
    for (const tool of MCP_TOOLS) expect(['viewer', 'member', 'admin', 'platform']).toContain(tool.tier);
  });
});

describe('the HTTP host', () => {
  it('serves the operator on loopback without a token, tools filtered by what the host honours', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    const names = await toolNames(client);
    expect(names).toContain('atoma_operator_run_start');
    expect(names).not.toContain('atoma_projects_list');
    // A reader tool answers through the session.
    const families = await client.callTool({ name: 'atoma_families', arguments: {} });
    const text = (families.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toHaveProperty('families');
    // The prompt surface rides the platform tier.
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(3);
    await client.close();
  });

  it('refuses a caller without identity with a 401 and a WWW-Authenticate header', async () => {
    const { url, host } = await listen(() => null, TENANT_HOST);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(host.health().refused).toBe(1);
  });

  it('gives a member the member ladder, and refuses a tool call above it even by name', async () => {
    const callers: Record<string, McpCaller> = {
      'member-token': { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' },
    };
    const { url } = await listen((req) => {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      return bearer ? callers[bearer] ?? null : null;
    }, TENANT_HOST);
    const client = await connect(url, 'member-token');
    const names = await toolNames(client);
    expect(names).toContain('atoma_run_start');
    expect(names).not.toContain('atoma_org_members');
    expect(names).not.toContain('atoma_registry_list');
    // Not registered on this session at all: the server answers "unknown tool",
    // never the registry.
    const refused = await client.callTool({ name: 'atoma_registry_list', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/not found|unknown tool/i);
    expect(JSON.stringify(refused.content)).not.toContain('molecule');
    await client.close();
  });

  it('ends a session whose caller changed, and does not let one caller ride another’s session', async () => {
    let current: McpCaller | null = { kind: 'principal', viewer: viewer('org:admin'), tokenId: 'a' };
    const { url, host } = await listen(() => current, TENANT_HOST);
    const client = await connect(url);
    expect(await toolNames(client)).toContain('atoma_org_members');
    expect(host.health().sessions).toBe(1);
    // The token was revoked: the resolver now says nobody.
    current = null;
    await expect(client.listTools()).rejects.toThrow();
    // Re-minted as a lesser role: the old session id is not honoured either.
    current = { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'b' };
    await expect(client.listTools()).rejects.toThrow();
    expect(host.health().sessions).toBe(0);
  });
});

describe('API tokens in the auth store', () => {
  function storeWithPrincipal(): { store: AuthStore; founder: Viewer } {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-tokens-'));
    dirs.push(dir);
    const store = AuthStore.open(join(dir, 'atoma.db'));
    const founder = store.completeLogin(
      { provider: 'github', subject: 'founder', displayName: 'Founder', email: null, emailVerified: false },
      null
    )!.viewer;
    return { store, founder };
  }

  it('mints once, resolves to a fresh viewer, lists secret-free and revokes only its owner’s', () => {
    const { store, founder } = storeWithPrincipal();
    const minted = store.createApiToken({ principalId: founder.principalId, orgId: founder.orgId, label: '  my  laptop ' });
    expect(minted.token).toMatch(/^atoma_[A-Za-z0-9_-]{40,}$/);
    const resolved = store.resolveApiToken(minted.token)!;
    expect(resolved).toMatchObject({ principalId: founder.principalId, orgId: founder.orgId, role: 'org:owner', tokenId: minted.tokenId, platformAdmin: false });
    // The flag is read NOW, not at minting.
    store.grantPlatformAdmin(founder.principalId);
    expect(store.resolveApiToken(minted.token)!.platformAdmin).toBe(true);
    const listed = store.listApiTokens(founder.principalId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tokenId: minted.tokenId, label: 'my laptop', revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain(minted.token.slice(6, 20));
    expect(JSON.stringify(listed)).not.toContain(sha256Hex(minted.token));
    // A stranger cannot revoke it; the owner can, once.
    expect(store.revokeApiToken('someone-else', minted.tokenId)).toBe(false);
    expect(store.revokeApiToken(founder.principalId, minted.tokenId)).toBe(true);
    expect(store.revokeApiToken(founder.principalId, minted.tokenId)).toBe(false);
    expect(store.resolveApiToken(minted.token)).toBeNull();
    expect(store.resolveApiToken('atoma_not-a-token')).toBeNull();
    expect(store.resolveApiToken('')).toBeNull();
  });

  it('refuses to mint for an organisation the principal is not a member of', () => {
    const { store, founder } = storeWithPrincipal();
    expect(() => store.createApiToken({ principalId: founder.principalId, orgId: 'other-org', label: 'x' })).toThrow(/not a member/);
  });
});
