import type { KeyObject } from 'node:crypto';
import { canonicalGitHubId } from './config.js';
import { createGitHubAppJwt } from './crypto.js';
import type {
  GitHubInstallationTargetType,
  GitHubPermissionLevel,
  GitHubRepositorySelection,
} from './store.js';

export const GITHUB_API_VERSION = '2026-03-10';
export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024;
export const MAX_GITHUB_INSTALLATION_PAGES = 10;
export const MAX_GITHUB_INITIAL_FILES = 1_000;
export const MAX_GITHUB_INITIAL_BYTES = 20 * 1024 * 1024;

export const GITHUB_PUBLISH_PERMISSIONS = Object.freeze({
  administration: 'write',
  contents: 'write',
} as const satisfies Readonly<Record<string, GitHubPermissionLevel>>);

export interface GitHubClientConfig {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: KeyObject;
  readonly apiBaseUrl: string;
}

export interface GitHubAppClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly responseMaxBytes?: number;
  readonly now?: () => number;
}

export interface GitHubInstallationView {
  readonly installationId: string;
  readonly appId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly targetType: GitHubInstallationTargetType;
  readonly repositorySelection: GitHubRepositorySelection;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly suspended: boolean;
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly repositorySelection: GitHubRepositorySelection;
}

export interface CreateGitHubRepositoryInput {
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
}

export interface GitHubRepository {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
}

export interface GitHubInitialFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface PublishGitHubInitialCommitInput {
  readonly token: string;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly branch?: string;
  readonly message: string;
  readonly files: readonly GitHubInitialFile[];
}

export interface GitHubInitialCommit {
  readonly branch: string;
  readonly treeSha: string;
  readonly commitSha: string;
  readonly ref: string;
}

type GitHubApiErrorCode = 'http' | 'network' | 'timeout' | 'response_too_large' | 'invalid_response';

/** Safe transport error: it never includes authorization headers or response bodies. */
export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly method: string;
  readonly path: string;
  readonly code: GitHubApiErrorCode;

  constructor(input: {
    readonly status: number | null;
    readonly method: string;
    readonly path: string;
    readonly code: GitHubApiErrorCode;
  }) {
    super(
      input.status === null
        ? `GitHub API ${input.method} ${input.path} failed (${input.code})`
        : `GitHub API ${input.method} ${input.path} returned HTTP ${input.status}`
    );
    this.name = 'GitHubApiError';
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.code = input.code;
  }
}

export class GitHubDivergenceError extends Error {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;

  constructor(owner: string, repository: string, branch: string) {
    super('GitHub repository branch already exists; initial publish refused');
    this.name = 'GitHubDivergenceError';
    this.owner = owner;
    this.repository = repository;
    this.branch = branch;
  }
}

interface RequestInput {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  readonly accepted?: readonly number[];
}

interface RequestOutput {
  readonly status: number;
  readonly json: unknown;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value as Record<string, unknown>;
}

function responseString(value: unknown, label: string, max = 4096): string {
  const hasControl = typeof value === 'string' && [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (typeof value !== 'string' || !value || value.length > max || hasControl) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function responseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} has an invalid value`);
  return value;
}

function repositoryName(value: string): string {
  if (
    value === '.' ||
    value === '..' ||
    value.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error('GitHub repository name has an invalid value');
  }
  return value;
}

function ownerLogin(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(value)) {
    throw new Error('GitHub owner login has an invalid value');
  }
  return value;
}

function branchName(value: string): string {
  if (
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    throw new Error('GitHub branch name has an invalid value');
  }
  return value;
}

function safeToken(value: string): string {
  const printableAscii = [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 33 && code <= 126;
  });
  if (value.length < 1 || value.length > 16_384 || !printableAscii) {
    throw new Error('GitHub bearer token has an invalid format');
  }
  return value;
}

function permissions(value: unknown): Readonly<Record<string, GitHubPermissionLevel>> {
  const object = asObject(value, 'GitHub permissions');
  if (Object.keys(object).length > 100) throw new Error('GitHub permissions have an invalid shape');
  const normalized: Record<string, GitHubPermissionLevel> = {};
  for (const [name, level] of Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(name) || (level !== 'read' && level !== 'write')) {
      throw new Error('GitHub permissions have an invalid value');
    }
    normalized[name] = level;
  }
  return Object.freeze(normalized);
}

function repositorySelection(value: unknown): GitHubRepositorySelection {
  if (value !== 'all' && value !== 'selected') {
    throw new Error('GitHub repository selection has an invalid value');
  }
  return value;
}

function parseInstallation(value: unknown): GitHubInstallationView {
  const object = asObject(value, 'GitHub installation');
  const account = asObject(object['account'], 'GitHub installation account');
  const targetType = object['target_type'] ?? account['type'];
  if (targetType !== 'User' && targetType !== 'Organization') {
    throw new Error('GitHub installation target type has an invalid value');
  }
  const suspendedAt = object['suspended_at'];
  if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== 'string') {
    throw new Error('GitHub installation suspension has an invalid value');
  }
  return Object.freeze({
    installationId: canonicalGitHubId(object['id'], 'GitHub installation id'),
    appId: canonicalGitHubId(object['app_id'], 'GitHub App id'),
    accountId: canonicalGitHubId(account['id'], 'GitHub account id'),
    accountLogin: responseString(account['login'], 'GitHub account login', 100),
    targetType,
    repositorySelection: repositorySelection(object['repository_selection']),
    permissions: permissions(object['permissions']),
    suspended: suspendedAt !== null && suspendedAt !== undefined,
  });
}

function parseRepository(value: unknown): GitHubRepository {
  const object = asObject(value, 'GitHub repository');
  const owner = asObject(object['owner'], 'GitHub repository owner');
  const name = repositoryName(responseString(object['name'], 'GitHub repository name', 100));
  const ownerName = ownerLogin(responseString(owner['login'], 'GitHub repository owner', 100));
  const fullName = responseString(object['full_name'], 'GitHub repository full name', 201);
  if (fullName.toLowerCase() !== `${ownerName}/${name}`.toLowerCase()) {
    throw new Error('GitHub repository identity is inconsistent');
  }
  const htmlUrl = responseString(object['html_url'], 'GitHub repository URL', 2048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(htmlUrl);
  } catch {
    throw new Error('GitHub repository URL has an invalid value');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('GitHub repository URL has an invalid value');
  return Object.freeze({
    id: canonicalGitHubId(object['id'], 'GitHub repository id'),
    owner: ownerName,
    name,
    fullName,
    defaultBranch: branchName(responseString(object['default_branch'], 'GitHub default branch', 255)),
    private: responseBoolean(object['private'], 'GitHub repository visibility'),
    htmlUrl: parsedUrl.toString(),
  });
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function filePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('GitHub artifact path has an invalid value');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')) {
    throw new Error('GitHub artifact path has an invalid value');
  }
  if (segments[0]?.toLowerCase() === '.github' && segments[1]?.toLowerCase() === 'workflows') {
    throw new Error('GitHub workflow files are outside the initial publish scope');
  }
  return value;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export class GitHubAppClient {
  private readonly config: GitHubClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly responseMaxBytes: number;
  private readonly now: () => number;

  constructor(config: GitHubClientConfig, options: GitHubAppClientOptions = {}) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(config.appSlug)) {
      throw new Error('GitHub App slug has an invalid value');
    }
    this.config = Object.freeze({
      appId: canonicalGitHubId(config.appId, 'GitHub App id'),
      appSlug: responseString(config.appSlug, 'GitHub App slug', 100),
      privateKey: config.privateKey,
      apiBaseUrl: config.apiBaseUrl.replace(/\/$/, ''),
    });
    const parsedBase = new URL(this.config.apiBaseUrl);
    const loopback = parsedBase.hostname === 'localhost' || parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === '::1';
    if (parsedBase.protocol !== 'https:' && !(parsedBase.protocol === 'http:' && loopback)) {
      throw new Error('GitHub API base URL must use HTTPS (HTTP is allowed only on loopback)');
    }
    if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
      throw new Error('GitHub API base URL has an invalid value');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
    this.responseMaxBytes = options.responseMaxBytes ?? DEFAULT_GITHUB_RESPONSE_MAX_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('GitHub request timeout must be between 1 and 60000 milliseconds');
    }
    if (!Number.isSafeInteger(this.responseMaxBytes) || this.responseMaxBytes < 1 || this.responseMaxBytes > 10 * 1024 * 1024) {
      throw new Error('GitHub response limit must be between 1 byte and 10 MiB');
    }
    this.now = options.now ?? Date.now;
  }

  private appJwt(): string {
    return createGitHubAppJwt({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      now: this.now(),
    });
  }

  private async readJson(response: Response, method: string, path: string): Promise<unknown> {
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > this.responseMaxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The response is already rejected by its byte count.
          }
          throw new GitHubApiError({
            status: response.status,
            method,
            path,
            code: 'response_too_large',
          });
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (length === 0) return null;
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new GitHubApiError({
        status: response.status,
        method,
        path,
        code: 'invalid_response',
      });
    }
  }

  private async request(input: RequestInput): Promise<RequestOutput> {
    const method = input.method ?? 'GET';
    if (!input.path.startsWith('/') || input.path.startsWith('//')) {
      throw new Error('GitHub API request path must be relative to the configured API');
    }
    const token = safeToken(input.token);
    const accepted = input.accepted ?? (method === 'POST' ? [201] : [200]);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > 30 * 1024 * 1024) {
      throw new Error('GitHub API request body exceeds the configured publish bound');
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${input.path}`, {
        method,
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `atoma-${this.config.appSlug}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new GitHubApiError({
        status: null,
        method,
        path: input.path,
        code: signal.aborted ? 'timeout' : 'network',
      });
    }
    if (!accepted.includes(response.status)) {
      try {
        await response.body?.cancel();
      } catch {
        // The status is authoritative; failure to cancel a diagnostic body is irrelevant.
      }
      throw new GitHubApiError({
        status: response.status,
        method,
        path: input.path,
        code: 'http',
      });
    }
    return Object.freeze({
      status: response.status,
      json: await this.readJson(response, method, input.path),
    });
  }

  async listUserInstallations(userAccessToken: string): Promise<readonly GitHubInstallationView[]> {
    const installations: GitHubInstallationView[] = [];
    for (let page = 1; page <= MAX_GITHUB_INSTALLATION_PAGES; page += 1) {
      const result = await this.request({
        token: userAccessToken,
        path: `/user/installations?per_page=100&page=${page}`,
      });
      const object = asObject(result.json, 'GitHub user installations response');
      if (!Array.isArray(object['installations'])) {
        throw new Error('GitHub user installations response has an invalid shape');
      }
      const pageInstallations = object['installations'].map(parseInstallation);
      installations.push(...pageInstallations);
      const totalCount = object['total_count'];
      if (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0) {
        throw new Error('GitHub user installations count has an invalid value');
      }
      if (installations.length >= (totalCount as number)) return Object.freeze(installations);
      if (pageInstallations.length === 0) {
        throw new Error('GitHub user installations pagination ended before total_count');
      }
    }
    throw new Error(`GitHub user installations exceed the ${MAX_GITHUB_INSTALLATION_PAGES}-page safety bound`);
  }

  async getAppInstallation(installationId: string): Promise<GitHubInstallationView> {
    const id = canonicalGitHubId(installationId, 'GitHub installation id');
    const result = await this.request({
      token: this.appJwt(),
      path: `/app/installations/${id}`,
    });
    const installation = parseInstallation(result.json);
    if (installation.installationId !== id || installation.appId !== this.config.appId) {
      throw new Error('GitHub installation does not belong to the configured App');
    }
    return installation;
  }

  /** Verify setup_url's untrusted installation_id through both App and user views. */
  async verifyInstallation(input: {
    readonly userAccessToken: string;
    readonly installationId: string;
  }): Promise<GitHubInstallationView> {
    const installationId = canonicalGitHubId(input.installationId, 'GitHub installation id');
    const [appInstallation, userInstallations] = await Promise.all([
      this.getAppInstallation(installationId),
      this.listUserInstallations(input.userAccessToken),
    ]);
    const userInstallation = userInstallations.find((candidate) => candidate.installationId === installationId);
    if (
      !userInstallation ||
      userInstallation.appId !== this.config.appId ||
      userInstallation.accountId !== appInstallation.accountId ||
      userInstallation.accountLogin !== appInstallation.accountLogin ||
      userInstallation.targetType !== appInstallation.targetType ||
      userInstallation.repositorySelection !== appInstallation.repositorySelection
    ) {
      throw new Error('GitHub installation is not accessible to the authenticated user');
    }
    return appInstallation;
  }

  async createInstallationToken(installationId: string): Promise<GitHubInstallationToken> {
    const id = canonicalGitHubId(installationId, 'GitHub installation id');
    const result = await this.request({
      method: 'POST',
      token: this.appJwt(),
      path: `/app/installations/${id}/access_tokens`,
      body: { permissions: GITHUB_PUBLISH_PERMISSIONS },
    });
    const object = asObject(result.json, 'GitHub installation token response');
    const token = safeToken(responseString(object['token'], 'GitHub installation token', 16_384));
    const expiresAt = responseString(object['expires_at'], 'GitHub installation token expiry', 64);
    const expiry = new Date(expiresAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiresAt) ||
      !Number.isFinite(expiry.getTime()) ||
      expiry.getTime() <= this.now()
    ) {
      throw new Error('GitHub installation token expiry has an invalid value');
    }
    const grantedPermissions = permissions(object['permissions']);
    if (
      grantedPermissions['administration'] !== 'write' ||
      grantedPermissions['contents'] !== 'write'
    ) {
      throw new Error('GitHub installation token lacks required publish permissions');
    }
    return Object.freeze({
      token,
      expiresAt: expiry.toISOString(),
      permissions: grantedPermissions,
      repositorySelection: repositorySelection(object['repository_selection']),
    });
  }

  private async createRepository(
    path: string,
    token: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    const name = repositoryName(input.name);
    const description = input.description ?? '';
    const descriptionHasControl = [...description].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
    if (description.length > 350 || descriptionHasControl) {
      throw new Error('GitHub repository description has an invalid value');
    }
    const result = await this.request({
      method: 'POST',
      path,
      token,
      body: {
        name,
        description,
        private: input.private ?? true,
        auto_init: false,
      },
    });
    return parseRepository(result.json);
  }

  async createUserRepository(
    userAccessToken: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    return this.createRepository('/user/repos', userAccessToken, input);
  }

  async createOrganisationRepository(
    installationToken: string,
    organisation: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    const owner = ownerLogin(organisation);
    return this.createRepository(`/orgs/${encodeSegment(owner)}/repos`, installationToken, input);
  }

  /**
   * Resolve an existing repository's identity. 404 is null (the caller's
   * idempotent-create path), any other status is a transport error.
   */
  async getRepository(
    token: string,
    owner: string,
    repository: string
  ): Promise<GitHubRepository | null> {
    const safeOwner = ownerLogin(owner);
    const safeRepository = repositoryName(repository);
    const result = await this.request({
      token,
      path: `/repos/${encodeSegment(safeOwner)}/${encodeSegment(safeRepository)}`,
      accepted: [200, 404],
    });
    if (result.status === 404) return null;
    return parseRepository(result.json);
  }

  async getReference(
    token: string,
    owner: string,
    repository: string,
    branch: string
  ): Promise<string | null> {
    const safeOwner = ownerLogin(owner);
    const safeRepository = repositoryName(repository);
    const safeBranch = branchName(branch);
    const path = `/repos/${encodeSegment(safeOwner)}/${encodeSegment(safeRepository)}/git/ref/heads/${safeBranch.split('/').map(encodeSegment).join('/')}`;
    const result = await this.request({ token, path, accepted: [200, 404, 409] });
    if (result.status === 404 || result.status === 409) return null;
    const object = asObject(result.json, 'GitHub reference response');
    const target = asObject(object['object'], 'GitHub reference target');
    return sha(target['sha'], 'GitHub reference sha');
  }

  async createBlob(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly content: string | Uint8Array;
  }): Promise<string> {
    const bytes = typeof input.content === 'string'
      ? Buffer.from(input.content, 'utf8')
      : Buffer.from(input.content);
    if (bytes.length > MAX_GITHUB_INITIAL_BYTES) {
      throw new Error('GitHub blob exceeds the initial publish byte bound');
    }
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'blobs'),
      body: {
        content: bytes.toString('base64'),
        encoding: 'base64',
      },
    });
    return sha(asObject(result.json, 'GitHub blob response')['sha'], 'GitHub blob sha');
  }

  async createTree(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly entries: readonly { readonly path: string; readonly sha: string }[];
  }): Promise<string> {
    if (input.entries.length < 1 || input.entries.length > MAX_GITHUB_INITIAL_FILES) {
      throw new Error('GitHub tree has an invalid number of entries');
    }
    const seen = new Set<string>();
    const tree = input.entries.map((entry) => {
      const path = filePath(entry.path);
      if (seen.has(path)) throw new Error('GitHub tree contains duplicate paths');
      seen.add(path);
      return { path, mode: '100644', type: 'blob', sha: sha(entry.sha, 'GitHub blob sha') };
    });
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'trees'),
      body: { tree },
    });
    return sha(asObject(result.json, 'GitHub tree response')['sha'], 'GitHub tree sha');
  }

  async createCommit(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly message: string;
    readonly treeSha: string;
  }): Promise<string> {
    if (!input.message.trim() || input.message.length > 65_536 || input.message.includes('\u0000')) {
      throw new Error('GitHub commit message has an invalid value');
    }
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'commits'),
      body: { message: input.message, tree: sha(input.treeSha, 'GitHub tree sha'), parents: [] },
    });
    return sha(asObject(result.json, 'GitHub commit response')['sha'], 'GitHub commit sha');
  }

  async createReference(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly commitSha: string;
  }): Promise<string> {
    const branch = branchName(input.branch);
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'refs'),
      body: { ref: `refs/heads/${branch}`, sha: sha(input.commitSha, 'GitHub commit sha') },
    });
    const object = asObject(result.json, 'GitHub reference response');
    const ref = responseString(object['ref'], 'GitHub reference', 512);
    if (ref !== `refs/heads/${branch}`) throw new Error('GitHub created an unexpected reference');
    return ref;
  }

  async publishInitialCommit(input: PublishGitHubInitialCommitInput): Promise<GitHubInitialCommit> {
    const owner = ownerLogin(input.repository.owner);
    const repository = repositoryName(input.repository.name);
    const branch = branchName(input.branch ?? 'main');
    if (input.files.length < 1 || input.files.length > MAX_GITHUB_INITIAL_FILES) {
      throw new Error('GitHub initial publish has an invalid number of files');
    }
    const files = input.files.map((file) => ({
      path: filePath(file.path),
      content: file.content,
      bytes: typeof file.content === 'string'
        ? Buffer.byteLength(file.content, 'utf8')
        : file.content.byteLength,
    })).sort((left, right) => left.path.localeCompare(right.path));
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      if (seen.has(file.path)) throw new Error('GitHub initial publish contains duplicate paths');
      seen.add(file.path);
      totalBytes += file.bytes;
      if (totalBytes > MAX_GITHUB_INITIAL_BYTES) {
        throw new Error('GitHub initial publish exceeds the byte bound');
      }
    }
    const existing = await this.getReference(input.token, owner, repository, branch);
    if (existing !== null) throw new GitHubDivergenceError(owner, repository, branch);

    const entries: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      entries.push({
        path: file.path,
        sha: await this.createBlob({
          token: input.token,
          owner,
          repository,
          content: file.content,
        }),
      });
    }
    const treeSha = await this.createTree({ token: input.token, owner, repository, entries });
    const commitSha = await this.createCommit({
      token: input.token,
      owner,
      repository,
      message: input.message,
      treeSha,
    });
    let ref: string;
    try {
      ref = await this.createReference({
        token: input.token,
        owner,
        repository,
        branch,
        commitSha,
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        throw new GitHubDivergenceError(owner, repository, branch);
      }
      throw error;
    }
    return Object.freeze({ branch, treeSha, commitSha, ref });
  }

  private gitPath(owner: string, repository: string, object: string): string {
    return `/repos/${encodeSegment(ownerLogin(owner))}/${encodeSegment(repositoryName(repository))}/git/${object}`;
  }
}
