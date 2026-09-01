import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import {
  DEFAULT_PROJECT_RUN_TIMEOUT_MS,
  MAX_PROJECT_RUN_TIMEOUT_MS,
  MIN_PROJECT_RUN_TIMEOUT_MS,
  PROJECT_RUN_TIMEOUT_ENV,
  ProjectRunBusy,
  ProjectRunConfigurationError,
  ProjectRunCoordinator,
  projectRunEnvironment,
  type ProjectRunDriver,
  projectRunHostLayout,
  projectRunTimeoutMs,
  runnerFailureDetail,
} from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { unsupportedRunHostMessage } from '../src/run/platform.js';
import { RunLockBusyError, type RunLease } from '../src/mcp/runLock.js';
import { TraceRecorder } from '../src/viz/trace.js';

type SpawnRunOptions = Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0];

const roots: string[] = [];
const DELIVERED_STATS: RunStats = {
  outcome: 'delivered',
  costUsd: 0.01,
  llmCalls: 1,
  opusCalls: 1,
  sonnetCalls: 0,
  haikuCalls: 0,
  otherCalls: 0,
  deterministicPhases: 0,
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 0,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
  uncoveredObligations: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-project-coordinator-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({
    provider: 'github',
    subject: 'owner',
    displayName: 'Owner',
    email: null,
    emailVerified: false,
  }, null);
  if (!login) throw new Error('owner bootstrap failed');
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId,
    principalId: login.viewer.principalId,
    project: {
      name: 'Clock',
      slug: 'clock',
      initialPrompt: 'Build a clock in one index.html.',
      repositoryTarget: {
        installationId: '123',
        owner: 'owner',
        name: 'clock',
        visibility: 'private',
      },
    },
  });
  return { root, dbPath, store, viewer: login.viewer, project };
}

function lease(): RunLease {
  return {
    path: '/test/lease',
    attachChild: vi.fn(),
    release: vi.fn(),
  };
}

/**
 * The ENVIRONMENT half of the builder. `projectRunEnvironment` returns
 * `{ environment, payers }` since the per-tier host subscription made "who
 * paid" a per-tier fact rather than a property of the whole run; most
 * assertions here only care about the env, and the ledger has its own cases.
 */
const runEnv = (input: Parameters<typeof projectRunEnvironment>[0]): NodeJS.ProcessEnv =>
  projectRunEnvironment(input).environment;

describe('project run environment', () => {
  it('lays a run out under orgs/<org>/projects/<project>/runs/<run>', () => {
    const layout = projectRunHostLayout('/control', 'org-a', 'proj-b', 'run-c');
    expect(layout.runRoot).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c');
    expect(layout.runsPath).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c/traces');
    expect(layout.workspacePath).toBe('/control/orgs/org-a/projects/proj-b/runs/run-c/workspace');
    expect(layout.skillsPath).toBe('/control/orgs/org-a/projects/proj-b/skills');
  });
  it('forwards only the direct model credential and host runtime allowlist', () => {
    const env = runEnv({
      hostEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'model-key',
        ATOMA_GITHUB_APP_PRIVATE_KEY: 'must-not-cross',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'must-not-cross-either',
      },
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    });
    expect(env['ANTHROPIC_API_KEY']).toBe('model-key');
    expect(env['ATOMA_REQUIRE_ISOLATION']).toBe('1');
    expect(env['ATOMA_CONTAINER']).toBe('1');
    expect(env['ATOMA_GITHUB_APP_PRIVATE_KEY']).toBeUndefined();
    expect(env['ATOMA_AUTH_GITHUB_CLIENT_SECRET']).toBeUndefined();
  });

  it('lets a tenant run LEARN, and keeps promotion, dispatch and the shared cache off', () => {
    // The platform's own point: a project's runs get cheaper as it grows.
    // Measured before this was on — two delivered runs, $0.59, learnedSkills 0.
    const env = runEnv({
      hostEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'model-key' },
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/projects/p1/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    });
    expect(env['ATOMA_SKILL_LEARN']).toBe('1');
    expect(env['ATOMA_EVENT_SKILLS']).toBe('1');
    // What makes that safe: skills are partitioned per PROJECT, so nothing
    // learned here can reach another project, let alone another organisation.
    expect(env['ATOMA_SKILLS_DIR']).toBe('/control/projects/p1/skills');
    // PROMOTION stays off explicitly, because a project run is seeded from the
    // last delivered workspace and a seed enables promotion by default — so
    // silence here would promote tenant scripts as a side effect of seeding.
    expect(env['ATOMA_SKILL_PROMOTE']).toBe('0');
    expect(env['ATOMA_SKILL_DIRECT']).toBe('0');
    // And the prefilter cache stays off for a different reason: it is the one
    // lifecycle store that is NOT per project — it lives in the shared product
    // store.
    expect(env['ATOMA_PREFILTER_CACHE']).toBe('0');
  });

  it('refuses subscription transports, cross-provider pins and ambiguous credentials', () => {
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    };
    expect(() => runEnv({ ...base, hostEnv: { ATOMA_LLM: 'claude-cli' } }))
      .toThrow(ProjectRunConfigurationError);
    expect(() => runEnv({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: 'key', ATOMA_MODEL_L2: 'codex:gpt-5' },
    })).toThrow(/cannot be routed/);
    // A bearer token is refused outright on the platform path: nothing in the
    // product can supply one (the org key store is keyed by catalogue
    // provider, and anthropic's credential is ANTHROPIC_API_KEY), and a
    // token refreshed from a login profile would expire inside a long run.
    expect(() => runEnv({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'token' },
    })).toThrow(/do not accept ANTHROPIC_AUTH_TOKEN/);
    expect(() => runEnv({
      ...base,
      hostEnv: { ANTHROPIC_AUTH_TOKEN: 'token' },
    })).toThrow(/do not accept ANTHROPIC_AUTH_TOKEN/);
  });

  it('runs BYO-only: the org anthropic key is a per-run credential, and it beats the host', () => {
    // A deployment may carry NO platform key at all. The org's own encrypted
    // key is the credential, so the run must start — it used to be refused
    // before the environment was ever built, which made the whole BYO-only
    // shape unreachable.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    };
    const byoOnly = runEnv({
      ...base,
      hostEnv: { PATH: '/bin' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic' },
    });
    expect(byoOnly['ANTHROPIC_API_KEY']).toBe('sk-org-anthropic');
    expect(byoOnly['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    // And an anthropic tier pin is now routable on that deployment: the
    // credential check reads the org key, not only the host env.
    const pinned = runEnv({
      ...base,
      hostEnv: { PATH: '/bin' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic' },
      tierModels: { l1: 'anthropic:claude-haiku-4-5-20251001', l2: null, l3: null },
    });
    expect(pinned['ATOMA_MODEL_L1']).toBe('anthropic:claude-haiku-4-5-20251001');
    // BYO beats a host key of the same shape: the org brought its own, it
    // pays with its own.
    const overHostKey = runEnv({
      ...base,
      hostEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'host-key' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic' },
    });
    expect(overHostKey['ANTHROPIC_API_KEY']).toBe('sk-org-anthropic');
    // A BYO key goes to its OWN issuer: a host gateway URL (the shape Z.ai's
    // own Claude Code instructions use) must not carry a tenant's key to a
    // third party the org never consented to.
    const hostGateway = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' };
    const orgKeyBehindGateway = runEnv({
      ...base,
      hostEnv: { ...hostGateway, ANTHROPIC_API_KEY: 'host-key' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic' },
    });
    expect(orgKeyBehindGateway['ANTHROPIC_API_KEY']).toBe('sk-org-anthropic');
    expect(orgKeyBehindGateway['ANTHROPIC_BASE_URL']).toBeUndefined();
    // The host's own credential still reaches the host's own gateway.
    const hostKeyBehindGateway = runEnv({
      ...base,
      hostEnv: { ...hostGateway, ANTHROPIC_API_KEY: 'host-key' },
    });
    expect(hostKeyBehindGateway['ANTHROPIC_BASE_URL']).toBe('https://api.z.ai/api/anthropic');
    // No host key and no org key is still a refusal, and the message names
    // both ways out.
    expect(() => runEnv({ ...base, hostEnv: { PATH: '/bin' } })).toThrow(
      /anthropic credential/
    );
  });

  it('forwards only the provider keys this run can actually reach', () => {
    // 2026-08-27, 3.1. Every configured org key rode into every run, referenced
    // or not. CHILD_ENV_ALLOWLIST already keeps them out of tool subprocesses,
    // so this narrows the RUNNER's own memory and /proc surface, not a hole.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      hostEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'host-key' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic', zai: 'sk-zai-org' },
    };
    // No tier names zai: its key stays out of the child.
    const unreferenced = runEnv(base);
    expect(unreferenced['ZAI_API_KEY']).toBeUndefined();
    // The base transport is always referenced — an unpinned tier routes there.
    expect(unreferenced['ANTHROPIC_API_KEY']).toBe('sk-org-anthropic');

    const referenced = runEnv({
      ...base,
      tierModels: { l1: 'zai:glm-4.5-air', l2: null, l3: null },
    });
    expect(referenced['ZAI_API_KEY']).toBe('sk-zai-org');
    expect(referenced['ATOMA_MODEL_L1']).toBe('zai:glm-4.5-air');
  });

  it('honours a per-tier host-subscription pin ONLY from an admin, in the declared org', () => {
    // Design 2026-08-28. The pin is a NON-ROUTABLE sentinel in storage and
    // becomes a transport only here, downstream of the authority check.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      hostEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'host-key',
        ATOMA_HOST_SUBSCRIPTION_ORG: 'org-operator',
      },
      orgId: 'org-operator',
      subscriptionTransport: { principalId: 'admin-1' },
      tierModels: { l1: null, l2: 'host-subscription:sonnet', l3: null },
    };
    const mixed = projectRunEnvironment(base);
    // Translated to the transport the router understands…
    expect(mixed.environment['ATOMA_MODEL_L2']).toBe('claude-cli:sonnet');
    // …and the base transport keeps its own credential: this is a MIXED run,
    // not a subscription run.
    expect(mixed.environment['ANTHROPIC_API_KEY']).toBe('host-key');
    expect(mixed.environment['ATOMA_LLM']).toBe('anthropic');
    // The ledger names both payers, base included — a three-row ledger would
    // be silent about the account that paid for everything unpinned.
    expect(mixed.payers.l2).toMatchObject({ payer: 'host-subscription', source: 'account' });
    expect(mixed.payers.base).toMatchObject({ payer: 'host-key', provider: 'anthropic' });
    expect(mixed.payers.l1.payer).toBe('host-key');
    // And the child's own gate is armed, naming exactly the authorised tier.
    expect(mixed.environment['ATOMA_TENANT_RUN']).toBe('1');
    expect(mixed.environment['ATOMA_SUBSCRIPTION_TIERS']).toBe('l2');

    // NO GRANT: refused, never fallen through. A revoked authority that
    // quietly became a billed credential is the audit lie this prevents.
    const { subscriptionTransport: _grant, ...noGrant } = base;
    expect(() => projectRunEnvironment(noGrant)).toThrow(/no longer holds the platform-admin flag/);
    // NO DECLARATION: refused, and told which variable is missing.
    expect(() =>
      projectRunEnvironment({
        ...base,
        hostEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'host-key' },
      })
    ).toThrow(/declares no organisation/);
    // ANOTHER ORGANISATION: refused. The flag is instance-wide; the
    // declaration is what scopes the spend.
    expect(() => projectRunEnvironment({ ...base, orgId: 'org-tenant' })).toThrow(
      /belongs to another organisation/
    );
  });

  it('refuses a host-subscription pin that arrives from the org or the host level', () => {
    // An org default is inherited by every member by construction, and the
    // host env is the third candidate for EVERY tier: a sentinel at either
    // level would be a payer-bearing default nobody chose.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      orgId: 'org-operator',
      subscriptionTransport: { principalId: 'admin-1' },
    };
    expect(() =>
      projectRunEnvironment({
        ...base,
        hostEnv: {
          PATH: '/bin',
          ANTHROPIC_API_KEY: 'host-key',
          ATOMA_HOST_SUBSCRIPTION_ORG: 'org-operator',
        },
        orgTierModels: { l1: 'host-subscription:haiku', l2: null, l3: null },
      })
    ).toThrow(/from the org level/);
    expect(() =>
      projectRunEnvironment({
        ...base,
        hostEnv: {
          PATH: '/bin',
          ANTHROPIC_API_KEY: 'host-key',
          ATOMA_HOST_SUBSCRIPTION_ORG: 'org-operator',
          ATOMA_MODEL_L3: 'host-subscription:opus',
        },
      })
    ).toThrow(/from the host level/);
  });

  it('opens the subscription transport for a platform admin ONLY, and forwards no credential', () => {
    // The door: a machine-bound transport spends the HOST login session and
    // cannot honour a per-run credential, so it stays refused for a tenant
    // and is allowed for the one identity whose subscription it actually is.
    // The authority is the platform-admin flag because it is never derived
    // from an OAuth claim — only the operator CLI can mint it.
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
    };
    for (const spelling of ['claude-cli', 'claude', 'CLAUDE-CLI']) {
      // Both spellings `resolveBaseProviderKind` accepts, or the door has a
      // hole in it.
      expect(() => runEnv({ ...base, hostEnv: { ATOMA_LLM: spelling } })).toThrow(
        /platform admin/
      );
      const env = runEnv({
        ...base,
        hostEnv: { ATOMA_LLM: spelling, ANTHROPIC_API_KEY: 'stale-host-key' },
        subscriptionTransport: { principalId: 'admin-1' },
      });
      // Canonical spelling regardless of the alias the host wrote.
      expect(env['ATOMA_LLM']).toBe('claude-cli');
      // No credential crosses: the transport cannot honour one, and a stale
      // exported key would only confuse the provider's own precedence.
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
      // Isolation is NOT relaxed by the door.
      expect(env['ATOMA_CONTAINER']).toBe('1');
      expect(env['ATOMA_REQUIRE_ISOLATION']).toBe('1');
    }
    // A subscription run has no per-run credential by definition, so the
    // exactly-one-credential rule must not fire on it.
    expect(() =>
      runEnv({
        ...base,
        hostEnv: { ATOMA_LLM: 'claude-cli' },
        subscriptionTransport: { principalId: 'admin-1' },
      })
    ).not.toThrow();
    // THE ORG'S KEYS ARE WITHHELD TOO. Injected, a tier pinned to zai or
    // anthropic would bill the ORGANISATION while the journal records
    // `run.host_subscription` — the audit row would name the wrong payer.
    const withOrgKeys = runEnv({
      ...base,
      hostEnv: { ATOMA_LLM: 'claude-cli', ANTHROPIC_API_KEY: 'stale-host-key' },
      subscriptionTransport: { principalId: 'admin-1' },
      orgProviderKeys: { anthropic: 'sk-org-anthropic', zai: 'sk-zai-org' },
      tierModels: { l1: 'zai:glm-4.5-air', l2: 'anthropic:claude-sonnet-5', l3: null },
    });
    expect(withOrgKeys['ZAI_API_KEY']).toBeUndefined();
    expect(withOrgKeys['ANTHROPIC_API_KEY']).toBeUndefined();
    // And the pins those keys would have unlocked are dropped with them, so
    // nothing reaches the router without its credential.
    expect(withOrgKeys['ATOMA_MODEL_L1']).toBeUndefined();
    expect(withOrgKeys['ATOMA_MODEL_L2']).toBeUndefined();
    // A grant does not turn every provider into a subscription transport.
    expect(() =>
      runEnv({
        ...base,
        hostEnv: { ATOMA_LLM: 'ollama' },
        subscriptionTransport: { principalId: 'admin-1' },
      })
    ).toThrow(/do not support/);
  });

  it('lets an account pin override the operator per tier, and inherit where it does not', () => {
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      hostEnv: {
        ANTHROPIC_API_KEY: 'key',
        ATOMA_MODEL_L1: 'claude-haiku-4-5-20251001',
        ATOMA_MODEL_L2: 'claude-sonnet-5',
      },
    };
    // No account pins: the operator's host pins stand, unchanged behaviour.
    const operatorOnly = runEnv(base);
    expect(operatorOnly['ATOMA_MODEL_L1']).toBe('claude-haiku-4-5-20251001');
    expect(operatorOnly['ATOMA_MODEL_L2']).toBe('claude-sonnet-5');
    expect(operatorOnly['ATOMA_MODEL_L3']).toBeUndefined();

    const withPins = runEnv({
      ...base,
      tierModels: { l1: 'claude-sonnet-5', l2: null, l3: 'claude-opus-5' },
    });
    // L1 overridden, L2 inherited from the host, L3 set where the host had none.
    expect(withPins['ATOMA_MODEL_L1']).toBe('claude-sonnet-5');
    expect(withPins['ATOMA_MODEL_L2']).toBe('claude-sonnet-5');
    expect(withPins['ATOMA_MODEL_L3']).toBe('claude-opus-5');

    // A non-catalogue provider prefix refuses on the account path exactly as
    // on the host path; claude-cli/codex stay unreachable whatever a client
    // sends, because nothing in the catalogue carries their ids.
    expect(() => runEnv({
      ...base,
      tierModels: { l1: 'claude-cli:opus', l2: null, l3: null },
    })).toThrow(/cannot be routed/);
    expect(() => runEnv({
      ...base,
      hostEnv: { ANTHROPIC_API_KEY: 'key', ATOMA_MODEL_L2: 'codex:gpt-5' },
    })).toThrow(/cannot be routed/);
    // An OLLAMA selector is routable ONLY where the deployment declared its
    // endpoint. "The host has an Ollama" is a fact only the operator can
    // assert — assuming the default localhost is exactly what detonates on a
    // host without one — so an undeclared pin falls through to the level
    // beneath it, like any provider whose credential nobody brought.
    const ollamaUndeclared = runEnv({
      ...base,
      tierModels: { l1: 'ollama:qwen3:8b', l2: null, l3: null },
    });
    expect(ollamaUndeclared['ATOMA_MODEL_L1']).toBe('claude-haiku-4-5-20251001');
    expect(ollamaUndeclared['OLLAMA_BASE_URL']).toBeUndefined();
    const ollamaPin = runEnv({
      ...base,
      hostEnv: { ...base.hostEnv, OLLAMA_BASE_URL: 'http://gpu-box:11434' },
      tierModels: { l1: 'ollama:qwen3:8b', l2: null, l3: null },
    });
    expect(ollamaPin['ATOMA_MODEL_L1']).toBe('ollama:qwen3:8b');
    // And the endpoint crosses with the pin, so the child talks to the
    // operator's Ollama rather than to a presumed localhost.
    expect(ollamaPin['OLLAMA_BASE_URL']).toBe('http://gpu-box:11434');
  });

  it('resolves the three-level precedence: account > org > operator', () => {
    const base = {
      dbPath: '/control/atoma.db',
      workspacePath: '/control/workspace',
      runsPath: '/control/runs',
      skillsPath: '/control/skills',
      runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
      artifactManifestPath: '/control/manifest.json',
      hostEnv: {
        ANTHROPIC_API_KEY: 'key',
        ATOMA_MODEL_L1: 'claude-haiku-4-5-20251001',
        ATOMA_MODEL_L2: 'claude-sonnet-5',
        ATOMA_MODEL_L3: 'claude-opus-5',
      },
      orgTierModels: {
        l1: 'zai:glm-4.5-air',
        l2: null,
        l3: 'anthropic:claude-sonnet-4-5',
      } as { l1: string | null; l2: string | null; l3: string | null },
    };
    // No account pins: the operator's host pins stand, unchanged behaviour.
    const accountL1 = runEnv({
      ...base,
      tierModels: { l1: null, l2: null, l3: null },
      orgProviderKeys: { zai: 'sk-zai-org' },
    });
    expect(accountL1['ATOMA_MODEL_L1']).toBe('zai:glm-4.5-air');
    // Org L1 defaults to zai but nobody brought its key: fail-open drops to
    // the operator's pin rather than detonating at the first billable call.
    const noZaiKey = runEnv({ ...base });
    expect(noZaiKey['ATOMA_MODEL_L1']).toBe('claude-haiku-4-5-20251001');
    // With the org key present the selection stays AND the key is forwarded.
    const withZaiKey = runEnv({
      ...base,
      orgProviderKeys: { zai: 'sk-zai-org' },
    });
    expect(withZaiKey['ATOMA_MODEL_L1']).toBe('zai:glm-4.5-air');
    expect(withZaiKey['ZAI_API_KEY']).toBe('sk-zai-org');
    // The anthropic org default on L3 inherits to a member who did not pin,
    // because the deployment's own key is always there for that transport.
    const memberL3 = runEnv({ ...base });
    expect(memberL3['ATOMA_MODEL_L3']).toBe('anthropic:claude-sonnet-4-5');
    // An account pin beats both levels.
    const pinned = runEnv({
      ...base,
      tierModels: { l1: 'anthropic:claude-haiku-4-5', l2: null, l3: null },
      orgProviderKeys: { zai: 'sk-zai-org' },
    });
    expect(pinned['ATOMA_MODEL_L1']).toBe('anthropic:claude-haiku-4-5');
  });
});

describe('ProjectRunCoordinator', () => {
  it('isolates, verifies and publishes a delivered project run', async () => {
    const f = fixture();
    const runLease = lease();
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      mkdirSync(join(declarations, '..'), { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      options.onSpawn?.(4242);
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => runLease,
      publisher,
    });

    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-1', goal: 'Build a clock in one index.html.' },
    });
    expect(started.status).toBe('running');
    await coordinator.waitForIdle();

    const finished = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(finished.status).toBe('delivered');
    expect(finished.traceId).toBe(started.projectRunId);
    expect(finished.artifactManifest?.files.map((file) => file.path)).toEqual(['index.html']);
    expect(driver.mock.calls[0]?.[0].extraArgs).toContain('--container');
    // The two vetoes travel as FLAGS because they are the final word over both
    // the environment and the seed; learning is not among them any more.
    expect(driver.mock.calls[0]?.[0].extraArgs).toContain('--no-promote-skills');
    expect(driver.mock.calls[0]?.[0].extraArgs).toContain('--no-direct-skills');
    expect(driver.mock.calls[0]?.[0].extraArgs).not.toContain('--no-learn-skills');
    expect(runLease.attachChild).toHaveBeenCalledWith(4242);
    expect(runLease.release).toHaveBeenCalledOnce();
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(driver.mock.calls[0]?.[0].extraArgs).not.toContain('--seed');
    expect(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']).toBe(
      join(
        f.root,
        'orgs',
        f.viewer.orgId,
        'projects',
        f.project.projectId,
        'runs',
        started.projectRunId,
        'traces'
      )
    );
    expect(started.hostPaths.runsPath).toBe(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']);
  });

  it('emits one terminal onRunFinished event with the requesting principal', async () => {
    const f = fixture();
    const finished = vi.fn();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
      onRunFinished: finished,
    });

    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(finished).toHaveBeenCalledExactlyOnceWith({
      orgId: f.viewer.orgId,
      projectId: f.project.projectId,
      projectRunId: started.projectRunId,
      principalId: f.viewer.principalId,
      goal: 'Build a clock in one index.html.',
      status: 'delivered',
    });
  });

  it('a failed run still emits onRunFinished and a throwing listener stays contained', async () => {
    const f = fixture();
    const finished = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: vi.fn(async () => {
        throw new Error('driver died');
      }),
      acquireLease: async () => lease(),
      onRunFinished: finished,
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.status).toBe('failed');
    expect(finished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'failed', projectRunId: started.projectRunId })
    );
  });

  it('records what a FAILED run cost, not only that it failed', async () => {
    // The defect this pins: the outcome vocabulary is
    // delivered | failed | error | cancelled, and the failure path enumerated
    // two of the three non-delivered values — so `outcome: 'failed'`, the
    // ordinary one, had its stats dropped. Measured on a real tenant run:
    // $1.10 over 41 calls, persisted as stats_json = NULL. On a platform that
    // bills, a failure with no cost on the row is not a rounding error.
    const f = fixture();
    const failedStats: RunStats = { ...DELIVERED_STATS, outcome: 'failed', costUsd: 1.1002, llmCalls: 41 };
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      // A run that spends, reports its spend, and produces no artifact.
      driver: vi.fn(async () => `${formatRunStatsEpilogue(failedStats)}\n✖ build failed\n`),
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-cost-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();

    const row = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(row.status).toBe('failed');
    expect(row.stats?.costUsd).toBe(1.1002);
    expect(row.stats?.llmCalls).toBe(41);
    expect(row.stats?.outcome).toBe('failed');
    // And the failure still carries its reason.
    expect(row.error).toBeTruthy();
  });

  it('seeds a later run from the last delivered workspace', async () => {
    const f = fixture();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['index.html'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS) + '\n✓ build finished\n';
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });

    const first = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-1', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    expect(f.store.getProjectRun(f.viewer.orgId, first.projectRunId)?.status).toBe('delivered');

    const second = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-2', goal: 'Add a timezone selector to the clock.' },
    });
    expect(second.goal).toBe('Add a timezone selector to the clock.');
    const extraArgs = driver.mock.calls[1]?.[0].extraArgs ?? [];
    const seedAt = extraArgs.indexOf('--seed');
    expect(seedAt).toBeGreaterThanOrEqual(0);
    expect(extraArgs[seedAt + 1]).toBe(first.hostPaths.workspacePath);
    await coordinator.waitForIdle();
  });

  it('fails closed when a delivered run declares an excluded secret', async () => {
    const f = fixture();
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(workspace, '.env'), 'TOKEN=secret', 'utf8');
      writeFileSync(declarations, JSON.stringify({
        version: 1,
        runId,
        generatedAt: new Date().toISOString(),
        outputs: ['.env'],
      }), 'utf8');
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        result: { summary: 'verified' },
      }), 'utf8');
      return formatRunStatsEpilogue(DELIVERED_STATS);
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-secret', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    const failed = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/excluded/);
  });

  it('keeps failed traces under the owning project run directory', async () => {
    const f = fixture();
    const failedStats: RunStats = { ...DELIVERED_STATS, outcome: 'failed' };
    const driver = vi.fn(async (options: SpawnRunOptions) => {
      const env = options.env ?? {};
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
        id: runId,
        endedAt: new Date().toISOString(),
        error: '401',
        result: { summary: 'auth failed' },
      }), 'utf8');
      return `${formatRunStatsEpilogue(failedStats)}\n✖ 401 API key is invalid.\n`;
    });
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-auth', goal: 'Build a clock in one index.html.' },
    });
    const tracesDir = join(
      f.root,
      'orgs',
      f.viewer.orgId,
      'projects',
      f.project.projectId,
      'runs',
      started.projectRunId,
      'traces'
    );
    expect(driver.mock.calls[0]?.[0].env?.['ATOMA_RUNS_DIR']).toBe(tracesDir);
    await coordinator.waitForIdle();
    const failed = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/API key is invalid/);
    expect(failed.traceId).toBe(started.projectRunId);
    expect(existsSync(join(tracesDir, `${started.projectRunId}.json`))).toBe(true);
  });

  it('does not leave a queued row when the instance lease is busy', async () => {
    const f = fixture();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: vi.fn(),
      acquireLease: async () => {
        throw new RunLockBusyError('another run is in progress');
      },
    });
    await expect(coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-click-busy', goal: 'Build a clock in one index.html.' },
    })).rejects.toBeInstanceOf(ProjectRunBusy);
    expect(f.store.listProjectRuns(f.viewer.orgId, f.project.projectId)).toEqual([]);
  });
});

describe('runnerFailureDetail', () => {
  it('prefers the runner bang line over a generic outcome', () => {
    expect(runnerFailureDetail('hello\n✖ 401 API key is invalid.\n', 'failed'))
      .toBe('401 API key is invalid.');
    expect(runnerFailureDetail('no bang', 'failed')).toBe('runner finished with outcome failed');
  });

  /**
   * MEASURED 2026-08-23, project run `d771d166`: the runner printed zod's
   * pretty-printed issues array after the bang, so the stored error column
   * held the single character `[` while the field that failed and why sat on
   * the indented lines below. Continuation is recognised by SHAPE (indented,
   * or a bare closing bracket), so a flat unrelated log line after a one-line
   * error is never swallowed.
   */
  it('collects the indented continuation of a multi-line error — the d771d166 shape', () => {
    const log = [
      'planning phase 2',
      '✖ [',
      '  {',
      '    "code": "invalid_type",',
      '    "expected": "string",',
      '    "received": "null",',
      '    "path": [',
      '      "subtasks",',
      '      0,',
      '      "preferredChild"',
      '    ],',
      '    "message": "Expected string, received null"',
      '  }',
      ']',
      '',
      '== post-mortem ==',
    ].join('\n');
    const detail = runnerFailureDetail(log, 'failed');
    expect(detail).toContain('preferredChild');
    expect(detail).toContain('Expected string, received null');
    expect(detail).not.toContain('post-mortem');
    expect(detail.length).toBeLessThanOrEqual(2_000);
  });

  it('does not swallow an unrelated flat line after a one-line error', () => {
    expect(
      runnerFailureDetail('✖ 401 API key is invalid.\nrun recorded in /tmp/x\n', 'failed')
    ).toBe('401 API key is invalid.');
  });

  /**
   * A LAUNCH THAT NEVER BECAME A RUN has no bang line, because the runner never
   * spoke. `spawnRun` writes `--- spawn failed --- <cause>` for all of those,
   * and without that branch every one of them reached the operator as
   * "runner finished with outcome error" while the log held the reason.
   */
  it('reads the launcher marker when the runner never spoke', () => {
    expect(
      runnerFailureDetail('\n--- spawn failed --- spawn npm ENOENT\n', 'error')
    ).toBe('spawn npm ENOENT');
    // The run-host refusal is the shape that surfaced this: reason AND remedy
    // on one line, so the operator learns the way out from the screen.
    const refusal = `\n--- spawn failed --- ${unsupportedRunHostMessage('win32')}\n`;
    const detail = runnerFailureDetail(refusal, 'error');
    expect(detail).toContain('not supported on win32');
    expect(detail).toMatch(/WSL2/);
    expect(detail).not.toBe('runner finished with outcome error');
  });

  it('still lets the runner outrank the launcher, and keeps the generic floor', () => {
    // Both markers present: the runner took a path and reported on it, so a
    // launcher line belongs to an earlier attempt or to echoed prose.
    expect(
      runnerFailureDetail('--- spawn failed --- stale\n✖ 401 API key is invalid.\n', 'failed')
    ).toBe('401 API key is invalid.');
    // A marker with no cause after it must not return an empty detail.
    expect(runnerFailureDetail('--- spawn failed ---\n', 'error'))
      .toBe('runner finished with outcome error');
  });
});

/**
 * THE PRODUCTION PATH, not just the helper: a refused launch has to reach
 * `project_runs.error`, which is what the Projects screen shows. Measured
 * 2026-09-01 on a win32 host — the refusal was written to the log, the outcome
 * parsed as `error`, and the operator read "runner finished with outcome
 * error" with no mention of the platform or the way out.
 */
describe('a launch refused before the spawn, through the coordinator', () => {
  it('stores the launcher cause on the run row', async () => {
    const f = fixture();
    const refusal = `\n--- spawn failed --- ${unsupportedRunHostMessage('win32')}\n`;
    // The real `spawnRun` returns exactly this and writes no trace, because it
    // refuses BEFORE the spawn. The driver reproduces both halves.
    const driver = vi.fn(async (_options: SpawnRunOptions) => refusal);
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver,
      acquireLease: async () => lease(),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-refused-host', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();

    const row = f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('not supported on win32');
    expect(row.error).toMatch(/WSL2/);
    expect(row.error).not.toBe('runner finished with outcome error');
  });
});

describe('the subscription-transport door, at the coordinator', () => {
  /**
   * The VERIFICATION lives here, not at the caller: `platformAdmins` is a
   * question the coordinator asks, so no route and no CLI can hand in a
   * pre-decided "yes". Every case below is about who is allowed to spend the
   * host's login session.
   */
  function deliveringDriver(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_options: SpawnRunOptions): Promise<string> => {
      return `${formatRunStatsEpilogue(DELIVERED_STATS)}\n✓ build finished\n`;
    });
  }

  /** A host with NO credential: only the door can make this run startable. */
  function subscriptionHost(): NodeJS.ProcessEnv {
    return { PATH: process.env['PATH'], ATOMA_LLM: 'claude-cli' };
  }

  async function expectRefused(
    f: ReturnType<typeof fixture>,
    coordinator: ProjectRunCoordinator,
    driver: ReturnType<typeof vi.fn>,
    key: string,
    matcher: RegExp | typeof ProjectRunConfigurationError
  ): Promise<void> {
    const promise = coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: key, goal: 'Build a clock.' },
    });
    await (matcher instanceof RegExp
      ? expect(promise).rejects.toThrow(matcher)
      : expect(promise).rejects.toThrow(matcher));
    expect(driver).not.toHaveBeenCalled();
  }

  it('refuses when NO authority is wired (fail-closed, unlike tier pins)', async () => {
    const f = fixture();
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
    });
    await expectRefused(f, coordinator, driver, 'no-authority', ProjectRunConfigurationError);
  });

  it('refuses a requester who is not a platform admin', async () => {
    const f = fixture();
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => false,
    });
    await expectRefused(f, coordinator, driver, 'not-admin', /platform admin/);
  });

  it('refuses when the authority lookup THROWS', async () => {
    // The opposite of `tierModelsFor`, deliberately: a preferences lookup
    // that throws must not block a run, an authority lookup that throws must
    // never be read as permission to spend.
    const f = fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => {
        throw new Error('store unavailable');
      },
    });
    await expectRefused(f, coordinator, driver, 'authority-down', ProjectRunConfigurationError);
  });

  it('lets a platform admin through, and announces the spend exactly once', async () => {
    const f = fixture();
    const seen: Array<{ principalId: string; transport: string }> = [];
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: subscriptionHost(),
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: (principalId) => principalId === f.viewer.principalId,
      onSubscriptionTransport: (info) =>
        seen.push({ principalId: info.principalId, transport: info.transport }),
    });
    const run = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'admin-run', goal: 'Build a clock.' },
    });
    await coordinator.waitForIdle();
    expect(driver).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { principalId: f.viewer.principalId, transport: 'claude-cli' },
    ]);
    // The env the driver received carries the transport and no credential.
    const passed = driver.mock.calls[0]![0] as SpawnRunOptions;
    expect(passed.env?.['ATOMA_LLM']).toBe('claude-cli');
    expect(passed.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(run.projectRunId).toBeTruthy();
  });

  it('says nothing when the host is NOT on a subscription transport', async () => {
    const f = fixture();
    const seen: unknown[] = [];
    const driver = deliveringDriver();
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      platformAdmins: () => true,
      onSubscriptionTransport: (info) => seen.push(info),
    });
    await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'credentialled', goal: 'Build a clock.' },
    });
    await coordinator.waitForIdle();
    // An admin on a credentialled transport is an ordinary run: the audit row
    // means "billed to the host subscription", and this one was not.
    expect(seen).toEqual([]);
  });
});

/**
 * A LARGE TRACE IS EVIDENCE, NOT A REFUSAL.
 *
 * Project run `2857a579` delivered a dark-mode toggle, wrote a 781_071-byte
 * trace, and was recorded `failed` with `control-plane JSON is not a bounded
 * regular file` because the control plane read the whole document behind a
 * 524_288-byte cap. Its archived epilogue was
 * `{"outcome":"delivered","costUsd":0.8421,"llmCalls":20,…,"learnedSkills":1}`
 * and its trace tail held a complete `result` with
 * `producedBy: {tier: 3, name: "Meristem", viaFallback: false}` — it would have
 * passed every SEMANTIC check. Only the size gate refused it.
 *
 * The erasure is not cosmetic: `previousDeliveredWorkspace` seeds the next run
 * of a project only from a row whose status is `delivered`, so an erased
 * delivery makes the following run seed from an OLDER workspace and silently
 * skip the work.
 *
 * Every driver below writes its trace through the REAL `TraceRecorder`. The
 * fixtures elsewhere in this file hand-write ~120-byte three-key traces, which
 * is exactly how a cap on a document growing ~19KB per tool call shipped
 * unnoticed.
 */
describe('ProjectRunCoordinator — a large trace is evidence, not a refusal', () => {
  /** ~19KB per tool event: the measured slope, reached the way a run reaches it. */
  const EVENT_FILLER = 'x'.repeat(19_000);

  function writeRealTrace(
    runsDir: string,
    traceRunId: string,
    targetBytes: number,
    finish: (recorder: TraceRecorder) => void
  ): void {
    mkdirSync(runsDir, { recursive: true });
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'Build a clock in one index.html.' }, 'clock', {
      runId: traceRunId,
    });
    for (let i = 0; i < Math.ceil(targetBytes / 19_000) + 2; i++) {
      recorder.record({
        id: `e${i}`,
        ts: Date.now(),
        kind: 'tool',
        llmEventId: 'l1',
        name: 'write_file',
        args: { path: `f${i}.js`, contents: EVENT_FILLER },
        durationMs: 1,
      });
    }
    finish(recorder);
  }

  const deliveredResult = {
    summary: 'the toggle keeps the elapsed time and laps',
    output: 'index.html, app.js',
    producedBy: { tier: 3 as const, name: 'Meristem', viaFallback: false },
  };

  /**
   * A driver that delivers for real: workspace file, declared manifest, and a
   * trace of at least `targetBytes` written by the recorder.
   */
  function bigTraceDriver(options: {
    targetBytes: number;
    finish: (recorder: TraceRecorder) => void;
    stats?: RunStats;
    traceRunId?: (runId: string) => string;
    afterTrace?: (runsDir: string, runId: string) => void;
    skipTrace?: boolean;
  }): ReturnType<typeof vi.fn> {
    return vi.fn(async (spawn: SpawnRunOptions) => {
      const env = spawn.env ?? {};
      const workspace = env['ATOMA_BUILD_WORKSPACE']!;
      const runs = env['ATOMA_RUNS_DIR']!;
      const runId = env['ATOMA_RUN_ID']!;
      const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(declarations, '..'), { recursive: true });
      writeFileSync(join(workspace, 'index.html'), '<h1>Clock</h1>', 'utf8');
      writeFileSync(
        declarations,
        JSON.stringify({
          version: 1,
          runId,
          generatedAt: new Date().toISOString(),
          outputs: ['index.html'],
        }),
        'utf8'
      );
      if (options.skipTrace !== true) {
        writeRealTrace(
          runs,
          options.traceRunId ? options.traceRunId(runId) : runId,
          options.targetBytes,
          options.finish
        );
      } else {
        mkdirSync(runs, { recursive: true });
      }
      options.afterTrace?.(runs, runId);
      // The runner said DELIVERED in every case here. What differs is only
      // what the trace says, which is precisely what `verifiedTrace` decides.
      return `${formatRunStatsEpilogue(options.stats ?? DELIVERED_STATS)}\n✓ build finished\n`;
    });
  }

  /** A publisher whose mock also satisfies `ProjectRunPublisher` structurally. */
  function publisherSpy() {
    return { publish: vi.fn(async (_input: unknown) => undefined) };
  }

  async function runOnce(
    f: ReturnType<typeof fixture>,
    driver: ReturnType<typeof vi.fn>,
    key: string,
    publisher?: ReturnType<typeof publisherSpy>
  ) {
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: 'model-key' },
      driver: driver as unknown as ProjectRunDriver,
      acquireLease: async () => lease(),
      ...(publisher ? { publisher } : {}),
    });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: key, goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    const tracePath = join(
      f.root,
      'orgs',
      f.viewer.orgId,
      'projects',
      f.project.projectId,
      'runs',
      started.projectRunId,
      'traces',
      `${started.projectRunId}.json`
    );
    return { started, row: f.store.getProjectRun(f.viewer.orgId, started.projectRunId)!, tracePath };
  }

  it("delivers a run whose real trace passes the cap that erased 2857a579", async () => {
    const f = fixture();
    const publisher = publisherSpy();
    const driver = bigTraceDriver({
      targetBytes: 781_071,
      finish: (r) => void r.endRun({ result: deliveredResult }),
      stats: { ...DELIVERED_STATS, costUsd: 0.8421, llmCalls: 20, learnedSkills: 1 },
    });
    const { started, row, tracePath } = await runOnce(f, driver, 'run-big-1', publisher);

    // FIRST: the trace really is over the old cap, so this case cannot pass
    // vacuously if the writer ever stops producing a large document.
    expect(statSync(tracePath).size).toBeGreaterThan(781_071);
    expect(row.status).toBe('delivered');
    expect(row.traceId).toBe(started.projectRunId);
    expect(row.stats?.costUsd).toBe(0.8421);
    expect(row.artifactManifest?.files.map((file) => file.path)).toEqual(['index.html']);
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it('delivers at 949ecd5d scale too, so the fix is not a raised constant', async () => {
    const f = fixture();
    const driver = bigTraceDriver({
      targetBytes: 1_173_116,
      finish: (r) => void r.endRun({ result: deliveredResult }),
    });
    const { row, tracePath } = await runOnce(f, driver, 'run-big-2');
    expect(statSync(tracePath).size).toBeGreaterThan(1_173_116);
    expect(row.status).toBe('delivered');
  });

  /**
   * The semantic gate had NO test at all before this one — grep the suite for
   * any of its three messages and you find nothing. Raising a constant would
   * have left it that way.
   */
  const refusals: Array<[string, (r: TraceRecorder) => void, RegExp]> = [
    // An errored or cancelled run usually has NO result, and the result check
    // comes first — the same order the whole-document reader applied.
    [
      'an errored trace with no result',
      (r) => void r.endRun({ error: '401 API key is invalid.' }),
      /run trace has no completed result/,
    ],
    [
      'a cancelled trace with no result',
      (r) => void r.endRun({ cancelled: true }),
      /run trace has no completed result/,
    ],
    // And these two reach the publishability branch, because a result IS there.
    [
      'a result carrying an error',
      (r) => void r.endRun({ result: deliveredResult, error: '401 API key is invalid.' }),
      /failed, cancelled or degraded traces are not publishable/,
    ],
    [
      'a result cancelled mid-flight',
      (r) => void r.endRun({ result: deliveredResult, cancelled: true }),
      /failed, cancelled or degraded traces are not publishable/,
    ],
    [
      'a degraded trace',
      (r) =>
        void r.endRun({
          result: { ...deliveredResult, producedBy: { tier: 3, name: 'Meristem', viaFallback: true } },
        }),
      /failed, cancelled or degraded traces are not publishable/,
    ],
    [
      'a trace that never completed',
      (r) => r.flushPartial(),
      /run trace has no completed result/,
    ],
  ];

  for (const [name, finish, message] of refusals) {
    it(`still refuses ${name} above the old cap`, async () => {
      const f = fixture();
      const publisher = publisherSpy();
      const driver = bigTraceDriver({ targetBytes: 600_000, finish });
      const key = `run-refuse-${name.replace(/[^A-Za-z0-9]+/g, '-')}`;
      const { row, tracePath } = await runOnce(f, driver, key, publisher);
      expect(statSync(tracePath).size).toBeGreaterThan(524_288);
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(message);
      expect(publisher.publish).not.toHaveBeenCalled();
    });
  }

  it('refuses a large trace whose id belongs to another run', async () => {
    const f = fixture();
    const driver = bigTraceDriver({
      targetBytes: 600_000,
      finish: (r) => void r.endRun({ result: deliveredResult }),
      traceRunId: () => 'someone-elses-run',
      // Put the foreign-id document at the path this run's trace must occupy.
      afterTrace: (runsDir, runId) =>
        renameSync(join(runsDir, 'someone-elses-run.json'), join(runsDir, `${runId}.json`)),
    });
    const { row, tracePath } = await runOnce(f, driver, 'run-foreign-id');
    // The identity check now runs on a file the OLD reader refused for size
    // before it ever compared an id.
    expect(statSync(tracePath).size).toBeGreaterThan(524_288);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/run trace id does not match the project run/);
  });

  it('refuses an absent trace by name, without leaking a host path', async () => {
    const f = fixture();
    const driver = bigTraceDriver({
      targetBytes: 0,
      finish: () => undefined,
      skipTrace: true,
    });
    const { row } = await runOnce(f, driver, 'run-no-trace');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('run trace was never written');
    // `project_runs.error` is served to tenants. The row this fix replaces
    // carried an absolute `/Users/…/.atoma/orgs/…` path into it.
    expect(row.error).not.toContain(f.root);
  });

  it('refuses a symlink standing in for a trace, without leaking a host path', async () => {
    const f = fixture();
    const driver = bigTraceDriver({
      targetBytes: 600_000,
      finish: (r) => void r.endRun({ result: deliveredResult }),
      traceRunId: () => 'real-target',
      afterTrace: (runsDir, runId) =>
        symlinkSync(join(runsDir, 'real-target.json'), join(runsDir, `${runId}.json`)),
    });
    const { row } = await runOnce(f, driver, 'run-symlinked-trace');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('run trace is not a bounded regular file');
    expect(row.error).not.toContain(f.root);
  });

  /**
   * KNOWN GAP, pinned deliberately rather than hidden. When the runner reports
   * `delivered` and the TRACE refuses, `finish()`'s failure path drops the
   * stats — its condition is `stats.outcome !== 'delivered'`, keyed on the
   * PARSED outcome rather than on the status actually written. So run
   * `2857a579` is recorded `failed` with `stats_json = NULL` despite $0.8421
   * spent and one skill learned. It is the same class of loss the ordinary
   * failure path already fixed, reopened through a different door, and it is
   * recorded in `docs/decided-not-built-2026-08-23.md` because the repair is a
   * store-contract question (a `failed` row may not carry `outcome:
   * 'delivered'` stats), not a one-line change.
   */
  it('does NOT yet record what a trace-refused delivery cost', async () => {
    const f = fixture();
    const driver = bigTraceDriver({
      targetBytes: 600_000,
      finish: (r) => void r.endRun({ cancelled: true }),
      stats: { ...DELIVERED_STATS, costUsd: 0.8421, llmCalls: 20 },
    });
    const { row } = await runOnce(f, driver, 'run-cost-dropped');
    expect(row.status).toBe('failed');
    expect(row.stats).toBeNull();
  });
});

/**
 * THE OPERATOR'S BUDGET WAS UNREACHABLE.
 *
 * `949ecd5d` died at 900s after 68 tool calls and $0.96, and its own post-mortem
 * advised raising `ATOMA_BUILD_TIMEOUT_MS` — which cannot work: `spawnRun`
 * writes that variable from the coordinator's own value AFTER spreading the
 * caller's environment, so a host export is silently overwritten. The
 * coordinator hard-coded 15 minutes, neither construction site passed
 * `timeoutMs`, and `projects run` had no flag.
 */
describe('a project run has a budget an operator can set', () => {
  it('defaults to 15 minutes, and reads the host environment', () => {
    expect(projectRunTimeoutMs({})).toBe(DEFAULT_PROJECT_RUN_TIMEOUT_MS);
    expect(projectRunTimeoutMs({})).toBe(900_000);
    expect(projectRunTimeoutMs({ [PROJECT_RUN_TIMEOUT_ENV]: '2400000' })).toBe(2_400_000);
    // An empty value is absence, not an error: `export VAR=` is how a shell
    // unsets in practice.
    expect(projectRunTimeoutMs({ [PROJECT_RUN_TIMEOUT_ENV]: '' })).toBe(900_000);
  });

  it('lets an explicit argument win over the environment', () => {
    expect(projectRunTimeoutMs({ [PROJECT_RUN_TIMEOUT_ENV]: '2400000' }, 600_000)).toBe(600_000);
  });

  it('REFUSES a malformed or out-of-range budget instead of falling back', () => {
    // A run that quietly gets 15 minutes when the operator asked for 40 is the
    // defect this replaces, wearing a different hat.
    for (const bad of ['forty minutes', '2400000.5', '-1', 'NaN']) {
      expect(() => projectRunTimeoutMs({ [PROJECT_RUN_TIMEOUT_ENV]: bad })).toThrow(
        ProjectRunConfigurationError
      );
    }
    expect(() => projectRunTimeoutMs({}, 59_000)).toThrow(/outside/);
    expect(() => projectRunTimeoutMs({}, 3 * 60 * 60 * 1_000)).toThrow(/outside/);
    expect(projectRunTimeoutMs({}, MIN_PROJECT_RUN_TIMEOUT_MS)).toBe(60_000);
    expect(projectRunTimeoutMs({}, MAX_PROJECT_RUN_TIMEOUT_MS)).toBe(7_200_000);
  });

  it('carries the resolved budget to the driver, and ATOMA_BUILD_TIMEOUT_MS stays inert', async () => {
    const f = fixture();
    const driver = vi.fn(
      async (_spawn: SpawnRunOptions) =>
        `${formatRunStatsEpilogue({ ...DELIVERED_STATS, outcome: 'failed' })}\n✖ build failed\n`
    );
    const coordinator = new ProjectRunCoordinator({
      store: f.store,
      dbPath: f.dbPath,
      projectsRoot: f.root,
      hostEnv: {
        PATH: process.env['PATH'],
        ANTHROPIC_API_KEY: 'model-key',
        // The variable the post-mortem advised, exported on the host. It
        // reaches the child only as whatever the coordinator decided, because
        // `spawnRun` overwrites it — so it must NOT be what sets the budget.
        ATOMA_BUILD_TIMEOUT_MS: '9999999',
        [PROJECT_RUN_TIMEOUT_ENV]: '2400000',
      },
      driver,
      acquireLease: async () => lease(),
    });
    await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'run-budget', goal: 'Build a clock in one index.html.' },
    });
    await coordinator.waitForIdle();
    // The host's ATOMA_BUILD_TIMEOUT_MS did not win; the project budget did.
    expect(driver.mock.calls[0]?.[0].timeoutMs).toBe(2_400_000);
  });

  it('refuses to start at all when the configured budget is nonsense', () => {
    const f = fixture();
    expect(
      () =>
        new ProjectRunCoordinator({
          store: f.store,
          dbPath: f.dbPath,
          projectsRoot: f.root,
          hostEnv: { PATH: process.env['PATH'], [PROJECT_RUN_TIMEOUT_ENV]: 'later' },
          driver: vi.fn(async (_spawn: SpawnRunOptions) => ''),
          acquireLease: async () => lease(),
        })
    ).toThrow(ProjectRunConfigurationError);
  });
});
