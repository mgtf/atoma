import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SkillRegistry } from '../skills/registry.js';
import { sortRunIndex, summarizeTraceFile } from './runIndex.js';
import type { VizRunIndexEntry } from './trace.js';
import { openStoreHandle, skillsDirPath, storeDbPath } from '../core/stores.js';
import { LEDGER_TABLE_DDL, readLedgerTail } from '../core/ledger.js';
import { LAUNCHABLE_PROFILES } from '../run/profiles/index.js';
import { assessShareability, type ShareAssessment } from '../skills/shareability.js';
import { taxonomyForTier, type AgentRank } from '../core/taxonomy.js';
import { elementForTool } from '../contracts/toolTaxonomy.js';
import { authPublicOrigin, openAuthGate, vizAuthEnabled } from '../auth/gate.js';
import { AUTH_COPY } from '../auth/copy.js';
import { snapshotProviderRegistry, type ProviderConfig } from '../auth/providers.js';
import { fetchAvatarImage } from '../auth/avatar.js';
import { operatorTierDefaults, TIER_MODEL_CHOICES } from '../contracts/tierModels.js';
import {
  ORG_ROLES,
  sha256Hex,
  TooManyPendingOauthStatesError,
  type AuthStore,
  type OrgRole,
  type Viewer,
} from '../auth/store.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchProviderIdentity,
  newPkcePair,
  newState,
} from '../auth/oidc.js';
import {
  BoundedFixedWindowRateLimiter,
  loginClientAddress,
  snapshotTrustedProxies,
  type TrustedProxySnapshot,
} from '../auth/rate-limit.js';
import {
  OAUTH_TX_COOKIE,
  OAUTH_TX_TTL_MS,
  issueSession,
  logoutSessionCandidatesFromCookieHeader,
  sessionTokenFromCookieHeader,
  retireSessionCookie,
  serializeCookie,
  parseCookieHeader,
} from '../auth/sessions.js';
import {
  isAuthorizationCode,
  isInvitationToken,
  isOauthState,
} from '../auth/values.js';
import { snapshotGitHubAppConfig, type GitHubAppConfig } from '../github/config.js';
import { GitHubAppClient } from '../github/client.js';
import {
  completeGitHubSetup,
  completeGitHubUserCallback,
  GITHUB_COPY,
  handleGitHubWebhook,
  startGitHubConnect,
  startGitHubUserAuthorize,
  type GitHubHttpResult,
} from '../github/http.js';
import { GitHubStore, isGitHubConnectState } from '../github/store.js';
import { persistGitHubUserTokens, resolveGitHubUserAccessToken } from '../github/tokens.js';
import { ProjectStore } from '../projects/store.js';
import { DEFAULT_PROJECTS_ROOT, ProjectRunCoordinator } from '../projects/coordinator.js';
import { GitHubPublisher } from '../projects/publisher.js';
import { ProjectHttpError, ProjectService } from '../projects/service.js';
import { PushStore } from './push/store.js';
import { PushNotifier } from './push/notifier.js';
import { NotificationRouter } from './push/router.js';
import { asPushLocale } from './push/routes.js';
import { PlatformEventLog } from '../platform/events.js';
import { eventLabel } from '../contracts/platformEvents.js';

/**
 * Tiny read-only HTTP server that exposes runs/*.json produced by
 * `TraceRecorder` plus the Vite-built static client bundled under
 * `dist/viz/client`. The server remains framework-free and read-only:
 * `node:http` serves APIs plus hashed assets, while Vite is build/dev only.
 *
 * Also exposes a read-only view of any agent registry (SQLite DB) so the UI
 * can render a "Registry" screen independent of any particular run.
 *
 * Usage:  npm run viz -- --dir ./runs --port 4111 [--db ./atoma.db ...]
 */

interface Cli {
  dir: string;
  port: number;
  host: string;
  /** One or more DB paths to expose under /api/registry. */
  dbs: string[];
  /** Optional skills root dir (overrides ATOMA_SKILLS_DIR). */
  skillsDir?: string;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = { dir: './runs', port: 4111, host: '127.0.0.1', dbs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a non-empty value`);
      }
      i += 1;
      return value;
    };
    if (flag === '--dir') out.dir = takeValue();
    else if (flag === '--port') {
      const rawPort = takeValue();
      if (!/^\d+$/.test(rawPort)) throw new Error('--port must be an integer from 0 to 65535');
      const port = Number(rawPort);
      if (!Number.isSafeInteger(port) || port > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535');
      }
      out.port = port;
    } else if (flag === '--host') out.host = takeValue();
    else if (flag === '--db') out.dbs.push(takeValue());
    else if (flag === '--skills-dir') out.skillsDir = takeValue();
    else throw new Error(`unknown viz argument: ${flag}`);
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
const RUNS_DIR = resolve(cli.dir);
const PROJECTS_ROOT = resolve(process.env['ATOMA_PROJECTS_ROOT'] ?? DEFAULT_PROJECTS_ROOT);
const BURNIN_CSV = resolve(process.env['ATOMA_BURNIN_CSV'] ?? './burnin/results.csv');

/**
 * Parse burnin/results.csv (written by `npm run burnin`) into typed rows.
 * The CSV is machine-written with simple cells (no quoting needed — task
 * goals are not in it), so a plain split is correct. Missing file → empty
 * list: the UI shows a "run a batch" hint instead of an error.
 */
function loadBurnin(): {
  rows: {
    ts: string;
    taskId: string;
    family: string;
    outcome: string;
    costUsd: number | null;
    durationS: number | null;
    llmCalls: number | null;
    opusCalls: number;
    sonnetCalls: number;
    haikuCalls: number;
    otherCalls: number;
    deterministicPhases: number;
    escalations: number;
    learnedSkills: number;
    learnedEventSkills: number;
    promotions: number;
    refusals: number;
    compileErrors: number;
    demotions: number;
    dispatchFallbacks: number;
    trace: string;
    provider: string;
  }[];
  csvPath: string;
} {
  if (!existsSync(BURNIN_CSV)) return { rows: [], csvPath: BURNIN_CSV };
  const lines = readFileSync(BURNIN_CSV, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c.length < 14) continue;
    const num = (s: string | undefined): number | null => {
      const n = Number(s);
      return s !== undefined && s !== '' && Number.isFinite(n) ? n : null;
    };
    const llmCalls = num(c[6]);
    const opusCalls = num(c[7]) ?? 0;
    const sonnetCalls = num(c[8]) ?? 0;
    const haikuCalls = num(c[9]) ?? 0;
    const otherCalls = num(c[19]) ?? 0;
    const explicitProvider = c[18]?.trim();
    const provider = explicitProvider || 'unknown';
    rows.push({
      ts: c[0]!,
      taskId: c[1]!,
      family: c[2]!,
      outcome: c[3]!,
      costUsd: num(c[4]),
      durationS: num(c[5]),
      llmCalls,
      opusCalls,
      sonnetCalls,
      haikuCalls,
      otherCalls,
      deterministicPhases: num(c[10]) ?? 0,
      escalations: num(c[11]) ?? 0,
      learnedSkills: num(c[12]) ?? 0,
      learnedEventSkills: num(c[20]) ?? 0,
      // Lifecycle columns appended later — older rows simply lack them.
      promotions: num(c[13]) ?? 0,
      refusals: num(c[14]) ?? 0,
      compileErrors: num(c[21]) ?? 0,
      demotions: num(c[15]) ?? 0,
      dispatchFallbacks: num(c[16]) ?? 0,
      trace: (c.length > 17 ? c[17] : c[13]) ?? '',
      provider,
    });
  }
  return { rows, csvPath: BURNIN_CSV };
}
const SKILLS_DIR = resolve(skillsDirPath(cli.skillsDir));
const skillRegistry = new SkillRegistry(SKILLS_DIR);

/**
 * Resolve the list of DB paths we'll serve: the explicit `--db` flags if any
 * (the flag repeats, so an archived store can be inspected alongside a live
 * one), otherwise the one store `storeDbPath()` resolves.
 *
 * IT USED TO GUESS TWO. The candidate list carried `./atoma.db` and
 * `./atoma-build.db` plus an `ATOMA_BUILD_DB_PATH` env branch, so the UI
 * rendered a store picker over one populated DB and one that had held zero
 * rows since `research-brief.ts` was deleted — presenting an artefact of a
 * dead split as a choice the operator had to understand. The list survives
 * because `--db` legitimately repeats; the guessing does not.
 *
 * Duplicates (same resolved path) are collapsed; a missing file is kept in the
 * list so the UI can still show it as empty rather than vanishing.
 */
function resolveDbs(): { id: string; label: string; path: string; exists: boolean }[] {
  const candidates: string[] = cli.dbs.length > 0 ? [...cli.dbs] : [storeDbPath()];
  const seen = new Set<string>();
  const out: { id: string; label: string; path: string; exists: boolean }[] = [];
  for (const c of candidates) {
    const abs = resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const label = basename(abs).replace(/\.db$/, '');
    out.push({ id: label, label, path: abs, exists: existsSync(abs) });
  }
  // Dedup by id: if two paths happen to share the basename, keep the first.
  const byId = new Map<string, typeof out[number]>();
  for (const d of out) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()];
}

const DBS = resolveDbs();

/**
 * THE AUTH GATE (SaaS A2). Opt-in via the HOST environment
 * (`ATOMA_VIZ_AUTH=1`), mirroring `ATOMA_REQUIRE_ISOLATION`: the developer
 * path without the flag is byte-for-byte unchanged, and a deployment that
 * wants the gate cannot get it silently disabled by a run's environment.
 * Fail-closed at startup: the flag with zero configured providers would
 * produce a server whose every /api/* answers 401 forever — refuse to boot
 * that instead, with a message naming the env vars to set.
 */
interface VizAuthRuntime {
  gate: NonNullable<ReturnType<typeof openAuthGate>>;
  providers: readonly ProviderConfig[];
  publicOrigin: URL;
  redirectUri: string;
  secureCookies: boolean;
  trustedProxies: TrustedProxySnapshot;
}

const AUTH_RUNTIME: VizAuthRuntime | null = (() => {
  if (!vizAuthEnabled()) return null;
  const registry = snapshotProviderRegistry(process.env);
  if (registry.diagnostics.length > 0) {
    throw new Error(
      `Invalid authentication provider configuration: ${registry.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`
    );
  }
  const providers = registry.providers;
  if (providers.length === 0) {
    throw new Error(
      'ATOMA_VIZ_AUTH is set but no complete login provider is configured. Set ATOMA_AUTH_<PROVIDER>_CLIENT_ID and CLIENT_SECRET (see .env.example).'
    );
  }
  const publicOrigin = authPublicOrigin(process.env);
  const trustedProxies = snapshotTrustedProxies(process.env);
  const gate = openAuthGate({ env: process.env, dbPath: DBS[0]!.path });
  if (!gate.store) throw new Error('authentication store did not open');
  gate.store.sweep();
  return {
    gate,
    providers,
    publicOrigin,
    redirectUri: new URL('/auth/callback', publicOrigin).href,
    secureCookies: publicOrigin.protocol === 'https:',
    trustedProxies,
  };
})();

const AUTH = AUTH_RUNTIME?.gate ?? null;

/**
 * PLATFORM EVENT LOG. Gated deployments only — every event it records is
 * scoped to a principal, an organisation or the instance operator, and none
 * of those exist on the ungated developer path. Declared before the sweep
 * timer below, which is its retention driver.
 */
const EVENTS: PlatformEventLog | null = AUTH_RUNTIME
  ? PlatformEventLog.open(DBS[0]!.path)
  : null;

/**
 * Fail-open emit helper. `EVENTS` is null on the ungated path, and `append`
 * itself never throws, so no call site needs a guard or a try/catch.
 */
const emit: (input: Parameters<PlatformEventLog['append']>[0]) => void = (input) => {
  EVENTS?.append(input);
};

if (AUTH?.store) {
  const sweepTimer = setInterval(() => {
    try {
      AUTH.store?.sweep();
    } catch (error) {
      console.error('[viz auth] failed to sweep expired auth records', error);
    }
    // Retention rides the same tick: one timer, two bounded tables. The log
    // sweeps fail-open on its own, so it needs no try/catch here.
    EVENTS?.sweep();
  }, 5 * 60 * 1000);
  sweepTimer.unref();
}

/**
 * WEB PUSH RUNTIME. Exists only behind the auth gate: subscriptions are
 * principal-scoped rows, meaningless without a viewer. The VAPID keypair is
 * generated once and persisted in the product store (rotating it silently
 * would orphan every browser subscription); `ATOMA_VIZ_VAPID_SUBJECT` may
 * override the JWT subject, defaulting to the deployment's public origin.
 */
interface PushRuntime {
  readonly store: PushStore;
  readonly notifier: PushNotifier;
  readonly publicKey: string;
}

const PUSH_RUNTIME: PushRuntime | null = (() => {
  if (!AUTH_RUNTIME) return null;
  const pushStore = PushStore.open(DBS[0]!.path);
  const vapid = pushStore.vapidKeys();
  const subject =
    process.env['ATOMA_VIZ_VAPID_SUBJECT']?.trim() || AUTH_RUNTIME.publicOrigin.origin;
  return {
    store: pushStore,
    notifier: new PushNotifier({ store: pushStore, vapid, subject }),
    publicKey: vapid.publicKey,
  };
})();

/**
 * THE ONE PATH FROM AN EVENT TO A DEVICE. Subscribing the router to the log
 * means no emitter can notify anybody directly: journal the fact, and the
 * routing table decides. The audience readers are the auth store's own
 * queries, wrapped so the router cannot reach anything else.
 */
if (EVENTS && PUSH_RUNTIME && AUTH?.store) {
  const authStore = AUTH.store;
  const router = new NotificationRouter({
    notifier: PUSH_RUNTIME.notifier,
    directory: {
      // Selected here rather than through a filtering argument so this
      // wiring does not depend on the reader's parameter list.
      ownersOf: (orgId) =>
        (
          authStore
            .listOrganisationsWithMembers()
            .find((organisation) => organisation.orgId === orgId)?.members ?? []
        )
          .filter((member) => member.role === 'org:owner')
          .map((member) => member.principalId),
      platformAdmins: () => authStore.listPlatformAdmins().map((admin) => admin.principalId),
    },
  });
  EVENTS.subscribe((event) => router.handle(event));
}

/**
 * PROJECTS + GITHUB APP RUNTIME.
 *
 * The project control plane exists only when the auth gate is on: projects
 * are organisation-owned, and an organisation is meaningless without a
 * viewer. The GitHub App layer is optional beyond that — the server runs
 * with projects read/run but no publication target when the App env vars
 * are absent, and refuses to boot when they are HALF-present (the same
 * fail-closed rule as the provider registry).
 */
interface ProjectsRuntime {
  readonly store: ProjectStore;
  readonly projects: ProjectService;
  readonly coordinator: ProjectRunCoordinator;
  readonly githubStore: GitHubStore;
  readonly githubConfig: GitHubAppConfig | null;
  readonly githubClient: GitHubAppClient | null;
}

const PROJECTS_RUNTIME: ProjectsRuntime | null = (() => {
  if (!AUTH_RUNTIME) return null;
  const dbPath = DBS[0]!.path;
  const projectStore = ProjectStore.open(dbPath);
  // openStoreHandle's cache returns the same better-sqlite3 handle for the
  // same path, so the GitHub tables join the one consolidated product store.
  const githubStore = GitHubStore.open(dbPath);
  const appConfigPresent = [
    'ATOMA_GITHUB_APP_ID',
    'ATOMA_GITHUB_APP_SLUG',
    'ATOMA_GITHUB_APP_PRIVATE_KEY',
    'ATOMA_GITHUB_APP_PRIVATE_KEY_PATH',
    'ATOMA_GITHUB_WEBHOOK_SECRET',
    'ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY',
  ].some((name) => process.env[name] !== undefined);
  let githubConfig: GitHubAppConfig | null = null;
  if (appConfigPresent) {
    const githubProvider = AUTH_RUNTIME.providers.find((provider) => provider.id === 'github');
    githubConfig = snapshotGitHubAppConfig(process.env, {
      ...(githubProvider
        ? { oauth: { clientId: githubProvider.clientId, clientSecret: githubProvider.clientSecret ?? '' } }
        : {}),
    });
  }
  const githubClient = githubConfig
    ? new GitHubAppClient({
        appId: githubConfig.appId,
        appSlug: githubConfig.appSlug,
        privateKey: githubConfig.privateKey,
        apiBaseUrl: githubConfig.apiBaseUrl,
      })
    : null;
  const githubProvider = AUTH_RUNTIME.providers.find((provider) => provider.id === 'github');
  const appConfig = githubConfig;
  const publisher = appConfig && githubClient
    ? new GitHubPublisher({
        client: githubClient,
        github: githubStore,
        store: projectStore,
        events: emit,
        resolveUserAccessToken: githubProvider
          ? (principalId) =>
              resolveGitHubUserAccessToken({
                github: githubStore,
                config: appConfig,
                provider: githubProvider,
                principalId,
              })
          : undefined,
      })
    : undefined;
  const coordinator = new ProjectRunCoordinator({
    store: projectStore,
    dbPath,
    projectsRoot: PROJECTS_ROOT,
    ...(publisher ? { publisher } : {}),
    // Accounts choose their own per-tier models in Settings; without a gate
    // there are no accounts and the operator's host pins are the only pins.
    ...(AUTH?.store
      ? { tierModelsFor: (principalId: string) => AUTH.store!.modelPins(principalId) }
      : {}),
    // The terminal-run hook JOURNALS; the router turns that row into pushes.
    // There is deliberately no direct notifier call here any more — one
    // delivery path, and no way to notify without an audit trail.
    // `run.cancelled` (requested, emitted by the service) and a
    // `run.finished` carrying status `cancelled` are DIFFERENT facts at
    // different times — the ask and the actual end — so both are journaled.
    onRunFinished: (event) => {
      emit({
        kind: 'run.finished',
        actorType: 'principal',
        actorId: event.principalId,
        orgId: event.orgId,
        projectId: event.projectId,
        runId: event.projectRunId,
        summary: `Run ${event.status}: ${eventLabel(event.goal, 120)}`,
        // `goal` and `status` are what the localised push copy renders from:
        // `summary` is one English line and could never become French.
        detail: { status: event.status, goal: eventLabel(event.goal, 120) },
      });
    },
  });
  // A previous process that died mid-run left rows only its in-memory
  // drivers could ever move. Recover them BEFORE any new run can start,
  // and say so — silent reaping hides the crash from the operator.
  const recovered = coordinator.reconcileInterrupted();
  if (recovered.runs > 0 || recovered.publications > 0) {
    process.stderr.write(
      `[atoma viz] recovered interrupted project state: ${recovered.runs} run(s) and ${recovered.publications} publication(s) marked failed\n`
    );
    emit({
      kind: 'server.recovered',
      actorType: 'system',
      summary: `Recovered ${recovered.runs} interrupted run(s) and ${recovered.publications} publication(s) after a restart`,
      detail: { runs: recovered.runs, publications: recovered.publications },
    });
  }
  const projects = new ProjectService({
    store: projectStore,
    coordinator,
    github: githubStore,
    events: emit,
  });
  return { store: projectStore, projects, coordinator, githubStore, githubConfig, githubClient };
})();

/** Set-Cookie that removes the oauth transaction cookie. */
function clearCookie(name: string, secure: boolean, path = '/'): string {
  return serializeCookie(name, '', { secure, path, maxAgeSeconds: 0 });
}

/**
 * The same-origin avatar URL for a principal, or null when there is none.
 *
 * `?v=` is the content hash, not a timestamp: an unchanged picture keeps the
 * browser cache warm across logins, and a new one changes the URL so the
 * five-minute cache above cannot serve a stale face.
 */
function avatarUrlFor(store: AuthStore, principalId: string): string | null {
  const meta = store.avatarMeta(principalId);
  if (!meta) return null;
  return `/auth/avatar/${encodeURIComponent(principalId)}?v=${meta.etag.slice(0, 16)}`;
}

/**
 * Minimal login page served when the gate is on. The GL client gets a real
 * login view later; this exists so the flow is testable and usable today
 * without shipping an unauthenticated app shell to an unauthenticated
 * browser. English, no external assets, no scripts.
 */
function loginPage(message?: string, invitationToken?: string): string {
  const inviteParam = invitationToken ? `&amp;invite=${encodeURIComponent(invitationToken)}` : '';
  const providers = (AUTH_RUNTIME?.providers ?? [])
    .map((p) => `<a class="btn" href="/auth/login?provider=${p.id}${inviteParam}">${escapeHtml(p.label)}</a>`)
    .join('');
  const notice = message ? `<p class="msg">${escapeHtml(message)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(AUTH_COPY.pageTitle)}</title>
<style>
body{font-family:ui-monospace,monospace;background:#0b0f14;color:#d8e2ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#11161d;border:1px solid #223041;border-radius:12px;padding:32px 40px;max-width:420px}
h1{font-size:18px;margin:0 0 4px;color:#7ee0c8}
p.sub{color:#8fa3b8;margin:0 0 20px;font-size:13px}
.btn{display:block;margin:8px 0;padding:10px 14px;border:1px solid #2d4157;border-radius:8px;color:#d8e2ec;text-decoration:none;font-size:14px}
.btn:hover{background:#182230}
.msg{color:#e8b84b;font-size:13px}
</style></head>
<body><div class="card">
<h1>${escapeHtml(AUTH_COPY.brand)}</h1>
<p class="sub">${escapeHtml(AUTH_COPY.signInSubtitle)}</p>
${notice}
${providers}
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(HERE, 'client');
const UI_HTML_PATH = join(CLIENT_DIR, 'index.html');
const DEV_UI_URL = (() => {
  const configured = process.env['ATOMA_VIZ_DEV_URL']?.trim();
  if (!configured) return null;
  const parsed = new URL(configured);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ATOMA_VIZ_DEV_URL must use http or https');
  }
  return parsed;
})();

function assetContentType(file: string): string {
  switch (extname(file)) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function send(
  res: import('node:http').ServerResponse,
  code: number,
  body: string | Buffer,
  type: string,
  cacheControl = 'no-store'
): void {
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': cacheControl,
  });
  res.end(body);
}

function staticCacheControl(path: string): string {
  const name = basename(path);
  if (name === 'sw.js') return 'no-cache';
  if (/[-.][A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(name)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

const AUTH_SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * Headers for the APP SHELL when the gate is on. Unlike the auth pages the
 * shell must run its own scripts, so the CSP pins only what the login-capable
 * page needs pinned: it cannot be framed. Script/style policy stays with the
 * shell itself.
 */
const SHELL_SECURITY_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/**
 * Bounded notice vocabulary the callback may bounce back to the shell.
 * The GL client maps each code to its catalogs; an unknown code renders the
 * generic failure line, so the query parameter is display steering, never
 * markup or free text.
 */
type AuthNoticeCode =
  | 'invalidInvitation'
  | 'invalidState'
  | 'replayedState'
  | 'expiredState'
  | 'providerRefused'
  | 'invalidAuthorizationCode'
  | 'invitationRequired'
  | 'providerFailure'
  | 'githubConnectExpired';

function sendAuthHtml(
  res: import('node:http').ServerResponse,
  code: number,
  body: string,
  headers: import('node:http').OutgoingHttpHeaders = {}
): void {
  res.writeHead(code, {
    ...AUTH_SECURITY_HEADERS,
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeAuthRedirect(
  res: import('node:http').ServerResponse,
  location: string,
  cookies: string | string[]
): void {
  res.writeHead(302, {
    ...AUTH_SECURITY_HEADERS,
    location,
    'set-cookie': cookies,
    'content-length': '0',
    'cache-control': 'no-store',
  });
  res.end();
}

function githubNoticePage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Atoma — GitHub</title>
<style>
body{font-family:ui-monospace,monospace;background:#0b0f14;color:#d8e2ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#11161d;border:1px solid #223041;border-radius:12px;padding:32px 40px;max-width:420px}
h1{font-size:18px;margin:0 0 12px;color:#7ee0c8}
p{color:#e8b84b;font-size:13px}
a{color:#7ee0c8}
</style></head>
<body><div class="card">
<h1>Atoma</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to Atoma</a></p>
</div></body></html>`;
}

function applyGitHubResult(
  res: import('node:http').ServerResponse,
  result: GitHubHttpResult,
  extraCookies: string[] = []
): void {
  const cookies = [...(result.kind === 'redirect' || result.kind === 'html' ? result.cookies ?? [] : []), ...extraCookies];
  if (result.kind === 'redirect') {
    writeAuthRedirect(res, result.location, cookies);
    return;
  }
  if (result.kind === 'html') {
    sendAuthHtml(
      res,
      result.status,
      githubNoticePage(result.body),
      cookies.length > 0 ? { 'set-cookie': cookies } : {}
    );
    return;
  }
  sendJson(res, result.status, result.body);
}

function sameOrigin(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
): boolean {
  if (!AUTH_RUNTIME) return false;
  if (req.headers.origin === AUTH_RUNTIME.publicOrigin.origin) return true;
  sendJson(res, 403, { error: 'origin mismatch' });
  return false;
}

/** Read a request body, refusing anything past `maxBytes` (413 is the caller's job). */
async function readBodyBounded(
  req: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer);
    length += bytes.length;
    if (length > maxBytes) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: import('node:http').ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function listOperatorRunIndex(): VizRunIndexEntry[] {
  if (!existsSync(RUNS_DIR)) return [];
  const indexFile = join(RUNS_DIR, 'index.json');
  if (existsSync(indexFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(indexFile, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is VizRunIndexEntry =>
            Boolean(entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string')
        );
      }
    } catch {
      // fall through to scanning directly
    }
  }
  const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const entries: VizRunIndexEntry[] = [];
  for (const f of files) {
    const entry = summarizeTraceFile(join(RUNS_DIR, f));
    if (entry) entries.push(entry);
  }
  return sortRunIndex(entries);
}

function listOrganisationRunIndex(orgId: string): VizRunIndexEntry[] {
  if (!PROJECTS_RUNTIME) return [];
  const entries: VizRunIndexEntry[] = [];
  for (const row of PROJECTS_RUNTIME.store.listOrgRunTraces(orgId)) {
    const summary = summarizeTraceFile(row.file);
    if (!summary) continue;
    entries.push({
      ...summary,
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
    });
  }
  return sortRunIndex(entries);
}

function listAllRunIndex(): VizRunIndexEntry[] {
  if (!PROJECTS_RUNTIME) return [];
  const entries: VizRunIndexEntry[] = [];
  for (const row of PROJECTS_RUNTIME.store.listAllRunTraces()) {
    const summary = summarizeTraceFile(row.file);
    if (!summary) continue;
    entries.push({
      ...summary,
      projectId: row.projectId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
    });
  }
  return sortRunIndex(entries);
}

function listIndex(viewer: Viewer | null): VizRunIndexEntry[] {
  if (AUTH) {
    if (!PROJECTS_RUNTIME || !viewer) return [];
    // The platform admin reads every organisation's project traces.
    return viewer.platformAdmin ? listAllRunIndex() : listOrganisationRunIndex(viewer.orgId);
  }
  return listOperatorRunIndex();
}

function resolveRunFile(id: string, viewer: Viewer | null): string | null {
  if (AUTH) {
    if (!PROJECTS_RUNTIME || !viewer) return null;
    return viewer.platformAdmin
      ? PROJECTS_RUNTIME.store.findAnyRunTraceFile(id)
      : PROJECTS_RUNTIME.store.findOrgRunTraceFile(viewer.orgId, id);
  }
  const primary = join(RUNS_DIR, `${id}.json`);
  return existsSync(primary) ? primary : null;
}

interface RegistryHistoryEntry {
  version: number;
  systemPrompt: string;
  tools: string[];
  params: Record<string, unknown>;
  modifiedBy: string;
  modifiedAt: string;
  reason: string | null;
}

interface RegistryType {
  tier: 1 | 2 | 3;
  rank: AgentRank;
  ordinal: number;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  elements: Array<{
    tool: string;
    number: number;
    name: string;
    symbol: string;
  }>;
  params: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  version: number;
  successes: number;
  failures: number;
  /** Archived versions, oldest first. Does NOT include the current version. */
  history: RegistryHistoryEntry[];
}

interface RegistrySummary {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  counts: { 1: number; 2: number; 3: number; total: number };
}

function safeParseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toolNames(toolsJson: string): string[] {
  const parsed = safeParseJson<Array<{ name?: string }>>(toolsJson, []);
  return parsed.map((t) => (typeof t?.name === 'string' ? t.name : '?'));
}

function toolElements(toolsJson: string): RegistryType['elements'] {
  return toolNames(toolsJson).flatMap((tool) => {
    const element = elementForTool(tool);
    return element
      ? [{ tool, number: element.number, name: element.name, symbol: element.symbol }]
      : [];
  });
}

function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function countsOf(path: string): { 1: number; 2: number; 3: number; total: number } {
  const zero = { 1: 0, 2: 0, 3: 0, total: 0 };
  if (!existsSync(path)) return zero;
  let db: Database.Database | null = null;
  try {
    db = openReadOnly(path);
    const rows = db
      .prepare('SELECT tier, COUNT(*) as n FROM atom_types GROUP BY tier')
      .all() as { tier: number; n: number }[];
    const out = { ...zero };
    for (const r of rows) {
      if (r.tier === 1 || r.tier === 2 || r.tier === 3) out[r.tier] = r.n;
    }
    out.total = out[1] + out[2] + out[3];
    return out;
  } catch {
    return zero;
  } finally {
    db?.close();
  }
}

function listRegistries(): RegistrySummary[] {
  return DBS.map((d) => ({
    id: d.id,
    label: d.label,
    path: d.path,
    exists: d.exists && existsSync(d.path),
    counts: countsOf(d.path),
  }));
}

function dumpRegistry(id: string): { registry: RegistrySummary; types: RegistryType[] } | null {
  const entry = DBS.find((d) => d.id === id);
  if (!entry) return null;
  if (!existsSync(entry.path)) {
    return {
      registry: { id: entry.id, label: entry.label, path: entry.path, exists: false, counts: { 1: 0, 2: 0, 3: 0, total: 0 } },
      types: [],
    };
  }
  const db = openReadOnly(entry.path);
  try {
    const rows = db
      .prepare('SELECT * FROM atom_types ORDER BY tier ASC, ordinal ASC')
      .all() as Array<{
        tier: number;
        ordinal: number;
        name: string;
        description: string;
        system_prompt: string;
        tools_json: string;
        params_json: string;
        created_by: string;
        created_at: string;
        version: number;
        successes: number;
        failures: number;
      }>;

    const versions = db
      .prepare(
        'SELECT tier, ordinal, version, system_prompt, tools_json, params_json, modified_by, modified_at, reason FROM atom_type_versions ORDER BY version ASC'
      )
      .all() as Array<{
        tier: number;
        ordinal: number;
        version: number;
        system_prompt: string;
        tools_json: string;
        params_json: string;
        modified_by: string;
        modified_at: string;
        reason: string | null;
      }>;

    const histByKey = new Map<string, RegistryHistoryEntry[]>();
    for (const v of versions) {
      const key = `${v.tier}:${v.ordinal}`;
      const arr = histByKey.get(key) ?? [];
      arr.push({
        version: v.version,
        systemPrompt: v.system_prompt,
        tools: toolNames(v.tools_json),
        params: safeParseJson<Record<string, unknown>>(v.params_json, {}),
        modifiedBy: v.modified_by,
        modifiedAt: v.modified_at,
        reason: v.reason,
      });
      histByKey.set(key, arr);
    }

    const types: RegistryType[] = rows.map((r) => ({
      tier: r.tier as 1 | 2 | 3,
      rank: taxonomyForTier(r.tier as 1 | 2 | 3).rank,
      ordinal: r.ordinal,
      name: r.name,
      description: r.description,
      systemPrompt: r.system_prompt,
      tools: toolNames(r.tools_json),
      elements: toolElements(r.tools_json),
      params: safeParseJson<Record<string, unknown>>(r.params_json, {}),
      createdBy: r.created_by,
      createdAt: r.created_at,
      version: r.version,
      successes: r.successes ?? 0,
      failures: r.failures ?? 0,
      history: histByKey.get(`${r.tier}:${r.ordinal}`) ?? [],
    }));

    const counts = { 1: 0, 2: 0, 3: 0, total: types.length };
    for (const t of types) counts[t.tier]++;
    return {
      registry: { id: entry.id, label: entry.label, path: entry.path, exists: true, counts },
      types,
    };
  } finally {
    db.close();
  }
}

interface SkillNamespaceSummary {
  /**
   * The stored namespace key — an atom id since T4. Clients pass it back on
   * /api/skills/:l1Name, so it must stay the key and not the label.
   */
  l1Name: string;
  /**
   * Display label for that key, resolved from the atom store. Falls back to
   * the key itself when the atom is gone, which is what an orphaned namespace
   * should look like rather than a crash.
   */
  l1Label: string;
  count: number;
}

interface SkillSummary {
  id: string;
  description: string;
  whenToUse: string;
  kind: 'llm' | 'script';
  language?: 'node' | 'python' | 'bash';
  successes: number;
  failures: number;
  updatedAt: string;
}

/**
 * List the L1 namespaces that have at least one skill on disk. The viz UI
 * uses this for the top-level "Skills" tab to render a per-L1 breakdown
 * before drilling into individual recipes. Returns an empty array if the
 * skills root doesn't exist (fresh repo / skills feature off).
 */
function listSkillNamespaces(): SkillNamespaceSummary[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: SkillNamespaceSummary[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const p = join(SKILLS_DIR, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(entry)) continue;
    let count = 0;
    try {
      count = skillRegistry.loadFor(entry).length;
    } catch {
      count = 0;
    }
    if (count > 0) out.push({ l1Name: entry, l1Label: displayNameForAtomId(entry) ?? entry, count });
  }
  // Sorted by the LABEL: the list is read by humans, and sorting by an
  // opaque id would shuffle the Skills tab into an arbitrary order.
  out.sort((a, b) => a.l1Label.localeCompare(b.l1Label));
  return out;
}

function listSkillsForL1(l1Name: string): SkillSummary[] {
  const skills = skillRegistry.loadFor(l1Name);
  return skills.map((s) => ({
    id: s.id,
    description: s.description,
    whenToUse: s.whenToUse,
    kind: s.kind,
    ...(s.language ? { language: s.language } : {}),
    successes: s.successes,
    failures: s.failures,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Tools the named atom declares, read from whichever exposed registry holds
 * it. Needed to judge a skill body's scope; absent DB → empty, which makes
 * the shareability check skip its tool findings rather than invent them.
 */
/** Resolve a namespace key back to the molecule's display name. */
function displayNameForAtomId(atomId: string): string | null {
  for (const reg of listRegistries()) {
    if (!reg.exists) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(reg.path, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT name FROM atom_types WHERE atom_id = ?').get(atomId) as
        | { name: string }
        | undefined;
      if (row) return row.name;
    } catch {
      /* unreadable registry — try the next one */
    } finally {
      db?.close();
    }
  }
  return null;
}

function toolNamesForAtomId(atomName: string): string[] {
  for (const reg of listRegistries()) {
    if (!reg.exists) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(reg.path, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT tools_json FROM atom_types WHERE atom_id = ?').get(atomName) as
        | { tools_json: string }
        | undefined;
      if (row) return (JSON.parse(row.tools_json) as { name: string }[]).map((t) => t.name);
    } catch {
      /* unreadable registry — try the next one */
    } finally {
      db?.close();
    }
  }
  return [];
}

function getSkillById(
  l1Name: string,
  skillId: string
): (SkillSummary & { body: string; shareability: ShareAssessment }) | null {
  const skills = skillRegistry.loadFor(l1Name);
  const found = skills.find((s) => s.id === skillId);
  if (!found) return null;
  return {
    id: found.id,
    description: found.description,
    whenToUse: found.whenToUse,
    kind: found.kind,
    ...(found.language ? { language: found.language } : {}),
    successes: found.successes,
    failures: found.failures,
    updatedAt: found.updatedAt,
    body: found.body,
    // The cross-org review criterion, at the point where a human actually
    // reads a skill. Same data as `npm run skills -- review`; surfacing the
    // verdict here follows the viz's own rule that a card should show the
    // DECISION, not just the artefact.
    shareability: assessShareability({ skill: found, ownerToolNames: toolNamesForAtomId(l1Name) }),
  };
}

/** Decode an untrusted URL path component without letting a malformed `%`
 * escape the request handler and terminate the whole viz process. */
function decodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    console.error('[viz] request failed', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal server error' });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
});

const LOGIN_RATE_WINDOW_MS = 60_000;
const LOGIN_RATE_MAX = 20;
const LOGIN_RATE_MAX_BUCKETS = 1_024;
const loginRate = new BoundedFixedWindowRateLimiter(
  LOGIN_RATE_MAX,
  LOGIN_RATE_WINDOW_MS,
  LOGIN_RATE_MAX_BUCKETS
);

function acceptLoginAttempt(
  req: import('node:http').IncomingMessage,
  trustedProxies: TrustedProxySnapshot
): { accepted: boolean; retryAfterSeconds: number } {
  return loginRate.attempt(loginClientAddress(req, trustedProxies));
}

function authProvider(id: string): ProviderConfig | null {
  return AUTH_RUNTIME?.providers.find((provider) => provider.id === id) ?? null;
}

function invitationTokenFrom(value: string | null): string | null {
  return isInvitationToken(value) ? value : null;
}

function methodAllowed(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
): boolean {
  if (req.method === method) return true;
  res.writeHead(405, { allow: method, 'content-length': '0', 'cache-control': 'no-store' });
  res.end();
  return false;
}

async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  let url: URL;
  try {
    // Host and the request-target are both untrusted wire input. A fixed base
    // prevents an invalid Host header from becoming URL syntax; the catch
    // contains invalid absolute/network-path request targets.
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendJson(res, 400, { error: 'bad request URL' });
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/webhooks/github') {
    if (!methodAllowed(req, res, 'POST')) return;
    if (!PROJECTS_RUNTIME?.githubConfig) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    applyGitHubResult(
      res,
      await handleGitHubWebhook({
        req,
        store: PROJECTS_RUNTIME.githubStore,
        config: PROJECTS_RUNTIME.githubConfig,
        events: emit,
      })
    );
    return;
  }

  // ------------------------------------------------------------- auth flow
  // The read-only capability probe stays available when the gate is off so
  // the shared GPU client can distinguish that normal state without causing
  // a browser-console 404. Every mutating/authentication route remains absent.
  if (!AUTH && pathname === '/auth/whoami') {
    if (!methodAllowed(req, res, 'GET')) return;
    sendJson(res, 200, { enabled: false, authenticated: false });
    return;
  }

  if (AUTH) {
    const authStore = AUTH.store;
    if (!authStore || !AUTH_RUNTIME) throw new Error('authentication runtime is incomplete');

    if (pathname === '/auth/login') {
      if (!methodAllowed(req, res, 'GET')) return;
      const providerId = url.searchParams.get('provider') ?? '';
      const rawInvitation = url.searchParams.get('invite');
      const invitationToken = invitationTokenFrom(rawInvitation);
      if (rawInvitation && !invitationToken) {
        writeAuthRedirect(res, '/?authNotice=invalidInvitation', []);
        return;
      }
      if (!providerId) {
        sendAuthHtml(res, 200, loginPage(undefined, invitationToken ?? undefined));
        return;
      }
      const provider = authProvider(providerId);
      if (!provider) {
        sendJson(res, 400, { error: 'unknown provider', provider: providerId });
        return;
      }
      const rate = acceptLoginAttempt(req, AUTH_RUNTIME.trustedProxies);
      if (!rate.accepted) {
        // The refusal itself is the event. The client address is the limiter's
        // bucket key and stays OUT of the journal: it is a network identifier
        // for a request nobody has authenticated, and the audit surface is
        // read by an operator, not by an abuse pipeline.
        emit({
          kind: 'auth.rate_limited',
          actorType: 'system',
          summary: `Login attempts rate-limited for provider ${provider.id}`,
          detail: { provider: provider.id, retryAfterSeconds: rate.retryAfterSeconds },
        });
        res.writeHead(429, {
          ...AUTH_SECURITY_HEADERS,
          'retry-after': String(rate.retryAfterSeconds),
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'too many login attempts' }));
        return;
      }

      const state = newState();
      const pkce = newPkcePair();
      try {
        authStore.createOauthState({
          state,
          provider: provider.id,
          codeVerifier: pkce.verifier,
          invitationHash: invitationToken ? sha256Hex(invitationToken) : null,
          ttlMs: OAUTH_TX_TTL_MS,
        });
      } catch (error) {
        if (error instanceof TooManyPendingOauthStatesError) {
          emit({
            kind: 'auth.state_flood',
            actorType: 'system',
            summary: 'Pending OAuth transaction ceiling reached; login refused',
            detail: { provider: provider.id },
          });
          sendJson(res, 429, { error: 'too many pending login transactions' });
          return;
        }
        throw error;
      }
      const target = buildAuthorizeUrl({
        provider,
        redirectUri: AUTH_RUNTIME.redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });
      writeAuthRedirect(
        res,
        target,
        serializeCookie(OAUTH_TX_COOKIE, state, {
          secure: AUTH_RUNTIME.secureCookies,
          path: '/auth',
          maxAgeSeconds: OAUTH_TX_TTL_MS / 1000,
        })
      );
      return;
    }

    if (pathname === '/auth/callback') {
      if (!methodAllowed(req, res, 'GET')) return;
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      const txCookies = parseCookieHeader(req.headers.cookie).filter((cookie) => cookie.name === OAUTH_TX_COOKIE);
      const txCookie = txCookies.length === 1 ? txCookies[0]!.value : null;
      // Login failures land back on the APP SHELL's arrival gate with a
      // bounded notice code — the GL welcome renders the message from its
      // catalogs. The old-school server HTML page is reserved for the no-JS
      // fallback at /auth/login; a redirected browser flow never sees it.
      const fail = (notice: AuthNoticeCode): void => {
        writeAuthRedirect(res, `/?authNotice=${notice}`, [
          clearCookie(OAUTH_TX_COOKIE, AUTH_RUNTIME.secureCookies, '/auth'),
        ]);
      };

      const viewer = AUTH.resolve(req);
      if (
        viewer &&
        PROJECTS_RUNTIME?.githubConfig &&
        PROJECTS_RUNTIME.githubClient &&
        isGitHubConnectState(state) &&
        PROJECTS_RUNTIME.githubStore.hasPendingConnectState(state)
      ) {
        if (!txCookie || txCookie !== state) {
          fail('githubConnectExpired');
          return;
        }
        const tx = authStore.consumeOauthState(state);
        const provider = tx ? authProvider(tx.provider) : null;
        if (!tx || !provider || provider.id !== 'github') {
          fail('githubConnectExpired');
          return;
        }
        if (errorParam) {
          fail('providerRefused');
          return;
        }
        if (!isAuthorizationCode(code)) {
          fail('invalidAuthorizationCode');
          return;
        }
        applyGitHubResult(
          res,
          await completeGitHubUserCallback({
            viewer,
            github: PROJECTS_RUNTIME.githubStore,
            config: PROJECTS_RUNTIME.githubConfig,
            provider,
            redirectUri: AUTH_RUNTIME.redirectUri,
            state,
            code,
            codeVerifier: tx.codeVerifier,
            installationId: url.searchParams.get('installation_id'),
            client: PROJECTS_RUNTIME.githubClient,
            homePath: '/',
          }),
          [clearCookie(OAUTH_TX_COOKIE, AUTH_RUNTIME.secureCookies, '/auth')]
        );
        return;
      }

      if (!isOauthState(state)) {
        fail('invalidState');
        return;
      }
      if (!txCookie || txCookie !== state) {
        fail('replayedState');
        return;
      }
      const tx = authStore.consumeOauthState(state);
      const provider = tx ? authProvider(tx.provider) : null;
      if (!tx || !provider) {
        fail('expiredState');
        return;
      }
      if (errorParam) {
        fail('providerRefused');
        return;
      }
      if (!isAuthorizationCode(code)) {
        fail('invalidAuthorizationCode');
        return;
      }

      try {
        const tokens = await exchangeCode({
          provider,
          redirectUri: AUTH_RUNTIME.redirectUri,
          code,
          codeVerifier: tx.codeVerifier,
        });
        const identity = await fetchProviderIdentity({ provider, accessToken: tokens.accessToken });
        const outcome = authStore.completeLogin(
          {
            provider: provider.id,
            subject: identity.subject,
            displayName: identity.displayName,
            email: identity.email,
            emailVerified: identity.emailVerified,
          },
          tx.invitationHash
        );
        if (!outcome) {
          fail('invitationRequired');
          return;
        }
        // The two admission facts, journaled where the outcome is known and
        // nowhere else. `createdOrganisation` and `joinedOrganisation` are
        // exclusive by construction in `completeLogin`, so at most one of
        // these fires per login.
        if (outcome.createdOrganisation) {
          emit({
            kind: 'org.created',
            actorType: 'principal',
            actorId: outcome.viewer.principalId,
            orgId: outcome.viewer.orgId,
            summary: `New organisation "${eventLabel(outcome.viewer.orgName)}" founded by its first login`,
            detail: {
              provider: provider.id,
              role: outcome.viewer.role,
              orgName: eventLabel(outcome.viewer.orgName),
            },
          });
        } else if (outcome.joinedOrganisation) {
          emit({
            kind: 'org.member_joined',
            actorType: 'principal',
            actorId: outcome.viewer.principalId,
            orgId: outcome.viewer.orgId,
            summary: `${eventLabel(outcome.viewer.displayName)} joined "${eventLabel(outcome.viewer.orgName)}" by invitation`,
            detail: {
              provider: provider.id,
              role: outcome.viewer.role,
              member: eventLabel(outcome.viewer.displayName),
              orgName: eventLabel(outcome.viewer.orgName),
            },
          });
        }
        // Provider picture, downloaded ONCE per source URL and stored as
        // bytes. Fail-open in every direction: a refused, oversized or
        // non-image response leaves the account on its procedural orb and the
        // login continues. Re-downloading only when the URL changed keeps
        // every subsequent sign-in free of an outbound request.
        if (identity.avatarUrl) {
          try {
            const existing = authStore.avatarMeta(outcome.viewer.principalId);
            if (existing?.sourceUrl !== identity.avatarUrl) {
              const image = await fetchAvatarImage(identity.avatarUrl);
              if (image) {
                authStore.saveAvatar({
                  principalId: outcome.viewer.principalId,
                  mime: image.mime,
                  bytes: image.bytes,
                  sourceUrl: identity.avatarUrl,
                });
              }
            }
          } catch (error) {
            console.error('[viz auth] avatar import failed', error);
          }
        }
        if (
          provider.id === 'github' &&
          PROJECTS_RUNTIME?.githubConfig &&
          tokens.accessTokenExpiresInSeconds
        ) {
          try {
            persistGitHubUserTokens({
              github: PROJECTS_RUNTIME.githubStore,
              config: PROJECTS_RUNTIME.githubConfig,
              principalId: outcome.viewer.principalId,
              githubSubject: identity.subject,
              tokens,
            });
          } catch (error) {
            console.error('[viz github] failed to persist login tokens', error);
          }
        }
        const issued = issueSession(authStore, outcome.viewer, { secure: AUTH_RUNTIME.secureCookies });
        writeAuthRedirect(res, '/', [
          issued.setCookie,
          clearCookie(OAUTH_TX_COOKIE, AUTH_RUNTIME.secureCookies, '/auth'),
        ]);
      } catch (error) {
        console.error('[viz auth] provider login failed', error);
        fail('providerFailure');
      }
      return;
    }

    if (pathname === '/auth/logout') {
      if (!methodAllowed(req, res, 'POST')) return;
      if (req.headers.origin !== AUTH_RUNTIME.publicOrigin.origin) {
        sendJson(res, 403, { error: 'origin mismatch' });
        return;
      }
      const candidates = logoutSessionCandidatesFromCookieHeader(req.headers.cookie);
      if (candidates.overflow) {
        sendJson(res, 431, { error: 'too many session cookie candidates' });
        return;
      }
      if (candidates.tokens.length > 0) {
        authStore.revokeSessions(candidates.tokens);
      }
      writeAuthRedirect(res, '/', [
        retireSessionCookie({ secure: AUTH_RUNTIME.secureCookies }),
        clearCookie(OAUTH_TX_COOKIE, AUTH_RUNTIME.secureCookies, '/auth'),
      ]);
      return;
    }

    if (pathname === '/auth/whoami') {
      if (!methodAllowed(req, res, 'GET')) return;
      const viewer = AUTH.resolve(req);
      if (!viewer) {
        // 200, not 401: the app shell IS the login surface now, and this
        // capability probe tells it which providers to offer on the arrival
        // gate. A 401 here would bounce the client into a redirect loop.
        sendJson(res, 200, {
          enabled: true,
          authenticated: false,
          providers: AUTH_RUNTIME.providers.map((provider) => ({
            id: provider.id,
            label: provider.label,
          })),
        });
        return;
      }
      const organisations = authStore.listOrganisationsForPrincipal(viewer.principalId);
      sendJson(res, 200, {
        enabled: true,
        authenticated: true,
        // Already visible to this browser through the avatar URL and the org
        // member list; the client needs it as the seed for the fallback orb so
        // an account without a picture still gets colours of its own.
        principalId: viewer.principalId,
        displayName: viewer.displayName,
        // Whether the name still belongs to the provider. The account page
        // labels an imported name; a user-owned one is never re-synchronised.
        displayNameSource: viewer.displayNameSource,
        orgName: viewer.orgName,
        role: viewer.role,
        platformAdmin: viewer.platformAdmin,
        // Same-origin URL, versioned by the content hash so a changed picture
        // busts the browser cache and an unchanged one stays cached.
        avatarUrl: avatarUrlFor(authStore, viewer.principalId),
        activeOrganisation: {
          id: viewer.orgId,
          name: viewer.orgName,
          role: viewer.role,
        },
        organisations: organisations.map((organisation) => ({
          id: organisation.orgId,
          name: organisation.orgName,
          role: organisation.role,
        })),
        providers: AUTH_RUNTIME.providers.map((provider) => ({ id: provider.id, label: provider.label })),
      });
      return;
    }

    const organisationActivation = pathname.match(
      /^\/auth\/organisations\/([^/]+)\/activate$/
    );
    if (organisationActivation) {
      if (!methodAllowed(req, res, 'POST')) return;
      if (req.headers.origin !== AUTH_RUNTIME.publicOrigin.origin) {
        sendJson(res, 403, { error: 'origin mismatch' });
        return;
      }
      const orgId = decodePathComponent(organisationActivation[1]!);
      if (!orgId || !/^[A-Za-z0-9-]{1,128}$/.test(orgId)) {
        sendJson(res, 400, { error: 'invalid organisation id' });
        return;
      }
      const token = sessionTokenFromCookieHeader(req.headers.cookie);
      if (!token) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      const activated = authStore.setSessionOrganisation(token, orgId);
      if (!activated) {
        sendJson(res, 403, { error: 'organisation membership required' });
        return;
      }
      sendJson(res, 200, {
        activeOrganisation: {
          id: activated.orgId,
          name: activated.orgName,
          role: activated.role,
        },
      });
      return;
    }

    if (pathname === '/auth/github/connect') {
      if (!methodAllowed(req, res, 'GET')) return;
      const viewer = AUTH.resolve(req);
      if (!viewer) {
        sendJson(res, 401, { error: GITHUB_COPY.authenticationRequired });
        return;
      }
      if (!PROJECTS_RUNTIME?.githubConfig) {
        sendJson(res, 503, { error: GITHUB_COPY.notConfigured });
        return;
      }
      applyGitHubResult(
        res,
        startGitHubConnect({
          viewer,
          github: PROJECTS_RUNTIME.githubStore,
          config: PROJECTS_RUNTIME.githubConfig,
        })
      );
      return;
    }

    if (pathname === '/auth/github/setup') {
      if (!methodAllowed(req, res, 'GET')) return;
      const viewer = AUTH.resolve(req);
      if (!viewer) {
        sendAuthHtml(res, 401, githubNoticePage(GITHUB_COPY.authenticationRequired));
        return;
      }
      if (!PROJECTS_RUNTIME?.githubConfig || !PROJECTS_RUNTIME.githubClient) {
        sendAuthHtml(res, 503, githubNoticePage(GITHUB_COPY.notConfigured));
        return;
      }
      applyGitHubResult(
        res,
        await completeGitHubSetup({
          viewer,
          github: PROJECTS_RUNTIME.githubStore,
          client: PROJECTS_RUNTIME.githubClient,
          state: url.searchParams.get('state'),
          installationId: url.searchParams.get('installation_id'),
          setupAction: url.searchParams.get('setup_action'),
          authorizePath: '/auth/github/authorize',
          homePath: '/',
          events: emit,
        })
      );
      return;
    }

    if (pathname === '/auth/github/authorize') {
      if (!methodAllowed(req, res, 'GET')) return;
      const viewer = AUTH.resolve(req);
      if (!viewer) {
        sendJson(res, 401, { error: GITHUB_COPY.authenticationRequired });
        return;
      }
      const githubProvider = authProvider('github');
      if (!PROJECTS_RUNTIME?.githubConfig || !githubProvider) {
        sendJson(res, 503, { error: GITHUB_COPY.notConfigured });
        return;
      }
      try {
        applyGitHubResult(
          res,
          startGitHubUserAuthorize({
            viewer,
            github: PROJECTS_RUNTIME.githubStore,
            provider: githubProvider,
            redirectUri: AUTH_RUNTIME.redirectUri,
            createOauthState: (state, codeVerifier) => {
              authStore.createOauthState({
                state,
                provider: githubProvider.id,
                codeVerifier,
                invitationHash: null,
                ttlMs: OAUTH_TX_TTL_MS,
              });
            },
            serializeOauthCookie: (state) =>
              serializeCookie(OAUTH_TX_COOKIE, state, {
                secure: AUTH_RUNTIME.secureCookies,
                path: '/auth',
                maxAgeSeconds: OAUTH_TX_TTL_MS / 1000,
              }),
          })
        );
      } catch (error) {
        if (error instanceof TooManyPendingOauthStatesError) {
          sendJson(res, 429, { error: 'too many pending login transactions' });
          return;
        }
        throw error;
      }
      return;
    }

    // AVATAR BYTES — same-origin, so rendering the app shell never talks to a
    // provider CDN and no viewer IP leaks to GitHub or Google on page load.
    // Readable by a viewer who shares an organisation with the subject: the
    // org card and the member list show faces. Anything else is a 404, not a
    // 403 — an outsider learns nothing about which principals exist.
    const avatarRoute = pathname.match(/^\/auth\/avatar\/([^/]+)$/);
    if (avatarRoute) {
      if (!methodAllowed(req, res, 'GET')) return;
      const viewer = AUTH.resolve(req);
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      const principalId = decodePathComponent(avatarRoute[1]!);
      if (!principalId || !authStore.sharesOrganisation(viewer.principalId, principalId)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const avatar = authStore.readAvatar(principalId);
      if (!avatar) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const etag = `"${avatar.etag}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, max-age=300' });
        res.end();
        return;
      }
      res.writeHead(200, {
        // The stored mime came from sniffing the bytes, not from the
        // provider's header; nosniff keeps the browser on that verdict.
        'content-type': avatar.mime,
        'content-length': avatar.bytes.byteLength,
        'cache-control': 'private, max-age=300',
        etag,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(avatar.bytes);
      return;
    }

    if (pathname.startsWith('/auth/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
  }

  // ------------------------------------------------------------------- gate
  if (AUTH && pathname.startsWith('/api/')) {
    const viewer = AUTH.resolve(req);
    if (!viewer) {
      sendJson(res, 401, { error: 'authentication required' });
      return;
    }

    // OPERATOR SURFACES. The registry, skill store and burn-in APIs are
    // instance-global: org runs mutate the shared registry and these routes
    // read it in full (atom names, system prompts, skill bodies). Behind the
    // org gate they belong to the PLATFORM ADMIN alone — an invitation must
    // not grant read access to operator-level state (review 2026-08-20 §2.2).
    const operatorApi =
      pathname === '/api/registries' ||
      pathname.startsWith('/api/registry/') ||
      pathname === '/api/skills' ||
      pathname.startsWith('/api/skills/') ||
      pathname === '/api/burnin';
    if (operatorApi && !viewer.platformAdmin) {
      sendJson(res, 403, { error: 'platform admin required' });
      return;
    }

    // ACCOUNT SELF-CARE — the viewer's own name and per-tier model pins.
    // Self-scoped by construction: the principal id comes from the resolved
    // session, never from the request, so there is no object to authorise.
    if (pathname === '/api/account' || pathname === '/api/account/models') {
      const authStore = AUTH.store!;
      if (pathname === '/api/account/models' && req.method === 'GET') {
        sendJson(res, 200, {
          pins: authStore.modelPins(viewer.principalId),
          // Labels for the "operator default" choice, resolved from the HOST
          // environment rather than a second copy of the tier defaults.
          defaults: operatorTierDefaults(process.env),
          choices: TIER_MODEL_CHOICES,
        });
        return;
      }
      const method = pathname === '/api/account' ? 'PATCH' : 'PUT';
      if (!methodAllowed(req, res, method)) return;
      if (!sameOrigin(req, res)) return;
      let body: unknown;
      try {
        body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'request body is not valid JSON' });
        return;
      }
      if (pathname === '/api/account') {
        const input = body as { displayName?: unknown };
        if (typeof input.displayName !== 'string') {
          sendJson(res, 400, { error: 'displayName is required' });
          return;
        }
        try {
          const displayName = authStore.setDisplayName(viewer.principalId, input.displayName);
          emit({
            kind: 'principal.renamed',
            actorType: 'principal',
            actorId: viewer.principalId,
            orgId: viewer.orgId,
            summary: `Account renamed to "${eventLabel(displayName)}"`,
          });
          sendJson(res, 200, { displayName, displayNameSource: 'user' });
        } catch (error) {
          sendJson(res, 400, {
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
        return;
      }
      try {
        const pins = authStore.setModelPins(viewer.principalId, (body as { pins?: unknown }).pins);
        sendJson(res, 200, {
          pins,
          defaults: operatorTierDefaults(process.env),
          choices: TIER_MODEL_CHOICES,
        });
      } catch {
        // The closed choice list is the contract; a rejected value is a
        // client bug, and echoing zod's shape back adds nothing.
        sendJson(res, 400, { error: 'each tier must be null or one of the offered models' });
      }
      return;
    }

    // THE VIEWER'S OWN ORGANISATION. Org-scoped, not operator-scoped: every
    // member sees who else is in the organisation they belong to. Emails are
    // deliberately absent — provider emails are display attributes and
    // GitHub's is not even a verified-email assertion.
    if (pathname === '/api/org') {
      if (!methodAllowed(req, res, 'GET')) return;
      const authStore = AUTH.store!;
      const organisation = authStore.getOrganisationWithMembers(viewer.orgId);
      if (!organisation) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const canSeeInvitations = viewer.role === 'org:owner' || viewer.role === 'org:admin';
      sendJson(res, 200, {
        id: organisation.orgId,
        name: organisation.name,
        createdAt: organisation.createdAt,
        viewerRole: viewer.role,
        members: organisation.members.map((member) => ({
          principalId: member.principalId,
          displayName: member.displayName,
          role: member.role,
          joinedAt: member.joinedAt,
          platformAdmin: member.platformAdmin,
          avatarUrl: member.avatarEtag
            ? `/auth/avatar/${encodeURIComponent(member.principalId)}?v=${member.avatarEtag.slice(0, 16)}`
            : null,
        })),
        projectCount: PROJECTS_RUNTIME
          ? PROJECTS_RUNTIME.store.listProjects(viewer.orgId).length
          : 0,
        // Only owners and admins can mint invitations, so only they are told
        // how many are outstanding.
        pendingInvitations: canSeeInvitations
          ? authStore.countLiveInvitations(viewer.orgId)
          : null,
      });
      return;
    }

    // ADMIN CONTROL PLANE — organisations and invitations, admin-only.
    if (pathname.startsWith('/api/admin/')) {
      if (!viewer.platformAdmin) {
        sendJson(res, 403, { error: 'platform admin required' });
        return;
      }
      const authStore = AUTH.store!;
      // THE AUDIT JOURNAL. Newest-first, cursor-paged on `seq` — the same
      // reading direction as the runs timeline. `before` is exclusive so a
      // page boundary can neither repeat nor skip a row, which ordering by
      // `at` could not guarantee (one login burst shares a millisecond).
      if (pathname === '/api/admin/events') {
        if (!methodAllowed(req, res, 'GET')) return;
        if (!EVENTS) {
          sendJson(res, 200, { events: [], nextBefore: null });
          return;
        }
        // `Number(null)` is 0, not NaN, so an ABSENT parameter must be tested
        // for presence before it is converted — otherwise a plain
        // `/api/admin/events` asks for a zero-length page (clamped to one
        // row) and the journal looks almost empty.
        const rawBefore = url.searchParams.get('before');
        const rawLimit = url.searchParams.get('limit');
        const before = rawBefore === null ? Number.NaN : Number(rawBefore);
        const limit = rawLimit === null ? Number.NaN : Number(rawLimit);
        sendJson(
          res,
          200,
          // Out-of-range values CLAMP inside `list` rather than 400: an
          // operator typing limit=5000 gets the maximum page, not an error.
          EVENTS.list({
            ...(Number.isFinite(before) && before > 0 ? { before } : {}),
            ...(Number.isFinite(limit) ? { limit } : {}),
            ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind')! } : {}),
            ...(url.searchParams.get('severity')
              ? { severity: url.searchParams.get('severity')! }
              : {}),
            ...(url.searchParams.get('orgId') ? { orgId: url.searchParams.get('orgId')! } : {}),
          })
        );
        return;
      }
      // The PRODUCT ledger's tail, as a SEPARATE read (decision 4). The two
      // journals answer different questions — what happened on the platform
      // versus what the catalogue learned — and are never joined or merged;
      // `lifecycle_events` keeps its counter-checking semantics and its own
      // `ledger check` consumer.
      if (pathname === '/api/admin/ledger') {
        if (!methodAllowed(req, res, 'GET')) return;
        const requested = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(requested) ? requested : 50;
        // `readLedgerTail` is bounded, newest-first and fail-open: a store
        // without the table reads empty rather than 500-ing the admin surface.
        sendJson(res, 200, {
          events: readLedgerTail(limit, openStoreHandle(DBS[0]!.path, LEDGER_TABLE_DDL)),
        });
        return;
      }
      if (pathname === '/api/admin/organisations') {
        if (!methodAllowed(req, res, 'GET')) return;
        sendJson(res, 200, authStore.listOrganisationsWithMembers());
        return;
      }
      if (pathname === '/api/admin/invitations') {
        if (!methodAllowed(req, res, 'POST')) return;
        if (!sameOrigin(req, res)) return;
        let body: unknown;
        try {
          body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
        } catch {
          sendJson(res, 400, { error: 'request body is not valid JSON' });
          return;
        }
        const input = body as { orgId?: unknown; role?: unknown; ttlHours?: unknown };
        const orgId = typeof input.orgId === 'string' ? input.orgId.trim() : '';
        const role = typeof input.role === 'string' ? input.role : 'org:member';
        const ttlHours = input.ttlHours === undefined ? 24 : Number(input.ttlHours);
        if (!orgId || !ORG_ROLES.includes(role as OrgRole)) {
          sendJson(res, 400, { error: 'orgId and a valid role are required' });
          return;
        }
        if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) {
          sendJson(res, 400, { error: 'ttlHours must be within (0, 720]' });
          return;
        }
        if (!authStore.listOrganisations().some((organisation) => organisation.orgId === orgId)) {
          sendJson(res, 404, { error: 'unknown organisation' });
          return;
        }
        const token = randomBytes(32).toString('base64url');
        try {
          const invitation = authStore.createInvitation({
            orgId,
            token,
            role: role as OrgRole,
            ttlMs: ttlHours * 60 * 60 * 1_000,
          });
          // The TOKEN never enters the journal, not even hashed: an audit row
          // must not be a bearer credential. Who minted it, for which org and
          // at which role is the auditable part.
          emit({
            kind: 'invitation.created',
            actorType: 'principal',
            actorId: viewer.principalId,
            orgId: invitation.orgId,
            summary: `Invitation minted for "${eventLabel(invitation.orgName)}" at role ${role}`,
            detail: { role, ttlHours, expiresAt: invitation.expiresAt },
          });
          sendJson(res, 200, {
            token,
            url: AUTH_RUNTIME
              ? new URL(`/?invite=${encodeURIComponent(token)}`, AUTH_RUNTIME.publicOrigin).href
              : `/?invite=${encodeURIComponent(token)}`,
            orgId: invitation.orgId,
            orgName: invitation.orgName,
            role,
            expiresAt: invitation.expiresAt,
          });
        } catch (error) {
          sendJson(res, 400, {
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // WEB PUSH — principal-scoped self-service. The permission ask lives in
    // the client during the viewer's first live run (that is where the value
    // shows), never in the login flow; these routes only store what the
    // browser's PushManager minted. Same-origin POSTs, bounded bodies, and
    // the store validates key material before persisting.
    if (pathname === '/api/push/config') {
      if (!methodAllowed(req, res, 'GET')) return;
      sendJson(
        res,
        200,
        PUSH_RUNTIME
          ? { enabled: true, publicKey: PUSH_RUNTIME.publicKey }
          : { enabled: false }
      );
      return;
    }
    if (pathname === '/api/push/subscribe' || pathname === '/api/push/unsubscribe') {
      if (!methodAllowed(req, res, 'POST')) return;
      if (!sameOrigin(req, res)) return;
      if (!PUSH_RUNTIME) {
        sendJson(res, 404, { error: 'push notifications are not enabled' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse((await readBodyBounded(req, 8_192)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'request body is not valid JSON' });
        return;
      }
      const input = body as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
        locale?: unknown;
      };
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
      if (pathname === '/api/push/unsubscribe') {
        const removed = PUSH_RUNTIME.store.deleteSubscription(viewer.principalId, endpoint);
        // The endpoint is a per-browser bearer URL: journal THAT a device was
        // detached, never which one.
        if (removed) {
          emit({
            kind: 'push.unsubscribed',
            actorType: 'principal',
            actorId: viewer.principalId,
            orgId: viewer.orgId,
            summary: 'Notification subscription removed for one browser',
          });
        }
        sendJson(res, 200, { removed });
        return;
      }
      const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh : '';
      const auth = typeof input.keys?.auth === 'string' ? input.keys.auth : '';
      try {
        PUSH_RUNTIME.store.saveSubscription({
          principalId: viewer.principalId,
          endpoint,
          p256dh,
          auth,
          // The browser's language, captured now because a push is generated
          // later with no request to read a header off. Anything unrecognised
          // becomes `en` rather than a 400: a wrong language is a far smaller
          // failure than a refused subscription.
          locale: asPushLocale(typeof input.locale === 'string' ? input.locale : null),
        });
      } catch (error) {
        sendJson(res, 400, {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        return;
      }
      emit({
        kind: 'push.subscribed',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        summary: 'Notification subscription added for one browser',
      });
      sendJson(res, 200, { subscribed: true });
      return;
    }
  }

  if (pathname === '/' || pathname === '/index.html') {
    // The app shell goes to EVERY browser, authenticated or not: the arrival
    // gate (crystal, tagline) IS the login surface — a new visitor's first
    // touch is the product, not a bare server form. The shell contains no
    // identity or run data, /api/* stays 401 without a session, and whoami
    // only names the configured providers; the no-JS fallback keeps the
    // plain selector at /auth/login.
    if (DEV_UI_URL) {
      const target = new URL(`${pathname}${url.search}`, DEV_UI_URL);
      res.writeHead(307, {
        location: target.href,
        'content-length': '0',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    if (!existsSync(UI_HTML_PATH)) {
      send(res, 500, 'viz client missing at ' + UI_HTML_PATH, 'text/plain; charset=utf-8');
      return;
    }
    const html = readFileSync(UI_HTML_PATH);
    // `no-cache` permits the service worker's offline copy while requiring
    // normal HTTP caches to revalidate. With the gate on, the login-capable
    // shell also pins that it cannot be framed.
    if (AUTH) {
      res.writeHead(200, {
        ...SHELL_SECURITY_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-cache',
      });
      res.end(html);
      return;
    }
    send(res, 200, html, 'text/html; charset=utf-8', 'no-cache');
    return;
  }

  if (PROJECTS_RUNTIME && AUTH) {
    const viewer = AUTH.resolve(req);
    if (pathname === '/api/github/installations') {
      if (!methodAllowed(req, res, 'GET')) return;
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      sendJson(res, 200, PROJECTS_RUNTIME.projects.listInstallations(viewer));
      return;
    }

    if (pathname === '/api/projects') {
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, PROJECTS_RUNTIME.projects.listProjects(viewer));
        return;
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req, res)) return;
        try {
          sendJson(res, 201, await PROJECTS_RUNTIME.projects.createProject(req, viewer));
        } catch (error) {
          if (error instanceof ProjectHttpError) {
            sendJson(res, error.status, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, POST', 'content-length': '0', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const projectRuns = pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
    if (projectRuns) {
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      const projectId = decodePathComponent(projectRuns[1]!);
      if (!projectId) {
        sendJson(res, 400, { error: 'bad project id' });
        return;
      }
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, PROJECTS_RUNTIME.projects.listProjectRuns(viewer, projectId));
        } catch (error) {
          if (error instanceof ProjectHttpError) {
            sendJson(res, error.status, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req, res)) return;
        try {
          sendJson(res, 201, await PROJECTS_RUNTIME.projects.startProjectRun(req, viewer, projectId));
        } catch (error) {
          if (error instanceof ProjectHttpError) {
            sendJson(res, error.status, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, POST', 'content-length': '0', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const cancelRun = pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (cancelRun) {
      if (!methodAllowed(req, res, 'POST')) return;
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (!sameOrigin(req, res)) return;
      const projectId = decodePathComponent(cancelRun[1]!);
      const projectRunId = decodePathComponent(cancelRun[2]!);
      if (!projectId || !projectRunId) {
        sendJson(res, 400, { error: 'bad project run id' });
        return;
      }
      try {
        sendJson(
          res,
          200,
          await PROJECTS_RUNTIME.projects.cancelProjectRun(viewer, projectId, projectRunId)
        );
      } catch (error) {
        if (error instanceof ProjectHttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const retryPublish = pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/publish$/);
    if (retryPublish) {
      if (!methodAllowed(req, res, 'POST')) return;
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (!sameOrigin(req, res)) return;
      const projectId = decodePathComponent(retryPublish[1]!);
      const projectRunId = decodePathComponent(retryPublish[2]!);
      if (!projectId || !projectRunId) {
        sendJson(res, 400, { error: 'bad project run id' });
        return;
      }
      try {
        sendJson(
          res,
          200,
          await PROJECTS_RUNTIME.projects.retryPublication(viewer, projectId, projectRunId)
        );
      } catch (error) {
        if (error instanceof ProjectHttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
  }

  if (pathname === '/api/runs') {
    sendJson(res, 200, listIndex(AUTH?.resolve(req) ?? null));
    return;
  }

  if (pathname.startsWith('/api/runs/')) {
    const id = decodePathComponent(pathname.slice('/api/runs/'.length));
    if (id === null || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
      sendJson(res, 400, { error: 'bad id' });
      return;
    }
    const file = resolveRunFile(id, AUTH?.resolve(req) ?? null);
    if (!file) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const body = readFileSync(file);
    // DELTA MODE (?after=<n>): the live poll re-fetched the WHOLE run every
    // second, so a long run re-shipped a growing payload ~60×/minute to
    // learn about a handful of new events. With `after`, the response
    // carries the run header (totals, endedAt, result…) plus ONLY the
    // events past index n, and `eventsFrom` tells the client where the
    // slice starts. Absent the param the full run is served byte-for-byte
    // as before — first load, non-live runs, and any other consumer are
    // untouched.
    const afterRaw = url.searchParams.get('after');
    if (afterRaw !== null) {
      const after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        sendJson(res, 400, { error: 'bad after' });
        return;
      }
      const run = safeParseJson<{ events?: unknown[] } | null>(body.toString('utf8'), null);
      if (!run || !Array.isArray(run.events)) {
        // Unparseable or shapeless on disk (a torn partial write): fall
        // back to the full body rather than inventing a delta.
        send(res, 200, body, 'application/json; charset=utf-8');
        return;
      }
      const total = run.events.length;
      // A shrunken event list means this is a DIFFERENT run than the one
      // the client is diffing against (id reuse / rewritten trace) — send
      // everything and let the client resync from scratch.
      const from = after <= total ? after : 0;
      sendJson(res, 200, { ...run, events: run.events.slice(from), eventsFrom: from, eventsTotal: total });
      return;
    }
    send(res, 200, body, 'application/json; charset=utf-8');
    return;
  }

  if (pathname === '/api/registries') {
    sendJson(res, 200, listRegistries());
    return;
  }

  if (pathname === '/api/burnin') {
    sendJson(res, 200, loadBurnin());
    return;
  }

  if (pathname === '/api/skills') {
    sendJson(res, 200, listSkillNamespaces());
    return;
  }

  if (pathname.startsWith('/api/skills/')) {
    const rest = decodePathComponent(pathname.slice('/api/skills/'.length));
    if (rest === null) {
      sendJson(res, 400, { error: 'bad skill path' });
      return;
    }
    const parts = rest.split('/').filter(Boolean);
    // Validate every component up-front so a malformed segment can't
    // slip past the SkillRegistry path-component check (which throws
    // on unsafe chars but produces a less friendly HTTP response).
    if (parts.length === 0 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p))) {
      sendJson(res, 400, { error: 'bad skill path' });
      return;
    }
    if (parts.length === 1) {
      try {
        sendJson(res, 200, listSkillsForL1(parts[0]!));
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
    if (parts.length === 2) {
      try {
        const skill = getSkillById(parts[0]!, parts[1]!);
        if (!skill) {
          sendJson(res, 404, { error: 'skill not found', l1: parts[0], id: parts[1] });
          return;
        }
        sendJson(res, 200, skill);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
    sendJson(res, 400, { error: 'bad skill path' });
    return;
  }

  if (pathname.startsWith('/api/registry/')) {
    const id = decodePathComponent(pathname.slice('/api/registry/'.length));
    if (id === null || !/^[A-Za-z0-9_.-]+$/.test(id)) {
      sendJson(res, 400, { error: 'bad id' });
      return;
    }
    try {
      const dump = dumpRegistry(id);
      if (!dump) {
        sendJson(res, 404, { error: 'unknown registry id', id });
        return;
      }
      sendJson(res, 200, dump);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  if (pathname === '/api/profiles') {
    // READ-ONLY, and deliberately so: it returns compile-time constants and
    // the command to copy, NOT a way to start anything. The server stays what
    // it is — no writeFileSync, no child_process, SQLite readonly — so this
    // adds zero attack surface. Launching from the browser is a separate,
    // opt-in decision documented in AGENTS.md; the reason it is not here is
    // that a run can call BACK into this server (`fetch_url` has no URL
    // allowlist by design, and run_shell's is "STEERING, not a boundary"),
    // so any secret served over HTTP would be readable by the very code it
    // is meant to gate.
    //
    // `defaults.dbPath` / `defaults.workspace` are NOT exposed: the run
    // resolves `process.env[...] ?? default` against ITS OWN environment, so
    // publishing the static default would state a fact that may be false.
    sendJson(res, 200, {
      launchEnabled: false,
      profiles: LAUNCHABLE_PROFILES.map(({ profile: p, npmScript }) => ({
        id: p.id,
        npmScript,
        label: p.guidance.label,
        help: p.guidance.help,
        examples: [...p.guidance.examples],
      })),
    });
    return;
  }

  const assetPath = resolve(CLIENT_DIR, `.${pathname}`);
  const assetRelative = relative(CLIENT_DIR, assetPath);
  if (
    assetRelative !== '' &&
    !assetRelative.startsWith('..') &&
    !assetRelative.startsWith('/') &&
    existsSync(assetPath) &&
    statSync(assetPath).isFile()
  ) {
    send(
      res,
      200,
      readFileSync(assetPath),
      assetContentType(assetPath),
      staticCacheControl(assetPath)
    );
    return;
  }

  send(res, 404, 'not found', 'text/plain; charset=utf-8');
}

server.listen(cli.port, cli.host, () => {
  console.log(`Atoma viz server — http://${cli.host}:${cli.port}/`);
  if (AUTH) {
    console.log(
      `auth: REQUIRED (providers: ${AUTH_RUNTIME!.providers.map((provider) => provider.id).join(', ')}; origin: ${AUTH_RUNTIME!.publicOrigin.origin})`
    );
    console.log(
      `project runs: ${join(PROJECTS_ROOT, 'orgs', '<orgId>', 'projects', '<projectId>', 'runs', '<runId>')}`
    );
  } else {
    console.log('auth: none (set ATOMA_VIZ_AUTH=1 to require login)');
    console.log(`serving runs from: ${RUNS_DIR}`);
    if (!existsSync(RUNS_DIR)) {
      console.log(`(directory does not exist yet — it will be created when a run is recorded)`);
    }
  }
  if (PROJECTS_RUNTIME?.githubConfig) {
    console.log(`github app: ${PROJECTS_RUNTIME.githubConfig.appSlug}`);
  } else if (PROJECTS_RUNTIME) {
    console.log('github app: not configured');
  }
  console.log('registries exposed:');
  for (const d of DBS) {
    const mark = existsSync(d.path) ? '✓' : '✗';
    console.log(`  [${mark}] ${d.id}  ${d.path}`);
  }
  const skillsMark = existsSync(SKILLS_DIR) ? '✓' : '✗';
  console.log(`skills root: [${skillsMark}] ${SKILLS_DIR}`);
});
