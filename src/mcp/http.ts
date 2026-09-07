import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionEventStore } from './eventStore.js';
import { callerKey, describeCaller, type McpCaller } from './identity.js';

/**
 * THE MCP OVER HTTP — one route on the viz server, `/mcp`, speaking the
 * Streamable HTTP transport to Claude Code, Codex and anything else that
 * takes a URL and a bearer.
 *
 * ONE SESSION, ONE SERVER, ONE CALLER. An `initialize` request authenticates
 * the caller, builds a server holding only the tools that caller's tier
 * admits, and binds both to a session id. Every later request on that session
 * must present the SAME caller: a token revoked between two calls ends the
 * session with a 401 rather than riding the id it opened. Sessions are
 * in-memory and idle-swept; a host restart forgets them and a client simply
 * re-initialises — the state that matters (runs, verdicts, the journal) lives
 * in the stores, never in a session.
 *
 * WHAT MOVED HERE FROM THE OLD STDIO ARGUMENT. Stdio was "no socket the run
 * could reach". On a gated deployment a run holds no bearer and is inside a
 * container with no network, so the identity layer is what neutralises the
 * reachable port — the same answer the viz's own project launcher gave. On the
 * ungated loopback path the operator is anonymous, and a local run could
 * indeed call this route; it could equally shell out to `npm run run:build`,
 * so the route adds no capability the run did not already have. Host and
 * Origin are still pinned (`allowedHosts`) so a page in the operator's browser
 * cannot address the port through DNS rebinding.
 */

export interface McpHttpHostOptions {
  /** Null → 401. The host never guesses an identity. */
  readonly resolveCaller: (req: IncomingMessage) => McpCaller | null;
  readonly buildServer: (caller: McpCaller) => McpServer;
  /** `Host` values this route answers; anything else is 403 by the transport. */
  readonly allowedHosts: readonly string[];
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly logger?: (line: string) => void;
}

interface Session {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly key: string;
  lastSeenMs: number;
}

export const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const MCP_SESSION_HEADER = 'mcp-session-id';

export interface McpHttpHealth {
  readonly sessions: number;
  readonly opened: number;
  readonly refused: number;
}

export class McpHttpHost {
  private readonly sessions = new Map<string, Session>();
  private readonly options: McpHttpHostOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sweeper: NodeJS.Timeout;
  private opened = 0;
  private refused = 0;

  constructor(options: McpHttpHostOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => {});
    const idleMs = options.idleMs ?? MCP_SESSION_IDLE_MS;
    this.sweeper = setInterval(() => void this.sweep(idleMs), Math.max(60_000, Math.min(idleMs, 5 * 60_000)));
    this.sweeper.unref();
  }

  health(): McpHttpHealth {
    return { sessions: this.sessions.size, opened: this.opened, refused: this.refused };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const caller = this.options.resolveCaller(req);
    if (!caller) {
      this.refused += 1;
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="atoma", error="invalid_token"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'a valid API token is required' }, id: null }));
      return;
    }
    const header = req.headers[MCP_SESSION_HEADER];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown or expired session; initialize again' }, id: null }));
        return;
      }
      if (session.key !== callerKey(caller)) {
        // The session was opened by a different identity or tier than the one
        // now presenting it — a revoked and re-minted token, a role change.
        await this.drop(session, 'caller changed');
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'session does not belong to this caller' }, id: null }));
        return;
      }
      session.lastSeenMs = this.now();
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session; POST an initialize request first' }, id: null }));
      return;
    }
    // A new session: the transport validates that the body is `initialize`.
    const key = callerKey(caller);
    const server = this.options.buildServer(caller);
    let session: Session | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // SSE responses, NEVER plain JSON. In JSON mode the SDK drops every
      // notification related to a request — a `notifications/progress` sent
      // during a `waitMs` long-poll reached nobody (measured 2026-09-07: 0 of 3
      // delivered, against 3 of 3 over SSE). The stream is also what the event
      // store replays after a cut connection (`Last-Event-ID`).
      eventStore: new SessionEventStore(),
      enableDnsRebindingProtection: true,
      allowedHosts: [...this.options.allowedHosts],
      onsessioninitialized: (id) => {
        session = { id, transport, server, key, lastSeenMs: this.now() };
        this.sessions.set(id, session);
        this.opened += 1;
        this.log(`session ${id.slice(0, 8)} opened for ${describeCaller(caller)}`);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (session) this.sessions.delete(session.id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (!session) {
      // Not an initialize, or a refused one: the transport already answered.
      await server.close().catch(() => {});
    }
  }

  private async drop(session: Session, reason: string): Promise<void> {
    this.sessions.delete(session.id);
    this.log(`session ${session.id.slice(0, 8)} closed (${reason})`);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
  }

  private async sweep(idleMs: number): Promise<void> {
    const cutoff = this.now() - idleMs;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenMs < cutoff) await this.drop(session, 'idle');
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) await this.drop(session, 'host closing');
  }
}
