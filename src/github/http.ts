import type { IncomingMessage } from 'node:http';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { eventLabel } from '../contracts/platformEvents.js';
import type { ProviderConfig } from '../auth/providers.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchProviderIdentity,
  newPkcePair,
} from '../auth/oidc.js';
import type { Viewer } from '../auth/store.js';
import { roleAtLeast } from '../projects/service.js';
import type { GitHubAppClient, GitHubInstallationView } from './client.js';
import type { GitHubAppConfig } from './config.js';
import { canonicalGitHubId } from './config.js';
import {
  GitHubInstallationCrossOrgError,
  GITHUB_CONNECT_STATE_TTL_MAX_MS,
  newGitHubConnectState,
  TooManyPendingGitHubConnectStatesError,
  type GitHubStore,
} from './store.js';
import { persistGitHubUserTokens } from './tokens.js';
import { githubAppInstallUrl } from './urls.js';
import {
  GitHubWebhookError,
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  processGitHubWebhook,
} from './webhook.js';

export { GITHUB_WEBHOOK_MAX_BODY_BYTES };

export const GITHUB_COPY = Object.freeze({
  notConfigured: 'GitHub App is not configured on this deployment.',
  authenticationRequired: 'Sign in before connecting GitHub.',
  adminRequired: 'org:admin role or above is required to connect GitHub.',
  invalidState: 'Missing or invalid GitHub connect state.',
  expiredState: 'GitHub connect transaction expired or was replayed — start again.',
  invalidInstallation: 'Missing or invalid GitHub installation id.',
  linkFailed: 'GitHub installation could not be linked to this organisation.',
  alreadyLinked: 'That GitHub installation is already linked to another organisation.',
  providerFailure: 'GitHub could not be reached. Start the connect flow again.',
  notYours: 'That GitHub installation is not one your GitHub account can administer.',
  suspended: 'That GitHub installation is suspended at GitHub. Re-enable it, then connect again.',
});

/** Which door an installation came through, for the audit row. */
export type InstallationBindOrigin = 'setup' | 'authorize';

/**
 * THE ONE PLACE AN INSTALLATION BECOMES THIS ORGANISATION'S.
 *
 * Both doors route through it, and that is the point: the setup callback and
 * the authorize callback each used to link on their own terms, and they did
 * not agree. Setup checked the role and skipped the journal; authorize
 * journaled nothing and checked NO role at all. Neither refused a suspended
 * installation, though `suspended` has been parsed off the API since the
 * client was written and read by nothing.
 *
 * The caller supplies a view it has already VERIFIED against the connecting
 * user (`verifyInstallation`), never one read from the App JWT alone — see
 * `completeGitHubSetup` for why that distinction is the security property.
 *
 * Returns null when the binding happened, or the refusal to send back.
 */
function bindInstallation(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly view: GitHubInstallationView;
  readonly via: InstallationBindOrigin;
  readonly events?: PlatformEventSink;
}): GitHubHttpResult | null {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  if (input.view.suspended) return htmlError(409, GITHUB_COPY.suspended);
  input.github.linkInstallation({
    installationId: input.view.installationId,
    orgId: input.viewer.orgId,
    accountId: input.view.accountId,
    accountLogin: input.view.accountLogin,
    targetType: input.view.targetType,
    repositorySelection: input.view.repositorySelection,
    permissions: input.view.permissions,
    connectedByPrincipalId: input.viewer.principalId,
  });
  input.events?.({
    kind: 'github.installation_linked',
    actorType: 'principal',
    actorId: input.viewer.principalId,
    orgId: input.viewer.orgId,
    summary: `GitHub installation linked for ${eventLabel(input.view.accountLogin)} (${input.view.targetType})`,
    detail: {
      installationId: input.view.installationId,
      targetType: input.view.targetType,
      repositorySelection: input.view.repositorySelection,
      via: input.via,
    },
  });
  return null;
}

export type GitHubHttpResult =
  | { readonly kind: 'installations'; readonly state: string; readonly installUrl: string; readonly accounts: readonly Pick<GitHubInstallationView, 'installationId' | 'accountLogin'>[] }
  | { readonly kind: 'redirect'; readonly location: string; readonly cookies?: readonly string[] }
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'html'; readonly status: number; readonly body: string; readonly cookies?: readonly string[] };

export async function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      throw new GitHubWebhookError('body_too_large', 'GitHub webhook body exceeds the byte limit');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function webhookStatus(error: GitHubWebhookError): number {
  switch (error.code) {
    case 'invalid_signature':
      return 401;
    case 'body_too_large':
      return 413;
    case 'wrong_app':
      return 400;
    default:
      return 400;
  }
}

export async function handleGitHubWebhook(input: {
  readonly req: IncomingMessage;
  readonly store: GitHubStore;
  readonly config: GitHubAppConfig;
  /**
   * Optional audit sink. Injected rather than imported so the github module
   * keeps knowing nothing about the viz server, and so a caller without an
   * event log (tests, the ungated path) behaves exactly as before.
   */
  readonly events?: PlatformEventSink;
}): Promise<GitHubHttpResult> {
  try {
    const rawBody = await readBoundedBody(input.req, GITHUB_WEBHOOK_MAX_BODY_BYTES);
    const result = processGitHubWebhook({
      store: input.store,
      appId: input.config.appId,
      webhookSecret: input.config.webhookSecret,
      rawBody,
      signature: headerValue(input.req.headers['x-hub-signature-256']),
      deliveryId: headerValue(input.req.headers['x-github-delivery']),
      event: headerValue(input.req.headers['x-github-event']),
      ...(input.events ? { events: input.events } : {}),
    });
    return { kind: 'json', status: 202, body: result };
  } catch (error) {
    if (error instanceof GitHubWebhookError) {
      // An unauthenticated caller reached a control-plane endpoint and was
      // refused. The refusal CODE is the auditable fact; the body is not
      // journaled — it is attacker-controlled bytes of unbounded shape.
      input.events?.({
        kind: 'webhook.rejected',
        actorType: 'webhook',
        summary: `GitHub webhook refused: ${error.code}`,
        detail: { code: error.code },
      });
      return { kind: 'json', status: webhookStatus(error), body: { error: error.message } };
    }
    throw error;
  }
}

export function startGitHubConnect(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  /** Where to send a viewer whose GitHub account this deployment cannot yet read. */
  readonly authorizePath?: string;
}): GitHubHttpResult {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  // THE USER TOKEN IS A PRECONDITION OF CONNECTING, not a consequence of it.
  // The setup callback must prove the installation GitHub names is one THIS
  // viewer can administer, and the only way to ask that is with the viewer's
  // own token. Acquiring it here — before GitHub is involved — is what lets
  // the callback verify instead of trust; acquiring it after the link, as this
  // flow used to, is what left the link unverified.
  //
  // Almost nobody sees this hop: an ordinary GitHub login already stores the
  // authorization. It exists for the admin who signed in with another
  // provider, who authorizes once and then connects normally.
  if (input.authorizePath && !input.github.getUserAuthorization(input.viewer.principalId)) {
    return { kind: 'redirect', location: input.authorizePath };
  }
  const state = newGitHubConnectState();
  try {
    input.github.createConnectState({
      state,
      principalId: input.viewer.principalId,
      orgId: input.viewer.orgId,
      ttlMs: GITHUB_CONNECT_STATE_TTL_MAX_MS,
    });
  } catch (error) {
    if (error instanceof TooManyPendingGitHubConnectStatesError) {
      return { kind: 'json', status: 429, body: { error: error.message } };
    }
    throw error;
  }
  return {
    kind: 'redirect',
    location: githubAppInstallUrl({
      appSlug: input.config.appSlug,
      state,
      apiBaseUrl: input.config.apiBaseUrl,
    }),
  };
}

/** Recover an already-installed App without relying on GitHub repeating setup. */
export async function prepareGitHubConnect(input: Parameters<typeof startGitHubConnect>[0] & {
  readonly client: GitHubAppClient;
  readonly resolveUserAccessToken: (principalId: string) => Promise<string>;
}): Promise<GitHubHttpResult> {
  const started = startGitHubConnect(input);
  if (started.kind !== 'redirect' || started.location === input.authorizePath) return started;
  try {
    const token = await input.resolveUserAccessToken(input.viewer.principalId);
    const installations = await input.client.listUserInstallations(token);
    const accounts = installations
      .filter(installation => installation.appId === input.config.appId)
      .map(({ installationId, accountLogin }) => ({ installationId, accountLogin }));
    if (accounts.length === 0) return started;
    // Listing is discovery only. Choosing an account uses the existing setup
    // callback, which re-verifies both views and enforces org ownership.
    return {
      kind: 'installations',
      state: new URL(started.location).searchParams.get('state')!,
      installUrl: started.location,
      accounts,
    };
  } catch (error) {
    console.error('[viz github] installation discovery failed', error);
    return htmlError(502, GITHUB_COPY.providerFailure);
  }
}

export async function completeGitHubSetup(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly client: GitHubAppClient;
  readonly state: string | null;
  readonly installationId: string | null;
  readonly setupAction: string | null;
  readonly homePath: string;
  /**
   * The connecting viewer's own GitHub token, so the untrusted
   * `installation_id` can be corroborated against what THEY can administer.
   * Throwing is a refusal: `startGitHubConnect` will not start a flow whose
   * callback could not verify.
   */
  readonly resolveUserAccessToken: (principalId: string) => Promise<string>;
  readonly events?: PlatformEventSink;
}): Promise<GitHubHttpResult> {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  if (!input.state) return htmlError(400, GITHUB_COPY.invalidState);
  const consumed = input.github.consumeConnectState({
    state: input.state,
    principalId: input.viewer.principalId,
    orgId: input.viewer.orgId,
  });
  if (!consumed) return htmlError(401, GITHUB_COPY.expiredState);
  if (input.setupAction === 'request') {
    return { kind: 'redirect', location: input.homePath };
  }
  if (!input.installationId) return htmlError(400, GITHUB_COPY.invalidInstallation);
  try {
    const installationId = canonicalGitHubId(input.installationId, 'GitHub installation id');
    // `installation_id` ARRIVES FROM A URL THE VIEWER CAN TYPE, and the connect
    // state does not bind one — the row holds a principal and an org, nothing
    // more. So the App-JWT view that used to stand here proved only "this is
    // some installation of this App", and an authenticated admin could paste a
    // stranger's installation id onto their own state and capture it: the
    // cross-org guard fires only once a row exists, so the FIRST binder wins,
    // permanently. Open signup makes org:admin free, and installation ids are
    // not secret — they sit in a settings URL and in every webhook payload.
    //
    // `verifyInstallation` is the same call the authorize door already made:
    // it corroborates the App view against the CONNECTING USER's own
    // /user/installations, so an id the viewer cannot administer is refused
    // before anything is written. `startGitHubConnect` guarantees the token
    // exists by this point.
    const userAccessToken = await input.resolveUserAccessToken(input.viewer.principalId);
    const installation = await input.client.verifyInstallation({
      userAccessToken,
      installationId,
    });
    const refused = bindInstallation({
      viewer: input.viewer,
      github: input.github,
      view: installation,
      via: 'setup',
      ...(input.events ? { events: input.events } : {}),
    });
    if (refused) return refused;
    return { kind: 'redirect', location: input.homePath };
  } catch (error) {
    if (error instanceof GitHubInstallationCrossOrgError) {
      return htmlError(409, GITHUB_COPY.alreadyLinked);
    }
    console.error('[viz github] setup failed', error);
    return htmlError(502, GITHUB_COPY.linkFailed);
  }
}

export function startGitHubUserAuthorize(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly provider: ProviderConfig;
  readonly redirectUri: string;
  readonly createOauthState: (state: string, codeVerifier: string) => void;
  readonly serializeOauthCookie: (state: string) => string;
}): GitHubHttpResult {
  const forbidden = requireAdmin(input.viewer);
  if (forbidden) return forbidden;
  const state = newGitHubConnectState();
  const pkce = newPkcePair();
  try {
    input.github.createConnectState({
      state,
      principalId: input.viewer.principalId,
      orgId: input.viewer.orgId,
      ttlMs: GITHUB_CONNECT_STATE_TTL_MAX_MS,
    });
    input.createOauthState(state, pkce.verifier);
  } catch (error) {
    if (error instanceof TooManyPendingGitHubConnectStatesError) {
      return { kind: 'json', status: 429, body: { error: error.message } };
    }
    throw error;
  }
  return {
    kind: 'redirect',
    location: buildAuthorizeUrl({
      provider: input.provider,
      redirectUri: input.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    }),
    cookies: [input.serializeOauthCookie(state)],
  };
}

/**
 * Persist user-to-server tokens (and optionally link an installation) after a
 * GitHub connect/authorize callback. The caller has already consumed the
 * matching oauth PKCE transaction.
 */
export async function completeGitHubUserCallback(input: {
  readonly viewer: Viewer;
  readonly github: GitHubStore;
  readonly config: GitHubAppConfig;
  readonly provider: ProviderConfig;
  readonly redirectUri: string;
  readonly state: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly installationId: string | null;
  readonly client: GitHubAppClient;
  readonly homePath: string;
  readonly events?: PlatformEventSink;
  readonly fetchImpl?: typeof fetch;
}): Promise<GitHubHttpResult> {
  const consumed = input.github.consumeConnectState({
    state: input.state,
    principalId: input.viewer.principalId,
    orgId: input.viewer.orgId,
  });
  if (!consumed) {
    throw new Error('GitHub connect state did not match the authenticated viewer');
  }
  try {
    const tokens = await exchangeCode(
      {
        provider: input.provider,
        redirectUri: input.redirectUri,
        code: input.code,
        codeVerifier: input.codeVerifier,
      },
      input.fetchImpl
    );
    const identity = await fetchProviderIdentity(
      { provider: input.provider, accessToken: tokens.accessToken },
      input.fetchImpl
    );
    persistGitHubUserTokens({
      github: input.github,
      config: input.config,
      principalId: input.viewer.principalId,
      githubSubject: identity.subject,
      tokens,
    });
    if (input.installationId) {
      const installation = await input.client.verifyInstallation({
        userAccessToken: tokens.accessToken,
        installationId: input.installationId,
      });
      // Through the shared binder, which is where this path picks up the role
      // check it never had and the audit row it never wrote. The token write
      // above stands either way: it is this principal's own authorization, and
      // a refused LINK is not a reason to forget that they authorized.
      const refused = bindInstallation({
        viewer: input.viewer,
        github: input.github,
        view: installation,
        via: 'authorize',
        ...(input.events ? { events: input.events } : {}),
      });
      if (refused) return refused;
    }
    return { kind: 'redirect', location: input.homePath };
  } catch (error) {
    if (error instanceof GitHubInstallationCrossOrgError) {
      return htmlError(409, GITHUB_COPY.alreadyLinked);
    }
    console.error('[viz github] user-token callback failed', error);
    return htmlError(502, GITHUB_COPY.providerFailure);
  }
}

function requireAdmin(viewer: Viewer): GitHubHttpResult | null {
  if (!roleAtLeast(viewer.role, 'org:admin')) {
    return { kind: 'json', status: 403, body: { error: GITHUB_COPY.adminRequired } };
  }
  return null;
}

function htmlError(status: number, message: string): GitHubHttpResult {
  return { kind: 'html', status, body: message };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
