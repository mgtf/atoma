import { createHash, createPrivateKey, createSecretKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const GITHUB_APP_ENV = Object.freeze({
  appId: 'ATOMA_GITHUB_APP_ID',
  appSlug: 'ATOMA_GITHUB_APP_SLUG',
  privateKey: 'ATOMA_GITHUB_APP_PRIVATE_KEY',
  privateKeyPath: 'ATOMA_GITHUB_APP_PRIVATE_KEY_PATH',
  webhookSecret: 'ATOMA_GITHUB_WEBHOOK_SECRET',
  tokenEncryptionKey: 'ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY',
  tokenEncryptionKeyId: 'ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY_ID',
  apiUrl: 'ATOMA_GITHUB_API_URL',
  oauthClientId: 'ATOMA_AUTH_GITHUB_CLIENT_ID',
  oauthClientSecret: 'ATOMA_AUTH_GITHUB_CLIENT_SECRET',
  legacyOauthClientId: 'GITHUB_CLIENT_ID',
  legacyOauthClientSecret: 'GITHUB_CLIENT_SECRET',
} as const);

export interface GitHubOauthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Immutable launch-time configuration. Key objects deliberately hide raw key bytes. */
export interface GitHubAppConfig extends GitHubOauthCredentials {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: KeyObject;
  readonly webhookSecret: string;
  readonly tokenEncryptionKey: KeyObject;
  readonly tokenEncryptionKeyId: string;
  readonly apiBaseUrl: string;
}

export interface GitHubAppConfigOptions {
  /** Pass the GitHub identity provider snapshot so both flows use one client. */
  readonly oauth?: GitHubOauthCredentials;
  /** Injectable only to make launch-time path loading deterministic in tests. */
  readonly readFile?: (path: string) => string | Buffer;
}

const MAX_GITHUB_ID = 9_223_372_036_854_775_807n;
const MAX_SECRET_LENGTH = 16_384;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/** GitHub integers cross JSON/SQLite boundaries as canonical decimal strings. */
export function canonicalGitHubId(value: unknown, label = 'GitHub id'): string {
  let canonical: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer or canonical decimal string`);
    }
    canonical = String(value);
  } else if (typeof value === 'bigint') {
    if (value <= 0n) throw new Error(`${label} must be positive`);
    canonical = value.toString();
  } else if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) {
    canonical = value;
  } else {
    throw new Error(`${label} must be a canonical positive decimal string`);
  }
  if (BigInt(canonical) > MAX_GITHUB_ID) {
    throw new Error(`${label} is outside GitHub's supported integer range`);
  }
  return canonical;
}

function requiredText(value: string | undefined, name: string, max = MAX_SECRET_LENGTH): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  if (trimmed.length > max || hasControlCharacters(trimmed)) {
    throw new Error(`${name} has an invalid value`);
  }
  return trimmed;
}

function credential(
  env: NodeJS.ProcessEnv,
  preferred: string,
  legacy: string
): string | undefined {
  return env[preferred] !== undefined ? env[preferred] : env[legacy];
}

function parsePrivateKey(pem: string | Buffer, sourceName: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`${sourceName} must contain a valid PEM private key`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`${sourceName} must contain an RSA private key`);
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (modulusLength !== undefined && modulusLength < 2048) {
    throw new Error(`${sourceName} must contain an RSA key of at least 2048 bits`);
  }
  return key;
}

function parseEncryptionKey(raw: string): Buffer {
  const value = requiredText(raw, GITHUB_APP_ENV.tokenEncryptionKey, 256);
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = Buffer.from(value, 'hex');
  } else {
    const payload = value.startsWith('base64url:') ? value.slice('base64url:'.length) : value;
    if (!/^[A-Za-z0-9_-]{43}$/.test(payload)) {
      throw new Error(
        `${GITHUB_APP_ENV.tokenEncryptionKey} must be 32 bytes encoded as 64 hex characters or canonical unpadded base64url`
      );
    }
    bytes = Buffer.from(payload, 'base64url');
  }
  if (bytes.length !== 32) {
    throw new Error(`${GITHUB_APP_ENV.tokenEncryptionKey} must decode to exactly 32 bytes`);
  }
  return bytes;
}

function apiBaseUrl(raw: string | undefined): string {
  const configured = raw?.trim() || 'https://api.github.com';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${GITHUB_APP_ENV.apiUrl} must be an absolute URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${GITHUB_APP_ENV.apiUrl} must use HTTPS (HTTP is allowed only on loopback)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${GITHUB_APP_ENV.apiUrl} must not include credentials, a query, or a fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Resolve all GitHub App inputs once. No method in the GitHub subsystem reads
 * process.env again, so one server process cannot mix credential generations.
 */
export function snapshotGitHubAppConfig(
  env: NodeJS.ProcessEnv,
  options: GitHubAppConfigOptions = {}
): GitHubAppConfig {
  const appId = canonicalGitHubId(requiredText(env[GITHUB_APP_ENV.appId], GITHUB_APP_ENV.appId), GITHUB_APP_ENV.appId);
  const appSlug = requiredText(env[GITHUB_APP_ENV.appSlug], GITHUB_APP_ENV.appSlug, 100);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(appSlug)) {
    throw new Error(`${GITHUB_APP_ENV.appSlug} must be a lowercase GitHub App slug`);
  }

  const inlineKeyPresent = env[GITHUB_APP_ENV.privateKey] !== undefined;
  const pathKeyPresent = env[GITHUB_APP_ENV.privateKeyPath] !== undefined;
  if (inlineKeyPresent === pathKeyPresent) {
    throw new Error(
      `configure exactly one of ${GITHUB_APP_ENV.privateKey} and ${GITHUB_APP_ENV.privateKeyPath}`
    );
  }
  const readFile = options.readFile ?? ((path: string): Buffer => readFileSync(path));
  let privateKeySource: string | Buffer;
  let privateKeySourceName: string;
  if (inlineKeyPresent) {
    const inlineKey = env[GITHUB_APP_ENV.privateKey]?.trim();
    if (!inlineKey || inlineKey.length > 64 * 1024 || inlineKey.includes('\u0000')) {
      throw new Error(`${GITHUB_APP_ENV.privateKey} has an invalid value`);
    }
    privateKeySource = inlineKey.replace(/\\n/g, '\n');
    privateKeySourceName = GITHUB_APP_ENV.privateKey;
  } else {
    const path = requiredText(env[GITHUB_APP_ENV.privateKeyPath], GITHUB_APP_ENV.privateKeyPath, 4096);
    try {
      privateKeySource = readFile(path);
    } catch {
      throw new Error(`${GITHUB_APP_ENV.privateKeyPath} could not be read`);
    }
    privateKeySourceName = GITHUB_APP_ENV.privateKeyPath;
  }
  const privateKey = parsePrivateKey(privateKeySource, privateKeySourceName);

  const oauth = options.oauth ?? {
    clientId: requiredText(
      credential(env, GITHUB_APP_ENV.oauthClientId, GITHUB_APP_ENV.legacyOauthClientId),
      GITHUB_APP_ENV.oauthClientId,
      512
    ),
    clientSecret: requiredText(
      credential(env, GITHUB_APP_ENV.oauthClientSecret, GITHUB_APP_ENV.legacyOauthClientSecret),
      GITHUB_APP_ENV.oauthClientSecret,
      2048
    ),
  };
  const clientId = requiredText(oauth.clientId, 'GitHub OAuth client id', 512);
  const clientSecret = requiredText(oauth.clientSecret, 'GitHub OAuth client secret', 2048);
  const webhookSecret = requiredText(env[GITHUB_APP_ENV.webhookSecret], GITHUB_APP_ENV.webhookSecret, 4096);
  if (Buffer.byteLength(webhookSecret, 'utf8') < 32) {
    throw new Error(`${GITHUB_APP_ENV.webhookSecret} must contain at least 32 bytes`);
  }

  const encryptionBytes = parseEncryptionKey(
    requiredText(env[GITHUB_APP_ENV.tokenEncryptionKey], GITHUB_APP_ENV.tokenEncryptionKey, 256)
  );
  const derivedKeyId = createHash('sha256').update(encryptionBytes).digest('base64url').slice(0, 16);
  const tokenEncryptionKeyId = env[GITHUB_APP_ENV.tokenEncryptionKeyId] === undefined
    ? derivedKeyId
    : requiredText(env[GITHUB_APP_ENV.tokenEncryptionKeyId], GITHUB_APP_ENV.tokenEncryptionKeyId, 64);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(tokenEncryptionKeyId)) {
    throw new Error(`${GITHUB_APP_ENV.tokenEncryptionKeyId} has an invalid value`);
  }
  const tokenEncryptionKey = createSecretKey(encryptionBytes);
  encryptionBytes.fill(0);

  return Object.freeze({
    appId,
    appSlug,
    clientId,
    clientSecret,
    privateKey,
    webhookSecret,
    tokenEncryptionKey,
    tokenEncryptionKeyId,
    apiBaseUrl: apiBaseUrl(env[GITHUB_APP_ENV.apiUrl]),
  });
}
