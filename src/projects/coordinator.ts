import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseRunLog, spawnRun, type RunStats } from '../cli/burnin.js';
import { declaredArtifactManifestSchema } from '../contracts/artifactManifest.js';
import type {
  ArtifactManifest,
  CreateProjectRunInput,
  Project,
  ProjectRun,
  Publication,
} from '../contracts/projects.js';
import type { TierModelPins } from '../contracts/tierModels.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV } from '../core/codexHomeLease.js';
import { LLM_PROVIDER_CATALOG } from '../core/providerCatalog.js';
import {
  HOST_SUBSCRIPTION_PREFIX,
  hostSubscriptionRoute,
  ledgerTouchesAnySubscription,
  ledgerTouchesSubscription,
  principalSubscriptionRoute,
  principalSubscriptionTiers,
  runPayerLedgerSchema,
  subscriptionTiers,
  type PayerKind,
  type RunPayerLedger,
  type TierPayer,
} from '../contracts/runPayers.js';
import {
  resolveTierChain,
  tierChainCandidates,
  type TierChainLevel,
} from '../contracts/tierModels.js';
import type { ProviderKeyProvider } from '../auth/store.js';
import { readTraceTopLevelFields } from '../contracts/traceFields.js';
// TYPE-ONLY, and it must stay that way: `src/viz/server.ts` imports four
// `src/projects` modules, so a value edge back into `src/viz` would close a
// subsystem cycle and put the delivered/failed decision inside the
// visualization subsystem. The import earns its place by pinning the member
// names below against the shape the recorder actually writes.
import type { VizRun } from '../viz/trace.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../run/runner.js';
import {
  acquireRunLease,
  RunLockBusyError,
  type RunLease,
  type RunLeaseAcquirer,
} from '../mcp/runLock.js';
import { repoRoot } from '../mcp/run.js';
import { buildArtifactManifest } from './artifacts.js';
import { ProjectStateConflict, ProjectStore } from './store.js';

const MAX_CONTROL_JSON_BYTES = 512 * 1024;

export interface ProjectRunPublisher {
  publish(input: {
    readonly project: Project;
    readonly run: ProjectRun;
    readonly workspaceRoot: string;
    readonly manifest: ArtifactManifest;
    readonly manifestHash: string;
  }): Promise<void | Publication | null>;
}

export type ProjectRunDriver = typeof spawnRun;

/**
 * Terminal outcome of one project run, emitted exactly once from `finish()`
 * after the state transition is persisted. Consumers (the viz push notifier)
 * are fail-open: a throwing listener is stderr, never a run failure.
 */
export interface ProjectRunFinishedEvent {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  /** The principal who requested the run — the one to notify. */
  readonly principalId: string;
  readonly goal: string;
  readonly status: 'delivered' | 'failed' | 'cancelled';
}

export interface ProjectCoordinatorOptions {
  readonly store: ProjectStore;
  readonly dbPath: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Host root whose layout is `orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
  readonly projectsRoot?: string;
  readonly driver?: ProjectRunDriver;
  readonly acquireLease?: RunLeaseAcquirer;
  readonly publisher?: ProjectRunPublisher;
  readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  /**
   * The requesting principal's per-tier model pins, when the deployment has
   * accounts (the viz gate supplies `authStore.modelPins`). Fail-open: a
   * throwing resolver falls back to the operator's host pins, because a
   * preference lookup must never be able to block a run.
   */
  readonly tierModelsFor?: (principalId: string) => TierModelPins;
  /**
   * The requesting principal's organisation's per-tier DEFAULTS (the second
   * level of the precedence chain account pin > org default > host env).
   * Same fail-open rule as `tierModelsFor`: resolved as a QUESTION per run,
   * never trusted from the request.
   */
  readonly orgTierModelsFor?: (orgId: string) => TierModelPins;
  /**
   * One provider credential the ORG configured, decrypted for injection into
   * this run child's environment. Resolved per (orgId, provider) at launch;
   * null or a throwing resolver means "no key", which degrades to not
   * forwarding that provider — never to failing the run.
   */
  readonly orgProviderKeyFor?: (
    orgId: string,
    provider: ProviderKeyProvider
  ) => string | null;
  /**
   * Does this principal hold the instance-wide platform-admin flag? Supplied
   * as a QUESTION, never as an answer: the coordinator asks it itself, so no
   * caller can hand in a pre-decided "yes". Absent or throwing means NO —
   * fail-closed, unlike `tierModelsFor`, because this one gates spending.
   *
   * It is the authority for the subscription-transport door
   * (`projectRunEnvironment`). The platform-admin flag is the right authority
   * because it is never derived from an OAuth claim: only the operator CLI,
   * run against the store on disk, can mint it (`src/cli/auth.ts`).
   */
  readonly platformAdmins?: (principalId: string) => boolean;
  /**
   * Resolve the requesting principal's CURRENT personal Codex generation.
   * The resolver is asked at launch, never trusted from an HTTP request. A
   * missing/throwing resolver is a hard refusal only when a personal sentinel
   * was selected; it can never fall through to the host's Codex login.
   */
  readonly principalCodexProfileFor?: (
    principalId: string
  ) => PrincipalCodexProfile | null;
  /**
   * Observer fired when a run spends any CLI subscription (host or requesting
   * principal). The payer ledger distinguishes them; the caller journals it,
   * so there is one delivery path as with `onRunFinished`.
   */
  readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  /**
   * Describe the delivered workspace for the result preview, at delivery.
   *
   * A NARROW COLLABORATOR, like `publisher` and `onRunFinished`, and for the
   * same reason: the coordinator owns when a run is delivered, not what a
   * preview is. It supplies the identity and the workspace it already holds;
   * the caller classifies and stores.
   *
   * WHY AT DELIVERY AND NOT ON DEMAND. The workspace is the seed of the next
   * run, so what it holds is a fact about THIS run only while this run is the
   * latest; and a classification computed per request would probe the
   * filesystem on a route a browser polls. Deciding once, here, is what lets
   * unavailability carry a stable reason.
   *
   * FAIL-OPEN, and that is not a shrug: a preview is a convenience over work
   * that is already delivered and already paid for. This repo has measured
   * what the other choice costs — a trace-size cap recorded delivered run
   * `2857a579` as failed and erased $0.84 of stats — so nothing on this path
   * may downgrade a delivered run. A throw is caught and reported to stderr,
   * and the missing row reads as `legacy-run`, which is exactly what it is.
   */
  readonly describeDeliveredPreview?: (input: DeliveredPreviewSubject) => void;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** What the coordinator knows about a delivered run's deliverable. */
export interface DeliveredPreviewSubject {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  readonly workspaceRoot: string;
}

/** One run allowed through the subscription-transport door. */
export interface SubscriptionTransportUse {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  readonly principalId: string;
  /** The `ATOMA_LLM` value the host configured, e.g. `claude-cli`. */
  readonly transport: string;
  /**
   * WHICH TIERS, PAID BY WHOM. A whole-run fact is no longer enough: a run may
   * spend the operator's login on L2 and L3 while L1 bills the organisation's
   * own key, and the journal row has to say so or it names the wrong payer.
   * The caller journals; this coordinator emits no audit row itself, as with
   * `onRunFinished`.
   */
  readonly payers: RunPayerLedger;
}

export class ProjectRunBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunBusy';
  }
}

export class ProjectRunConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunConfigurationError';
  }
}

interface ActiveRun {
  readonly orgId: string;
  readonly principalId: string;
  readonly controller: AbortController;
}

/** Non-secret, exact generation passed from the account-profile authority. */
export interface PrincipalCodexProfile {
  readonly profileId: string;
  readonly homePath: string;
  readonly profilesRoot: string;
}

const FORWARDED_HOST_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CI',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * Transports that bind to a machine-local login session rather than to a
 * credential the caller can supply. `claude` is the bare alias
 * `resolveBaseProviderKind` accepts for `claude-cli`; both spellings must be
 * recognised here or the door would have a hole in it.
 */
export function isSubscriptionTransport(value: string | undefined): boolean {
  const kind = (value ?? '').trim().toLowerCase();
  return kind === 'claude-cli' || kind === 'claude';
}

/**
 * Is this tier value routable for a tenant run? The catalogue shape is the
 * contract — bare historical ids pass (the router treats them as default-
 * provider models), catalogue selectors pass, and anything else with a
 * colon (an unknown provider, `claude-cli:*`, a shell fragment) refuses.
 * Mirrors the write-side validator; kept locally so a drift between them
 * fails loudly in tests rather than silently at routing time.
 */
function isCatalogueSelection(value: string): boolean {
  const providerId = selectorProvider(value);
  if (providerId === null) return true;
  return LLM_PROVIDER_CATALOG.some((provider) => provider.id === providerId);
}

/**
 * The provider a selection names, or null for a bare model id (which routes
 * through the default transport). ONE reading of the prefix: three call sites
 * used to split on the first colon themselves, and an ollama tag carries its
 * own colons, so the rule that only the FIRST one separates is not a detail
 * any of them may restate differently.
 */
function selectorProvider(value: string): string | null {
  const colonIndex = value.indexOf(':');
  return colonIndex === -1 ? null : value.slice(0, colonIndex);
}

/**
 * Can THIS run honour a selection? A bare model id routes through the
 * default transport whose credential the base environment already carries.
 * A `provider:model` selector needs that provider's credential.
 *
 * `childEnv` is the environment BEING BUILT, never the host's: what decides
 * whether a pin can be honoured is what the child will actually receive. On
 * a subscription run that is nothing at all, so an anthropic pin falls
 * through here instead of detonating on the first call — the host's exported
 * key is irrelevant to a child that is not given it.
 */
function providerCredentialAvailable(
  value: string,
  keys: Partial<Record<ProviderKeyProvider, string>>,
  childEnv: NodeJS.ProcessEnv
): boolean {
  const providerId = selectorProvider(value);
  if (providerId === null) return true;
  if (providerId === 'ollama') {
    // Self-hosted, so no secret — but "the deployment HAS an Ollama" is
    // still a fact only the operator can assert, by exporting
    // OLLAMA_BASE_URL. Assuming the default localhost endpoint is exactly
    // what detonates on a host without one, so no declaration means the pin
    // falls through like any provider whose credential nobody brought. The
    // endpoint is the OPERATOR's infrastructure: an org picks ollama models,
    // never an ollama destination (a tenant-supplied URL would be SSRF from
    // the platform's own process).
    return Boolean(childEnv['OLLAMA_BASE_URL']);
  }
  const provider = LLM_PROVIDER_CATALOG.find((entry) => entry.id === providerId);
  if (!provider?.credentialEnvVar) return false;
  return Boolean(
    keys[providerId as ProviderKeyProvider] || childEnv[provider.credentialEnvVar]
  );
}

/**
 * FORWARD ONLY WHAT THE ORG BROUGHT, AND ONLY WHAT THIS RUN REFERENCES. Each
 * forwarded credential rides the same environment snapshot as its tier pins,
 * so the child's lazy provider factories can build exactly the referenced
 * clients. Host values are NOT overridden by absent org keys — but an
 * explicitly configured org key wins over a host variable of the same name,
 * because "the org brought its own key" is BYO-key's entire point.
 *
 * `referenced` narrows it further (2026-08-27, 3.1): an org with three stored
 * keys used to hand all three to every run, including the two no tier asked
 * for. `CHILD_ENV_ALLOWLIST` (`src/tools/sandbox.ts`) already keeps them out
 * of tool subprocesses, so this is not a hole being closed — it is the
 * runner's own memory and `/proc` surface being no wider than the run needs.
 */
function injectOrgProviderKeys(
  environment: NodeJS.ProcessEnv,
  keys: Partial<Record<ProviderKeyProvider, string>>,
  referenced: ReadonlySet<string>
): void {
  for (const provider of LLM_PROVIDER_CATALOG) {
    if (provider.credentialEnvVar === null) continue;
    if (!referenced.has(provider.id)) continue;
    const orgKey = keys[provider.id];
    const trimmed = orgKey?.trim();
    if (!trimmed) continue;
    environment[provider.credentialEnvVar] = trimmed;
    // Optional tuning variables stay HOST-owned: an org never sets base
    // URLs through this path.
    void provider.configurableEnvVars;
  }
}

/**
 * WHO PAYS FOR A CATALOGUE SELECTION. Ollama is the operator's own hardware
 * (priced at zero, billed to nobody) and is a different fact from "the
 * operator's API key"; a provider whose key the ORG brought bills the org; a
 * bare model id inherits whoever pays for the base transport.
 */
function payerForProvider(
  providerId: string | null,
  base: TierPayer,
  keys: Partial<Record<ProviderKeyProvider, string>>
): PayerKind {
  if (providerId === null) return base.payer;
  if (providerId === 'ollama') return 'host-selfhosted';
  if (providerId === base.provider) return base.payer;
  return keys[providerId as ProviderKeyProvider] ? 'org-key' : base.payer;
}

/**
 * MAY THIS RUN SPEND THE OPERATOR'S OWN LOGIN ON THIS TIER? Three refusals,
 * each naming what is missing, and every one of them THROWS rather than
 * falling through: a revoked authority that quietly became a billed
 * credential is exactly the audit lie this feature exists to avoid.
 *
 * The authority is asked HERE, per run, and is never handed in as an answer —
 * `resolveSubscriptionGrant` is fail-closed and reads the platform-admin flag
 * that only the operator CLI can mint. A stored pin is data; permission is not
 * storable.
 */
function assertSubscriptionPinIsHonourable(input: {
  readonly tier: 1 | 2 | 3;
  readonly level: TierChainLevel;
  readonly grant: { readonly principalId: string } | undefined;
  readonly declaredOrg: string | undefined;
  readonly orgId: string | undefined;
}): void {
  const where = `ATOMA_MODEL_L${input.tier}`;
  if (input.level !== 'account') {
    // An org default is inherited by every member by construction, and the
    // host env is the third candidate for EVERY tier: a sentinel at either
    // level would be a payer-bearing default nobody chose (design D2/D3).
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription from the ${input.level} level; only a platform ` +
        "admin's own account pin may spend the operator's login"
    );
  }
  if (!input.grant) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but the requesting account no longer holds the ` +
        'platform-admin flag. Clear the pin in Settings, or have the flag restored'
    );
  }
  if (!input.declaredOrg) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but this deployment declares no organisation for ` +
        'it. Set ATOMA_HOST_SUBSCRIPTION_ORG, or clear the pin in Settings'
    );
  }
  if (input.orgId !== input.declaredOrg) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but this run belongs to another organisation than ` +
        'the one this deployment declares for it'
    );
  }
}

/**
 * A personal subscription is valid only as the requester's own account pin.
 * Unlike a missing catalogue key, loss of the exact profile is never a
 * fall-through: changing payer after the user selected their subscription
 * would make both the bill and the audit row false.
 */
function assertPrincipalSubscriptionPinIsHonourable(input: {
  readonly tier: 1 | 2 | 3;
  readonly level: TierChainLevel;
  readonly profile: PrincipalCodexProfile | undefined;
}): void {
  const where = `ATOMA_MODEL_L${input.tier}`;
  if (input.level !== 'account') {
    throw new ProjectRunConfigurationError(
      `${where} names a personal subscription from the ${input.level} level; only the ` +
        "requesting member's own account pin may spend their subscription"
    );
  }
  if (!input.profile) {
    throw new ProjectRunConfigurationError(
      `${where} names the requester's ChatGPT subscription, but their Codex account is no ` +
        'longer connected. Reconnect it in Settings or clear the pin'
    );
  }
}

export interface ProjectRunEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  /** Who paid for what, per tier plus the base transport. */
  readonly payers: RunPayerLedger;
}

export function projectRunEnvironment(input: {
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly dbPath: string;
  readonly workspacePath: string;
  readonly runsPath: string;
  readonly skillsPath: string;
  readonly runId: string;
  readonly artifactManifestPath: string;
  /**
   * The requesting account's per-tier choices, and the organisation's
   * defaults beneath them: `effectiveTierSelection` resolves the chain
   * account pin > org default > null, and a null tier inherits the
   * operator's host pin inside the loop below.
   *
   * A selection MAY now be a `provider:model` selector. That is safe by
   * construction: the values come from `contracts/tierModels.ts`, whose
   * catalogue admits exactly the credential-honouring providers of
   * `core/providerCatalog.ts` (raw claude-cli/codex routes cannot appear), and each
   * referenced provider's credential is injected alongside the pin from the
   * org's own key store — a pin without its key is dropped before it can
   * reach the router and detonate mid-run. The historical bare-`:`
   * REFUSAL narrows to what it always defended: any provider prefix that
   * is not in the catalogue.
   */
  readonly tierModels?: TierModelPins;
  /** The org-level defaults under `tierModels`. See its doc above. */
  readonly orgTierModels?: TierModelPins;
  /**
   * The organisation this run belongs to. Required to judge a per-tier
   * host-subscription pin: the deployment declares ONE organisation in
   * `ATOMA_HOST_SUBSCRIPTION_ORG` where the operator's own login may be
   * spent, and a pin naming it from anywhere else is refused (design
   * 2026-08-28, D6/Q1). Optional so the many callers that never touch the
   * subscription keep compiling; absent simply cannot match a declaration.
   */
  readonly orgId?: string;
  /**
   * Credentials the org configured, by catalogue provider id. Present keys
   * are forwarded into the run child; absent ones are not.
   */
  readonly orgProviderKeys?: Partial<Record<ProviderKeyProvider, string>>;
  /**
   * THE SUBSCRIPTION-TRANSPORT DOOR. Present only when the coordinator has
   * verified that the REQUESTING principal holds the platform-admin flag.
   *
   * What it permits and what it costs, stated plainly because the whole point
   * is that this is not silent: a machine-bound transport such as
   * `claude-cli` binds to the host's own `claude /login` session, so the run
   * spends THAT subscription and cannot honour a per-run credential. For a
   * tenant that would be one account billing another, which is why the
   * default is still refusal. For a platform admin on their own instance the
   * host subscription IS their subscription, so the objection does not apply
   * — and the platform-admin flag is the right authority precisely because it
   * is never derived from an OAuth claim: only the operator CLI, run against
   * the store on disk, can mint it.
   */
  readonly subscriptionTransport?: { readonly principalId: string };
  /** Exact personal Codex generation resolved for the requesting principal. */
  readonly principalCodexProfile?: PrincipalCodexProfile;
}): ProjectRunEnvironment {
  const selected = input.hostEnv['ATOMA_LLM']?.trim() || 'anthropic';
  const subscriptionRequested = isSubscriptionTransport(selected);
  if (subscriptionRequested && !input.subscriptionTransport) {
    throw new ProjectRunConfigurationError(
      `project runs cannot use ATOMA_LLM=${selected}: a subscription CLI transport binds to this ` +
        'machine\'s own login session, so the run would spend the HOST subscription and ignore ' +
        'per-run credentials. Set ATOMA_LLM=anthropic with a per-run credential, or have a ' +
        'platform admin request the run — that is the one identity allowed through this door.'
    );
  }
  const baseProvider = selected.toLowerCase();
  if (!subscriptionRequested && baseProvider !== 'anthropic' && baseProvider !== 'zai') {
    throw new ProjectRunConfigurationError(
      `project runs do not support ATOMA_LLM=${selected}; use anthropic or zai with a per-run credential`
    );
  }
  const baseEntry = LLM_PROVIDER_CATALOG.find((provider) => provider.id === baseProvider);
  const credentialEnvVar = baseEntry?.credentialEnvVar;
  const hostBaseKey = credentialEnvVar ? input.hostEnv[credentialEnvVar]?.trim() : undefined;
  const orgBaseKey =
    baseProvider === 'anthropic' || baseProvider === 'zai'
      ? input.orgProviderKeys?.[baseProvider]?.trim()
      : undefined;
  // NO BEARER TOKEN ON THIS PATH. `ANTHROPIC_AUTH_TOKEN` is the SDK's other
  // credential slot, and a tenant has nowhere to supply one: the org key
  // store is keyed by catalogue provider, and anthropic's credential
  // variable is `ANTHROPIC_API_KEY`. It could therefore only ever come from
  // the host env, where it is also the wrong shape — a bearer is short-lived
  // and refreshed from a login profile on disk, while a run child receives a
  // frozen env snapshot it cannot refresh, so a long run would simply expire
  // mid-flight. The operator's own LOCAL runs keep it (`src/run/auth.ts`),
  // where the SDK reads the live profile.
  // The org's OWN anthropic key is a per-run credential too — it is what
  // makes a BYO-ONLY deployment possible, one that carries no platform key at
  // all. Reading it here rather than only at injection time below is the
  // difference between that deployment working and every one of its runs
  // being refused while the encrypted key sits in the store.
  // Refused rather than dropped: an operator who exported a bearer expecting
  // it to be spent must be told it is not, not watch runs bill a different
  // credential — or fail for "no credential" while a token sits in the shell.
  if (
    !subscriptionRequested &&
    baseProvider === 'anthropic' &&
    input.hostEnv['ANTHROPIC_AUTH_TOKEN']?.trim()
  ) {
    throw new ProjectRunConfigurationError(
      'project runs do not accept ANTHROPIC_AUTH_TOKEN: a bearer token is refreshed from a login ' +
        'profile the run child cannot read, so it would expire mid-run. Use ANTHROPIC_API_KEY on ' +
        "the host, or the organisation's own anthropic provider key"
    );
  }
  // The credential rule applies to the credentialled transport only. A
  // subscription run has no per-run credential BY DEFINITION, and demanding
  // one here would refuse exactly the case the door just allowed.
  if (!subscriptionRequested && !hostBaseKey && !orgBaseKey) {
    throw new ProjectRunConfigurationError(
      `project runs require a ${baseProvider} credential: ${credentialEnvVar} on the host, or ` +
        `this organisation's own ${baseProvider} provider key`
    );
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_HOST_ENV) {
    const value = input.hostEnv[key];
    if (value !== undefined) environment[key] = value;
  }
  environment['NODE_ENV'] = 'production';
  if (subscriptionRequested) {
    // Canonical spelling, so a run's env says which transport it used even
    // when the host wrote the bare `claude` alias.
    environment['ATOMA_LLM'] = 'claude-cli';
    // NO credential is forwarded. The transport cannot honour one, and a
    // stale exported key reaching the subprocess would only confuse the
    // provider's own precedence rules. `usableOrgKeys` below is what makes
    // that true of the ORG's keys as well as the host's.
  } else {
    environment['ATOMA_LLM'] = baseProvider;
    if (orgBaseKey && credentialEnvVar) {
      // BYO wins over the host: an org that brought its own key pays with it.
      // `injectOrgProviderKeys` writes the same value below; the branch here
      // is what keeps the host's gateway URL out of the child.
      environment[credentialEnvVar] = orgBaseKey;
      // A BYO KEY GOES TO ITS OWN ISSUER. `ANTHROPIC_BASE_URL` is how a host
      // points the anthropic transport at a gateway (Z.ai's own Claude Code
      // instructions are exactly this variable plus a bearer token), and
      // forwarding it here would send an ORGANISATION's key to a third party
      // it never consented to — rejected at best, disclosed at worst. The
      // host's gateway applies to the host's own credential, not to a
      // tenant's, so the variable is dropped on this path.
    } else {
      if (hostBaseKey && credentialEnvVar) environment[credentialEnvVar] = hostBaseKey;
      for (const variable of baseEntry?.configurableEnvVars ?? []) {
        const value = input.hostEnv[variable]?.trim();
        if (value) environment[variable] = value;
      }
    }
  }
  // THE BASE ROW OF THE PAYER LEDGER. The branch above just decided who pays
  // for every call that carries no `provider:` prefix — an unpinned tier,
  // `resolveLatestOpus` on the L3 path, anything reaching the default client.
  // A ledger of three tier rows would say "L2 and L3 were on the subscription"
  // and stay silent about the account that paid for everything else, which is
  // the omission finding 2.2 punished (design 2026-08-28, D8).
  const baseRow: TierPayer = subscriptionRequested
    ? {
        selection: null,
        provider: HOST_SUBSCRIPTION_PREFIX,
        payer: 'host-subscription',
        source: 'host',
      }
    : {
        selection: null,
        provider: baseProvider,
        payer: orgBaseKey ? 'org-key' : 'host-key',
        source: orgBaseKey ? 'org' : 'host',
      };
  // THE HOST'S OLLAMA ENDPOINT crosses on every branch: it selects no payer
  // (self-hosted, priced at zero), so unlike the anthropic gateway URL above
  // it is safe beside a BYO key and on a subscription run alike. Forwarded
  // BEFORE tier resolution because it is what makes an ollama pin honourable.
  const ollamaBaseUrl = input.hostEnv['OLLAMA_BASE_URL']?.trim();
  if (ollamaBaseUrl) environment['OLLAMA_BASE_URL'] = ollamaBaseUrl;
  // A SUBSCRIPTION RUN SPENDS THE HOST SUBSCRIPTION, AND NOTHING ELSE. The
  // org's keys are withheld from it entirely: injected, they would let a
  // tier pinned to `anthropic:*` or `zai:*` bill the ORGANISATION while the
  // journal records `run.host_subscription`, so the audit row would name the
  // wrong payer. Withholding them here — rather than at injection only —
  // also drops the pins those keys would have unlocked, which is what keeps
  // a pin from reaching the router without its credential.
  const usableOrgKeys = subscriptionRequested ? {} : (input.orgProviderKeys ?? {});
  // CATALOGUE-GUARDED TIER RESOLUTION: account pin > org default > host env,
  // resolved PER CANDIDATE so a preference pointing at a provider whose
  // credential nobody configured falls through to the level beneath it
  // instead of reaching the router and detonating mid-run. Non-catalogue
  // provider prefixes refuse outright at every level.
  //
  // THE THREE ANSWERS ARE NOT INTERCHANGEABLE, and the rule generalises:
  // FALL-THROUGH IS PERMITTED WITHIN A PAYER, REFUSAL IS REQUIRED ACROSS
  // PAYERS. A credential nobody brought is a fall-through (the next level
  // bills the same kind of account); a provider you may not use, or an
  // authority you no longer hold, is a refusal — falling through there would
  // move the payer from the operator's subscription to a billed credential
  // with no event anywhere, which is the defect class finding 2.2 closed.
  const subscriptionOrg = input.hostEnv['ATOMA_HOST_SUBSCRIPTION_ORG']?.trim();
  const ledger: Record<'l1' | 'l2' | 'l3', TierPayer> = {
    l1: baseRow,
    l2: baseRow,
    l3: baseRow,
  };
  for (const tier of [1, 2, 3] as const) {
    const key = `l${tier}` as const;
    const chosen = resolveTierChain(
      tierChainCandidates({
        account: input.tierModels,
        org: input.orgTierModels,
        host: input.hostEnv[`ATOMA_MODEL_L${tier}`],
        tier,
      }),
      (candidate) => {
        const personalSubscription = principalSubscriptionRoute(candidate.value);
        if (personalSubscription) {
          if (tier === 1) {
            throw new ProjectRunConfigurationError(
              'ATOMA_MODEL_L1 cannot use the requester ChatGPT subscription because Codex ' +
                'cannot expose the L1 tool loop through ToolSandbox'
            );
          }
          assertPrincipalSubscriptionPinIsHonourable({
            tier,
            level: candidate.level,
            profile: input.principalCodexProfile,
          });
          return 'take';
        }
        const subscription = hostSubscriptionRoute(candidate.value);
        if (subscription) {
          if (tier === 1 && subscription.provider === 'codex') {
            throw new ProjectRunConfigurationError(
              'ATOMA_MODEL_L1 cannot use the ChatGPT host subscription because Codex cannot ' +
                'expose the L1 tool loop through ToolSandbox'
            );
          }
          assertSubscriptionPinIsHonourable({
            tier,
            level: candidate.level,
            grant: input.subscriptionTransport,
            declaredOrg: subscriptionOrg,
            orgId: input.orgId,
          });
          return 'take';
        }
        if (!isCatalogueSelection(candidate.value)) {
          throw new ProjectRunConfigurationError(
            `ATOMA_MODEL_L${tier}=${candidate.value} names a provider project runs cannot be routed to`
          );
        }
        // Fail-open: nobody brought this provider's credential, so the next
        // level of the chain decides instead.
        return providerCredentialAvailable(candidate.value, usableOrgKeys, environment)
          ? 'take'
          : 'skip';
      }
    );
    if (!chosen) continue;
    const personalSubscription = principalSubscriptionRoute(chosen.value);
    if (personalSubscription) {
      // The persisted sentinel is deliberately not routable. Translation is
      // downstream of the self-scoped profile check above, so no other caller
      // can turn a string into access to a principal's credential generation.
      environment[`ATOMA_MODEL_L${tier}`] =
        `${personalSubscription.provider}:${personalSubscription.model}`;
      ledger[key] = {
        selection: chosen.value,
        provider: personalSubscription.provider,
        payer: 'principal-subscription',
        source: chosen.level,
      };
      continue;
    }
    const subscription = hostSubscriptionRoute(chosen.value);
    if (subscription) {
      // TRANSLATED HERE AND NOWHERE ELSE, downstream of the authority check.
      // The sentinel is what is STORED — non-routable on purpose, so no other
      // code path that forwards a pin into an environment can become a
      // subscription route by accident.
      environment[`ATOMA_MODEL_L${tier}`] = `${subscription.provider}:${subscription.model}`;
      ledger[key] = {
        selection: chosen.value,
        provider: subscription.provider,
        payer: 'host-subscription',
        source: chosen.level,
      };
      continue;
    }
    environment[`ATOMA_MODEL_L${tier}`] = chosen.value;
    ledger[key] = {
      selection: chosen.value,
      provider: selectorProvider(chosen.value) ?? baseRow.provider,
      payer: payerForProvider(selectorProvider(chosen.value), baseRow, usableOrgKeys),
      source: chosen.level,
    };
  }
  const payers: RunPayerLedger = runPayerLedgerSchema.parse({
    base: baseRow,
    l1: ledger.l1,
    l2: ledger.l2,
    l3: ledger.l3,
  });
  if (principalSubscriptionTiers(payers).length > 0) {
    if (!input.principalCodexProfile) {
      // Kept next to the environment mutation as a defensive invariant even
      // though the candidate gate above already refuses this state.
      throw new ProjectRunConfigurationError(
        "the requester's Codex profile disappeared while constructing the run"
      );
    }
    const rows = [payers.base, payers.l1, payers.l2, payers.l3];
    if (
      rows.some(
        (row) => row.provider === 'codex' && row.payer === 'host-subscription'
      )
    ) {
      throw new ProjectRunConfigurationError(
        'one run cannot mix the host and requester ChatGPT subscriptions because Codex has ' +
          'one credential home per process'
      );
    }
    environment['CODEX_HOME'] = path.resolve(input.principalCodexProfile.homePath);
    environment['CODEX_SQLITE_HOME'] = path.resolve(input.principalCodexProfile.homePath);
    environment[PERSONAL_CODEX_PROFILE_ROOT_ENV] = path.resolve(
      input.principalCodexProfile.profilesRoot
    );
  }
  if (ledgerTouchesSubscription(payers)) {
    // A GATEWAY AND A SUBSCRIPTION DO NOT SHARE A RUN. `ANTHROPIC_BASE_URL`
    // redirects the anthropic transport at a third party; the subscription
    // subprocess already refuses every `ANTHROPIC_*` variable, so leaving it
    // in the env would only mislead about where the OTHER tiers went.
    delete environment['ANTHROPIC_BASE_URL'];
  }
  // WHICH PROVIDERS THIS RUN CAN ACTUALLY REACH. Read from the RESOLVED pins
  // rather than from the preferences, because a pin whose credential nobody
  // brought already fell through the loop above — forwarding a key for it
  // would arm a provider no tier can name. The base transport is always
  // referenced on the credentialled branch: an unpinned tier routes there.
  const referencedProviders = new Set<string>();
  if (!subscriptionRequested) referencedProviders.add(baseProvider);
  for (const tier of [1, 2, 3] as const) {
    const resolved = environment[`ATOMA_MODEL_L${tier}`];
    const providerId = resolved ? selectorProvider(resolved) : null;
    if (providerId) referencedProviders.add(providerId);
  }
  injectOrgProviderKeys(environment, usableOrgKeys, referencedProviders);
  Object.assign(environment, {
    ATOMA_REQUIRE_ISOLATION: '1',
    ATOMA_CONTAINER: '1',
    ATOMA_EGRESS: '0',
    ATOMA_DB_PATH: path.resolve(input.dbPath),
    ATOMA_LEDGER_DB: path.resolve(input.dbPath),
    ATOMA_BUILD_WORKSPACE: path.resolve(input.workspacePath),
    ATOMA_RUNS_DIR: path.resolve(input.runsPath),
    ATOMA_SKILLS_DIR: path.resolve(input.skillsPath),
    ATOMA_RUN_ID: input.runId,
    [ARTIFACT_MANIFEST_PATH_ENV]: path.resolve(input.artifactManifestPath),
    // SKILL LEARNING IS ON, and it is the point of the platform: a tenant's
    // runs should get cheaper as their project grows. It was off, and two
    // delivered runs measured what that costs — $0.59 spent, `learnedSkills:
    // 0`, nothing carried into the next run.
    //
    // What makes it safe here is `ATOMA_SKILLS_DIR` above: it points at
    // `<projectRoot>/skills`, so what a run learns is partitioned PER PROJECT.
    // Nothing crosses to another project, let alone another organisation, and
    // the cross-tenant question stays where it belongs — a reviewed offer with
    // a human gate (`docs/platform-skill-offer-review-2026-08-23.md`).
    ATOMA_SKILL_LEARN: '1',
    ATOMA_EVENT_SKILLS: '1',
    // PROMOTION AND DETERMINISTIC DISPATCH STAY OFF. A project run is
    // `--seed`ed from the previous delivered workspace, which is itself the
    // maintenance-mode signal that enables promotion by default — so leaving
    // these unset would promote tenant scripts to trusted executables as a
    // side effect of the seeding. Promotion is what turns a learned recipe
    // into something that RUNS without a model reading it, and that needs
    // measurement this product has not done for tenant work.
    ATOMA_SKILL_PROMOTE: '0',
    ATOMA_SKILL_DIRECT: '0',
    // The prefilter cache stays off for a different reason: it is the one
    // lifecycle store that is NOT partitioned per project — it lives in the
    // shared product store, so one tenant's cached planning decisions would be
    // readable to the next. Partitioning it is its own change.
    ATOMA_PREFILTER_CACHE: '0',
    // THE SECOND GATE'S INPUT. A tenant run's child re-checks, at launch,
    // that every machine-bound transport it can see was authorised HERE —
    // `assertTransportHonoursCredentials` in `src/run/providers.ts`, which
    // never fired on a project run before because nothing supplied it a
    // credential snapshot. `ATOMA_TENANT_RUN` is what arms it; the tier list
    // is what keeps it from refusing the very pins this coordinator just
    // authorised (design 2026-08-28, Q8).
    ATOMA_TENANT_RUN: '1',
  });
  const authorisedTiers = [
    ...subscriptionTiers(payers),
    ...principalSubscriptionTiers(payers),
  ];
  if (authorisedTiers.length > 0) {
    environment['ATOMA_SUBSCRIPTION_TIERS'] = authorisedTiers.join(',');
  }
  return { environment, payers };
}

function previousDeliveredWorkspace(
  store: ProjectStore,
  orgId: string,
  projectId: string
): string | null {
  const runs = store.listProjectRuns(orgId, projectId);
  if (!runs) return null;
  for (const run of runs) {
    if (run.status !== 'delivered') continue;
    try {
      if (lstatSync(run.hostPaths.workspacePath).isDirectory()) {
        return run.hostPaths.workspacePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * ONE caller: `declared-artifacts.json`. That file is small by contract and its
 * CONTENT is model-chosen, so a size bound plus a whole-document parse is the
 * right shape for it.
 *
 * A run trace is the opposite on both axes — a control-plane-owned path whose
 * SIZE is a function of how much work the run did — and bounding the two the
 * same way is what recorded delivered run `2857a579` as failed. Traces go
 * through `readTraceTopLevelFields`; see `src/contracts/traceFields.ts`.
 */
function boundedOwnJson(pathname: string): unknown {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`control-plane JSON is not a bounded regular file: ${pathname}`);
  }
  return JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
}

/**
 * The members the delivery decision reads. `satisfies` pins them against the
 * shape the recorder writes, so renaming a field in `VizRun` fails to compile
 * here instead of silently reading `undefined` in production.
 */
const TRACE_VALUE_KEYS = ['id', 'endedAt', 'cancelled', 'degraded'] as const satisfies readonly (keyof VizRun)[];
/**
 * `result` and `error` are the two members a MODEL wrote. They are read as
 * shapes — present, and an object — and never materialised, which is what
 * makes the projection under 400 bytes on a trace of any size.
 */
const TRACE_SHAPE_KEYS = ['result', 'error'] as const satisfies readonly (keyof VizRun)[];

function verifiedTrace(pathname: string, expectedRunId: string): void {
  const trace = readTraceTopLevelFields(pathname, {
    values: TRACE_VALUE_KEYS,
    shapes: TRACE_SHAPE_KEYS,
  });
  if (trace.values['id'] !== expectedRunId) {
    throw new Error('run trace id does not match the project run');
  }
  if (typeof trace.values['endedAt'] !== 'string' || trace.shapes['result'] !== 'object') {
    throw new Error('run trace has no completed result');
  }
  // PRESENCE, not truthiness: `error: ''` now refuses where it used to pass.
  // `endRun` assigns `error` only from a real message, so no writer produces
  // the empty string, and the tightening only ever refuses.
  if (
    trace.shapes['error'] !== undefined ||
    trace.values['cancelled'] === true ||
    trace.values['degraded'] === true
  ) {
    throw new Error('failed, cancelled or degraded traces are not publishable');
  }
}

/** First `✖ …` line from a failed runner log, else a bounded outcome label. */
export function runnerFailureDetail(log: string, outcome: string): string {
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('✖ ')) continue;
    const detail = trimmed.slice(2).trim();
    if (!detail) continue;
    // A runner error is not always one line: a schema failure prints zod's
    // pretty-printed issues array, whose FIRST line is `[`. MEASURED
    // 2026-08-23, project run `d771d166`: the stored error column held the
    // single character `[` while the field that failed and why sat on the
    // eleven indented lines below it. Continuation lines are recognised by
    // SHAPE — indented, or a bare closing bracket — so an unrelated flat log
    // line that happens to follow a one-line error is never swallowed.
    const parts = [detail];
    let budget = 2_000 - detail.length;
    for (let j = i + 1; j < lines.length && budget > 0; j++) {
      const raw = lines[j]!;
      const isContinuation =
        /^\s+\S/.test(raw) || /^[\]}],?$/.test(raw.trim());
      if (!isContinuation) break;
      const piece = raw.trim();
      parts.push(piece);
      budget -= piece.length + 1;
    }
    return parts.join(' ').slice(0, 2_000);
  }
  // A LAUNCH that never became a run has no `✖ ` line, because the runner
  // never spoke. `--- spawn failed --- <cause>` is the shape `spawnRun` writes
  // for every one of those: an ENOENT on `npm`, an unwritable workspace, and
  // the run-host refusal on a platform whose reap sequence cannot work
  // (src/run/platform.ts). Without this branch every such failure reached the
  // operator as the generic sentence below while the log held the reason —
  // measured on a win32 host 2026-09-01, where the platform refusal names the
  // way out and the Projects screen showed none of it.
  //
  // Ranked BELOW the runner's own verdict on purpose, and it is the same
  // reasoning parseRunLog applies to outcomes: a run takes one path, so if the
  // runner reported a failure it is the cause, and a launcher marker then
  // belongs to an earlier attempt or to echoed prose. A tenant goal is echoed
  // verbatim into this log and can therefore forge this line exactly as it can
  // already forge `✖ ` — which changes a detail string, never an outcome, and
  // is the accepted trade recorded in src/cli/AGENTS.md.
  for (const line of lines) {
    const spawned = /^-{3} spawn failed -{3}\s+(\S.*)$/.exec(line.trim());
    const cause = spawned?.[1]?.trim();
    if (cause) return cause.slice(0, 2_000);
  }
  return `runner finished with outcome ${outcome}`.slice(0, 2_000);
}

/**
 * THE OPERATOR'S BUDGET FOR ONE PROJECT RUN, and the one place it is decided.
 *
 * It used to be unreachable. The coordinator hard-coded 15 minutes, neither
 * construction site passed `timeoutMs`, `projects run` had no flag, and
 * `spawnRun` writes `ATOMA_BUILD_TIMEOUT_MS` AFTER spreading the caller's env —
 * so an operator's exported value was silently overwritten by the default. Run
 * `949ecd5d` died at 900s after 68 tool calls and $0.96, and its own post-mortem
 * advised raising a variable that could not be raised.
 *
 * The DEFAULT IS UNCHANGED at 15 minutes: what a tenant run may spend is a
 * product decision, not a refactor. What changes is that it can be said.
 *
 * Bounded on both ends because the child derives two later deadlines from it:
 * the runner's watchdog fires at budget + 60s and the harness hard-reaps at
 * budget + 180s, so an absurd value moves those too.
 */
export const DEFAULT_PROJECT_RUN_TIMEOUT_MS = 15 * 60 * 1_000;
export const MIN_PROJECT_RUN_TIMEOUT_MS = 60 * 1_000;
export const MAX_PROJECT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const PROJECT_RUN_TIMEOUT_ENV = 'ATOMA_PROJECT_TIMEOUT_MS';

/**
 * Resolve the budget: an explicit argument wins over the host environment,
 * which wins over the default. A malformed or out-of-range value is a REFUSAL,
 * never a silent fallback — a run that quietly gets 15 minutes when the
 * operator asked for 40 is the defect this replaces, wearing a different hat.
 *
 * Deliberately NOT named `ATOMA_BUILD_TIMEOUT_MS`: that variable belongs to the
 * child, is written by `spawnRun` from this value, and two names for one number
 * on either side of a process boundary is how the first version got confusing.
 */
export function projectRunTimeoutMs(
  hostEnv: NodeJS.ProcessEnv = process.env,
  explicitMs?: number
): number {
  const raw = explicitMs ?? hostEnv[PROJECT_RUN_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_PROJECT_RUN_TIMEOUT_MS;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new ProjectRunConfigurationError(
      `invalid project run timeout "${String(raw)}" (expected an integer in milliseconds)`
    );
  }
  if (parsed < MIN_PROJECT_RUN_TIMEOUT_MS || parsed > MAX_PROJECT_RUN_TIMEOUT_MS) {
    throw new ProjectRunConfigurationError(
      `project run timeout ${parsed}ms is outside ${MIN_PROJECT_RUN_TIMEOUT_MS}..${MAX_PROJECT_RUN_TIMEOUT_MS}ms`
    );
  }
  return parsed;
}

/** Default host root: `~/.atoma/orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
export const DEFAULT_PROJECTS_ROOT = path.join(homedir(), '.atoma');

/**
 * One run, one directory. The runner's `ATOMA_RUNS_DIR` is the `traces/`
 * child so `{runId}.json` never lands in a shared instance corpus.
 */
export function projectRunHostLayout(
  root: string,
  orgId: string,
  projectId: string,
  runId: string
) {
  const projectRoot = path.join(path.resolve(root), 'orgs', orgId, 'projects', projectId);
  const runRoot = path.join(projectRoot, 'runs', runId);
  return {
    projectRoot,
    runRoot,
    workspacePath: path.join(runRoot, 'workspace'),
    runsPath: path.join(runRoot, 'traces'),
    logPath: path.join(runRoot, 'run.log'),
    skillsPath: path.join(projectRoot, 'skills'),
    artifactManifestPath: path.join(runRoot, 'declared-artifacts.json'),
  };
}

export class ProjectRunCoordinator {
  private readonly store: ProjectStore;
  private readonly dbPath: string;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly root: string;
  private readonly driver: ProjectRunDriver;
  private readonly acquireLease: RunLeaseAcquirer;
  private readonly publisher?: ProjectRunPublisher;
  private readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  private readonly tierModelsFor?: (principalId: string) => TierModelPins;
  private readonly orgTierModelsFor?: (orgId: string) => TierModelPins;
  private readonly orgProviderKeyFor?: (
    orgId: string,
    provider: ProviderKeyProvider
  ) => string | null;
  private readonly platformAdmins?: (principalId: string) => boolean;
  private readonly principalCodexProfileFor?: (
    principalId: string
  ) => PrincipalCodexProfile | null;
  private readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  private readonly describeDeliveredPreview?: (input: DeliveredPreviewSubject) => void;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: ProjectCoordinatorOptions) {
    this.store = options.store;
    this.dbPath = path.resolve(options.dbPath);
    this.hostEnv = { ...(options.hostEnv ?? process.env) };
    this.root = path.resolve(options.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
    this.driver = options.driver ?? spawnRun;
    this.acquireLease = options.acquireLease ?? acquireRunLease;
    this.publisher = options.publisher;
    if (options.onRunFinished) this.onRunFinished = options.onRunFinished;
    if (options.tierModelsFor) this.tierModelsFor = options.tierModelsFor;
    if (options.orgTierModelsFor) this.orgTierModelsFor = options.orgTierModelsFor;
    if (options.orgProviderKeyFor) this.orgProviderKeyFor = options.orgProviderKeyFor;
    if (options.platformAdmins) this.platformAdmins = options.platformAdmins;
    if (options.principalCodexProfileFor) {
      this.principalCodexProfileFor = options.principalCodexProfileFor;
    }
    if (options.onSubscriptionTransport) {
      this.onSubscriptionTransport = options.onSubscriptionTransport;
    }
    if (options.describeDeliveredPreview) {
      this.describeDeliveredPreview = options.describeDeliveredPreview;
    }
    this.cwd = options.cwd ?? repoRoot();
    this.timeoutMs = projectRunTimeoutMs(this.hostEnv, options.timeoutMs);
  }

  /**
   * Boot-time crash recovery: fail every run/publication a dead process left
   * in flight (see `ProjectStore.reconcileInterrupted`). Refuses to run while
   * anything is active in-memory — those rows have live drivers.
   */
  reconcileInterrupted(): { runs: number; publications: number } {
    if (this.active.size > 0) {
      throw new Error('reconcileInterrupted is a boot-time operation; runs are active');
    }
    return this.store.reconcileInterrupted('interrupted by server restart');
  }

  /**
   * The requesting account's tier pins, or none. Fail-open by design: a
   * preferences lookup that throws leaves the operator's host pins in force
   * instead of failing the run the viewer just asked for.
   */
  private resolveTierModels(principalId: string): TierModelPins | undefined {
    if (!this.tierModelsFor) return undefined;
    try {
      return this.tierModelsFor(principalId);
    } catch (error) {
      process.stderr.write(
        `[atoma projects] tier model preferences unavailable for ${principalId}: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * The requester's organisation tier defaults, or none. Same fail-open
   * rule as `resolveTierModels` — it is a preference level, not an
   * authority.
   */
  private resolveOrgTierModels(orgId: string): TierModelPins | undefined {
    if (!this.orgTierModelsFor) return undefined;
    try {
      return this.orgTierModelsFor(orgId);
    } catch (error) {
      process.stderr.write(
        `[atoma projects] organisation tier defaults unavailable for ${orgId}: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * The org's configured provider credentials, decrypted per run. A key
   * that cannot be read degrades to absent (the run continues without the
   * provider), and one failing provider never hides another.
   */
  private resolveOrgProviderKeys(
    orgId: string
  ): Partial<Record<ProviderKeyProvider, string>> | undefined {
    if (!this.orgProviderKeyFor) return undefined;
    const keys: Partial<Record<ProviderKeyProvider, string>> = {};
    for (const provider of LLM_PROVIDER_CATALOG) {
      try {
        const value = this.orgProviderKeyFor(orgId, provider.id);
        if (value) keys[provider.id] = value;
      } catch (error) {
        process.stderr.write(
          `[atoma projects] provider key lookup failed for ${provider.id} in ${orgId}: ${String(error)}\n`
        );
      }
    }
    return keys;
  }

  /**
   * The subscription-transport grant for this requester, or none.
   *
   * FAIL-CLOSED, and deliberately the opposite of `resolveTierModels`: a
   * preferences lookup that throws must not block a run, but an authority
   * lookup that throws must never be read as permission to spend. No
   * resolver wired (a deployment without accounts) is also NO — the
   * ungated developer path uses the CLI runner directly and never comes
   * through here.
   */
  private resolveSubscriptionGrant(principalId: string): { principalId: string } | undefined {
    if (!this.platformAdmins) return undefined;
    try {
      return this.platformAdmins(principalId) ? { principalId } : undefined;
    } catch (error) {
      process.stderr.write(
        `[atoma projects] platform-admin lookup failed for ${principalId}; refusing the subscription transport: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * Resolve the exact personal credential generation at launch. Authority
   * lookups fail closed: only a selected personal sentinel observes absence,
   * and that absence becomes an explicit configuration error in the builder.
   */
  private resolvePrincipalCodexProfile(
    principalId: string
  ): PrincipalCodexProfile | undefined {
    if (!this.principalCodexProfileFor) return undefined;
    try {
      return this.principalCodexProfileFor(principalId) ?? undefined;
    } catch {
      process.stderr.write(
        `[atoma projects] personal Codex profile lookup failed for ${principalId}; refusing personal subscription pins\n`
      );
      return undefined;
    }
  }

  async start(input: {
    readonly orgId: string;
    readonly principalId: string;
    readonly projectId: string;
    readonly request: CreateProjectRunInput;
  }): Promise<ProjectRun> {
    const candidateRunId = randomUUID();
    const candidatePaths = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      candidateRunId
    );
    let lease: RunLease;
    try {
      lease = await this.acquireLease(`project:${candidateRunId}`);
    } catch (error) {
      if (error instanceof RunLockBusyError) throw new ProjectRunBusy(error.message);
      throw error;
    }
    let reservation: { readonly run: ProjectRun; readonly created: boolean } | null;
    try {
      reservation = this.store.createProjectRun({
        orgId: input.orgId,
        projectId: input.projectId,
        principalId: input.principalId,
        request: input.request,
        projectRunId: candidateRunId,
        hostPaths: {
          workspacePath: candidatePaths.workspacePath,
          runsPath: candidatePaths.runsPath,
          logPath: candidatePaths.logPath,
        },
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    if (!reservation) {
      lease.release();
      throw new Error('project not found');
    }
    const run = reservation.run;
    if (
      run.projectRunId !== candidateRunId ||
      run.status !== 'queued' ||
      this.active.has(run.projectRunId)
    ) {
      lease.release();
      return run;
    }
    const project = this.store.getProject(input.orgId, input.projectId);
    if (!project) {
      lease.release();
      throw new Error('project not found');
    }
    const layout = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      run.projectRunId
    );
    const paths = {
      ...run.hostPaths,
      skillsPath: layout.skillsPath,
      artifactManifestPath: layout.artifactManifestPath,
    };
    const subscriptionGrant = this.resolveSubscriptionGrant(input.principalId);
    const principalCodexProfile = this.resolvePrincipalCodexProfile(input.principalId);
    let environment: NodeJS.ProcessEnv;
    try {
      const built = projectRunEnvironment({
        hostEnv: this.hostEnv,
        dbPath: this.dbPath,
        workspacePath: paths.workspacePath,
        runsPath: paths.runsPath,
        skillsPath: paths.skillsPath,
        runId: run.projectRunId,
        artifactManifestPath: paths.artifactManifestPath,
        orgId: input.orgId,
        tierModels: this.resolveTierModels(input.principalId),
        orgTierModels: this.resolveOrgTierModels(input.orgId),
        orgProviderKeys: this.resolveOrgProviderKeys(input.orgId),
        ...(subscriptionGrant ? { subscriptionTransport: subscriptionGrant } : {}),
        ...(principalCodexProfile ? { principalCodexProfile } : {}),
      });
      environment = built.environment;
      // FIRED FROM THE LEDGER, not from the host env. A run may now spend the
      // subscription on some tiers and a key on others, so "did this run touch
      // a CLI login" is a question about what was RESOLVED — the old
      // `isSubscriptionTransport(hostEnv.ATOMA_LLM)` test could only see the
      // whole-deployment regime and would stay silent on every mixed run.
      if (ledgerTouchesAnySubscription(built.payers)) {
        this.onSubscriptionTransport?.({
          orgId: input.orgId,
          projectId: input.projectId,
          projectRunId: run.projectRunId,
          principalId: input.principalId,
          transport: (this.hostEnv['ATOMA_LLM'] ?? '').trim() || 'claude-cli',
          payers: built.payers,
        });
      }
      this.store.transitionProjectRun({
        orgId: input.orgId,
        projectRunId: run.projectRunId,
        from: 'queued',
        to: 'running',
      });
    } catch (error) {
      try {
        this.store.transitionProjectRun({
          orgId: input.orgId,
          projectRunId: run.projectRunId,
          from: 'queued',
          to: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        });
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist configuration error for ${run.projectRunId}: ${String(transitionError)}\n`
        );
      }
      lease.release();
      throw error;
    }
    const controller = new AbortController();
    this.active.set(run.projectRunId, {
      orgId: input.orgId,
      principalId: input.principalId,
      controller,
    });

    const seedFrom = previousDeliveredWorkspace(this.store, input.orgId, input.projectId);
    let driven: Promise<string>;
    try {
      driven = this.driver({
        goal: run.goal,
        timeoutMs: this.timeoutMs,
        logPath: paths.logPath,
        cwd: this.cwd,
        npmScript: 'run:build',
        signal: controller.signal,
        cleanWorkspace: true,
        extraArgs: [
          '--container',
          // `--no-learn-skills` is gone; the two vetoes below remain, and they
          // are the FINAL word over both the environment and the seed
          // (`src/skills/AGENTS.md`). Without them a seeded workspace would
          // re-enable promotion underneath the env above.
          '--no-promote-skills',
          '--no-direct-skills',
          ...(seedFrom ? ['--seed', seedFrom] : []),
        ],
        env: environment,
        onSpawn: (pid) => lease.attachChild(pid),
      });
    } catch (error) {
      driven = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void this.finish(project, run, paths.artifactManifestPath, driven, lease, controller.signal);
    return this.store.getProjectRun(input.orgId, run.projectRunId)!;
  }

  private async finish(
    project: Project,
    reservedRun: ProjectRun,
    artifactManifestPath: string,
    driven: Promise<string>,
    lease: RunLease,
    signal: AbortSignal
  ): Promise<void> {
    let stats: RunStats | null = null;
    try {
      const log = await driven;
      stats = parseRunLog(log);
      if (signal.aborted || stats.outcome === 'cancelled') {
        this.store.transitionProjectRun({
          orgId: reservedRun.orgId,
          projectRunId: reservedRun.projectRunId,
          from: 'running',
          to: 'cancelled',
          ...(stats.outcome === 'cancelled' || stats.outcome === 'error' ? { stats } : {}),
        });
        return;
      }
      if (stats.outcome !== 'delivered') {
        throw new Error(runnerFailureDetail(log, stats.outcome));
      }
      const tracePath = path.join(reservedRun.hostPaths.runsPath, `${reservedRun.projectRunId}.json`);
      verifiedTrace(tracePath, reservedRun.projectRunId);
      const declarations = declaredArtifactManifestSchema.parse(
        boundedOwnJson(artifactManifestPath)
      );
      if (declarations.runId !== reservedRun.projectRunId) {
        throw new Error('declared artifact manifest belongs to another run');
      }
      const built = buildArtifactManifest({
        workspaceRoot: reservedRun.hostPaths.workspacePath,
        declaredPaths: declarations.outputs,
      });
      let completed = this.store.transitionProjectRun({
        orgId: reservedRun.orgId,
        projectRunId: reservedRun.projectRunId,
        from: 'running',
        to: 'delivered',
        traceId: reservedRun.projectRunId,
        stats,
      });
      if (!completed) throw new Error('project run disappeared before completion');
      completed = this.store.saveArtifactManifest(
        reservedRun.orgId,
        reservedRun.projectRunId,
        built.manifest
      );
      if (!completed) throw new Error('project run disappeared before artifact persistence');
      // BEFORE publication and AFTER the run is durably delivered, in its own
      // guard. The surrounding catch only repairs a row that is still
      // `running`, so a throw from here would be swallowed silently and the
      // run would stay delivered with no preview and no explanation; the
      // explicit stderr line is that explanation.
      if (this.describeDeliveredPreview) {
        try {
          this.describeDeliveredPreview({
            orgId: reservedRun.orgId,
            projectId: reservedRun.projectId,
            projectRunId: reservedRun.projectRunId,
            workspaceRoot: reservedRun.hostPaths.workspacePath,
          });
        } catch (error) {
          process.stderr.write(
            `[atoma projects] preview descriptor unavailable for ${reservedRun.projectRunId}: ${String(error)}\n`
          );
        }
      }
      if (this.publisher) {
        await this.publisher.publish({
          project,
          run: completed,
          workspaceRoot: reservedRun.hostPaths.workspacePath,
          manifest: built.manifest,
          manifestHash: built.hash,
        });
      }
    } catch (error) {
      try {
        const current = this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId);
        if (current?.status === 'running') {
          const tracePath = path.join(
            reservedRun.hostPaths.runsPath,
            `${reservedRun.projectRunId}.json`
          );
          this.store.transitionProjectRun({
            orgId: reservedRun.orgId,
            projectRunId: reservedRun.projectRunId,
            from: 'running',
            to: signal.aborted ? 'cancelled' : 'failed',
            ...(existsSync(tracePath) ? { traceId: reservedRun.projectRunId } : {}),
            // WHAT THE FAILURE COST. The outcome vocabulary is
            // delivered | failed | error | cancelled, and this condition
            // enumerated two of the three non-delivered values — so the most
            // ordinary failure, `outcome: 'failed'`, had its stats dropped and
            // the row recorded no cost at all. Measured: a tenant run that
            // burned $1.10 over 41 calls persisted `stats_json = NULL`, which
            // on a platform that bills is not a rounding error. `delivered` is
            // the only outcome that cannot ride a failure, and the store
            // refuses the remaining contradictions itself.
            ...(stats && stats.outcome !== 'delivered' ? { stats } : {}),
            ...(signal.aborted
              ? {}
              : {
                  error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
                }),
          });
        }
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist completion for ${reservedRun.projectRunId}: ${String(transitionError)}\n`
        );
      }
    } finally {
      // Terminal-outcome hook, AFTER the state transition above persisted and
      // read back from the store so listeners see exactly what the run table
      // says. Fire-and-forget: notification latency or failure must never
      // delay the lease release below or fail the run.
      try {
        const settled = this.onRunFinished
          ? this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId)
          : null;
        if (
          this.onRunFinished &&
          settled &&
          (settled.status === 'delivered' ||
            settled.status === 'failed' ||
            settled.status === 'cancelled')
        ) {
          const emit = this.onRunFinished;
          void Promise.resolve(
            emit({
              orgId: settled.orgId,
              projectId: settled.projectId,
              projectRunId: settled.projectRunId,
              principalId: settled.requestedByPrincipalId,
              goal: settled.goal,
              status: settled.status,
            })
          ).catch((error: unknown) => {
            process.stderr.write(
              `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
            );
          });
        }
      } catch (error) {
        process.stderr.write(
          `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      try {
        lease.release();
      } catch (error) {
        process.stderr.write(
          `[atoma projects] failed to release run lease for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      this.active.delete(reservedRun.projectRunId);
      if (this.active.size === 0) {
        for (const resolveIdle of this.idleWaiters) resolveIdle();
        this.idleWaiters.clear();
      }
    }
  }

  /**
   * Re-drive the publisher for a delivered run whose publication never made
   * it to GitHub — the missing caller behind the 'a retry never creates a
   * second repo' contract. The publication row stays the idempotency
   * boundary: 'published' returns as-is, a concurrent 'publishing' is left
   * alone, and only pending/failed rows are (re)driven. The publisher
   * revalidates the manifest byte-for-byte against the workspace before any
   * upload, so a workspace that changed since delivery is a refusal.
   */
  async retryPublication(orgId: string, projectRunId: string): Promise<ProjectRun | null> {
    if (!this.publisher) {
      throw new ProjectRunConfigurationError('GitHub App is not configured on this deployment');
    }
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run) return null;
    if (run.status !== 'delivered' || !run.artifactManifest || !run.artifactManifestHash) {
      throw new ProjectStateConflict('publication retry requires a delivered run with artifacts');
    }
    const project = this.store.getProject(orgId, run.projectId);
    if (!project) return null;
    await this.publisher.publish({
      project,
      run,
      workspaceRoot: run.hostPaths.workspacePath,
      manifest: run.artifactManifest,
      manifestHash: run.artifactManifestHash,
    });
    return run;
  }

  cancel(orgId: string, projectRunId: string): ProjectRun | null {
    const current = this.store.getProjectRun(orgId, projectRunId);
    if (!current) return null;
    const active = this.active.get(projectRunId);
    if (active?.orgId === orgId) active.controller.abort(new Error('project run cancelled'));
    return current;
  }

  /** Disconnecting a profile cannot race a run that already captured it. */
  hasActiveRunForPrincipal(principalId: string): boolean {
    for (const active of this.active.values()) {
      if (active.principalId === principalId) return true;
    }
    return false;
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolveIdle) => this.idleWaiters.add(resolveIdle));
  }
}
