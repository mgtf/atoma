/**
 * LOGIN PROVIDER REGISTRY — identity registry, never a billing registry.
 *
 * The registry is resolved exclusively from the environment snapshot supplied
 * by the caller. It never reads process.env itself, so a long-lived server can
 * keep one immutable provider configuration for its whole lifetime.
 *
 * ATOMA_AUTH_* credential names are canonical. The unprefixed names remain as
 * compatibility fallbacks for existing deployments, but an explicitly present
 * ATOMA_AUTH_* value (including an empty one) always wins.
 */

export type ProviderId = 'github' | 'google' | 'chatgpt';

export interface ProviderConfig {
  readonly id: ProviderId;
  readonly label: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  /** Authorization endpoint (browser-facing redirect target). */
  readonly authorizeUrl: string;
  /** Token endpoint (server-to-server code exchange). */
  readonly tokenUrl: string;
  /** Userinfo endpoint returning the stable subject claim. */
  readonly userinfoUrl: string;
  /**
   * Space-separated scopes requested at authorization. An empty string means
   * the parameter is omitted: GitHub Apps derive access from configured App
   * permissions and do not use OAuth App scopes.
   */
  readonly scope: string;
  /** GitHub exposes an OAuth2 profile; Google and ChatGPT expose OIDC claims. */
  readonly protocol: 'openid' | 'oauth2';
}

export type ProviderConfigurationIssue =
  | 'incomplete_credentials'
  | 'orphaned_endpoint_override'
  | 'invalid_endpoint';

export interface ProviderConfigurationDiagnostic {
  readonly provider: ProviderId;
  readonly issue: ProviderConfigurationIssue;
  /** Safe to show to an operator: contains variable names, never values. */
  readonly message: string;
}

/** A data-only, immutable view detached from subsequent env mutations. */
export interface ProviderRegistrySnapshot {
  readonly providers: readonly ProviderConfig[];
  readonly diagnostics: readonly ProviderConfigurationDiagnostic[];
}

type EndpointKind = 'authorize' | 'token' | 'userinfo';

interface StaticProviderShape {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultAuthorizeUrl: string;
  readonly defaultTokenUrl: string;
  readonly defaultUserinfoUrl: string;
  readonly defaultScope: string;
  readonly protocol: 'openid' | 'oauth2';
  /** Confidential web clients require both values; ChatGPT currently uses PKCE. */
  readonly requiresClientSecret: boolean;
  readonly preferredClientIdEnv: string;
  readonly preferredClientSecretEnv: string;
  readonly legacyClientIdEnv: string;
  readonly legacyClientSecretEnv: string;
  readonly endpointEnv: Readonly<Record<EndpointKind, string>>;
}

const SHAPES: readonly StaticProviderShape[] = [
  {
    id: 'github',
    label: 'GitHub',
    defaultAuthorizeUrl: 'https://github.com/login/oauth/authorize',
    defaultTokenUrl: 'https://github.com/login/oauth/access_token',
    defaultUserinfoUrl: 'https://api.github.com/user',
    defaultScope: '',
    protocol: 'oauth2',
    requiresClientSecret: true,
    preferredClientIdEnv: 'ATOMA_AUTH_GITHUB_CLIENT_ID',
    preferredClientSecretEnv: 'ATOMA_AUTH_GITHUB_CLIENT_SECRET',
    legacyClientIdEnv: 'GITHUB_CLIENT_ID',
    legacyClientSecretEnv: 'GITHUB_CLIENT_SECRET',
    endpointEnv: {
      authorize: 'ATOMA_AUTH_GITHUB_AUTHORIZE_URL',
      token: 'ATOMA_AUTH_GITHUB_TOKEN_URL',
      userinfo: 'ATOMA_AUTH_GITHUB_USERINFO_URL',
    },
  },
  {
    id: 'google',
    label: 'Google',
    defaultAuthorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    defaultTokenUrl: 'https://oauth2.googleapis.com/token',
    defaultUserinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    defaultScope: 'openid email profile',
    protocol: 'openid',
    requiresClientSecret: true,
    preferredClientIdEnv: 'ATOMA_AUTH_GOOGLE_CLIENT_ID',
    preferredClientSecretEnv: 'ATOMA_AUTH_GOOGLE_CLIENT_SECRET',
    legacyClientIdEnv: 'GOOGLE_CLIENT_ID',
    legacyClientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    endpointEnv: {
      authorize: 'ATOMA_AUTH_GOOGLE_AUTHORIZE_URL',
      token: 'ATOMA_AUTH_GOOGLE_TOKEN_URL',
      userinfo: 'ATOMA_AUTH_GOOGLE_USERINFO_URL',
    },
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // Current Sign in with ChatGPT discovery endpoints. Keep the overrides
    // below available because this identity surface can evolve independently
    // from the OpenAI API endpoints used for model inference.
    defaultAuthorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
    defaultTokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
    defaultUserinfoUrl: 'https://auth.openai.com/api/accounts/oauth/userinfo',
    defaultScope: 'openid profile email',
    protocol: 'openid',
    requiresClientSecret: false,
    preferredClientIdEnv: 'ATOMA_AUTH_CHATGPT_CLIENT_ID',
    preferredClientSecretEnv: 'ATOMA_AUTH_CHATGPT_CLIENT_SECRET',
    legacyClientIdEnv: 'CHATGPT_CLIENT_ID',
    legacyClientSecretEnv: 'CHATGPT_CLIENT_SECRET',
    endpointEnv: {
      authorize: 'ATOMA_AUTH_CHATGPT_AUTHORIZE_URL',
      token: 'ATOMA_AUTH_CHATGPT_TOKEN_URL',
      userinfo: 'ATOMA_AUTH_CHATGPT_USERINFO_URL',
    },
  },
];

/** Resolve the complete provider registry once from an explicit env snapshot. */
export function snapshotProviderRegistry(env: NodeJS.ProcessEnv): ProviderRegistrySnapshot {
  const providers: ProviderConfig[] = [];
  const diagnostics: ProviderConfigurationDiagnostic[] = [];

  for (const shape of SHAPES) {
    const resolved = resolveProvider(shape, env);
    if (resolved.provider) providers.push(resolved.provider);
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
  }

  return Object.freeze({
    providers: Object.freeze(providers),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  });
}

export function providerFromEnv(id: ProviderId, env: NodeJS.ProcessEnv): ProviderConfig | null {
  const shape = SHAPES.find((candidate) => candidate.id === id);
  return shape ? resolveProvider(shape, env).provider : null;
}

/**
 * Every fully configured provider in stable registration order. Invalid or
 * partial entries are absent; use snapshotProviderRegistry for diagnostics.
 */
export function configuredProviders(env: NodeJS.ProcessEnv): ProviderConfig[] {
  return [...snapshotProviderRegistry(env).providers];
}

export function providerById(id: string, env: NodeJS.ProcessEnv): ProviderConfig | null {
  if (!isProviderId(id)) return null;
  return providerFromEnv(id, env);
}

/** Resolve an id without consulting a possibly mutated environment again. */
export function providerByIdFromSnapshot(
  id: string,
  snapshot: ProviderRegistrySnapshot
): ProviderConfig | null {
  if (!isProviderId(id)) return null;
  return snapshot.providers.find((provider) => provider.id === id) ?? null;
}

function resolveProvider(
  shape: StaticProviderShape,
  env: NodeJS.ProcessEnv
): { provider: ProviderConfig | null; diagnostic: ProviderConfigurationDiagnostic | null } {
  const clientId = credential(env, shape.preferredClientIdEnv, shape.legacyClientIdEnv);
  const clientSecret = credential(
    env,
    shape.preferredClientSecretEnv,
    shape.legacyClientSecretEnv
  );
  const endpointOverridePresent = Object.values(shape.endpointEnv).some(
    (name) => env[name] !== undefined
  );

  if (!clientId) {
    if (!clientSecret && !endpointOverridePresent) return { provider: null, diagnostic: null };
    return {
      provider: null,
      diagnostic: {
        provider: shape.id,
        issue: clientSecret ? 'incomplete_credentials' : 'orphaned_endpoint_override',
        message: clientSecret
          ? `${shape.preferredClientIdEnv} is required when a client secret is configured`
          : `${shape.preferredClientIdEnv} is required when provider endpoints are overridden`,
      },
    };
  }

  if (shape.requiresClientSecret && !clientSecret) {
    return {
      provider: null,
      diagnostic: {
        provider: shape.id,
        issue: 'incomplete_credentials',
        message: `${shape.preferredClientIdEnv} and ${shape.preferredClientSecretEnv} must both be configured for a web OAuth client`,
      },
    };
  }

  const endpoints: Record<EndpointKind, string> = {
    authorize: endpoint(env, shape.endpointEnv.authorize, shape.defaultAuthorizeUrl),
    token: endpoint(env, shape.endpointEnv.token, shape.defaultTokenUrl),
    userinfo: endpoint(env, shape.endpointEnv.userinfo, shape.defaultUserinfoUrl),
  };

  for (const kind of ['authorize', 'token', 'userinfo'] as const) {
    const problem = authUrlProblem(endpoints[kind]);
    if (problem) {
      return {
        provider: null,
        diagnostic: {
          provider: shape.id,
          issue: 'invalid_endpoint',
          message: `${shape.endpointEnv[kind]} ${problem}`,
        },
      };
    }
  }

  return {
    provider: Object.freeze({
      id: shape.id,
      label: shape.label,
      clientId,
      clientSecret,
      authorizeUrl: endpoints.authorize,
      tokenUrl: endpoints.token,
      userinfoUrl: endpoints.userinfo,
      scope: shape.defaultScope,
      protocol: shape.protocol,
    }),
    diagnostic: null,
  };
}

function credential(env: NodeJS.ProcessEnv, preferredName: string, legacyName: string): string | null {
  const raw = env[preferredName] !== undefined ? env[preferredName] : env[legacyName];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function endpoint(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined ? fallback : raw.trim();
}

function authUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  if (url.hash) return 'must not contain a fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'must use HTTPS (plain HTTP is allowed only for loopback hosts)';
}

/**
 * A host that can only ever mean THIS machine.
 *
 * Exported because three subsystems ask the same question and each had written
 * its own answer: this file's HTTPS exemption, the gate's public-origin rule,
 * and the preview's development-runtime carve-out. The bracketed IPv6 form is
 * what `URL.hostname` actually returns, so it is what the comparison uses.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

/** The same question about a whole origin. An unparseable one is not loopback. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    // Consistent with `previewDomainCollides`: a string we cannot parse is
    // never treated as proof of safety.
    return false;
  }
}

function isProviderId(id: string): id is ProviderId {
  return id === 'github' || id === 'google' || id === 'chatgpt';
}
