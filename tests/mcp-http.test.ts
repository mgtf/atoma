import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore, sha256Hex, type Viewer } from '../src/auth/store.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { resetRunsForTest, startRun, type RunDriver } from '../src/mcp/run.js';
import { FAMILIES_URI, operatorRunUri } from '../src/mcp/resources.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { callerTier, type McpCaller } from '../src/mcp/identity.js';
import { buildServer } from '../src/mcp/server.js';
import { MCP_TOOL_NAMES, MCP_TOOLS, visibleTools, type McpToolDeps } from '../src/mcp/tools.js';
import { SessionTaskStore, projectRunTaskHandler, type RunTaskHost } from '../src/mcp/tasks.js';
import { CallToolResultSchema, CreateTaskResultSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

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
  for (const server of servers.splice(0)) {
    // The SDK client keeps its sockets alive; `close` alone would wait out
    // their idle timeout (~4s per server) before calling back.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
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
    expect(asViewer).toEqual(['atoma_families', 'atoma_projects_list', 'atoma_project_runs', 'atoma_run_status', 'atoma_run_trace', 'atoma_run_preview']);
    expect(asMember).toEqual([...asViewer, 'atoma_project_create', 'atoma_run_start', 'atoma_run_cancel', 'atoma_publication_retry']);
    expect(asAdmin).toEqual([...asMember, 'atoma_org_members', 'atoma_org_models']);
    // The tray needs the host's notification builder; this host has none, so
    // the platform ladder is the whole table minus that one row.
    expect(asPlatform).toEqual(MCP_TOOL_NAMES.filter((name) => name !== 'atoma_notifications'));
    const withTray = names({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 't' }, { ...TENANT_HOST, notifications: () => ({ notifications: [], nextBefore: null }) });
    expect(withTray).toContain('atoma_notifications');
    expect(callerTier({ kind: 'operator' })).toBe('platform');
    // The ungated operator: no organisations to honour, no journal.
    const asOperator = names({ kind: 'operator' }, NO_TENANT);
    expect(asOperator).not.toContain('atoma_projects_list');
    expect(asOperator).not.toContain('atoma_journal_tail');
    expect(asOperator).not.toContain('atoma_notifications');
    expect(asOperator).toContain('atoma_operator_run_start');
    expect(asOperator).toContain('atoma_registry_list');
    expect(asOperator).toContain('atoma_run_trace');
    // The readers and writes the roadmap owed, all platform-tier.
    for (const owed of ['atoma_skills_show', 'atoma_ledger_tail', 'atoma_costs', 'atoma_registry_history', 'atoma_verdicts_list', 'atoma_verdict_show', 'atoma_sentinel_health', 'atoma_skill_reset', 'atoma_skill_drop', 'atoma_skill_merge', 'atoma_registry_rollback']) {
      expect(asOperator).toContain(owed);
      expect(asAdmin).not.toContain(owed);
    }
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



describe('organisation model audit across MCP', () => {
  it('emits one attributed journal event after a successful update and none for a read', async () => {
    const events: unknown[] = [];
    const models = { l1: null, l2: null, l3: null };
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:admin'), tokenId: 'a' }), {
      ...TENANT_HOST,
      auth: { orgTierModels: () => models, setOrgTierModels: () => models } as never,
      emit: (event) => { events.push(event); },
    });
    const client = await connect(url);
    await client.callTool({ name: 'atoma_org_models', arguments: {} });
    expect(events).toEqual([]);
    const result = await client.callTool({ name: 'atoma_org_models', arguments: { models } });
    expect(result.isError).not.toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'org.models_updated', actorType: 'principal',
      actorId: viewer('org:admin').principalId, orgId: viewer('org:admin').orgId });
    await client.close();
  });
});

describe('operator writes over MCP — attributed and journaled', () => {
  const saved: Record<string, string | undefined> = {};
  function skillsFixture(): { dir: string; l1: string } {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-writes-'));
    dirs.push(dir);
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR', 'ATOMA_LEDGER_DB']) saved[k] = process.env[k];
    process.env['ATOMA_DB_PATH'] = join(dir, 'atoma.db');
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'atoma.db');
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'skills');
    const reg = new SkillRegistry(join(dir, 'skills'));
    reg.save('mol-1', { id: 'keep-me', description: 'keep', whenToUse: 'when keeping', kind: 'llm', body: 'body A' });
    reg.save('mol-1', { id: 'absorb-me', description: 'absorb', whenToUse: 'when absorbing', kind: 'llm', body: 'body B' });
    reg.recordSuccess('mol-1', 'absorb-me');
    return { dir, l1: 'mol-1' };
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses to drop or absorb proven knowledge without force, and journals the actor when it does act', async () => {
    const { l1 } = skillsFixture();
    const events: unknown[] = [];
    const admin = viewer('org:owner', true);
    const { url } = await listen(() => ({ kind: 'principal', viewer: admin, tokenId: 'a' }), { ...TENANT_HOST, emit: (event) => { events.push(event); } });
    const client = await connect(url);
    const refused = await client.callTool({ name: 'atoma_skill_drop', arguments: { l1, id: 'absorb-me' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/proven knowledge/);
    const mergeRefused = await client.callTool({ name: 'atoma_skill_merge', arguments: { l1, keep: 'keep-me', absorb: 'absorb-me' } });
    expect(mergeRefused.isError).toBe(true);
    expect(events).toEqual([]);
    const reset = await client.callTool({ name: 'atoma_skill_reset', arguments: { l1, id: 'absorb-me' } });
    expect(reset.isError).not.toBe(true);
    expect(reset.structuredContent).toMatchObject({ before: { successes: 1 }, after: { successes: 0 }, journaled: true, actor: `mcp:${admin.principalId}` });
    const merged = await client.callTool({ name: 'atoma_skill_merge', arguments: { l1, keep: 'keep-me', absorb: 'absorb-me' } });
    expect(merged.isError).not.toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'skill.reset', actorType: 'principal', actorId: admin.principalId, orgId: admin.orgId });
    expect(events[1]).toMatchObject({ kind: 'skill.merged', actorType: 'principal', actorId: admin.principalId });
    expect(JSON.stringify(events)).not.toContain('body A');
    expect(new SkillRegistry(process.env['ATOMA_SKILLS_DIR']).loadFor(l1).map((s) => s.id)).toEqual(['keep-me']);
    await client.close();
  });

  it('a member cannot even see the writes, and a rollback of a missing type is a refusal, not a fault', async () => {
    skillsFixture();
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), TENANT_HOST);
    const client = await connect(url);
    expect(await toolNames(client)).not.toContain('atoma_skill_drop');
    await client.close();
    const { url: opUrl } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const operator = await connect(opUrl);
    const rollback = await operator.callTool({ name: 'atoma_registry_rollback', arguments: { name: 'Nobody', toVersion: 1 } });
    expect(rollback.isError).toBe(true);
    expect(JSON.stringify(rollback.content)).toMatch(/refused/);
    await operator.close();
  });
});

describe('preview, notifications and the tray over MCP', () => {
  it('reads preview state as a viewer, refuses to open one below member, opens as a member', async () => {
    const calls: string[] = [];
    const preview = {
      status: (_v: Viewer, p: string, r: string) => { calls.push(`status ${p}/${r}`); return { state: 'idle' }; },
      open: async (_v: Viewer, p: string, r: string, o: { inFlight?: boolean }) => { calls.push(`open ${p}/${r} ${o.inFlight}`); return { status: 200, body: { summary: { state: 'ready' }, url: 'https://preview/x#claim' } }; },
      stop: async () => ({ state: 'stopped' }),
    } as never;
    const callers: Record<string, McpCaller> = {
      v: { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' },
      m: { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' },
    };
    const { url } = await listen((req) => callers[/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''] ?? null, { ...TENANT_HOST, preview: () => preview });
    const asViewer = await connect(url, 'v');
    const state = await asViewer.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1' } });
    expect(state.structuredContent).toEqual({ state: 'idle' });
    const refused = await asViewer.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1', action: 'open' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/403/);
    await asViewer.close();
    const asMember = await connect(url, 'm');
    const opened = await asMember.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1', action: 'open', inFlight: true } });
    expect(opened.structuredContent).toMatchObject({ httpStatus: 200, url: 'https://preview/x#claim' });
    expect(calls).toEqual(['status p1/r1', 'open p1/r1 true']);
    await asMember.close();
  });

  it('answers "not available" when the host has no preview runtime, like the HTTP route', async () => {
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), { ...TENANT_HOST, preview: () => null });
    const client = await connect(url);
    const result = await client.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/503/);
    await client.close();
  });

  it('the tray is the host builder’s answer for THIS principal, with structured content', async () => {
    const seen: unknown[] = [];
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' }), {
      ...TENANT_HOST,
      notifications: (input) => { seen.push(input); return { notifications: [{ seq: 7, at: 'now', kind: 'run.finished', severity: 'info', title: 'Run finished', body: 'b', orgId: 'org-1', projectId: null, runId: null, traceId: null }], nextBefore: null }; },
    });
    const client = await connect(url);
    const result = await client.callTool({ name: 'atoma_notifications', arguments: { locale: 'fr', limit: 5 } });
    expect(seen).toEqual([{ principalId: viewer('org:viewer').principalId, locale: 'fr', limit: 5 }]);
    expect(result.structuredContent).toMatchObject({ notifications: [{ seq: 7 }], nextBefore: null });
    await client.close();
  });
});

describe('resources — addressable state with subscriptions', () => {
  afterEach(() => resetRunsForTest());

  it('lists the families for everyone, the operator corpus only for the platform tier, and reads through the readers', async () => {
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), TENANT_HOST);
    const member = await connect(url);
    const caps = member.getServerCapabilities();
    expect(caps?.resources).toMatchObject({ subscribe: true, listChanged: true });
    const templates = (await member.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('atoma://projects/{projectId}/runs/{runId}');
    expect(templates).not.toContain('atoma://runs/{file}');
    const families = await member.readResource({ uri: FAMILIES_URI });
    expect(JSON.parse((families.contents[0] as { text: string }).text)).toHaveProperty('families');
    await member.close();
    const { url: opUrl } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const operator = await connect(opUrl);
    const opTemplates = (await operator.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(opTemplates).toContain('atoma://runs/{file}');
    expect(opTemplates).toContain('atoma://operator-runs/{runId}');
    const traversal = await operator.readResource({ uri: 'atoma://runs/..%2F..%2Fetc%2Fpasswd' });
    expect((traversal.contents[0] as { text: string }).text).toMatch(/refused/);
    await operator.close();
  });

  it('tells a subscribed session when an operator run finishes', async () => {
    let settle: (log: string) => void = () => {};
    const driver: RunDriver = () => new Promise<string>((resolve) => { settle = resolve; });
    const record = await startRun({ goal: 'a goal for the resource test' }, driver, async () => ({ path: '<test>', attachChild() {}, release() {} }));
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    const updated: string[] = [];
    client.setNotificationHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).ResourceUpdatedNotificationSchema,
      (notification) => { updated.push(notification.params.uri); }
    );
    const uri = operatorRunUri(record.runId);
    await client.subscribeResource({ uri });
    const before = await client.readResource({ uri });
    expect(JSON.parse((before.contents[0] as { text: string }).text)).toMatchObject({ runId: record.runId, status: 'running' });
    settle('no epilogue');
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(updated).toEqual([uri]);
    const after = await client.readResource({ uri });
    expect(JSON.parse((after.contents[0] as { text: string }).text)).toMatchObject({ runId: record.runId, status: 'finished' });
    await client.close();
  });
});

describe('the stream — SSE frames and replay', () => {
  afterEach(() => resetRunsForTest());

  it('stamps every SSE frame with an event id the store can replay from', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const body = await response.text();
    expect(body).toMatch(/^id: /m);
    expect(body).toMatch(/"result"/);
  });

  it('replays the frames after a cursor on the same stream, and nothing for a lost cursor', async () => {
    const { SessionEventStore } = await import('../src/mcp/eventStore.js');
    const store = new SessionEventStore(4);
    const note = (n: number) => ({ jsonrpc: '2.0' as const, method: 'notifications/progress', params: { progressToken: 't', progress: n } });
    const a1 = await store.storeEvent('A', note(1));
    await store.storeEvent('B', note(10));
    await store.storeEvent('A', note(2));
    await store.storeEvent('A', note(3));
    expect(await store.getStreamIdForEventId(a1)).toBe('A');
    const replayed: number[] = [];
    const stream = await store.replayEventsAfter(a1, { send: async (_id, message) => { replayed.push((message as unknown as { params: { progress: number } }).params.progress); } });
    expect(stream).toBe('A');
    expect(replayed).toEqual([2, 3]);
    // The ring evicts the oldest: a cursor that fell off replays nothing.
    await store.storeEvent('A', note(4));
    expect(store.size()).toBe(4);
    expect(await store.replayEventsAfter(a1, { send: async () => {} })).toBe('');
    expect(await store.replayEventsAfter('never', { send: async () => {} })).toBe('');
  });
});

describe('runs as tasks, and the run log', () => {
  afterEach(() => resetRunsForTest());

  const lease = async () => ({ path: '<test>', attachChild() {}, release() {} });
  /** A driver the test feeds: chunks on demand, a settle to end, and an abort that ends it as cancelled. */
  function scriptedDriver() {
    const handle = { chunk: (_text: string) => {}, settle: (_log: string) => {}, aborted: false };
    const driver: RunDriver = (opts) =>
      new Promise<string>((resolve) => {
        handle.settle = resolve;
        handle.chunk = (text) => opts.onChunk?.(text);
        opts.signal?.addEventListener('abort', () => { handle.aborted = true; resolve('cancelled'); }, { once: true });
      });
    return { driver, handle };
  }
  const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * The task is a second door onto the SAME run: `createTask` starts it the way
   * the start tool does, `tasks/get` carries the output tail as the status
   * line, `tasks/result` returns the status payload when the run ends, and
   * `tasks/cancel` reaches the run's abort. All through the real SDK client.
   */
  it('drives atoma_operator_run_start as an MCP task: working with a status line, the status payload as the result, cancel reaching the run', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const caps = client.getServerCapabilities();
    expect(caps?.tasks).toMatchObject({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
    expect(caps?.logging).toEqual({});
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'atoma_operator_run_start');
    expect(listed?.execution).toEqual({ taskSupport: 'optional' });

    const created = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a goal driven as a task' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    expect(created.task.status).toBe('working');
    expect(created.task.statusMessage).toMatch(/^run mcp-.* started \(build\)$/);
    handle.chunk('alpha');
    await tick(20);
    const working = await client.experimental.tasks.getTask(created.task.taskId);
    expect(working.status).toBe('working');
    expect(working.statusMessage).toMatch(/1 chunks — untrusted model output: alpha$/);
    handle.settle('no epilogue');
    await tick(100);
    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema);
    const payload = result.structuredContent as { runId: string; status: string; progress: { chunks: number } };
    expect(payload.status).toBe('finished');
    expect(payload.progress.chunks).toBe(1);
    expect(payload.runId).toMatch(/^mcp-/);

    // A second run, cancelled through tasks/cancel: the run's abort fires and the record ends cancelled.
    const second = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a goal to cancel' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    const cancelled = await client.experimental.tasks.cancelTask(second.task.taskId);
    expect(cancelled.status).toBe('cancelled');
    await tick(100);
    expect(handle.aborted).toBe(true);
    const runs = (await client.experimental.tasks.listTasks()).tasks;
    expect(runs.map((task) => task.status).sort()).toEqual(['cancelled', 'completed']);
    const status = await client.callTool({ name: 'atoma_operator_run_status', arguments: {} });
    const seen = (status.structuredContent as { runs: { status: string }[] }).runs.map((run) => run.status);
    expect(seen).toEqual(['cancelled', 'finished']);
    await client.close();
  });

  it('answers a non-augmented start with the terminal result, as a synchronous run', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const pending = client.callTool({ name: 'atoma_operator_run_start', arguments: { goal: 'a synchronous goal' } });
    await tick(50);
    handle.chunk('one');
    handle.settle('done');
    const result = await pending;
    expect((result.structuredContent as { status: string }).status).toBe('finished');
    // A refused start is a task that fails at once, never a hung call.
    const refused = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'x', family: 'no-such-family' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    expect(refused.task.status).toBe('failed');
    const failure = await client.experimental.tasks.getTaskResult(refused.task.taskId, CallToolResultSchema);
    expect(failure.isError).toBe(true);
    expect((failure.content as { text: string }[])[0]!.text).toMatch(/refused/);
    await client.close();
  });

  it('follows atoma_run_start through the tenant store, and cancels the run on tasks/cancel', async () => {
    const statuses = ['queued', 'running', 'running', 'delivered'];
    const cancelled: string[] = [];
    const service = {
      startProjectRunFromInput: async (_v: unknown, _p: string, body: unknown) => ({ projectRunId: 'run-1', status: 'queued', goal: (body as { goal: string }).goal }),
      projectRunStatus: () => ({ projectRunId: 'run-1', status: statuses.length > 1 ? statuses.shift()! : statuses[0]! }),
      cancelProjectRun: async (_v: unknown, _p: string, runId: string) => { cancelled.push(runId); return { cancelled: runId }; },
    };
    const store = new SessionTaskStore();
    const host: RunTaskHost = { store, follow: () => {}, cleanups: [] };
    const handler = projectRunTaskHandler(host, { viewer: () => viewer('org:member'), service, pollMs: 10 });
    const requestStore = {
      createTask: (params: { ttl?: number | null; pollInterval?: number }) => store.createTask(params, 1, { method: 'tools/call' }),
      getTask: async (taskId: string) => (await store.getTask(taskId))!,
      storeTaskResult: (taskId: string, status: 'completed' | 'failed', result: { content: unknown[] }) => store.storeTaskResult(taskId, status, result),
      getTaskResult: (taskId: string) => store.getTaskResult(taskId),
      updateTaskStatus: (taskId: string, status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled', message?: string) => store.updateTaskStatus(taskId, status, message),
    };
    const extra = { taskStore: requestStore, signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) } as never;
    const created = await handler.createTask({ projectId: 'p-1', goal: 'ship it', idempotencyKey: undefined }, extra);
    expect(created.task.status).toBe('working');
    expect(created.task.statusMessage).toBe('run run-1 queued');
    await tick(120);
    const done = await store.getTask(created.task.taskId);
    expect(done?.status).toBe('completed');
    const result = (await store.getTaskResult(created.task.taskId)) as { structuredContent: { status: string } };
    expect(result.structuredContent.status).toBe('delivered');
    // A second task, cancelled the way the SDK's tasks/cancel handler does it: the run is cancelled too.
    statuses.splice(0, statuses.length, 'running');
    const second = await handler.createTask({ projectId: 'p-1', goal: 'stop me', idempotencyKey: undefined }, extra);
    await store.updateTaskStatus(second.task.taskId, 'cancelled', 'Client cancelled task execution.');
    expect(cancelled).toEqual(['run-1']);
    for (const cleanup of host.cleanups) cleanup();
    store.close();
  });

  it('sends the output of a run this session started as notifications/message, and one notice when it ends', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const messages: { level: string; logger?: string | undefined; data: unknown }[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { messages.push({ level: n.params.level, logger: n.params.logger, data: n.params.data }); });
    await client.setLoggingLevel('info');
    // A run this session did NOT start is not followed.
    const foreign = await startRun({ goal: 'a goal started elsewhere' }, driver, lease);
    handle.chunk('unfollowed');
    handle.settle('done');
    await tick(100);
    expect(messages).toEqual([]);
    // A run started through the session IS followed, chunk by chunk, then the notice.
    const started = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a followed goal' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    const runId = started.task.statusMessage!.match(/^run (mcp-\S+) started/)![1]!;
    expect(runId).not.toBe(foreign.runId);
    handle.chunk('alpha');
    handle.chunk('beta');
    handle.settle('done');
    await tick(150);
    expect(messages.map((m) => m.level)).toEqual(['info', 'info', 'notice']);
    expect(messages.every((m) => m.logger === `atoma.run.${runId}`)).toBe(true);
    expect(messages[0]!.data).toEqual({ runId, chunk: 'alpha', chunks: 1, untrusted: true });
    expect(messages[2]!.data).toMatchObject({ runId, status: 'finished' });
    // Below the level the client asked for, nothing is sent.
    await client.setLoggingLevel('warning');
    await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a quiet goal' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    handle.chunk('gamma');
    handle.settle('done');
    await tick(100);
    expect(messages).toHaveLength(3);
    await client.close();
  });
});
