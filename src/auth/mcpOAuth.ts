import { hasControlCharacters } from './values.js';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AuthGate } from './gate.js';
import { MCP_CODE_TTL_MS, MCP_OAUTH_SCOPE, oauthHash } from './mcpOAuthStore.js';
import { parseCookieHeader, serializeCookie, SESSION_COOKIE } from './sessions.js';
import { BoundedFixedWindowRateLimiter } from './rate-limit.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';

const RETURN_COOKIE = 'atoma_mcp_return';
const MAX_PENDING = 1_024;
const fresh = (): string => randomBytes(32).toString('base64url');
const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function redirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)));
  } catch { return false; }
}
const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(80).refine(value => !hasControlCharacters(value)).default('MCP client'),
  redirect_uris: z.array(z.string().max(2048).refine(redirectUri)).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
});
interface Pending {
  clientId: string; redirectUri: string; challenge: string; state: string | null; resource: string;
  expiresAt: number; sessionHash?: string; principalId?: string; orgId?: string;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const bytes = Buffer.from(part as Uint8Array);
    size += bytes.length;
    if (size > 16_384) throw new Error('request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' });
  res.end(JSON.stringify(value));
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}
function singleCookie(req: IncomingMessage, name: string): string | null {
  const values = parseCookieHeader(req.headers.cookie).filter((cookie) => cookie.name === name);
  return values.length === 1 ? values[0]!.value : null;
}
function params(raw: string): URLSearchParams {
  const result = new URLSearchParams(raw);
  for (const key of result.keys()) if (result.getAll(key).length !== 1) throw new Error('duplicate parameter');
  return result;
}

/** OAuth routes are mounted before the browser API gate, only on authenticated deployments. */
export class McpOAuth {
  private readonly pending = new Map<string, Pending>();
  private readonly rate = new BoundedFixedWindowRateLimiter(60, 60_000, 1_024);
  readonly resource: string;
  readonly metadataUrl: string;

  constructor(private readonly options: {
    gate: AuthGate; origin: URL; clientAddress: (req: IncomingMessage) => string; emit: PlatformEventSink;
  }) {
    this.resource = new URL('/mcp', options.origin).href;
    this.metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', options.origin).href;
  }

  /** Only an opaque pending request can resume after the existing upstream login. */
  loginReturn(req: IncomingMessage): { location: string; cookie: string } {
    const id = singleCookie(req, RETURN_COOKIE);
    const pending = id ? this.pending.get(id) : null;
    return { location: pending && pending.expiresAt > Date.now() ? `/oauth/authorize?request=${id}` : '/',
      cookie: serializeCookie(RETURN_COOKIE, '', { secure: this.options.origin.protocol === 'https:', path: '/auth', maxAgeSeconds: 0 }) };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const metadata = path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource';
    const discovery = path === '/.well-known/oauth-authorization-server';
    const endpoint = ['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'].includes(path);
    if (!metadata && !discovery && !endpoint) return false;
    if (req.headers.host !== this.options.origin.host) { json(res, 403, { error: 'invalid_request' }); return true; }
    if ((metadata || discovery) && req.method === 'GET') {
      const origin = this.options.origin.origin;
      json(res, 200, metadata ? { resource: this.resource, authorization_servers: [origin],
        scopes_supported: [MCP_OAUTH_SCOPE], bearer_methods_supported: ['header'] } : {
        issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'], scopes_supported: [MCP_OAUTH_SCOPE],
        authorization_response_iss_parameter_supported: true,
      });
      return true;
    }
    if (metadata || discovery || (req.method !== 'POST' && !(path === '/oauth/authorize' && req.method === 'GET'))) {
      res.setHeader('allow', metadata || discovery ? 'GET' : path === '/oauth/authorize' ? 'GET, POST' : 'POST');
      json(res, 405, { error: 'invalid_request' }); return true;
    }
    const rate = this.rate.attempt(this.options.clientAddress(req));
    if (!rate.accepted) { res.setHeader('retry-after', String(rate.retryAfterSeconds)); json(res, 429, { error: 'temporarily_unavailable' }); return true; }
    const auth = this.options.gate.store!;
    try {
      if (path === '/oauth/register') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
        const input = registrationSchema.parse(JSON.parse(await body(req)));
        const client = auth.mcpOAuth.register(input.client_name, input.redirect_uris);
        json(res, 201, { ...input, ...client, client_id_issued_at: Math.floor(Date.now() / 1000) });
      } else if (path === '/oauth/authorize') {
        await this.authorize(req, res, url);
      } else {
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('form required');
        const form = params(await body(req));
        const clientId = form.get('client_id') ?? '';
        if (!auth.mcpOAuth.client(clientId)) { json(res, 400, { error: 'invalid_client' }); return true; }
        if (path === '/oauth/revoke') {
          auth.mcpOAuth.revoke(auth, form.get('token') ?? '', clientId, this.revoked);
          json(res, 200, {}); return true;
        }
        if (form.get('resource') !== this.resource) { json(res, 400, { error: 'invalid_target' }); return true; }
        if (form.has('scope') && form.get('scope') !== MCP_OAUTH_SCOPE) { json(res, 400, { error: 'invalid_scope' }); return true; }
        const grantType = form.get('grant_type');
        if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
          json(res, 400, { error: 'unsupported_grant_type' }); return true;
        }
        const result = grantType === 'authorization_code'
          ? auth.mcpOAuth.exchange(auth, { code: form.get('code') ?? '', clientId, redirectUri: form.get('redirect_uri') ?? '',
            verifier: form.get('code_verifier') ?? '', resource: this.resource }, this.revoked)
          : auth.mcpOAuth.refresh(auth, { token: form.get('refresh_token') ?? '', clientId, resource: this.resource }, this.revoked);
        if (!result) { json(res, 400, { error: 'invalid_grant' }); return true; }
        if (grantType === 'authorization_code') this.options.emit({ kind: 'token.created', actorType: 'principal',
          actorId: result.principalId, orgId: result.orgId, summary: 'OAuth access granted to an MCP client',
          detail: { tokenId: result.tokenId, clientId } });
        const { access_token, token_type, expires_in, refresh_token, scope } = result;
        json(res, 200, { access_token, token_type, expires_in, refresh_token, scope });
      }
    } catch {
      json(res, 400, { error: 'invalid_request' });
    }
    return true;
  }

  private readonly revoked = (receipt: { tokenId: string; principalId: string; orgId: string }): void => {
    this.options.emit({ kind: 'token.revoked', actorType: 'principal', actorId: receipt.principalId,
      orgId: receipt.orgId, summary: 'MCP OAuth authorization revoked', detail: { tokenId: receipt.tokenId } });
  };

  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = this.options.gate.store!;
    const now = Date.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(id);
    const query = params(url.search.slice(1));
    const form = req.method === 'POST' ? params(await body(req)) : query;
    let id = form.get('request');
    let pending = id ? this.pending.get(id) : undefined;
    if (!id && req.method === 'GET') {
      const client = auth.mcpOAuth.client(query.get('client_id') ?? '');
      const callback = query.get('redirect_uri') ?? '';
      const challenge = query.get('code_challenge') ?? '';
      if (!client || !client.redirect_uris.includes(callback)) throw new Error('unregistered callback');
      if ((query.get('state')?.length ?? 0) > 2048) throw new Error('state too large');
      const error = query.get('response_type') !== 'code' ? 'unsupported_response_type'
        : query.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ? 'invalid_request'
        : query.get('resource') !== this.resource ? 'invalid_target'
        : query.has('scope') && query.get('scope') !== MCP_OAUTH_SCOPE ? 'invalid_scope' : null;
      if (error) {
        // Only a validated, registered callback can receive protocol errors.
        const target = new URL(callback);
        target.searchParams.set('error', error);
        target.searchParams.set('iss', this.options.origin.origin);
        if (query.has('state')) target.searchParams.set('state', query.get('state')!);
        redirect(res, target.href); return;
      }
      if (this.pending.size >= MAX_PENDING) throw new Error('authorization capacity reached');
      id = fresh();
      pending = { clientId: client.client_id, redirectUri: callback, challenge, state: query.get('state'),
        resource: this.resource, expiresAt: now + MCP_CODE_TTL_MS };
      this.pending.set(id, pending);
    }
    if (!id || !pending) throw new Error('expired authorization request');
    const viewer = this.options.gate.resolve(req);
    const session = singleCookie(req, SESSION_COOKIE);
    if (!viewer || !session) {
      if (req.method !== 'GET') { json(res, 401, { error: 'login_required' }); return; }
      res.setHeader('set-cookie', serializeCookie(RETURN_COOKIE, id, { secure: this.options.origin.protocol === 'https:',
        path: '/auth', maxAgeSeconds: MCP_CODE_TTL_MS / 1000 }));
      redirect(res, '/auth/login'); return;
    }
    const binding = oauthHash(session);
    if (req.method === 'POST') {
      if (req.headers.origin !== this.options.origin.origin || pending.sessionHash !== binding ||
        pending.principalId !== viewer.principalId || pending.orgId !== viewer.orgId) {
        json(res, 403, { error: 'access_denied' }); return;
      }
      this.pending.delete(id);
      const callback = new URL(pending.redirectUri);
      callback.searchParams.set('iss', this.options.origin.origin);
      if (pending.state !== null) callback.searchParams.set('state', pending.state);
      if (form.get('decision') === 'allow') callback.searchParams.set('code', auth.mcpOAuth.code({
        clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge,
        resource: pending.resource, viewer,
      }));
      else callback.searchParams.set('error', 'access_denied');
      redirect(res, callback.href); return;
    }
    // Consent binds the displayed identity and organisation to this exact session.
    if (pending.sessionHash && pending.sessionHash !== binding) throw new Error('authorization belongs to another session');
    pending.sessionHash = binding; pending.principalId = viewer.principalId; pending.orgId = viewer.orgId;
    const client = auth.mcpOAuth.client(pending.clientId);
    if (!client) throw new Error('expired client');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      // no-referrer makes browser form POSTs send Origin: null, failing the consent guard.
      'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
      // Browsers apply form-action to the POST's redirect too, including desktop loopback callbacks.
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(pending.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'` });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Atoma</title><style>body{font:17px system-ui;background:#101918;color:#e7eeeb;max-width:560px;margin:12vh auto;padding:24px;line-height:1.6}button{font:inherit;padding:10px 24px;margin:16px 12px 0 0;border-radius:8px;cursor:pointer}code{overflow-wrap:anywhere}</style>
<h1>Connect to Atoma</h1><p><strong>${escape(client.client_name)}</strong> wants access as <strong>${escape(viewer.displayName)}</strong>
in <strong>${escape(viewer.orgName)}</strong>.</p><p>This grants your current MCP permissions, including starting runs and spending the organisation’s configured provider when your role allows it.${viewer.platformAdmin ? ' Your platform administrator access is included.' : ''}</p>
<p>Client names are supplied by the application. Continue only if you started this connection.</p>
<p>Return address: <code>${escape(pending.redirectUri)}</code></p><p>You can revoke this connection in Settings → MCP access.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${id}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form></html>`);
  }
}
