import { updateOrgModels } from '../auth/orgModels.js';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestWaitsForDeployment } from './deployment.js';
import Database from 'better-sqlite3';
import { SkillRegistry } from '../skills/registry.js';
import { readBoundedRunFile, sortRunIndex, summarizeTraceFile } from './runIndex.js';
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
import {
  HOST_SUBSCRIPTION_FAMILIES,
  HOST_SUBSCRIPTION_FAMILY,
  LLM_PROVIDER_CATALOG,
} from '../core/providerCatalog.js';
import {
  hostSubscriptionSummary,
  isHostSubscriptionSelection,
  isPrincipalSubscriptionSelection,
  ledgerTouchesPrincipalSubscription,
  ledgerTouchesSubscription,
  principalSubscriptionSummary,
  runPayerDetail,
  selectionsMixCodexOwners,
} from '../contracts/runPayers.js';
import { operatorTierDefaults } from '../contracts/tierModels.js';
import {
  ORG_ROLES,
  sha256Hex,
  PROVIDER_KEY_PROVIDERS,
  TooManyPendingOauthStatesError,
  type AuthStore,
  type OrgRole,
  type ProviderKeyProvider,
  type Viewer,
} from '../auth/store.js';
import { resolveSecretEncryption, SECRET_ENCRYPTION_ENV } from '../auth/secretEncryption.js';
import {
  AccountSubscriptionService,
  ACCOUNT_PROFILES_ROOT_ENV,
  CodexSubscriptionCapacityError,
  CodexSubscriptionConflictError,
  CodexSubscriptionUnavailableError,
} from '../auth/subscriptionProfiles.js';
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
import {
  DEFAULT_PROJECTS_ROOT,
  ProjectRunCoordinator,
} from '../projects/coordinator.js';
import { GitHubPublisher } from '../projects/publisher.js';
import { ProjectHttpError, ProjectService, roleAtLeast } from '../projects/service.js';
import { PreviewStore } from '../preview/store.js';
import { PreviewPolicyError } from '../preview/policy.js';
import { recordDeliveredPreview } from '../preview/service.js';
import { previewConfigPresent, previewEnabled, snapshotPreviewConfig } from '../preview/config.js';
import { PreviewClaimRegistry } from '../preview/claims.js';
import {
  PreviewRouteTable,
  startPreviewGateway,
  type RunningPreviewGateway,
} from '../preview/gatewayServer.js';
import { PreviewManager } from '../preview/manager.js';
import { PreviewHttpService } from '../preview/httpService.js';
import { DockerLauncher } from '../launcher/docker.js';
import { DEFAULT_WORKER_IMAGE } from '../tools/containerExecutor.js';
import { PushStore } from './push/store.js';
import { PushNotifier } from './push/notifier.js';
import {
  NotificationRouter,
  cachedAudienceDirectory,
  resolveAudience,
  type AudienceDirectory,
} from './push/router.js';
import { PUSH_ROUTES, asPushLocale, renderPush } from './push/routes.js';
import { draftAnnouncementTranslations } from './push/translate.js';
import { organisationsForSegment } from './push/segments.js';
import {
  announcementDetailFits,
  announcementDraftSchema,
  announcementRequestSchema,
  type AnnouncementDetail,
} from '../contracts/announcements.js';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../contracts/locales.js';
import { PLATFORM_EVENT_DETAIL_MAX_CHARS } from '../contracts/platformEvents.js';
import { makeAnthropicClient } from '../run/auth.js';
import { makeBaseClient, resolveBaseProviderKind } from '../run/providers.js';
import type { LlmClient } from '../core/types.js';
import { PlatformEventLog } from '../platform/events.js';
import { eventLabel } from '../contracts/platformEvents.js';
import { sentinelRuleTable } from '../sentinel/rules.js';
import {
  operatorRunSource,
  projectRunSource,
  type SentinelDiscovery,
  type SentinelRunSource,
} from '../sentinel/sources.js';
import { SentinelWatch, SENTINEL_DEFAULT_INTERVAL_MS } from '../sentinel/watch.js';
import {
  sentinelCostAlertFromEnv,
  sentinelIntervalFromEnv,
  startResidentSentinel,
  sleepInhibitorHint,
  unarmedSentinelHealth,
  vizSentinelEnabled,
  type ResidentSentinel,
  type SentinelHealth,
} from '../sentinel/resident.js';
import { peekSentinelWatch } from '../sentinel/lease.js';
import { analyseTarget, pendingTargets, resolveTarget, type AnalystOptions } from '../supervisor/analyst.js';
import { anyRunActive } from '../supervisor/activity.js';
import { dispatchConfigFromEnv } from '../supervisor/dispatch.js';
import {
  analystBudgetFromEnv,
  analystQuietMsFromEnv,
  startResidentAnalyst,
  vizAnalystEnabled,
  type ResidentAnalyst,
} from '../supervisor/resident.js';
import { analystProvider } from '../supervisor/session.js';
import { McpHttpHost } from '../mcp/http.js';
import type { McpCaller } from '../mcp/identity.js';
import { buildServer as buildMcpServer } from '../mcp/server.js';
import { signalActiveRunOnExit } from '../mcp/run.js';
import type { McpToolDeps } from '../mcp/tools.js';
import { injectAppShellSeo, robotsTxt, sitemapXml } from './seo.js';
// The MCP run lease, read for CONTEXT only (which pid holds the run slot) and
// never as a detector. `src/sentinel/watch.ts` already reaches for it, so this
// adds a name, not a dependency.
import { mcpRunLockPath } from '../mcp/runLock.js';

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
  /** Refuse to host the mechanical watch, whatever the environment says. */
  noSentinel: boolean;
  sentinelIntervalMs?: number;
  costAlertUsd?: number;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = {
    // `ATOMA_RUNS_DIR` is where the RUNNER writes, and `viz-dev.mjs` forwards
    // no `--dir`, so a hardcoded './runs' meant an operator who moved their
    // corpus had a permanently empty Runs tab and, now, a watch confidently
    // screening a directory nothing writes to.
    dir: process.env['ATOMA_RUNS_DIR'] ?? './runs',
    port: 4111,
    host: '127.0.0.1',
    dbs: [],
    noSentinel: false,
  };
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
    else if (flag === '--no-sentinel') out.noSentinel = true;
    else if (flag === '--sentinel-interval') {
      const raw = takeValue();
      if (!/^\d+$/.test(raw) || Number(raw) < 1_000) {
        throw new Error('--sentinel-interval must be at least 1000 (ms)');
      }
      out.sentinelIntervalMs = Number(raw);
    } else if (flag === '--cost-alert') {
      const raw = takeValue();
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--cost-alert must be a positive number of USD');
      }
      out.costAlertUsd = value;
    } else throw new Error(`unknown viz argument: ${flag}`);
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
 * THE OPERATOR'S SECRET-ENCRYPTION CONTEXT for organisation provider keys.
 * Resolved ONCE at boot from host env — the same launch-time,
 * host-sourced-policy pattern as the auth gate itself. `context` is null
 * when `ATOMA_SECRET_ENCRYPTION_KEY` (or the GitHub token wrapping key) is
 * absent: key MANAGEMENT routes then refuse with an operator-facing message, and stored keys simply do not
 * decrypt (fail-open per run, never a crash).
 */
const SECRET_ENCRYPTION = (() => {
  try {
    return { context: resolveSecretEncryption(process.env) };
  } catch (error) {
    throw new Error(
      `Invalid ${SECRET_ENCRYPTION_ENV} configuration: ${String(
        error instanceof Error ? error.message : error
      )}`
    );
  }
})();

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

/**
 * PERSONAL PROVIDER PROFILES. Only authenticated deployments have principals,
 * so the profile authority follows the auth gate. Credential bytes stay in
 * provider-owned private directories; callbacks journal only provider names.
 */
const ACCOUNT_SUBSCRIPTIONS: AccountSubscriptionService | null = AUTH?.store
  ? new AccountSubscriptionService({
      auth: AUTH.store,
      sourceEnv: process.env,
      ...(process.env[ACCOUNT_PROFILES_ROOT_ENV]?.trim()
        ? { profilesRoot: process.env[ACCOUNT_PROFILES_ROOT_ENV].trim() }
        : {}),
      onConnected: ({ principalId, orgId }) => {
        emit({
          kind: 'principal.subscription_connected',
          actorType: 'principal',
          actorId: principalId,
          orgId,
          summary: 'Personal Codex subscription connected',
          detail: { provider: 'codex' },
        });
      },
      onDisconnected: ({ principalId, orgId }) => {
        emit({
          kind: 'principal.subscription_disconnected',
          actorType: 'principal',
          actorId: principalId,
          orgId,
          summary: 'Personal Codex subscription disconnected',
          detail: { provider: 'codex' },
        });
      },
    })
  : null;

// Closing is synchronous at this boundary: pending profile app-servers receive
// SIGTERM before Node exits. A startup reconciliation handles hard crashes.
process.once('exit', () => ACCOUNT_SUBSCRIPTIONS?.close());

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
 * THE VIZ SERVER'S ONLY LLM CLIENT, and it exists for exactly one thing:
 * drafting announcement translations for an admin to review.
 *
 * Built on FIRST USE and never at boot. A control plane that constructed a
 * provider at startup would demand a credential from every deployment that
 * never sends an announcement, and would fail to start over a feature nobody
 * asked for. `undefined` means "not tried yet", `null` means "tried, none
 * available" — the distinction is what stops a missing provider from being
 * re-resolved on every request.
 */
let announcementLlm: LlmClient | null | undefined;
function announcementTranslator(): LlmClient | null {
  if (announcementLlm !== undefined) return announcementLlm;
  try {
    const kind = resolveBaseProviderKind(process.env['ATOMA_LLM']);
    announcementLlm = makeBaseClient(
      kind,
      kind === 'anthropic' ? { anthropic: makeAnthropicClient() } : {}
    );
  } catch (error) {
    // No provider configured here is a normal deployment, not a fault: the
    // form falls back to the admin writing every language by hand. But the
    // REASON is written down. Swallowing it made an unset `ATOMA_LLM` — which
    // defaults to `anthropic` and then demands a credential — indistinguishable
    // on screen from a deployment that deliberately has no provider, with
    // nothing anywhere to tell the two apart (measured 2026-08-23).
    process.stderr.write(
      `[atoma viz] no announcement translator: ${error instanceof Error ? error.message : String(error)}\n`
    );
    announcementLlm = null;
  }
  return announcementLlm;
}

/**
 * The audience readers over the auth store — the push router's view of
 * identity, and the ONLY one. The notification-tray read (`/api/notifications`)
 * replays the same resolution over journal rows, so both consume this one
 * wiring: a tray that resolved audiences its own way would drift from what was
 * actually pushed.
 */
function audienceDirectory(authStore: AuthStore): AudienceDirectory {
  return {
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
    // Every principal, membership or not: an announcement addressed to the
    // whole instance must not silently skip someone who has yet to join an
    // organisation but has already subscribed a device.
    allPrincipals: () => authStore.listPrincipals().map((principal) => principal.principalId),
    membersOf: (orgIds) => {
      const wanted = new Set(orgIds);
      return authStore
        .listOrganisationsWithMembers()
        .filter((organisation) => wanted.has(organisation.orgId))
        .flatMap((organisation) => organisation.members.map((member) => member.principalId));
    },
  };
}

/**
 * THE ONE PATH FROM AN EVENT TO A DEVICE. Subscribing the router to the log
 * means no emitter can notify anybody directly: journal the fact, and the
 * routing table decides. The audience readers are the auth store's own
 * queries, wrapped so the router cannot reach anything else.
 */
if (EVENTS && PUSH_RUNTIME && AUTH?.store) {
  const router = new NotificationRouter({
    notifier: PUSH_RUNTIME.notifier,
    directory: audienceDirectory(AUTH.store),
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
  /**
   * ONE construction of the viewer-token resolver, shared by the publisher and
   * by the setup callback that must corroborate an untrusted `installation_id`
   * against the connecting user. Null only when there is no GitHub login
   * provider, in which case no user token can exist to resolve.
   */
  readonly resolveUserAccessToken: ((principalId: string) => Promise<string>) | null;
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
  const resolveUserAccessToken =
    appConfig && githubProvider
      ? (principalId: string): Promise<string> =>
          resolveGitHubUserAccessToken({
            github: githubStore,
            config: appConfig,
            provider: githubProvider,
            principalId,
          })
      : null;
  const publisher = appConfig && githubClient
    ? new GitHubPublisher({
        client: githubClient,
        github: githubStore,
        store: projectStore,
        events: emit,
        ...(resolveUserAccessToken ? { resolveUserAccessToken } : {}),
      })
    : undefined;
  // Same consolidated product store, opened through its own DDL constant.
  const previewStore = PreviewStore.open(dbPath);
  const coordinator = new ProjectRunCoordinator({
    store: projectStore,
    dbPath,
    projectsRoot: PROJECTS_ROOT,
    ...(publisher ? { publisher } : {}),
    // Describe the deliverable while the workspace is still this run's. The
    // adapter stays one call wide; `src/preview/service.ts` owns what a
    // preview is.
    describeDeliveredPreview: (subject) => {
      recordDeliveredPreview(previewStore, subject);
    },
    // Accounts choose their own per-tier models in Settings; without a gate
    // there are no accounts and the operator's host pins are the only pins.
    ...(AUTH?.store
      ? { tierModelsFor: (principalId: string) => AUTH.store!.modelPins(principalId) }
      : {}),
    // The ORG level of the precedence chain, and the org's own provider
    // keys. Both ride the same fail-open resolver contract as
    // `tierModelsFor`; the encryption context is resolved ONCE from host
    // env at boot (launch-time host-sourced policy) — absent means org key
    // management is unavailable and decryption degrades to null per key.
    ...(AUTH?.store
      ? {
          orgTierModelsFor: (orgId: string) => AUTH.store!.orgTierModels(orgId),
          orgProviderKeyFor: (orgId: string, provider: ProviderKeyProvider) =>
            AUTH.store!.decryptOrgProviderKey(orgId, provider, SECRET_ENCRYPTION.context),
        }
      : {}),
    // The subscription-transport authority. Passed as the QUESTION, not the
    // answer — the coordinator asks it — and absent without a gate, where
    // there are no accounts to be admin of.
    ...(AUTH?.store
      ? { platformAdmins: (principalId: string) => AUTH.store!.isPlatformAdmin(principalId) }
      : {}),
    ...(ACCOUNT_SUBSCRIPTIONS
      ? {
          principalCodexProfileFor: (principalId: string) =>
            ACCOUNT_SUBSCRIPTIONS.codexProfileForRun(principalId),
        }
      : {}),
    // A run billed to a host or requester login is journaled, never pushed.
    // Same one-delivery-path rule as `onRunFinished`: no audit-free side
    // channel.
    onSubscriptionTransport: (use) => {
      if (ledgerTouchesSubscription(use.payers)) {
        emit({
          kind: 'run.host_subscription',
          actorType: 'principal',
          actorId: use.principalId,
          orgId: use.orgId,
          projectId: use.projectId,
          runId: use.projectRunId,
          // ONE summary and one detail shape, shared with the CLI emitter: the
          // two used to word the same fact differently, so the row read
          // differently depending on which surface started the run.
          summary: hostSubscriptionSummary(use.payers),
          detail: runPayerDetail(use.payers),
        });
      }
      if (ledgerTouchesPrincipalSubscription(use.payers)) {
        emit({
          kind: 'run.principal_subscription',
          actorType: 'principal',
          actorId: use.principalId,
          orgId: use.orgId,
          projectId: use.projectId,
          runId: use.projectRunId,
          summary: principalSubscriptionSummary(use.payers),
          detail: runPayerDetail(use.payers),
        });
      }
    },
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
  // Previews die with the process that launched them, so a row left in a live
  // state describes containers that no longer exist. Same boot, same rule.
  const recoveredPreviews = previewStore.reconcileInterrupted();
  if (recoveredPreviews > 0) {
    process.stderr.write(
      `[atoma viz] recovered ${recoveredPreviews} interrupted preview(s) after a restart\n`
    );
  }
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
  return {
    store: projectStore,
    projects,
    coordinator,
    githubStore,
    githubConfig,
    githubClient,
    resolveUserAccessToken,
  };
})();

/**
 * THE PREVIEW RUNTIME, hosted here for the same reason the watch is.
 *
 * A preview needs four things that must agree: a launcher to build isolates, a
 * gateway serving its own origins, a claim registry deciding who may look, and
 * a route table joining the two. Splitting them across processes would give
 * four places for them to disagree; the gateway in particular holds its claims
 * and routes IN MEMORY on purpose, because both must die with a restart —
 * "on gateway restart all grants and hosts fail closed, users reopen
 * explicitly".
 *
 * NULL UNLESS THE DEPLOYMENT ASKED FOR IT. `previewEnabled` is a tri-state
 * that refuses a value it does not recognise, and `snapshotPreviewConfig`
 * refuses half a configuration — so a deployment either has previews or is
 * told exactly what is missing. It also needs the auth gate: a preview belongs
 * to an organisation, and an organisation is meaningless without a viewer.
 */
interface PreviewRuntime {
  readonly service: PreviewHttpService;
  readonly manager: PreviewManager;
  readonly gateway: RunningPreviewGateway;
  readonly claims: PreviewClaimRegistry;
}

/**
 * Why previews are off, in one sentence, or null when they are on.
 *
 * SEPARATE FROM THE CONSTRUCTION because silence was the whole defect: a
 * deployment missing `ATOMA_VIZ_AUTH` booted cleanly, printed nothing about
 * previews, and then answered a plain 404 on every preview route — the route
 * block lives inside the gated section, so there was not even the 503 the
 * design promises. An operator had no way to tell "I never asked for this"
 * from "I asked and it did not happen".
 */
function previewOffReason(): string | null {
  if (previewEnabled(process.env)) {
    if (!AUTH_RUNTIME) {
      return 'the visualizer auth gate is off, and a preview belongs to an organisation’s run — set ATOMA_VIZ_AUTH=1';
    }
    if (!PROJECTS_RUNTIME) return 'org-scoped project storage is unavailable';
    return null;
  }
  // Half a configuration must never read as "off": an operator who set the
  // domain and the image but not the switch wanted previews.
  return previewConfigPresent(process.env)
    ? 'ATOMA_PREVIEW is unset while other ATOMA_PREVIEW_* variables are set — set ATOMA_PREVIEW=1, or remove them'
    : 'ATOMA_PREVIEW is not set';
}

const PREVIEW_RUNTIME_PROMISE: Promise<PreviewRuntime | null> = (async () => {
  if (!PROJECTS_RUNTIME || !AUTH_RUNTIME) return null;
  if (!previewEnabled(process.env)) return null;
  const config = snapshotPreviewConfig(process.env, {
    visualizerOrigin: AUTH_RUNTIME.publicOrigin.origin,
  });
  const previewStore = PreviewStore.open(DBS[0]!.path);
  // No preview survives the process that started it, so a row left in a live
  // state describes containers that are gone.
  previewStore.reconcileInterrupted();
  const claims = new PreviewClaimRegistry();
  const routes = new PreviewRouteTable();
  const launcher = new DockerLauncher({
    image: DEFAULT_WORKER_IMAGE,
    previewImage: config.image,
    previewRuntime: config.runtime,
  });
  const manager = new PreviewManager({
    store: previewStore,
    launcher,
    routes,
    claims,
    config,
    /**
     * HOST-OWNED, never a caller's — and READ, not recomputed.
     *
     * The run row already carries the workspace the coordinator chose, behind
     * a `BEFORE UPDATE` trigger that refuses to let it move. Deriving a second
     * answer from `PROJECTS_ROOT` made that one row advisory and put three
     * derivations of one path in the codebase: this one honours
     * `ATOMA_PROJECTS_ROOT`, `src/cli/projects.ts` passes no root and always
     * writes the default, and `scripts/preview-demo.mjs` had guessed a third.
     * They agree only while every process shares one environment — so with the
     * variable unset the seeded workspace sat in a directory this line never
     * looked at, the Preview button appeared, and the click failed on an empty
     * copy with nothing saying which derivation had moved.
     *
     * The project is still checked: a run reached through another project's
     * path is the IDOR the route hierarchy exists to refuse, and the store
     * row is what settles it.
     */
    workspaceOf: (orgId, projectId, projectRunId) => {
      const run = PROJECTS_RUNTIME.store.getProjectRun(orgId, projectRunId);
      if (!run || run.projectId !== projectId) {
        throw new PreviewPolicyError('missing', 'no project run owns this preview');
      }
      return run.hostPaths.workspacePath;
    },
    probe: (hostPort) => probePreviewRelay(hostPort),
    log: (line) => console.error(line),
  });
  const gateway = await startPreviewGateway({
    host: config.gatewayHost,
    port: config.gatewayPort,
    routes,
    claims,
    visualizerOrigin: AUTH_RUNTIME.publicOrigin.origin,
    // One resolution of the scheme, shared with the URL the claim is minted
    // into: two computations from the same environment could disagree.
    publicScheme: config.publicScheme,
    log: (line) => console.error(line),
  });
  // Idle and hard bounds are enforced HERE rather than in the gateway, because
  // the gateway sees only traffic and traffic is exactly what must not keep a
  // preview alive.
  const sweep = setInterval(() => {
    void manager.sweepExpired().catch(() => undefined);
    claims.sweep();
  }, 30_000);
  sweep.unref?.();
  return {
    service: new PreviewHttpService({
      manager,
      store: previewStore,
      projects: PROJECTS_RUNTIME.store,
    }),
    manager,
    gateway,
    claims,
  };
})();

let PREVIEW_RUNTIME: PreviewRuntime | null = null;
void PREVIEW_RUNTIME_PROMISE.then((runtime) => {
  PREVIEW_RUNTIME = runtime;
  if (runtime) {
    console.error(`[atoma viz] preview gateway on ${runtime.gateway.port}`);
    return;
  }
  // `previewEnabled` throws on a value it does not recognise, and this line
  // must not be the thing that takes the server down.
  let reason: string;
  try {
    reason = previewOffReason() ?? 'unknown';
  } catch (error) {
    reason = String(error);
  }
  console.error(`[atoma viz] previews are off: ${reason}`);
}).catch((error: unknown) => {
  // A configuration this deployment asked for and cannot have is a hard fact,
  // not a degraded mode: previews stay off and the reason is printed once.
  console.error(`[atoma viz] previews are unavailable: ${String(error)}`);
});

/**
 * One request through the relay, which is what turns "a process bound a port"
 * into "a member will find something there".
 */
function probePreviewRelay(hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: hostPort, path: '/', method: 'GET', timeout: 2_000 },
      (response) => {
        response.resume();
        resolve((response.statusCode ?? 0) > 0);
      }
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

/**
 * THE MECHANICAL WATCH, hosted here.
 *
 * `npm run viz`, `npm run viz:dev` and `npm run viz:serve` all start it,
 * because they are all this file: the launcher supervises the source server and
 * Vite, and the release entry IS this process. A watch spawned beside the
 * launcher would have armed the development path and left the release contract
 * with nothing.
 *
 * It exists exactly where the journal does — behind the gate — for a reason
 * that is not merely mechanical: de-duplication is against the journal, and a
 * watch with nowhere to write is theatre. The Sentinel screen is gated too, so
 * an ungated instance would have had a watch nobody could read. The ungated
 * path says so in the boot banner rather than arming silently, and
 * `npm run sentinel` is its watch.
 *
 * ONE source builder, shared with `/api/admin/sentinel`: the screen must
 * describe the corpora the watch actually covers, and two builders would drift
 * the day one of them gains a corpus.
 */
function sentinelSources(): SentinelRunSource[] {
  return [
    operatorRunSource({ runsDir: RUNS_DIR }),
    ...(PROJECTS_RUNTIME ? [projectRunSource({ reader: PROJECTS_RUNTIME.store })] : []),
  ];
}

const SENTINEL_BOOTED_AT = new Date().toISOString();

const SENTINEL: ResidentSentinel | null = (() => {
  if (!EVENTS) return null;
  if (cli.noSentinel) return null;
  if (!vizSentinelEnabled()) return null;
  return startResidentSentinel({
    watch: new SentinelWatch({
      journal: EVENTS,
      sources: sentinelSources(),
      costAlertUsd: cli.costAlertUsd ?? sentinelCostAlertFromEnv(),
      leasePath: mcpRunLockPath(),
      source: 'viz-server',
      logger: (line) => console.error(`[sentinel] ${line}`),
    }),
    dbPath: DBS[0]!.path,
    source: 'viz-server',
    intervalMs:
      cli.sentinelIntervalMs ?? sentinelIntervalFromEnv() ?? SENTINEL_DEFAULT_INTERVAL_MS,
    label: `viz ${cli.host}:${cli.port}`,
    logger: (line) => console.error(`[sentinel] ${line}`),
  });
})();

/**
 * THE RESIDENT ANALYST — stage 2 of `docs/supervisor-design.md`, hosted here
 * for the same reason the sentinel is: the gated server is the one process a
 * production deployment always runs, and the journal it writes into is the
 * bus the coordinator already announces finished runs on.
 *
 * OPT-IN, unlike the sentinel, because it spends the operator's quota:
 * `ATOMA_VIZ_ANALYST=1` plus the `ATOMA_ANALYST_*` provider set, and a
 * `claude` binary on the host's PATH. Quiet period, idle gate and one session
 * at a time are the resident shell's promises (`src/supervisor/resident.ts`).
 * With `ATOMA_MENDER_DISPATCH_REPO`/`_TOKEN` set, a verdict's cited defects
 * are handed to the repository's mender workflow — the mender itself never
 * runs on this host (`src/supervisor/AGENTS.md`).
 */
const ANALYST: ResidentAnalyst | null = (() => {
  if (!EVENTS || !PROJECTS_RUNTIME) return null;
  if (!vizAnalystEnabled()) return null;
  const journal = EVENTS;
  const log = (line: string): void => console.error(`[analyst] ${line}`);
  let dispatch = null;
  try {
    dispatch = dispatchConfigFromEnv();
  } catch (error) {
    console.error(`[analyst] ${error instanceof Error ? error.message : String(error)} — dispatch OFF`);
  }
  const options: AnalystOptions = {
    repoRoot: process.cwd(),
    runsDir: RUNS_DIR,
    projectReader: PROJECTS_RUNTIME.store,
    dispatch,
    supervisorDir: resolve(process.env['ATOMA_SUPERVISOR_DIR'] ?? './supervisor'),
    leasePath: mcpRunLockPath(),
    provider: analystProvider(),
    claudeCommand: process.env['ATOMA_SUPERVISOR_CMD_CLAUDE'] ?? 'claude',
    budgetUsd: analystBudgetFromEnv() ?? 2,
    timeoutMs: 900_000,
    dryRun: false,
    force: false,
    journal: (input) => void journal.append(input),
    log,
    warn: log,
  };
  const resident = startResidentAnalyst({
    subscribe: (listener) => journal.subscribe(listener),
    analyse: (runId) => analyseTarget(resolveTarget(runId, options), options),
    isActive: () => anyRunActive({ runsDir: RUNS_DIR, leasePath: mcpRunLockPath() }),
    quietMs: analystQuietMsFromEnv() ?? undefined,
    logger: log,
  });
  // Runs that ended while no analyst was listening: the store remembers them.
  for (const target of pendingTargets(options)) {
    resident.enqueue(target.runId, Date.parse(target.endedAt ?? '') || Date.now());
  }
  return resident;
})();

/**
 * THE MCP — one surface for everyone, on this server's `/mcp` route
 * (`src/mcp/AGENTS.md`). Gated, a caller is a bearer API token a principal
 * minted (`/api/tokens`), and the tools it sees are its tier's. Ungated, the
 * caller is the operator on loopback, as for the CLI. Host is pinned either
 * way so a page in a browser cannot address this port through DNS rebinding.
 */
const MCP_DEPS: McpToolDeps = {
  projects: PROJECTS_RUNTIME ? { service: PROJECTS_RUNTIME.projects, store: PROJECTS_RUNTIME.store } : null,
  auth: AUTH?.store ?? null,
  journal: EVENTS,
  operatorRuns: true,
  emit,
};
const MCP_HOST = new McpHttpHost({
  resolveCaller: (req): McpCaller | null => {
    if (!AUTH_RUNTIME || !AUTH?.store) return { kind: 'operator' };
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match) return null;
    const resolved = AUTH.store.resolveApiToken(match[1]!);
    if (!resolved) return null;
    const { tokenId, ...viewer } = resolved;
    return { kind: 'principal', viewer, tokenId };
  },
  buildServer: (caller) => buildMcpServer(caller, MCP_DEPS),
  allowedHosts: AUTH_RUNTIME
    ? [AUTH_RUNTIME.publicOrigin.host]
    : [`127.0.0.1:${cli.port}`, `localhost:${cli.port}`, `[::1]:${cli.port}`],
  logger: (line) => console.error(`[mcp] ${line}`),
});
// An operator run started through the MCP is a child of THIS process; a
// generic exit signals it (SIGTERM only, never SIGKILL) so it can close its
// trace. Same handler the stdio server registered.
process.once('exit', signalActiveRunOnExit);

/** What this process can honestly say about watching. Never an aggregate. */
function sentinelHealth(): SentinelHealth {
  if (SENTINEL) return SENTINEL.health();
  const reason = !EVENTS ? 'ungated' : 'disabled';
  // Even disarmed, the store can name the watch that IS holding it — a fact,
  // read fresh, not a claim about the world.
  return unarmedSentinelHealth(
    reason,
    'viz-server',
    SENTINEL_BOOTED_AT,
    EVENTS ? peekSentinelWatch(DBS[0]!.path) : null
  );
}


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
<meta name="robots" content="noindex, nofollow">
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

/** Does a submitted pins body name the host subscription anywhere? */
function namesHostSubscription(pins: unknown): boolean {
  if (!pins || typeof pins !== 'object') return false;
  return Object.values(pins as Record<string, unknown>).some(
    (value) => typeof value === 'string' && isHostSubscriptionSelection(value)
  );
}

/** Does a submitted account pin set name the requester's own subscription? */
function namesPrincipalSubscription(pins: unknown): boolean {
  if (!pins || typeof pins !== 'object') return false;
  return Object.values(pins as Record<string, unknown>).some(
    (value) => typeof value === 'string' && isPrincipalSubscriptionSelection(value)
  );
}

function isAnyAccountSubscriptionSelection(value: string): boolean {
  return isHostSubscriptionSelection(value) || isPrincipalSubscriptionSelection(value);
}

/** The tiers a saved pin set arms the subscription on, in tier order. */
function subscriptionTiersOf(pins: { l1: string | null; l2: string | null; l3: string | null }): string[] {
  return (['l1', 'l2', 'l3'] as const).filter((tier) => {
    const value = pins[tier];
    return typeof value === 'string' && isAnyAccountSubscriptionSelection(value);
  });
}

/** Non-secret stored choices, used so switching Claude ↔ ChatGPT is journaled too. */
function subscriptionSelectionsOf(
  pins: { l1: string | null; l2: string | null; l3: string | null }
): Record<string, string> {
  return Object.fromEntries(
    (['l1', 'l2', 'l3'] as const).flatMap((tier) => {
      const value = pins[tier];
      return typeof value === 'string' && isAnyAccountSubscriptionSelection(value)
        ? [[tier, value] as const]
        : [];
    })
  );
}

function listOperatorRunIndex(): VizRunIndexEntry[] {
  if (!existsSync(RUNS_DIR)) return [];
  const indexFile = join(RUNS_DIR, 'index.json');
  // The index is read under the SAME ceiling as the traces it points at
  // (2026-08-27 review, 3.9): nothing prunes it — one row per run for the life
  // of the checkout — so this was the last operator path able to materialise an
  // unbounded document per request.
  //
  // Over the ceiling falls through to the directory scan below, the fallback
  // this code already had for a torn index. That trade is stated rather than
  // pretended away: the scan reads far MORE bytes in total, but one bounded
  // file at a time, so the peak this fix exists to bound is the one that
  // improves. An index that large also means a run corpus that large, where a
  // wrong-but-cheap empty list would be the worse answer.
  const index = readBoundedRunFile(indexFile);
  if (index.ok) {
    try {
      const parsed: unknown = JSON.parse(index.bytes.toString('utf8'));
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
      projectRunId: row.id,
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
      projectRunId: row.id,
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
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

  // The host creates this marker before taking the run lease. Reads stay up
  // while a deployment drains, but no new durable write, run or preview may
  // enter the gap between the preflight and systemd stopping this generation.
  if (requestWaitsForDeployment(req.method, pathname)) {
    res.setHeader('retry-after', '30');
    sendJson(res, 503, { error: 'deployment in progress; retry this request shortly' });
    return;
  }

  if (pathname === '/mcp') {
    await MCP_HOST.handle(req, res);
    return;
  }

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
            events: emit,
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
          // Send an admin with no stored GitHub authorization to acquire one
          // first: the setup callback cannot verify the installation without
          // their token, and a flow whose callback cannot verify must not
          // start. Passing the path is what arms that hop.
          authorizePath: '/auth/github/authorize',
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
      if (
        !PROJECTS_RUNTIME?.githubConfig ||
        !PROJECTS_RUNTIME.githubClient ||
        !PROJECTS_RUNTIME.resolveUserAccessToken
      ) {
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
          resolveUserAccessToken: PROJECTS_RUNTIME.resolveUserAccessToken,
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

    // MAY THIS VIEWER SPEND THE OPERATOR'S OWN LOGIN, AND WHERE? Shaped per
    // REQUESTER, not served to everyone and filtered in the browser: an offer
    // a viewer cannot use is a payer they should never see named. Three
    // declared facts, all read server-side — the platform-admin flag on the
    // resolved session, the deployment's declaration, and whether the
    // viewer's ACTIVE organisation is the declared one. The picker greys the
    // family when it is offered-but-unusable and hides it entirely otherwise.
    const hostSubscriptionOffers = (): Array<{ family: unknown; reason?: string }> | undefined => {
      if (!viewer.platformAdmin) return undefined;
      const declared = process.env['ATOMA_HOST_SUBSCRIPTION_ORG']?.trim();
      if (!declared) {
        return HOST_SUBSCRIPTION_FAMILIES.map((family) => ({ family, reason: 'undeclared' }));
      }
      if (viewer.orgId !== declared) {
        return HOST_SUBSCRIPTION_FAMILIES.map((family) => ({
          family,
          reason: 'other-organisation',
        }));
      }
      return HOST_SUBSCRIPTION_FAMILIES.map((family) => ({ family }));
    };

    const subscriptionPayload = (): Record<string, unknown> => {
      const offers = hostSubscriptionOffers();
      return {
        personalSubscriptions: {
          codex:
            roleAtLeast(viewer.role, 'org:member') &&
            Boolean(ACCOUNT_SUBSCRIPTIONS?.codexProfileForRun(viewer.principalId)),
          // Anthropic requires prior approval before a third-party product may
          // offer claude.ai subscription login. Keep the capability explicit
          // and server-owned; the client cannot turn it on.
          claude: false,
        },
        ...(offers ? { hostSubscriptions: offers } : {}),
        // Compatibility for a cached pre-upgrade client: it can still show
        // and clear the Claude family while the new bundle loads.
        ...(offers
          ? {
              hostSubscription: offers.find(
                (offer) =>
                  (offer.family as { id?: string }).id === HOST_SUBSCRIPTION_FAMILY.id
              ),
            }
          : {}),
      };
    };

    // PERSONAL SUBSCRIPTIONS — every route is self-scoped by the resolved
    // session. Device material is short-lived and memory-only; provider
    // credential bytes never cross this HTTP surface.
    if (pathname === '/api/account/subscriptions') {
      if (!methodAllowed(req, res, 'GET')) return;
      if (!roleAtLeast(viewer.role, 'org:member')) {
        // A viewer downgraded during an in-flight login must not keep reading
        // its short-lived device code.
        sendJson(res, 403, { error: 'org:member role or above is required' });
        return;
      }
      if (!ACCOUNT_SUBSCRIPTIONS) {
        sendJson(res, 503, { error: 'personal subscriptions are unavailable' });
        return;
      }
      sendJson(
        res,
        200,
        await ACCOUNT_SUBSCRIPTIONS.status(viewer.principalId, {
          // A run child owns this exact auth.json generation. Return the
          // persisted receipt while it is live instead of starting a second
          // provider process that could rotate the same credentials.
          verify: !PROJECTS_RUNTIME?.coordinator.hasActiveRunForPrincipal(
            viewer.principalId
          ),
        })
      );
      return;
    }

    if (pathname === '/api/account/subscriptions/codex/login') {
      if (!roleAtLeast(viewer.role, 'org:member')) {
        sendJson(res, 403, { error: 'org:member role or above is required' });
        return;
      }
      if (!ACCOUNT_SUBSCRIPTIONS) {
        sendJson(res, 503, { error: 'personal subscriptions are unavailable' });
        return;
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req, res)) return;
        const rate = acceptLoginAttempt(req, AUTH_RUNTIME!.trustedProxies);
        if (!rate.accepted) {
          res.setHeader('retry-after', String(rate.retryAfterSeconds));
          sendJson(res, 429, { error: 'too many login attempts' });
          return;
        }
        try {
          sendJson(
            res,
            200,
            await ACCOUNT_SUBSCRIPTIONS.startCodexLogin(
              viewer.principalId,
              viewer.orgId
            )
          );
        } catch (error) {
          if (error instanceof CodexSubscriptionConflictError) {
            sendJson(res, 409, { error: error.message });
          } else if (error instanceof CodexSubscriptionCapacityError) {
            sendJson(res, 429, { error: 'too many pending Codex logins' });
          } else if (error instanceof CodexSubscriptionUnavailableError) {
            sendJson(res, 503, { error: 'Codex CLI is unavailable on this deployment' });
          } else {
            console.error('[viz subscriptions] Codex login start failed', error);
            sendJson(res, 502, { error: 'Codex login could not start' });
          }
        }
        return;
      }
      if (!methodAllowed(req, res, 'DELETE')) return;
      if (!sameOrigin(req, res)) return;
      sendJson(res, 200, {
        cancelled: await ACCOUNT_SUBSCRIPTIONS.cancelCodexLogin(viewer.principalId),
      });
      return;
    }

    if (pathname === '/api/account/subscriptions/codex') {
      if (!roleAtLeast(viewer.role, 'org:member')) {
        sendJson(res, 403, { error: 'org:member role or above is required' });
        return;
      }
      if (!methodAllowed(req, res, 'DELETE')) return;
      if (!sameOrigin(req, res)) return;
      if (!ACCOUNT_SUBSCRIPTIONS) {
        sendJson(res, 503, { error: 'personal subscriptions are unavailable' });
        return;
      }
      if (PROJECTS_RUNTIME?.coordinator.hasActiveRunForPrincipal(viewer.principalId)) {
        sendJson(res, 409, {
          error: 'cancel the active run before disconnecting its Codex subscription',
        });
        return;
      }
      sendJson(res, 200, {
        disconnected: await ACCOUNT_SUBSCRIPTIONS.disconnectCodex(
          viewer.principalId,
          viewer.orgId
        ),
      });
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
          catalog: LLM_PROVIDER_CATALOG,
          // Whether THIS deployment declared an Ollama endpoint. An ollama
          // pin without one falls through at run time, so the picker greys
          // the family instead of offering a dormant choice.
          ollamaAvailable: Boolean(process.env['OLLAMA_BASE_URL']?.trim()),
          ...subscriptionPayload(),
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
        const requested = (body as { pins?: unknown }).pins;
        // AUTHORITY IS THE ROUTE'S QUESTION. The store validates the SHAPE and
        // its account-level space admits the sentinel; whether THIS principal
        // may name it is decided here, from the resolved session, and again at
        // every run by the coordinator. A stored pin is data, never permission.
        if (namesHostSubscription(requested) && !hostSubscriptionOffers()) {
          sendJson(res, 403, {
            error: 'the host subscription is not offered to this account on this deployment',
          });
          return;
        }
        if (namesPrincipalSubscription(requested)) {
          if (!roleAtLeast(viewer.role, 'org:member')) {
            sendJson(res, 403, {
              error: 'org:member role or above is required to use a personal subscription',
            });
            return;
          }
          if (!ACCOUNT_SUBSCRIPTIONS?.codexProfileForRun(viewer.principalId)) {
            sendJson(res, 409, {
              error: 'connect your Codex subscription before selecting it for a tier',
            });
            return;
          }
        }
        if (
          requested &&
          typeof requested === 'object' &&
          selectionsMixCodexOwners(Object.values(requested as Record<string, unknown>).map(
            (value) => typeof value === 'string' ? value : null
          ))
        ) {
          sendJson(res, 409, {
            error: 'one account pin set cannot mix host and personal ChatGPT subscriptions',
          });
          return;
        }
        const before = authStore.modelPins(viewer.principalId);
        const pins = authStore.setModelPins(viewer.principalId, requested);
        // Journaled at the moment of the CHOICE. The run rows that follow are
        // written by whoever launches, which may be someone else entirely, so
        // they cannot answer "who decided the operator's login was spendable".
        const armedAfter = subscriptionTiersOf(pins);
        const selectionsBefore = subscriptionSelectionsOf(before);
        const selectionsAfter = subscriptionSelectionsOf(pins);
        if (JSON.stringify(selectionsBefore) !== JSON.stringify(selectionsAfter)) {
          emit({
            kind: 'principal.subscription_pin',
            actorType: 'principal',
            actorId: viewer.principalId,
            orgId: viewer.orgId,
            summary:
              armedAfter.length > 0
                ? `Account subscription armed on ${armedAfter.join(', ')}`
                : 'Account subscription cleared from every tier',
            detail: { tiers: armedAfter, selections: selectionsAfter },
          });
        }
        sendJson(res, 200, {
          pins,
          defaults: operatorTierDefaults(process.env),
          catalog: LLM_PROVIDER_CATALOG,
          ollamaAvailable: Boolean(process.env['OLLAMA_BASE_URL']?.trim()),
          ...subscriptionPayload(),
        });
      } catch {
        sendJson(res, 400, { error: 'each tier must be null or one of the offered models' });
      }
      return;
    }

    // ORGANISATION MODEL SETTINGS — org default tiers and provider keys.
    // Authority rides the VIEWER's ACTIVE organisation (never a body field)
    // and the role ladder: admin and owner write; members read the defaults
    // so their own Settings can show what they inherit.
    if (pathname === '/api/org/models' || pathname.startsWith('/api/org/provider-keys')) {
      const authStore = AUTH.store!;
      const mayRead = roleAtLeast(viewer.role, 'org:viewer') || viewer.platformAdmin;
      const mayWrite = roleAtLeast(viewer.role, 'org:admin') || viewer.platformAdmin;
      if (!mayRead) {
        sendJson(res, 403, { error: 'organisation membership required' });
        return;
      }

      if (pathname === '/api/org/models') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            models: authStore.orgTierModels(viewer.orgId),
            keys: authStore.listOrgProviderKeys(viewer.orgId),
            encryptionReady: SECRET_ENCRYPTION.context !== null,
            catalog: LLM_PROVIDER_CATALOG,
            operatorDefaults: operatorTierDefaults(process.env),
            ollamaAvailable: Boolean(process.env['OLLAMA_BASE_URL']?.trim()),
          });
          return;
        }
        if (!mayWrite) {
          sendJson(res, 403, { error: 'org admin required' });
          return;
        }
        if (!methodAllowed(req, res, 'PUT')) return;
        if (!sameOrigin(req, res)) return;
        let body: unknown;
        try {
          body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
        } catch {
          sendJson(res, 400, { error: 'request body is not valid JSON' });
          return;
        }
        // The ORG level's value space never admits the sentinel: an org
        // default is inherited by every member by construction, so a
        // payer-bearing value there would need a fail-closed re-ask on every
        // tenant run. `setOrgTierModels` refuses it through the narrower
        // schema; this says WHICH rule refused, instead of "not a model".
        if (
          namesHostSubscription((body as { models?: unknown }).models) ||
          namesPrincipalSubscription((body as { models?: unknown }).models)
        ) {
          sendJson(res, 400, {
            error:
              'a subscription cannot be an organisation default; it is an account pin chosen ' +
              'by the account that will spend it',
          });
          return;
        }
        try {
          const models = updateOrgModels(authStore, viewer, (body as { models?: unknown }).models, emit);
          sendJson(res, 200, { models });
        } catch (error) {
          sendJson(res, 400, {
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
        return;
      }

      // /api/org/provider-keys[/:provider]
      const providerMatch = /^\/api\/org\/provider-keys\/([a-z-]+)$/.exec(pathname);
      if (!providerMatch) {
        if (!methodAllowed(req, res, 'GET')) return;
        sendJson(res, 200, {
          keys: authStore.listOrgProviderKeys(viewer.orgId),
          encryptionReady: SECRET_ENCRYPTION.context !== null,
          catalog: LLM_PROVIDER_CATALOG,
        });
        return;
      }
      const provider = providerMatch[1] as ProviderKeyProvider;
      if (!PROVIDER_KEY_PROVIDERS.includes(provider)) {
        sendJson(res, 404, { error: 'unknown provider' });
        return;
      }
      if (req.method === 'DELETE') {
        if (!mayWrite) {
          sendJson(res, 403, { error: 'org admin required' });
          return;
        }
        if (!sameOrigin(req, res)) return;
        if (authStore.deleteOrgProviderKey(viewer.orgId, provider)) {
          emit({
            kind: 'org.provider_key_removed',
            actorType: 'principal',
            actorId: viewer.principalId,
            orgId: viewer.orgId,
            summary: `Provider key removed for ${provider}`,
            detail: { provider },
          });
        }
        sendJson(res, 200, { keys: authStore.listOrgProviderKeys(viewer.orgId) });
        return;
      }
      if (!mayWrite) {
        sendJson(res, 403, { error: 'org admin required' });
        return;
      }
      if (!methodAllowed(req, res, 'PUT')) return;
      if (!sameOrigin(req, res)) return;
      let body: unknown;
      try {
        body = JSON.parse((await readBodyBounded(req, 65_536)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'request body is not valid JSON' });
        return;
      }
      if (!SECRET_ENCRYPTION.context) {
        sendJson(res, 503, {
          error:
            'provider keys are unavailable: ask the operator to configure ATOMA_SECRET_ENCRYPTION_KEY on this deployment',
        });
        return;
      }
      try {
        authStore.setOrgProviderKey({
          orgId: viewer.orgId,
          provider,
          plaintext: (body as { key?: unknown }).key as string,
          encryption: SECRET_ENCRYPTION.context,
        });
        emit({
          kind: 'org.provider_key_set',
          actorType: 'principal',
          actorId: viewer.principalId,
          orgId: viewer.orgId,
          summary: `Provider key stored for ${provider}`,
          detail: { provider },
        });
        sendJson(res, 200, { keys: authStore.listOrgProviderKeys(viewer.orgId) });
      } catch (error) {
        sendJson(res, 400, {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
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

    // THE VIEWER'S NOTIFICATION TRAY — the journal, projected through the SAME
    // routing table the push path delivers from. A row is in your tray exactly
    // when `PUSH_ROUTES` would have pushed it to your devices, resolved
    // against your CURRENT roles: no second table of per-principal deliveries,
    // no second audience policy. Newest first, cursor-paged on `seq` like the
    // admin journal; copy is rendered per request in the viewer's language by
    // the same `renderPush` a subscription reads.
    if (pathname === '/api/notifications') {
      if (!methodAllowed(req, res, 'GET')) return;
      if (!EVENTS) {
        sendJson(res, 200, { notifications: [], nextBefore: null });
        return;
      }
      const rawBefore = url.searchParams.get('before');
      const rawLimit = url.searchParams.get('limit');
      const before = rawBefore === null ? Number.NaN : Number(rawBefore);
      const limit = Math.max(
        1,
        Math.min(50, Number.isFinite(Number(rawLimit)) && rawLimit !== null ? Math.trunc(Number(rawLimit)) : 30)
      );
      const locale = asPushLocale(url.searchParams.get('locale')) ?? DEFAULT_LOCALE;
      // One request, one directory: the cache keeps a page scan from listing
      // every organisation once per row, and dies with the response so a
      // membership change is visible on the next read.
      const directory = cachedAudienceDirectory(audienceDirectory(AUTH.store!));
      // The event's own scope ids ride each row so the client can LINK a
      // notification to its subject. `runId` is a PROJECT-RUN id, which the
      // Runs view cannot address, so the trace is resolved here against the
      // org-scoped projects store — the same fact the audience member would
      // get by opening the project. Tolerant like every journal reader: a
      // foreign or operator-shaped id resolves to null, never to a crash.
      const traceIdFor = (event: { orgId: string | null; runId: string | null }): string | null => {
        if (!event.orgId || !event.runId || !PROJECTS_RUNTIME) return null;
        try {
          return PROJECTS_RUNTIME.store.getProjectRun(event.orgId, event.runId)?.traceId ?? null;
        } catch {
          return null;
        }
      };
      const notifications: {
        seq: number;
        at: string;
        kind: string;
        severity: string;
        title: string;
        body: string;
        orgId: string | null;
        projectId: string | null;
        runId: string | null;
        traceId: string | null;
      }[] = [];
      // Routed kinds are sparse in the journal, so the page FILLS by scanning:
      // filtering a fixed page would thin it (the journal filter rule). The
      // scan is bounded per request; a cap hit hands back the cursor with a
      // short page rather than holding the response open over 50k rows.
      let cursor = Number.isFinite(before) && before > 0 ? Math.trunc(before) : undefined;
      let nextBefore: number | null = null;
      for (let scanned = 0; notifications.length < limit && scanned < 1_000; ) {
        const chunk = EVENTS.list({
          ...(cursor !== undefined ? { before: cursor } : {}),
          limit: 200,
        });
        for (const event of chunk.events) {
          scanned += 1;
          nextBefore = event.seq;
          const route = PUSH_ROUTES[event.kind] ?? null;
          if (!route) continue;
          if (!resolveAudience(event, route.audience, directory).includes(viewer.principalId)) {
            continue;
          }
          const copy = renderPush(event, locale, route);
          // The router's own refusal: a row that renders no title is a blank
          // line in a tray, not a degraded notification.
          if (!copy.title) continue;
          notifications.push({
            seq: event.seq,
            at: event.at,
            kind: event.kind,
            severity: event.severity,
            title: copy.title,
            body: copy.body,
            orgId: event.orgId,
            projectId: event.projectId,
            runId: event.runId,
            traceId: traceIdFor(event),
          });
          if (notifications.length >= limit) break;
        }
        if (notifications.length >= limit) break;
        if (chunk.nextBefore === null) {
          nextBefore = null;
          break;
        }
        cursor = chunk.nextBefore;
      }
      sendJson(res, 200, { notifications, nextBefore });
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
            // FAMILY, not kind: 28 kinds is not a filter row, and the family
            // list is derived from the kind vocabulary rather than written a
            // second time. An unknown family is dropped by `list`, which
            // checks it against that closed set before it reaches SQL.
            ...(url.searchParams.get('family')
              ? { kindFamily: url.searchParams.get('family')! }
              : {}),
          })
        );
        return;
      }
      // WHAT THE SENTINEL SEES — this server's own watch, the rule table, the
      // runs it would screen right now, and the findings in the journal.
      // Read-only and quota-free, like the watch itself.
      //
      // `watch` is a fact about THIS PROCESS, which is the only reason it may
      // be reported at all: the server hosts the tick, so it knows its own
      // timer. It is never an aggregate — a `npm run sentinel` on another
      // machine, or against another store, is invisible here — and when this
      // server is not watching, `incumbent` names the watch holding the store
      // from the lease row, which is a read, not a claim.
      //
      // `live` and `skipped` are discovered FRESH on every request rather than
      // replayed from the last tick: it is one file read plus one indexed
      // query, and a screen that showed a 20-second-old list while calling it
      // "in flight now" would need a disclaimer nobody would read.
      if (pathname === '/api/admin/sentinel') {
        if (!methodAllowed(req, res, 'GET')) return;
        const discovery: SentinelDiscovery[] = [];
        const now = Date.now();
        for (const source of [
          operatorRunSource({ runsDir: RUNS_DIR }),
          ...(PROJECTS_RUNTIME
            ? [projectRunSource({ reader: PROJECTS_RUNTIME.store })]
            : []),
        ]) {
          try {
            discovery.push(source.discover(now));
          } catch {
            // One unreadable corpus must not empty the whole screen.
            discovery.push({ runs: [], skipped: [{ runId: null, reason: `${source.corpus} source unreadable` }] });
          }
        }
        // Two kinds, two queries, merged newest-first: `list` filters one
        // kind or one family, and these two share neither.
        const findings = EVENTS
          ? [
              ...EVENTS.list({ kind: 'run.anomaly', limit: 40 }).events,
              ...EVENTS.list({ kind: 'security.flagged', limit: 40 }).events,
            ]
              .sort((left, right) => right.seq - left.seq)
              .slice(0, 60)
          : [];
        sendJson(res, 200, {
          watch: sentinelHealth(),
          rules: sentinelRuleTable(),
          live: discovery.flatMap((entry) =>
            entry.runs.map((run) => ({
              runId: run.runId,
              corpus: run.corpus,
              orgId: run.orgId,
              projectId: run.projectId,
              label: run.label,
            }))
          ),
          skipped: discovery.flatMap((entry) => entry.skipped),
          findings,
        });
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
      // OPERATOR ANNOUNCEMENTS — the one push a human writes, in two steps.
      //
      // The split is the safety property, not an interaction detail. `/draft`
      // proposes translations and sends NOTHING; `/announce` delivers text the
      // admin has read in every language. That is what keeps model prose out
      // of the audit row and out of subscribers' pockets, on a message no one
      // can recall.
      if (pathname === '/api/admin/announce/draft') {
        if (!methodAllowed(req, res, 'POST')) return;
        if (!sameOrigin(req, res)) return;
        let body: unknown;
        try {
          body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
        } catch {
          sendJson(res, 400, { error: 'request body is not valid JSON' });
          return;
        }
        const draft = announcementDraftSchema.safeParse(body);
        if (!draft.success) {
          sendJson(res, 400, { error: draft.error.issues[0]?.message ?? 'invalid draft' });
          return;
        }
        const llm = announcementTranslator();
        const translations = await draftAnnouncementTranslations(draft.data, { llm });
        if (!translations) {
          // 200, not an error: no provider is a normal state of this server,
          // and the form's answer is "write the other languages yourself",
          // not "something broke". But WHICH of the two is said out loud —
          // "nothing is configured" and "the configured provider refused" ask
          // the operator for different actions, and they reached the screen as
          // one sentence until an unset ATOMA_LLM was mistaken for the first.
          // The reason itself stays on stderr: a provider's error text is not
          // for a broadcast form.
          sendJson(res, 200, {
            translated: false,
            reason: llm ? 'failed' : 'unavailable',
            texts: null,
          });
          return;
        }
        sendJson(res, 200, { translated: true, reason: null, texts: translations });
        return;
      }
      if (pathname === '/api/admin/announce') {
        if (!methodAllowed(req, res, 'POST')) return;
        if (!sameOrigin(req, res)) return;
        if (!PUSH_RUNTIME || !EVENTS) {
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
        const parsed = announcementRequestSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid announcement' });
          return;
        }
        const { segment, texts } = parsed.data;
        const orgIds = PROJECTS_RUNTIME
          ? organisationsForSegment(segment, PROJECTS_RUNTIME.store.listAllProjects())
          : organisationsForSegment(segment, []);
        if (orgIds !== null && orgIds.length === 0) {
          // Refused rather than sent: a segment matching nothing is far more
          // likely a mistaken pick than an intent to notify no one.
          sendJson(res, 409, { error: 'no organisation matches this segment' });
          return;
        }
        const detail: AnnouncementDetail = {
          segment,
          ...(orgIds ? { orgIds } : {}),
          orgCount: orgIds ? orgIds.length : null,
          texts,
        };
        // BEFORE emitting, because the journal is fail-open: an oversized row
        // would be dropped silently and the push would vanish with it, since
        // the router only ever sees events that were journaled.
        if (!announcementDetailFits(detail, PLATFORM_EVENT_DETAIL_MAX_CHARS)) {
          sendJson(res, 400, {
            error: `the announcement does not fit one audit row (${PLATFORM_EVENT_DETAIL_MAX_CHARS} characters across ${SUPPORTED_LOCALES.length} languages)`,
          });
          return;
        }
        emit({
          kind: 'platform.announcement',
          actorType: 'principal',
          actorId: viewer.principalId,
          summary: `Announcement to ${segment}: ${eventLabel(texts[DEFAULT_LOCALE].title)}`,
          detail: { ...detail },
        });
        sendJson(res, 200, { segment, orgCount: detail.orgCount });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // WEB PUSH — principal-scoped self-service. Members are asked during their
    // first live run (where the value shows); platform admins are asked at
    // login because curated platform alerts do not depend on them launching a
    // run. These routes only store what the browser's PushManager minted.
    // Same-origin POSTs, bounded bodies, and validated key material.
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
      let saved: 'created' | 'refreshed';
      try {
        saved = PUSH_RUNTIME.store.saveSubscription({
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
      // Only a NEW device is a fact worth an audit row. The same browser
      // re-saving its endpoint is repair, not an event: an admin's page load
      // does it unprompted, and journaling that buries the real rows under
      // one line per reload. The unsubscribe branch above already reads this
      // way — `if (removed)`.
      if (saved === 'created') {
        emit({
          kind: 'push.subscribed',
          actorType: 'principal',
          actorId: viewer.principalId,
          orgId: viewer.orgId,
          summary: 'Notification subscription added for one browser',
        });
      }
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
    const html = injectAppShellSeo(
      readFileSync(UI_HTML_PATH, 'utf8'),
      AUTH_RUNTIME?.publicOrigin ?? null
    );
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

  if (pathname === '/robots.txt') {
    if (!methodAllowed(req, res, 'GET')) return;
    send(
      res,
      200,
      robotsTxt(AUTH_RUNTIME?.publicOrigin ?? null),
      'text/plain; charset=utf-8',
      'public, max-age=3600'
    );
    return;
  }

  if (pathname === '/sitemap.xml') {
    if (!methodAllowed(req, res, 'GET')) return;
    if (!AUTH_RUNTIME) {
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return;
    }
    send(
      res,
      200,
      sitemapXml(AUTH_RUNTIME.publicOrigin),
      'application/xml; charset=utf-8',
      'public, max-age=3600'
    );
    return;
  }

  // API TOKENS — a principal's bearer for the MCP, self-scoped from the
  // session, bound to the ACTIVE organisation, revocable, journaled at both
  // ends. The plaintext is returned once by the POST and never again.
  if (pathname === '/api/tokens' || pathname.startsWith('/api/tokens/')) {
    if (!AUTH_RUNTIME || !AUTH?.store) {
      if (pathname === '/api/tokens' && req.method === 'GET') {
        sendJson(res, 200, {
          mode: 'operator', tokens: [], mcpUrl: `http://127.0.0.1:${cli.port}/mcp`,
        });
      } else {
        sendJson(res, 409, { error: 'API tokens require an authenticated deployment' });
      }
      return;
    }
    const viewer = AUTH.resolve(req);
    if (!viewer) {
      sendJson(res, 401, { error: 'authentication required' });
      return;
    }
    const authStore = AUTH.store;
    if (pathname === '/api/tokens' && req.method === 'GET') {
      sendJson(res, 200, { mode: 'bearer', tokens: authStore.listApiTokens(viewer.principalId), mcpUrl: new URL('/mcp', AUTH_RUNTIME!.publicOrigin).href });
      return;
    }
    if (pathname === '/api/tokens' && req.method === 'POST') {
      if (!sameOrigin(req, res)) return;
      if (!roleAtLeast(viewer.role, 'org:viewer')) {
        sendJson(res, 403, { error: 'organisation membership required' });
        return;
      }
      let body: { label?: unknown } = {};
      try {
        body = JSON.parse((await readBodyBounded(req, 2_048)).toString('utf8') || '{}') as { label?: unknown };
      } catch {
        sendJson(res, 400, { error: 'request body is not valid JSON' });
        return;
      }
      const minted = authStore.createApiToken({
        principalId: viewer.principalId,
        orgId: viewer.orgId,
        label: typeof body.label === 'string' ? body.label : 'MCP token',
      });
      emit({
        kind: 'token.created',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        summary: `API token created for the MCP (${eventLabel(typeof body.label === 'string' ? body.label : 'MCP token')})`,
        detail: { tokenId: minted.tokenId },
      });
      sendJson(res, 201, { ...minted, mcpUrl: new URL('/mcp', AUTH_RUNTIME!.publicOrigin).href });
      return;
    }
    const revoke = pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (revoke && req.method === 'DELETE') {
      if (!sameOrigin(req, res)) return;
      const tokenId = decodePathComponent(revoke[1]!);
      const revoked = tokenId ? authStore.revokeApiToken(viewer.principalId, tokenId) : false;
      if (revoked) {
        emit({
          kind: 'token.revoked',
          actorType: 'principal',
          actorId: viewer.principalId,
          orgId: viewer.orgId,
          summary: 'API token revoked',
          detail: { tokenId },
        });
      }
      sendJson(res, revoked ? 200 : 404, { revoked });
      return;
    }
    res.writeHead(405, { allow: 'GET, POST, DELETE', 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
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

    // PREVIEW. Five thin blocks: authenticate, check same-origin on a
    // mutation, and call the service. Every decision — roles, org binding,
    // which status a failure maps to — lives in `src/preview/httpService.ts`,
    // because a decision made here would be a decision the CLI cannot reach.
    const previewRoute = pathname.match(
      /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/preview(?:\/(open|heartbeat|stop|restart))?$/
    );
    if (previewRoute) {
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      const preview = PREVIEW_RUNTIME;
      if (!preview) {
        // A deployment that has not configured previews, or could not start
        // the gateway. An operator's problem, and never the member's fault.
        sendJson(res, 503, { error: 'previews are not available on this deployment' });
        return;
      }
      const projectId = decodePathComponent(previewRoute[1]!);
      const projectRunId = decodePathComponent(previewRoute[2]!);
      const action = previewRoute[3];
      if (!projectId || !projectRunId) {
        sendJson(res, 400, { error: 'bad project run id' });
        return;
      }
      try {
        if (!action) {
          if (!methodAllowed(req, res, 'GET')) return;
          sendJson(res, 200, preview.service.status(viewer, projectId, projectRunId));
          return;
        }
        if (!methodAllowed(req, res, 'POST')) return;
        if (!sameOrigin(req, res)) return;
        let body: unknown;
        try {
          body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
        } catch {
          sendJson(res, 400, { error: 'request body is not valid JSON' });
          return;
        }
        const inFlight = (body as { inFlight?: unknown }).inFlight === true;
        if (action === 'open' || action === 'restart') {
          const answered =
            action === 'open'
              ? await preview.service.open(viewer, projectId, projectRunId, { inFlight })
              : await preview.service.restart(viewer, projectId, projectRunId, { inFlight });
          if (answered.body.retryAfterSeconds !== undefined) {
            res.setHeader('retry-after', String(answered.body.retryAfterSeconds));
          }
          sendJson(res, answered.status, answered.body);
          return;
        }
        if (action === 'heartbeat') {
          const generation = Number((body as { generation?: unknown }).generation);
          if (!Number.isInteger(generation) || generation <= 0) {
            sendJson(res, 400, { error: 'a heartbeat names the generation it is for' });
            return;
          }
          sendJson(
            res,
            200,
            preview.service.heartbeat(viewer, projectId, projectRunId, generation)
          );
          return;
        }
        sendJson(res, 200, await preview.service.stop(viewer, projectId, projectRunId));
      } catch (error) {
        if (error instanceof ProjectHttpError) {
          // A capacity refusal carries the delay: a caller that retried
          // immediately would spend the quota it is waiting for.
          if (error.status === 429) res.setHeader('retry-after', '30');
          sendJson(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const previewEgress = pathname.match(/^\/api\/projects\/([^/]+)\/preview-egress$/);
    if (previewEgress) {
      if (!viewer) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      const preview = PREVIEW_RUNTIME;
      if (!preview) {
        sendJson(res, 503, { error: 'previews are not available on this deployment' });
        return;
      }
      const projectId = decodePathComponent(previewEgress[1]!);
      if (!projectId) {
        sendJson(res, 400, { error: 'bad project id' });
        return;
      }
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, preview.service.listEgress(viewer, projectId));
          return;
        }
        if (req.method === 'PUT') {
          if (!sameOrigin(req, res)) return;
          let body: unknown;
          try {
            body = JSON.parse((await readBodyBounded(req, 4_096)).toString('utf8') || '{}');
          } catch {
            sendJson(res, 400, { error: 'request body is not valid JSON' });
            return;
          }
          const hosts = (body as { hosts?: unknown }).hosts;
          if (!Array.isArray(hosts)) {
            sendJson(res, 400, { error: 'expected a hosts array' });
            return;
          }
          sendJson(res, 200, await preview.service.replaceEgress(viewer, projectId, hosts));
          return;
        }
        res.writeHead(405, {
          allow: 'GET, PUT',
          'content-length': '0',
          'cache-control': 'no-store',
        });
        res.end();
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
    // BOUNDED, like every other reader of this corpus (2026-08-27 review, 2.4).
    // A trace has no cap in the pipeline and this route is polled ~1×/s per
    // live client and per tab, so the unbounded read let one long-running
    // tenant run materialise an arbitrary document in the server process every
    // second, multiplied by the open tabs.
    //
    // 413 for the refusal, KNOWINGLY reusing the status this codebase gives to
    // an oversized REQUEST body (`src/projects/service.ts`, `src/github/http.ts`
    // and the bounded readers above). There is no response-side size code in
    // HTTP; the alternatives lie harder — 404 makes an existing trace
    // indistinguishable from a deleted one, and 500 calls a policy an error.
    // The distinct `error` string is what tells the two 413s apart.
    const read = readBoundedRunFile(file);
    if (!read.ok) {
      if (read.reason === 'overCeiling') {
        sendJson(res, 413, { error: 'run trace exceeds the read ceiling' });
        return;
      }
      // Unlinked, replaced, or no longer a regular file since it resolved.
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const body = read.bytes;
    // DELTA MODE (?after=<n>): the live poll re-fetched the WHOLE run every
    // second, so a long run re-shipped a growing payload ~60×/minute to
    // learn about a handful of new events. With `after`, the response
    // carries the run header (totals, endedAt, result…) plus ONLY the
    // events past index n, and `eventsFrom` tells the client where the
    // slice starts. Absent the param the full run is served byte-for-byte
    // as before — first load, non-live runs, and any other consumer are
    // untouched.
    //
    // The ceiling above is what bounds the parse below: the delta still
    // materialises the whole document ONCE PER POLL, because slicing `events`
    // needs it. Removing that needs a server-side cache keyed on the trace's
    // mtime, or a streaming projection of the events array — and
    // `contracts/traceFields.ts` cannot return a document by construction, so
    // neither exists today. Both are new mechanisms; COOLING-OFF puts their
    // design outside the session that measured this one. Registered, not built.
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
    // READ-ONLY, and deliberately so: it returns compile-time constants — the
    // family guidance the project run form renders and the shell command for a
    // deployment with no organisations — NOT a way to start anything. This
    // route is UNGATED, which is exactly why it stays a reader: a run can call
    // BACK into this server (`fetch_url` has no URL allowlist by design, and
    // run_shell's is "STEERING, not a boundary"), so an ungated launcher here
    // would be reachable by the very code it would have to gate, and any
    // secret served over HTTP would be readable by it too. Starting a run from
    // the browser lives on the AUTHENTICATED project routes instead, where a
    // session the run does not hold is the boundary.
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
  // THE WATCH, in the banner beside auth and the registries — the honest
  // substitute for a whole-stack command. `npm run viz` starts the API, the UI
  // and this; there is nothing else to launch, so there is nothing to name.
  const health = sentinelHealth();
  if (health.armed) {
    console.log(
      `sentinel: watching every ${Math.round(health.intervalMs / 1000)}s ` +
        `(${sentinelRuleTable().length} rules, zero tokens, flagging only)`
    );
    // The same obligation the CLI banner carries: a laptop that sleeps stops
    // watching exactly while the run it was watching keeps spending. The
    // command is the HOST's own, and on a platform that cannot start a run
    // there is nothing to say — see `sleepInhibitorHint`.
    const inhibitor = sleepInhibitorHint();
    if (inhibitor) {
      console.log(`  keep this machine awake alongside long runs: ${inhibitor}`);
    }
  } else if (health.reason === 'ungated') {
    console.log('sentinel: off (no platform journal on this path — npm run sentinel writes its own)');
  } else if (health.reason === 'lease-held' && health.incumbent) {
    console.log(
      `sentinel: off — ${health.incumbent.source} pid ${health.incumbent.ownerPid} holds the watch on this store`
    );
  } else {
    console.log(`sentinel: off (${health.reason})`);
  }
  if (ANALYST) {
    const analyst = ANALYST.health();
    console.log(
      `analyst: on (quiet ${Math.round(analyst.quietMs / 1000)}s, ${analyst.queued} finished run(s) queued; ` +
        `spends ${analystProvider().model} — see src/supervisor/AGENTS.md)`
    );
  } else if (EVENTS && PROJECTS_RUNTIME) {
    console.log('analyst: off (ATOMA_VIZ_ANALYST=1 to analyse finished runs on this host)');
  }
  console.log(
    AUTH_RUNTIME
      ? `mcp: ${new URL('/mcp', AUTH_RUNTIME.publicOrigin).href} (bearer API token from /api/tokens or npm run auth -- token)`
      : `mcp: http://${cli.host}:${cli.port}/mcp (operator, loopback, no token)`
  );
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
