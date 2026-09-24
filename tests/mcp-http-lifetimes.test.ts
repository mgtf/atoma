import { createServer, request, type Server, type ClientRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it, vi } from 'vitest';
import { McpHttpHost } from '../src/mcp/http.js';

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
async function listen(build: () => McpServer, limits = 1) {
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
    now: () => now, maxSessions: limits, maxSessionsPerCaller: 1 });
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
  }).then(res => res.text());
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    now = 181 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(0);
    await pending;
  } finally { finish(); }
});
