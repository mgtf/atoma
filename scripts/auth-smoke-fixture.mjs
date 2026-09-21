// Shared loopback OAuth fixture for compiled release and packaged-stack checks.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

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

export async function startProvider({ port = 0, identities = [{ id: 4242, name: 'Release Smoke Owner' }, { id: 4300, name: 'Release Smoke Member' }] } = {}) {
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
        const identity = identities[Math.min(Number(bearer[1]) - 1, identities.length - 1)];
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
    server.listen(port, '127.0.0.1', () => {
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

export class CookieJar {
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

export async function request(jar, url, init = {}) {
  const cookie = jar.header(url);
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  jar.absorb(response, url);
  return response;
}

export function providerLoginUrl(selectorHtml, pageUrl, invitationToken) {
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
