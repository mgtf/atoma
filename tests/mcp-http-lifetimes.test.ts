import { createServer, request, type Server, type ClientRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpHttpHost, mcpMaxRequestMsFromEnv, MCP_MAX_REQUEST_MS, STANDALONE_SSE_STREAM_ID } from '../src/mcp/http.js';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifetimes', version: '1' },
} });
let host: McpHttpHost;
let server: Server;
let now = 0;
let built = 0;
const requests: ClientRequest[] = [];
afterEach(async () => {
  for (const req of requests.splice(0)) req.destroy();
  await host?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.useRealTimers();
});
async function listen(build: () => McpServer, limits = 1, perCaller = 1) {
  now = 0;
  built = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  server = createServer((req, res) => { void host.handle(req, res).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  host = new McpHttpHost({ resolveCaller: req => ({ kind: 'principal', tokenId: String(req.headers['authorization'] ?? 'a'),
    viewer: { principalId: String(req.headers['authorization'] ?? 'a'), orgId: 'o', orgName: 'o', displayName: 'a', displayNameSource: 'provider', kind: 'human', role: 'org:member', platformAdmin: false } }),
    buildServer: () => { built++; return build(); }, allowedHosts: [`127.0.0.1:${address.port}`],
    now: () => now, maxSessions: limits, maxSessionsPerCaller: perCaller });
  return `http://127.0.0.1:${address.port}/mcp`;
}
function fragmented(url: string, authorization = 'a') {
  let req: ClientRequest;
  const response = new Promise<{ status: number; body: string; id?: string }>((resolve, reject) => {
    req = request(url, { method: 'POST', headers: { ...headers, authorization } }, res => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, body, id: res.headers['mcp-session-id'] as string | undefined }));
    });
    req.on('error', reject);
    req.write(initialize.slice(0, 10));
    requests.push(req);
  });
  return { req: req!, response };
}
const fresh = () => new McpServer({ name: 'test', version: '1' });
it.each([1, 2])('reserves caller and global capacity before fragmented initialize bodies (limit=%s)', async limit => {
  const url = await listen(fresh, limit);
  const first = fragmented(url);
  await vi.waitFor(() => expect(built).toBe(1));
  const second = fragmented(url);
  expect((await second.response).status).toBe(503);
  second.req.end(initialize.slice(10));
  expect(built).toBe(1);
  if (limit === 1) {
    const other = fragmented(url, 'b');
    expect((await other.response).status).toBe(503);
    other.req.end(initialize.slice(10));
  }
  first.req.end(initialize.slice(10));
  expect((await first.response).status).toBe(200);
  expect(host.health().sessions).toBe(1);
});
it('releases invalid and disconnected initialization reservations', async () => {
  const url = await listen(fresh);
  const invalid = fragmented(url);
  invalid.req.end('invalid');
  expect((await invalid.response).status).toBe(400);
  const abandoned = fragmented(url);
  const closed = abandoned.response.catch(() => undefined);
  await vi.waitFor(() => expect(built).toBe(2));
  abandoned.req.destroy();
  await closed;
  await new Promise(resolve => setImmediate(resolve));
  const valid = fragmented(url);
  valid.req.end(initialize.slice(10));
  expect((await valid.response).status).toBe(200);
});
it('keeps a pending POST past idle, delivers its response, then sweeps the idle session', async () => {
  let finish!: () => void;
  let entered = false;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const url = await listen(() => {
    const sdk = fresh();
    sdk.registerTool('slow', {}, async () => { entered = true; await result; return { content: [{ type: 'text', text: 'finished' }] }; });
    return sdk;
  });
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const pending = fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': id },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }),
  }).then(res => res.text());
  await vi.waitFor(() => expect(entered).toBe(true));
  now = 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(1);
  finish();
  expect(await pending).toContain('finished');
  now += 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(0);
});
it('does not let a standalone GET event stream pin an idle session', async () => {
  const url = await listen(fresh);
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const stream = await fetch(url, { headers: { ...headers, 'mcp-session-id': id } });
  const body = stream.text();
  now = 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(0);
  await body;
});

it('bounds a POST that never answers even though it pins the idle clock', async () => {
  let finish!: () => void;
  let entered = false;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const url = await listen(() => {
    const sdk = fresh();
    sdk.registerTool('wedged', {}, async () => { entered = true; await result; return { content: [] }; });
    return sdk;
  });
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const pending = fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': id },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wedged' } }),
  }).then(res => res.text()).catch(() => '');
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    now = 181 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The stalled CALL ends; its session, and whatever else it holds, does not.
    await pending;
    expect(host.health().sessions).toBe(1);
    now += 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(0);
  } finally { finish(); }
});

it('reads the request ceiling from the deployment, refusing a value it cannot honour', () => {
  expect(mcpMaxRequestMsFromEnv({})).toBe(MCP_MAX_REQUEST_MS);
  expect(mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '43200000' })).toBe(43_200_000);
  expect(() => mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '5000' })).toThrow(/at least 60000/);
  expect(() => mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '3h' })).toThrow(/integer/);
});

it('names the SDK standalone stream id it relies on', () => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) as unknown as Record<string, unknown>;
  const inner = (transport['_webStandardTransport'] ?? transport) as Record<string, unknown>;
  expect(inner['_standaloneSseStreamId']).toBe(STANDALONE_SSE_STREAM_ID);
});

describe('a call the client is still waiting for (2026-09-25 review, 1.3)', () => {
  const callBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } });
  function slowServer(gates: Array<() => void>) {
    return () => {
      const sdk = fresh();
      sdk.registerTool('slow', {}, async () => {
        await new Promise<void>(resolve => gates.push(resolve));
        return { content: [{ type: 'text', text: 'FINISHED-RESULT' }] };
      });
      return sdk;
    };
  }
  function raw(url: string, method: string, headers: Record<string, string>, body?: string,
    onChunk?: (text: string, req: ClientRequest) => void) {
    return new Promise<{ status?: number; text: string }>(resolve => {
      const req = request(url, { method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += String(chunk); onChunk?.(text, req); });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
        res.on('aborted', () => resolve({ status: res.statusCode!, text }));
        res.on('error', () => resolve({ status: res.statusCode!, text }));
        res.on('close', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', () => resolve({ text: '' }));
      req.on('close', () => setImmediate(() => resolve({ text: '' })));
      requests.push(req);
      req.end(body);
    });
  }

  it('keeps the session of a call resumed with Last-Event-ID, and replays its response', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const id = (await init.response).id!;
    // As the SDK client does: the negotiated version, whose streams carry
    // priming event ids, and the `initialized` notification.
    const session = { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
    await raw(url, 'POST', session, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    let eventId: string | undefined;
    await raw(url, 'POST', session, callBody, (text, req) => {
      const match = /id: (\S+)/.exec(text);
      if (match && !eventId) { eventId = match[1]; req.destroy(); }
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(eventId).toBeDefined();
    const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId! });
    await new Promise(resolve => setTimeout(resolve, 100));
    now = 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(1);
    gates.shift()!();
    expect((await resumed).text).toContain('FINISHED-RESULT');
  });

  /** A session with a slow call begun at `now`, its POST cut after the first event id. */
  async function cutCall(url: string, gates: Array<() => void>) {
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const id = (await init.response).id!;
    const session = { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
    await raw(url, 'POST', session, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    let eventId: string | undefined;
    await raw(url, 'POST', session, callBody, (text, req) => {
      const match = /id: (\S+)/.exec(text);
      if (match && !eventId) { eventId = match[1]; req.destroy(); }
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    return { session, eventId: eventId! };
  }

  it('does not pin a session with the resumed stream of a call already answered', async () => {
    // The SDK holds a resumed stream open after its replay, and nothing more
    // will ever be sent there: pinned, it held the session for the whole
    // request ceiling (2026-09-25 adversarial review).
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const { session, eventId } = await cutCall(url, gates);
    gates.shift()!();
    await new Promise(resolve => setTimeout(resolve, 100));
    let replayed = false;
    const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId },
      undefined, (text) => { if (text.includes('FINISHED-RESULT')) replayed = true; });
    await vi.waitFor(() => expect(replayed).toBe(true));
    now = 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(0);
    await resumed;
  });

  it('bounds a resumed call by the start of the call, so reconnecting never extends the ceiling', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const { session, eventId } = await cutCall(url, gates);
    try {
      now = 170 * 60_000;
      const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId });
      await new Promise(resolve => setTimeout(resolve, 100));
      now = 181 * 60_000;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Past three hours of the CALL, not of the reconnect: the response
      // closes, the session stays for its other calls.
      expect((await resumed).text).not.toContain('FINISHED-RESULT');
      expect(host.health().sessions).toBe(1);
    } finally { gates.shift()?.(); }
  });

  it('never evicts a session answering a call to make room for the same caller', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates), 16, 2);
    const openSession = async () => {
      const init = fragmented(url); init.req.end(initialize.slice(10));
      return (await init.response).id!;
    };
    now = 0; const busy = await openSession();
    now = 1_000; const pending = raw(url, 'POST', { ...headers, 'mcp-session-id': busy }, callBody);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    now = 2_000; const idle = await openSession();
    now = 3_000; await openSession();
    // The idle session was the one reclaimed; the busy call answers.
    expect(host.health().evicted).toBe(1);
    const stillThere = await raw(url, 'POST', { ...headers, 'mcp-session-id': idle },
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    expect(stillThere.status).toBe(404);
    gates.shift()!();
    expect((await pending).text).toContain('FINISHED-RESULT');
  });

  it('answers 503 rather than cutting a call when every place of the caller is busy', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates), 16, 1);
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const busy = (await init.response).id!;
    const pending = raw(url, 'POST', { ...headers, 'mcp-session-id': busy }, callBody);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const refused = fragmented(url); refused.req.end(initialize.slice(10));
    expect((await refused.response).status).toBe(503);
    expect(host.health().evicted).toBe(0);
    gates.shift()!();
    expect((await pending).text).toContain('FINISHED-RESULT');
  });
});
