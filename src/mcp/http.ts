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
 * so the route adds no capability the run did not already have.
 *
 * WHAT THE BROWSER CANNOT DO, AND BY WHICH CONTROL. `allowedHosts` pins the
 * Host, which is what defeats DNS rebinding: a page on an attacker domain
 * resolved to this address still sends that domain as Host and is refused.
 * `allowedOrigins` pins the Origin, which the SDK checks ONLY when the header
 * is present, so a CLI client that sends none is unaffected while a page that
 * sends one is refused by name. Origin is defence in depth, not the
 * load-bearing control: nothing here emits CORS headers, and MCP's own
 * required headers (`content-type: application/json`, `Accept:
 * text/event-stream`) are not CORS-safelisted, so a cross-origin page is
 * stopped at a preflight this server never answers. Both are passed, and
 * neither is described as doing the other's work.
 *
 * SESSIONS ARE CEILINGED TWICE. A session holds a whole `McpServer` and a
 * replay ring worth megabytes (`eventStore.ts`), and the only other reclaim
 * is the 30-minute idle sweep — so a client that re-initialises in a loop
 * would grow this map until the process died. A caller past its own ceiling
 * loses its STALEST session, which is self-limiting and costs that caller
 * only; the global ceiling refuses with 503 and is the backstop, never the
 * first line.
 */

export interface McpHttpHostOptions {
  /** Null → 401. The host never guesses an identity. */
  readonly resolveCaller: (req: IncomingMessage) => McpCaller | null;
  readonly buildServer: (caller: McpCaller) => McpServer;
  /** `Host` values this route answers; anything else is 403 by the transport. */
  readonly allowedHosts: readonly string[];
  /** `Origin` values this route answers WHEN the header is sent; an absent Origin is unaffected. */
  readonly allowedOrigins?: readonly string[];
  readonly resourceMetadataUrl?: string;
  readonly idleMs?: number;
  /** Total live sessions on this host. Past it, a new session is refused. */
  readonly maxSessions?: number;
  /** Live sessions one caller may hold. Past it, that caller's stalest session is dropped. */
  readonly maxSessionsPerCaller?: number;
  readonly now?: () => number;
  readonly logger?: (line: string) => void;
}

interface Session {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  /** The session's replay ring, held so `health()` can report the depth it lost. */
  readonly events: SessionEventStore;
  readonly key: string;
  lastSeenMs: number;
}

export const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const MCP_SESSION_HEADER = 'mcp-session-id';
/** The host's backstop. At 4 MiB of replay ring apiece this bounds the rings at ~512 MiB. */
export const MCP_MAX_SESSIONS = 128;
/** One caller's share. A client needs one session; a handful covers a reconnect storm. */
export const MCP_MAX_SESSIONS_PER_CALLER = 8;

export interface McpHttpHealth {
  readonly sessions: number;
  readonly opened: number;
  /** Requests answered 401: no caller, or a caller that does not own the session it presented. */
  readonly refused: number;
  /** Sessions dropped to keep a caller inside its own ceiling. */
  readonly evicted: number;
  /** Sessions refused 503 by the host ceiling. Non-zero means the backstop is load-bearing. */
  readonly overflowed: number;
  /** Frames the live sessions' rings dropped: replay depth a reconnect can no longer reach. */
  readonly replayEvictions: number;
}

export class McpHttpHost {
  private readonly sessions = new Map<string, Session>();
  private readonly options: McpHttpHostOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sweeper: NodeJS.Timeout;
  private readonly maxSessions: number;
  private readonly maxPerCaller: number;
  private opened = 0;
  private refused = 0;
  private evicted = 0;
  private overflowed = 0;

  constructor(options: McpHttpHostOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => {});
    this.maxSessions = options.maxSessions ?? MCP_MAX_SESSIONS;
    this.maxPerCaller = options.maxSessionsPerCaller ?? MCP_MAX_SESSIONS_PER_CALLER;
    const idleMs = options.idleMs ?? MCP_SESSION_IDLE_MS;
    this.sweeper = setInterval(() => void this.sweep(idleMs), Math.max(60_000, Math.min(idleMs, 5 * 60_000)));
    this.sweeper.unref();
  }

  health(): McpHttpHealth {
    let replayEvictions = 0;
    for (const session of this.sessions.values()) replayEvictions += session.events.evictions();
    return { sessions: this.sessions.size, opened: this.opened, refused: this.refused, evicted: this.evicted, overflowed: this.overflowed, replayEvictions };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const caller = this.options.resolveCaller(req);
    if (!caller) {
      this.refused += 1;
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': this.options.resourceMetadataUrl
          ? `Bearer realm="atoma", error="invalid_token", resource_metadata="${this.options.resourceMetadataUrl}", scope="mcp"`
          : 'Bearer realm="atoma", error="invalid_token"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'a valid access token is required' }, id: null }));
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
    // This caller's own ceiling first, so a busy client reclaims from itself
    // rather than from the host — and only then the host's backstop.
    await this.reclaim(key);
    if (this.sessions.size >= this.maxSessions) {
      this.overflowed += 1;
      this.log(`session refused for ${describeCaller(caller)}: ${this.sessions.size} sessions is the host ceiling`);
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'too many active MCP sessions on this host; retry shortly' }, id: null }));
      return;
    }
    const server = this.options.buildServer(caller);
    const events = new SessionEventStore();
    let session: Session | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // SSE responses, NEVER plain JSON. In JSON mode the SDK drops every
      // notification related to a request — a `notifications/progress` sent
      // during a `waitMs` long-poll reached nobody (measured 2026-09-07: 0 of 3
      // delivered, against 3 of 3 over SSE). The stream is also what the event
      // store replays after a cut connection (`Last-Event-ID`).
      eventStore: events,
      enableDnsRebindingProtection: true,
      allowedHosts: [...this.options.allowedHosts],
      // Checked only when the request carries an Origin, so a CLI client that
      // sends none is untouched. Absent here, the SDK skips the check entirely.
      ...(this.options.allowedOrigins ? { allowedOrigins: [...this.options.allowedOrigins] } : {}),
      onsessioninitialized: (id) => {
        session = { id, transport, server, events, key, lastSeenMs: this.now() };
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
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      // Not an initialize, a refused one, or a throw on the way: the transport
      // has already answered, and nothing else will ever close this server —
      // the sweeper only walks `sessions`, which this one never entered.
      if (!session) {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    }
  }

  /**
   * Keep one caller inside its own ceiling by dropping its stalest session.
   * A loop, not an `if`: a lowered ceiling or a burst can leave several over.
   */
  private async reclaim(key: string): Promise<void> {
    for (;;) {
      const mine = [...this.sessions.values()].filter((session) => session.key === key);
      if (mine.length < this.maxPerCaller) return;
      const stalest = mine.reduce((oldest, session) => (session.lastSeenMs < oldest.lastSeenMs ? session : oldest));
      this.evicted += 1;
      await this.drop(stalest, 'caller session ceiling');
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
