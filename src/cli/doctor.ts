/**
 * Quota-free preflight for the exact runtime mode a build run will use.
 *
 *   npm run doctor
 *   ATOMA_LLM=claude-cli npm run doctor
 *   npm run doctor -- --container
 *   npm run doctor -- --egress
 *
 * The command never calls a model. Credential checks prove configuration or
 * an existing CLI login, not that a remote provider will accept the next
 * billable request.
 */
import { execFile } from 'node:child_process';
import { diagnosePreview } from './doctorPreview.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OLLAMA_DEFAULT_BASE_URL } from '../core/llmOllama.js';
import {
  referencedProviderNames,
  resolveBaseProviderKind,
  ZAI_DEFAULT_BASE_URL,
} from '../run/providers.js';
import {
  resolveIsolationRequirement,
  resolveToolBackendMode,
  type ToolBackendMode,
} from '../run/backendMode.js';
import {
  runHostSupported,
  UNSUPPORTED_RUN_HOST_REMEDY,
  unsupportedRunHostReason,
} from '../run/platform.js';
import { ContainerToolExecutor, DEFAULT_WORKER_IMAGE } from '../tools/containerExecutor.js';
import { DEFAULT_DB_PATH } from '../core/stores.js';
import { inspectAtomStoreSchema } from '../registry/db.js';
import { authPublicOrigin, vizAuthEnabled } from '../auth/gate.js';
import { snapshotProviderRegistry } from '../auth/providers.js';
import { snapshotTrustedProxies } from '../auth/rate-limit.js';
import { GITHUB_APP_ENV, snapshotGitHubAppConfig } from '../github/config.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const runFile = promisify(execFile);
export const NODE_ENGINE_RANGE = '^22.14.0 || >=24';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly ready: boolean;
  readonly mode: 'local' | 'container' | 'container+egress';
  readonly providers: readonly string[];
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface DoctorDependencies {
  readonly nodeVersion: string;
  /** Run host. Injected so the suite can diagnose a platform it is not on. */
  readonly platform: NodeJS.Platform;
  runCommand(
    command: string,
    args: readonly string[],
    options?: DoctorCommandOptions
  ): Promise<{ stdout: string; stderr: string }>;
  fetchStatus(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number }>;
  probeWorker(image: string): Promise<{ toolCount: number }>;
}

export interface ParsedDoctorOptions {
  readonly help: boolean;
  readonly mode: ToolBackendMode;
  /** Add the preview preconditions, including a REAL container probe. */
  readonly preview: boolean;
  readonly error?: string;
}

type ProviderName = 'anthropic' | 'ollama' | 'claude-cli' | 'zai' | 'codex';

function printHelp(): void {
  console.log(`atoma doctor — quota-free runtime preflight

usage:
  npm run doctor
  npm run doctor -- --container
  npm run doctor -- --egress
  npm run doctor -- --preview

flags:
  --container / --no-container   require or disable the Docker worker path
  --egress / --no-egress         select proxied egress (implies container)
  --preview                      add the result-preview preconditions
  --help                         show this help

The same ATOMA_LLM, ATOMA_MODEL_L1/L2/L3, ATOMA_CONTAINER and ATOMA_EGRESS
variables used by run:build determine what doctor checks. When visualizer auth
is enabled, its public origin and provider registry are checked offline too.`);
}

export function parseDoctorOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ParsedDoctorOptions {
  const allowed = new Set([
    '--container',
    '--no-container',
    '--egress',
    '--no-egress',
    '--preview',
    '--help',
    '-h',
  ]);
  const unknown = argv.find((arg) => !allowed.has(arg));
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    mode: resolveToolBackendMode(argv, env),
    preview: argv.includes('--preview'),
    ...(unknown ? { error: `unknown doctor argument "${unknown}"` } : {}),
  };
}

/** Exact package-engine policy without pulling a semver dependency into runtime. */
export function nodeVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 14;
  return major >= 24;
}

/** Engine 28 introduced bridge gateway mode `isolated`, required by egress. */
export function dockerVersionSupportsIsolatedGateway(version: string): boolean {
  const match = /^(\d+)\./.exec(version.trim());
  return match !== null && Number(match[1]) >= 28;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function providerName(value: string): value is ProviderName {
  return ['anthropic', 'ollama', 'claude-cli', 'zai', 'codex'].includes(value);
}

function modeName(mode: ToolBackendMode): DoctorReport['mode'] {
  if (mode.egress) return 'container+egress';
  return mode.container ? 'container' : 'local';
}

function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '(invalid URL)';
  }
}

function unavailableStatus(required: boolean): DoctorStatus {
  return required ? 'fail' : 'warn';
}

function checkVisualizerAuth(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    if (!vizAuthEnabled(env)) {
      return {
        id: 'viz-auth',
        label: 'Visualizer authentication',
        status: 'pass',
        detail: 'disabled',
      };
    }
    const origin = authPublicOrigin(env);
    const registry = snapshotProviderRegistry(env);
    if (registry.diagnostics.length > 0) {
      throw new Error(registry.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    if (registry.providers.length === 0) {
      throw new Error('no complete login provider is configured');
    }
    const trustedProxies = snapshotTrustedProxies(env);
    return {
      id: 'viz-auth',
      label: 'Visualizer authentication',
      status: 'pass',
      detail:
        `required · ${origin.origin} · ${registry.providers.map((provider) => provider.id).join(', ')}` +
        (trustedProxies.addresses.length > 0
          ? ` · ${trustedProxies.addresses.length} trusted proxy IP${trustedProxies.addresses.length === 1 ? '' : 's'}`
          : ''),
    };
  } catch (error) {
    return {
      id: 'viz-auth',
      label: 'Visualizer authentication',
      status: 'fail',
      detail: failureDetail(error),
      remedy:
        'Set ATOMA_VIZ_AUTH to 0/false or correct ATOMA_VIZ_PUBLIC_ORIGIN, ATOMA_VIZ_TRUSTED_PROXIES, and one complete ATOMA_AUTH_<PROVIDER> client.',
    };
  }
}

function checkGitHubApp(env: NodeJS.ProcessEnv): DoctorCheck {
  // EVERY App-specific key arms the probe — including KEY_ID (a rotation
  // leftover) and API_URL (a GHES half-config), which used to report
  // 'disabled' instead of the documented half-present hard failure. The
  // oauth/legacy client keys stay out: GitHub LOGIN legitimately exists
  // without the App.
  const appConfigPresent = [
    GITHUB_APP_ENV.appId,
    GITHUB_APP_ENV.appSlug,
    GITHUB_APP_ENV.privateKey,
    GITHUB_APP_ENV.privateKeyPath,
    GITHUB_APP_ENV.webhookSecret,
    GITHUB_APP_ENV.tokenEncryptionKey,
    GITHUB_APP_ENV.tokenEncryptionKeyId,
    GITHUB_APP_ENV.apiUrl,
  ].some((name) => env[name] !== undefined);
  if (!appConfigPresent) {
    return {
      id: 'github-app',
      label: 'GitHub App',
      status: 'pass',
      detail: 'disabled',
    };
  }
  try {
    const config = snapshotGitHubAppConfig(env);
    return {
      id: 'github-app',
      label: 'GitHub App',
      status: 'pass',
      detail: `configured · ${config.appSlug} · ${config.apiBaseUrl}`,
    };
  } catch (error) {
    return {
      id: 'github-app',
      label: 'GitHub App',
      status: 'fail',
      detail: failureDetail(error),
      remedy:
        'Set a complete GitHub App snapshot (ATOMA_GITHUB_APP_ID, ATOMA_GITHUB_APP_SLUG, exactly one private key source, ATOMA_GITHUB_WEBHOOK_SECRET, ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY) plus GitHub OAuth client credentials.',
    };
  }
}

function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: DoctorCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const result = await runFile(command, [...args], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function defaultFetchStatus(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { ok: response.ok, status: response.status };
}

async function defaultProbeWorker(image: string): Promise<{ toolCount: number }> {
  const workspace = mkdtempSync(join(tmpdir(), 'atoma-doctor-'));
  const worker = new ContainerToolExecutor({
    workspaceHostPath: workspace,
    image,
    startTimeoutMs: 15_000,
    forwardWorkerLogs: false,
  });
  try {
    await worker.start();
    const toolCount = worker.toolDeclarations().length;
    if (toolCount === 0) throw new Error('worker announced no tools');
    return { toolCount };
  } finally {
    worker.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function defaultDependencies(): DoctorDependencies {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    runCommand: defaultRunCommand,
    fetchStatus: defaultFetchStatus,
    probeWorker: defaultProbeWorker,
  };
}

/**
 * `start_static_server` — the element nearly every web run uses to serve its
 * workspace — spawns `python3 -m http.server`, and `run_shell`'s allowlist
 * admits `python3` outright. Neither was preflighted, so a host without it
 * failed inside a run, several tool calls in, as an ENOENT the model then
 * tried to work around. A WARNING, not a failure: tasks that never serve a
 * page complete fine without python3.
 */
async function checkPython(deps: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await deps.runCommand('python3', ['--version']);
    const version = `${stdout} ${stderr}`.trim();
    if (!/^Python \d/.test(version)) throw new Error(`unexpected reply: ${version || 'no output'}`);
    return {
      id: 'python',
      label: 'Python 3',
      status: 'pass',
      detail: `${version} answers on PATH`,
    };
  } catch (error) {
    return {
      id: 'python',
      label: 'Python 3',
      status: 'warn',
      detail: `python3 did not answer (${failureDetail(error)})`,
      remedy:
        'start_static_server and run_shell need python3 on PATH; install it (Debian: apt-get install python3) or expect web-serving tasks to fail mid-run.',
    };
  }
}

async function checkProvider(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
  deps: DoctorDependencies
): Promise<DoctorCheck> {
  const label = `Provider ${provider}`;
  const timeoutMs = 5_000;
  try {
    if (provider === 'zai') {
      if (!nonEmpty(env['ZAI_API_KEY'])) {
        throw new Error('ZAI_API_KEY is not set');
      }
      const baseUrl = env['ZAI_BASE_URL']?.trim() || ZAI_DEFAULT_BASE_URL;
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('ZAI_BASE_URL must use http or https');
      }
      return {
        id: 'provider:zai',
        label,
        status: 'pass',
        detail: `credential configured · ${safeUrlLabel(baseUrl)}`,
      };
    }

    if (provider === 'ollama') {
      const baseUrl = env['OLLAMA_BASE_URL']?.trim() || OLLAMA_DEFAULT_BASE_URL;
      const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/version`;
      const response = await deps.fetchStatus(endpoint, timeoutMs);
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      return {
        id: 'provider:ollama',
        label,
        status: 'pass',
        detail: `reachable · ${safeUrlLabel(baseUrl)}`,
      };
    }

    if (provider === 'claude-cli') {
      const authEnv = { ...env };
      // ClaudeCliLlmClient drops this key so subscription OAuth cannot be
      // shadowed. Doctor must inspect that same environment.
      delete authEnv['ANTHROPIC_API_KEY'];
      const result = await deps.runCommand('claude', ['auth', 'status', '--json'], {
        env: authEnv,
        timeoutMs,
      });
      const status = JSON.parse(result.stdout) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        apiProvider?: unknown;
      };
      if (status.loggedIn !== true) throw new Error('Claude CLI is not logged in');
      const method = typeof status.authMethod === 'string' ? status.authMethod : 'authenticated';
      const api = typeof status.apiProvider === 'string' ? ` · ${status.apiProvider}` : '';
      return {
        id: 'provider:claude-cli',
        label,
        status: 'pass',
        detail: `${method}${api}`,
      };
    }

    if (provider === 'codex') {
      const hasApiCredential =
        nonEmpty(env['OPENAI_API_KEY']) || nonEmpty(env['CODEX_API_KEY']);
      await deps.runCommand('codex', hasApiCredential ? ['--version'] : ['login', 'status'], {
        env,
        timeoutMs,
      });
      return {
        id: 'provider:codex',
        label,
        status: 'pass',
        detail: hasApiCredential ? 'CLI available · API credential configured' : 'ChatGPT login available',
      };
    }

    // The SDK resolves credentials on the FIRST REQUEST, not at construction:
    // `new Anthropic()` with no key, no bearer token, no ANTHROPIC_PROFILE and
    // a nonexistent config dir returns a client with `apiKey === null` and
    // exits 0 (measured 2026-08-17). The previous version of this check ran
    // exactly that constructor in a child process and treated exit 0 as proof,
    // then NAMED a source it had never observed — so a machine with no
    // credential at all reported
    // `pass · credential source available · ant OAuth profile`.
    //
    // Doctor is quota-free, so it cannot settle the question with a request
    // either, and re-deriving the SDK's profile/WIF lookup here is the
    // two-copies-of-one-rule drift this repo has been bitten by. It therefore
    // reports only what it can actually see, and says so when it cannot see.
    const forceCli = (env['ATOMA_AUTH'] ?? '').trim().toLowerCase() === 'cli';
    const apiKey = forceCli ? undefined : env['ANTHROPIC_API_KEY'];
    const source = nonEmpty(apiKey)
      ? 'ANTHROPIC_API_KEY'
      : nonEmpty(env['ANTHROPIC_AUTH_TOKEN'])
        ? 'ANTHROPIC_AUTH_TOKEN'
        : null;
    if (source === null) {
      return {
        id: 'provider:anthropic',
        label,
        status: 'warn',
        detail: forceCli
          ? 'ATOMA_AUTH=cli · no bearer token in the environment; an ant OAuth profile cannot be proven without a billable request'
          : 'no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment; an ant OAuth profile cannot be proven without a billable request',
        remedy:
          'Run `ant auth status` to confirm the active profile, or export ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.',
      };
    }
    return {
      id: 'provider:anthropic',
      label,
      status: 'pass',
      detail: `credential source available · ${source}`,
    };
  } catch {
    const remedy =
      provider === 'claude-cli'
        ? 'Run `claude /login`, then retry with ATOMA_LLM=claude-cli.'
        : provider === 'codex'
          ? 'Run `codex login` or configure OPENAI_API_KEY/CODEX_API_KEY.'
          : provider === 'ollama'
            ? 'Start Ollama and verify OLLAMA_BASE_URL (default http://localhost:11434).'
            : provider === 'zai'
              ? 'Export ZAI_API_KEY and verify ZAI_BASE_URL.'
              : 'Export ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN or run `ant auth login`.';
    return {
      id: `provider:${provider}`,
      label,
      status: 'fail',
      detail: 'authentication or endpoint unavailable',
      remedy,
    };
  }
}

async function checkDocker(
  required: boolean,
  deps: DoctorDependencies,
  egress: boolean
): Promise<DoctorCheck[]> {
  const status = unavailableStatus(required);
  try {
    const result = await deps.runCommand(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 5_000 }
    );
    const version = result.stdout.trim() || 'unknown';
    const isolatedGatewaySupported = dockerVersionSupportsIsolatedGateway(version);
    const docker: DoctorCheck = {
      id: 'docker',
      label: 'Docker daemon',
      status: egress && !isolatedGatewaySupported ? 'fail' : 'pass',
      detail:
        `reachable · server ${version}` +
        (egress && !isolatedGatewaySupported
          ? ' · too old for isolated egress gateway'
          : ''),
      ...(egress && !isolatedGatewaySupported
        ? {
            remedy:
              'Upgrade to Docker Engine 28+; older --internal bridges can reach host services through their gateway.',
          }
        : {}),
    };
    try {
      await deps.runCommand(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', DEFAULT_WORKER_IMAGE],
        { timeoutMs: 5_000 }
      );
      try {
        const worker = await deps.probeWorker(DEFAULT_WORKER_IMAGE);
        return [
          docker,
          {
            id: 'worker',
            label: 'Worker image',
            status: 'pass',
            detail: `${DEFAULT_WORKER_IMAGE} starts · ${worker.toolCount} tools announced`,
          },
        ];
      } catch (error) {
        return [
          docker,
          {
            id: 'worker',
            label: 'Worker image',
            status,
            detail: `image exists but startup failed · ${failureDetail(error)}`,
            remedy:
              'Rebuild with `npm run build:worker` (`build:worker:dev` after source changes).',
          },
        ];
      }
    } catch {
      return [
        docker,
        {
          id: 'worker',
          label: 'Worker image',
          status,
          detail: `${DEFAULT_WORKER_IMAGE} is not installed`,
          remedy: 'Run `npm run build:worker` to build it from compiled dist.',
        },
      ];
    }
  } catch {
    return [
      {
        id: 'docker',
        label: 'Docker daemon',
        status,
        detail: 'unavailable',
        remedy: required
          ? 'Install/start Docker, or run without --container.'
          : 'Optional for local runs; install/start Docker before using --container.',
      },
      {
        id: 'worker',
        label: 'Worker image',
        status,
        detail: 'not checked because Docker is unavailable',
        remedy: 'After Docker starts, run `npm run build:worker`.',
      },
    ];
  }
}

export async function diagnoseDoctor(args: {
  readonly mode: ToolBackendMode;
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: Partial<DoctorDependencies>;
  /**
   * OPT-IN, because it starts a real container. Every other check here is
   * observation; this one allocates, so an operator asks for it rather than
   * paying for it on every `npm run doctor`.
   */
  readonly preview?: boolean;
}): Promise<DoctorReport> {
  const env = args.env ?? process.env;
  const deps = { ...defaultDependencies(), ...args.dependencies };
  const checks: DoctorCheck[] = [];

  checks.push(
    nodeVersionSupported(deps.nodeVersion)
      ? {
          id: 'node',
          label: 'Node.js',
          status: 'pass',
          detail: `${deps.nodeVersion} satisfies ${NODE_ENGINE_RANGE}`,
        }
      : {
          id: 'node',
          label: 'Node.js',
          status: 'fail',
          detail: `${deps.nodeVersion} does not satisfy ${NODE_ENGINE_RANGE}`,
          remedy: 'Install Node 22.14+ or 24+.',
        }
  );

  // The run host, before anything about credentials or Docker: on an
  // unsupported platform every other check can pass and no run can start.
  checks.push(
    runHostSupported(deps.platform)
      ? {
          id: 'run-host',
          label: 'Run host',
          status: 'pass',
          detail: `${deps.platform} can execute runs`,
        }
      : {
          id: 'run-host',
          label: 'Run host',
          status: 'fail',
          detail: unsupportedRunHostReason(deps.platform),
          remedy: UNSUPPORTED_RUN_HOST_REMEDY,
        }
  );

  let baseProvider: ProviderName | undefined;
  const configProblems: string[] = [];
  try {
    baseProvider = resolveBaseProviderKind(env['ATOMA_LLM']);
  } catch (error) {
    configProblems.push(failureDetail(error));
  }
  const l1Model = env['ATOMA_MODEL_L1']?.trim().toLowerCase();
  if (l1Model?.startsWith('codex:')) {
    configProblems.push(
      'ATOMA_MODEL_L1 cannot use codex because Codex cannot expose tools through ToolSandbox'
    );
  }

  const providers: ProviderName[] = [];
  const addProvider = (name: string | undefined): void => {
    if (name && providerName(name) && !providers.includes(name)) providers.push(name);
  };
  addProvider(baseProvider);
  for (const name of referencedProviderNames(env)) addProvider(name);

  checks.push(
    configProblems.length === 0
      ? {
          id: 'provider-config',
          label: 'Provider routing',
          status: 'pass',
          detail: providers.join(', ') || 'no provider selected',
        }
      : {
          id: 'provider-config',
          label: 'Provider routing',
          status: 'fail',
          detail: configProblems.join('; '),
          remedy: 'Correct ATOMA_LLM and the ATOMA_MODEL_L1/L2/L3 tier pins.',
        }
  );

  checks.push(checkVisualizerAuth(env));
  checks.push(checkGitHubApp(env));

  const anthropicKeyIgnored =
    nonEmpty(env['ANTHROPIC_API_KEY']) &&
    (providers.includes('claude-cli') ||
      (providers.includes('anthropic') &&
        (env['ATOMA_AUTH'] ?? '').trim().toLowerCase() === 'cli'));
  if (anthropicKeyIgnored) {
    checks.push({
      id: 'provider-key-precedence',
      label: 'Provider key precedence',
      status: 'warn',
      detail: 'ANTHROPIC_API_KEY is set but ignored on at least one configured route',
      remedy:
        'This is intentional for claude-cli and ATOMA_AUTH=cli; remove the variable if the warning is unexpected.',
    });
  }
  if (providers.includes('claude-cli') && nonEmpty(env['ATOMA_CLAUDE_MODEL'])) {
    checks.push({
      id: 'claude-model-override',
      label: 'Claude model override',
      status: 'warn',
      detail: 'ATOMA_CLAUDE_MODEL flattens every Claude CLI tier onto one model',
      remedy:
        'Unset it for the normal L1/L2/L3 cost gradient; prefer ATOMA_MODEL_L3 for a tier-specific override.',
    });
  }

  for (const provider of providers) {
    checks.push(await checkProvider(provider, env, deps));
  }
  // Doctor's contract is to diagnose the mode the runner will ACTUALLY use,
  // so a deployment that demands an OS boundary must hear about a run that
  // would not get one — before the run, not from a trace afterwards.
  if (resolveIsolationRequirement(env) && !args.mode.container) {
    checks.push({
      id: 'isolation',
      label: 'Run isolation',
      status: 'fail',
      detail:
        'ATOMA_REQUIRE_ISOLATION=1 but this mode resolves to the local tool backend, which is not a boundary',
      remedy: 'Launch with --container (or --egress), or set ATOMA_CONTAINER=1.',
    });
  }
  const dbPath = env['ATOMA_DB_PATH'] ?? DEFAULT_DB_PATH;
  const storeSchema = inspectAtomStoreSchema(dbPath);
  if (storeSchema === 'missing') {
    checks.push({
      id: 'store-schema',
      label: 'Agent store',
      status: 'pass',
      detail: 'no store yet — the next run will create the current schema',
    });
  } else if (storeSchema === 'compatible') {
    checks.push({
      id: 'store-schema',
      label: 'Agent store',
      status: 'pass',
      detail: 'store accepts the current schema',
    });
  } else if (storeSchema === 'pre-t4') {
    checks.push({
      id: 'store-schema',
      label: 'Agent store',
      status: 'fail',
      detail: `${dbPath} predates the atom_id column; CREATE TABLE IF NOT EXISTS will not migrate it and the next open will throw on idx_atom_types_atom_id`,
      remedy:
        'The schema is the schema. Point ATOMA_DB_PATH at a post-reset store, or remove this file and start empty.',
    });
  } else {
    checks.push({
      id: 'store-schema',
      label: 'Agent store',
      status: 'fail',
      detail: `${dbPath} exists but is not a readable SQLite atom store`,
      remedy: 'Fix or replace ATOMA_DB_PATH.',
    });
  }
  // Only for the LOCAL backend: in container mode the elements run inside the
  // worker image, which ships its own python3, so the host's is irrelevant.
  if (!args.mode.container) checks.push(await checkPython(deps));
  checks.push(...(await checkDocker(args.mode.container, deps, args.mode.egress)));
  // LAST, and only when asked: it starts a real container, so it is the one
  // check here that allocates rather than observes.
  if (args.preview) checks.push(...(await diagnosePreview(env, deps)));
  if (args.mode.egress) {
    checks.push({
      id: 'egress',
      label: 'Proxied egress',
      status: 'warn',
      detail: 'not exercised by the lightweight doctor probe',
      remedy:
        'Run `npm run release:container-smoke` for an allowlisted external request and control-plane denial check.',
    });
  }

  return {
    ready: checks.every((check) => check.status !== 'fail'),
    mode: modeName(args.mode),
    providers,
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`atoma doctor — ${report.mode} mode`];
  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
    lines.push(`${icon} ${check.label}: ${check.detail}`);
    if (check.remedy && check.status !== 'pass') lines.push(`  ↳ ${check.remedy}`);
  }
  const warnings = report.checks.filter((check) => check.status === 'warn').length;
  lines.push(
    report.ready
      ? warnings > 0
        ? `READY WITH WARNINGS — required ${report.mode} prerequisites are satisfied`
        : `READY — ${report.mode} run prerequisites are satisfied`
      : `NOT READY — fix the failed prerequisite${report.checks.filter((c) => c.status === 'fail').length === 1 ? '' : 's'} above`
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const parsed = parseDoctorOptions(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    printHelp();
    process.exitCode = 2;
    return;
  }
  const report = await diagnoseDoctor({ mode: parsed.mode, preview: parsed.preview });
  console.log(renderDoctorReport(report));
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && /doctor\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
