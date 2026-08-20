import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_API_VERSION,
  GitHubApiError,
  GitHubAppClient,
  GitHubDivergenceError,
} from '../src/github/client.js';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installation(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    app_id: '123456',
    account: { id: '701', login: 'atoma-org', type: 'Organization' },
    target_type: 'Organization',
    repository_selection: 'all',
    permissions: { administration: 'write', contents: 'write' },
    suspended_at: null,
    ...overrides,
  };
}

function repository(owner: string, name: string): Record<string, unknown> {
  return {
    id: '9007199254740992',
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    default_branch: 'main',
    private: true,
    html_url: `https://github.com/${owner}/${name}`,
  };
}

function client(fetchImpl: typeof fetch, overrides: { timeoutMs?: number; responseMaxBytes?: number } = {}): GitHubAppClient {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new GitHubAppClient({
    appId: '123456',
    appSlug: 'atoma-test',
    privateKey,
    apiBaseUrl: 'https://api.github.test',
  }, {
    fetch: fetchImpl,
    now: () => NOW,
    ...overrides,
  });
}

function callBody(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== 'string') throw new Error('expected a JSON request body');
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

describe('GitHub App bounded API client', () => {
  it('paginates user installations with bearer auth and rejects redirects', async () => {
    const calls: FetchCall[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ url: requestUrl(input), init });
      const page = new URL(requestUrl(input)).searchParams.get('page');
      return Promise.resolve(json({
        total_count: 2,
        installations: [installation(page === '1' ? '501' : '502')],
      }));
    };
    const result = await client(fakeFetch).listUserInstallations('ghu_user-token');
    expect(result.map((entry) => entry.installationId)).toEqual(['501', '502']);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.test/user/installations?per_page=100&page=1',
      'https://api.github.test/user/installations?per_page=100&page=2',
    ]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(call.init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer ghu_user-token');
      expect(headers.get('X-GitHub-Api-Version')).toBe(GITHUB_API_VERSION);
    }
  });

  it('verifies setup installation ids through both App and user views', async () => {
    const authorizations: string[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = new URL(requestUrl(input));
      authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
      if (url.pathname === '/app/installations/501') return Promise.resolve(json(installation('501')));
      if (url.pathname === '/user/installations') {
        return Promise.resolve(json({ total_count: 1, installations: [installation('501')] }));
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const verified = await client(fakeFetch).verifyInstallation({
      userAccessToken: 'ghu_user-token',
      installationId: '501',
    });
    expect(verified.accountLogin).toBe('atoma-org');
    expect(authorizations).toContain('Bearer ghu_user-token');
    expect(authorizations.some((value) => value.startsWith('Bearer eyJ'))).toBe(true);
  });

  it('refuses an installation absent from the authenticated user view', async () => {
    const fakeFetch: typeof fetch = (input) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === '/app/installations/501') return Promise.resolve(json(installation('501')));
      return Promise.resolve(json({ total_count: 1, installations: [installation('502')] }));
    };
    await expect(client(fakeFetch).verifyInstallation({
      userAccessToken: 'ghu_user-token',
      installationId: '501',
    })).rejects.toThrow(/not accessible/);
  });

  it('mints a one-hour installation token downscoped to publish permissions', async () => {
    const calls: FetchCall[] = [];
    const expiresAt = new Date(NOW + 60 * 60 * 1_000).toISOString();
    const githubExpiresAt = expiresAt.replace('.000Z', 'Z');
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(json({
        token: 'ghs_installation-token',
        expires_at: githubExpiresAt,
        permissions: { administration: 'write', contents: 'write' },
        repository_selection: 'all',
      }, 201));
    };
    const token = await client(fakeFetch).createInstallationToken('501');
    expect(token).toMatchObject({ token: 'ghs_installation-token', expiresAt });
    expect(calls[0]?.url).toBe('https://api.github.test/app/installations/501/access_tokens');
    expect(callBody(calls[0]!)).toEqual({
      permissions: { administration: 'write', contents: 'write' },
    });
  });

  it('uses user and installation credentials on their distinct repository routes', async () => {
    const calls: FetchCall[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ url: requestUrl(input), init });
      const path = new URL(requestUrl(input)).pathname;
      return Promise.resolve(json(
        path === '/user/repos'
          ? repository('alice', 'personal-app')
          : repository('atoma-org', 'team-app'),
        201
      ));
    };
    const github = client(fakeFetch);
    await github.createUserRepository('ghu_user-token', { name: 'personal-app' });
    await github.createOrganisationRepository('ghs_installation-token', 'atoma-org', { name: 'team-app' });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/user/repos',
      '/orgs/atoma-org/repos',
    ]);
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer ghu_user-token');
    expect(new Headers(calls[1]?.init?.headers).get('Authorization')).toBe('Bearer ghs_installation-token');
    expect(callBody(calls[0]!)).toMatchObject({ private: true, auto_init: false });
  });

  it('bounds response bytes before parsing JSON', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(json({
      total_count: 0,
      installations: [],
      padding: 'x'.repeat(1_000),
    }));
    const promise = client(fakeFetch, { responseMaxBytes: 64 })
      .listUserInstallations('ghu_user-token');
    await expect(promise).rejects.toMatchObject({
      name: 'GitHubApiError',
      code: 'response_too_large',
    });
  });

  it('aborts a transport that outlives its deadline', async () => {
    const fakeFetch: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      const rejectAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
    });
    const promise = client(fakeFetch, { timeoutMs: 5 }).listUserInstallations('ghu_user-token');
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      error instanceof GitHubApiError && error.code === 'timeout'
    );
  });
});

describe('Git Data initial commit publication', () => {
  it('creates sorted blobs, one root tree/commit, and the new branch ref', async () => {
    const calls: FetchCall[] = [];
    let blob = 0;
    const fakeFetch: typeof fetch = (input, init) => {
      const call = { url: requestUrl(input), init };
      calls.push(call);
      const { pathname } = new URL(call.url);
      if (pathname.endsWith('/git/ref/heads/main')) return Promise.resolve(new Response(null, { status: 404 }));
      if (pathname.endsWith('/git/blobs')) {
        blob += 1;
        return Promise.resolve(json({ sha: blob === 1 ? SHA_A : SHA_B }, 201));
      }
      if (pathname.endsWith('/git/trees')) return Promise.resolve(json({ sha: SHA_C }, 201));
      if (pathname.endsWith('/git/commits')) return Promise.resolve(json({ sha: SHA_D }, 201));
      if (pathname.endsWith('/git/refs')) {
        return Promise.resolve(json({ ref: 'refs/heads/main', object: { sha: SHA_D } }, 201));
      }
      throw new Error(`unexpected ${pathname}`);
    };
    const result = await client(fakeFetch).publishInitialCommit({
      token: 'ghs_installation-token',
      repository: { owner: 'atoma-org', name: 'generated-app' },
      message: 'Initial commit from Atoma',
      files: [
        // Executable mode recorded by the artifact manifest must reach the
        // tree entry — it used to be hardcoded to 100644 at this last link.
        { path: 'src/z.ts', content: 'z', mode: '100755' },
        { path: 'README.md', content: '# Generated' },
      ],
    });
    expect(result).toEqual({ branch: 'main', treeSha: SHA_C, commitSha: SHA_D, ref: 'refs/heads/main' });
    const treeCall = calls.find((call) => new URL(call.url).pathname.endsWith('/git/trees'))!;
    expect(callBody(treeCall)).toEqual({
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: SHA_A },
        { path: 'src/z.ts', mode: '100755', type: 'blob', sha: SHA_B },
      ],
    });
    const commitCall = calls.find((call) => new URL(call.url).pathname.endsWith('/git/commits'))!;
    expect(callBody(commitCall)).toEqual({
      message: 'Initial commit from Atoma',
      tree: SHA_C,
      parents: [],
    });
  });

  it('fails closed before writes when the target branch already exists', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(json({ ref: 'refs/heads/main', object: { sha: SHA_A } }));
    };
    await expect(client(fakeFetch).publishInitialCommit({
      token: 'ghs_installation-token',
      repository: { owner: 'atoma-org', name: 'generated-app' },
      message: 'Initial commit',
      files: [{ path: 'README.md', content: 'hello' }],
    })).rejects.toBeInstanceOf(GitHubDivergenceError);
    expect(calls).toBe(1);
  });

  it('turns a concurrent ref creation race into explicit divergence', async () => {
    const fakeFetch: typeof fetch = (input) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith('/git/ref/heads/main')) return Promise.resolve(new Response(null, { status: 404 }));
      if (path.endsWith('/git/blobs')) return Promise.resolve(json({ sha: SHA_A }, 201));
      if (path.endsWith('/git/trees')) return Promise.resolve(json({ sha: SHA_B }, 201));
      if (path.endsWith('/git/commits')) return Promise.resolve(json({ sha: SHA_C }, 201));
      if (path.endsWith('/git/refs')) return Promise.resolve(json({ message: 'Reference already exists' }, 422));
      throw new Error(`unexpected ${path}`);
    };
    await expect(client(fakeFetch).publishInitialCommit({
      token: 'ghs_installation-token',
      repository: { owner: 'atoma-org', name: 'generated-app' },
      message: 'Initial commit',
      files: [{ path: 'README.md', content: 'hello' }],
    })).rejects.toBeInstanceOf(GitHubDivergenceError);
  });

  it('rejects workflow injection and duplicate artifact paths before network I/O', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const github = client(fakeFetch);
    await expect(github.publishInitialCommit({
      token: 'ghs_installation-token',
      repository: { owner: 'atoma-org', name: 'generated-app' },
      message: 'Initial commit',
      files: [{ path: '.github/workflows/deploy.yml', content: 'unsafe' }],
    })).rejects.toThrow(/outside/);
    await expect(github.publishInitialCommit({
      token: 'ghs_installation-token',
      repository: { owner: 'atoma-org', name: 'generated-app' },
      message: 'Initial commit',
      files: [
        { path: 'README.md', content: 'one' },
        { path: 'README.md', content: 'two' },
      ],
    })).rejects.toThrow(/duplicate/);
    expect(calls).toBe(0);
  });
});
