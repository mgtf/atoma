import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { inspectAtomStoreSchema } from '../src/registry/db.js';
import { ANTHROPIC_PINS, CLAUDE_CLI_PINS, OLLAMA_PINS } from './tier-pins.js';
import {
  diagnoseDoctor,
  dockerVersionSupportsIsolatedGateway,
  nodeVersionSupported,
  parseDoctorOptions,
  renderDoctorReport,
  type DoctorCommandOptions,
  type DoctorDependencies,
} from '../src/cli/doctor.js';

function dependencies(
  overrides: Partial<DoctorDependencies> = {}
): Partial<DoctorDependencies> {
  return {
    nodeVersion: 'v24.20.0',
    // PINNED, so this suite diagnoses one platform whatever host it runs on.
    // Without it every doctor assertion below would flip on a Windows
    // developer's machine, where the run-host check fails by contract.
    platform: 'linux',
    runCommand: async (command, args) => {
      if (command === 'docker' && args[0] === 'version') {
        return { stdout: '28.0.0\n', stderr: '' };
      }
      if (command === 'docker' && args[0] === 'image') {
        return { stdout: 'sha256:test\n', stderr: '' };
      }
      if (command === 'python3') {
        return { stdout: 'Python 3.13.5\n', stderr: '' };
      }
      if (command === 'claude') {
        return {
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            apiProvider: 'firstParty',
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
    fetchStatus: async () => ({ ok: true, status: 200 }),
    probeWorker: async () => ({ toolCount: 10 }),
    ...overrides,
  };
}

describe('atoma doctor', () => {
  it.each([
    ['v20.18.9', false],
    ['v20.19.0', false],
    ['22.12.0', false],
    ['22.13.0', false],
    ['22.14.0', false],
    ['v23.9.0', false],
    ['v24.0.0', true],
    ['v24.20.0', true],
    ['v25.1.0', true],
    ['garbage', false],
  ])('applies the package Node engine floor to %s', (version, supported) => {
    expect(nodeVersionSupported(version)).toBe(supported);
  });

  it.each([
    ['27.5.1', false],
    ['28.0.0', true],
    ['29.1.2', true],
    ['unknown', false],
  ])('recognizes the Docker isolated-gateway floor in %s', (version, supported) => {
    expect(dockerVersionSupportsIsolatedGateway(version)).toBe(supported);
  });

  it('resolves the same container and egress precedence as the runner', () => {
    expect(parseDoctorOptions([], {}).mode).toEqual({ container: false, egress: false });
    expect(parseDoctorOptions(['--container'], {}).mode).toEqual({
      container: true,
      egress: false,
    });
    expect(parseDoctorOptions(['--egress', '--no-container'], {}).mode).toEqual({
      container: true,
      egress: true,
    });
    expect(
      parseDoctorOptions(['--no-egress'], {
        ATOMA_CONTAINER: '1',
        ATOMA_EGRESS: '1',
      }).mode
    ).toEqual({ container: true, egress: false });
    expect(parseDoctorOptions(['unexpected'], {}).error).toContain('unexpected');
  });

  it('preflights visualizer auth without contacting an identity provider', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...ANTHROPIC_PINS,
        ANTHROPIC_API_KEY: 'configured',
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
      },
      dependencies: dependencies(),
    });

    expect(report.checks.find((check) => check.id === 'viz-auth')).toMatchObject({
      status: 'pass',
      detail: 'required · https://viz.example · github',
    });
    expect(report.checks.find((check) => check.id === 'github-app')).toMatchObject({
      status: 'pass',
      detail: 'disabled',
    });
    expect(renderDoctorReport(report)).not.toContain('client-secret');
  });

  it('treats a complete GitHub App snapshot as configured and a half-present one as a hard failure', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const configured = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...ANTHROPIC_PINS,
        ANTHROPIC_API_KEY: 'configured',
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
        ATOMA_GITHUB_APP_ID: '123456',
        ATOMA_GITHUB_APP_SLUG: 'atoma-test',
        ATOMA_GITHUB_APP_PRIVATE_KEY: pem,
        ATOMA_GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
        ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      },
      dependencies: dependencies(),
    });
    expect(configured.checks.find((check) => check.id === 'github-app')).toMatchObject({
      status: 'pass',
      detail: expect.stringMatching(/^configured · atoma-test · /),
    });
    expect(renderDoctorReport(configured)).not.toContain(pem.slice(0, 40));

    const half = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...ANTHROPIC_PINS,
        ANTHROPIC_API_KEY: 'configured',
        ATOMA_GITHUB_APP_ID: '123456',
      },
      dependencies: dependencies(),
    });
    expect(half.checks.find((check) => check.id === 'github-app')).toMatchObject({
      status: 'fail',
      remedy: expect.stringContaining('ATOMA_GITHUB_APP_ID'),
    });
    expect(half.ready).toBe(false);

    // A rotation leftover (KEY_ID alone) or a GHES half-config (API_URL
    // alone) is the same half-present hard failure — these two keys used to
    // be missing from the presence probe and reported 'disabled'.
    for (const leftover of [
      { ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY_ID: 'k2' },
      { ATOMA_GITHUB_API_URL: 'https://ghes.example/api/v3' },
    ]) {
      const stale = await diagnoseDoctor({
        mode: { container: false, egress: false },
        env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured', ...leftover },
        dependencies: dependencies(),
      });
      expect(stale.checks.find((check) => check.id === 'github-app')?.status).toBe('fail');
      expect(stale.ready).toBe(false);
    }
  });

  it.each([
    [
      { ATOMA_VIZ_AUTH: 'yes' },
      /must be one of/,
    ],
    [
      {
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: 'http://public.example',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
      },
      /must use https/,
    ],
    [
      {
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
      },
      /must both be configured/,
    ],
    [
      {
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: 'https://viz.example',
        ATOMA_VIZ_TRUSTED_PROXIES: 'proxy.internal',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'client-id',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'client-secret',
      },
      /IP literals/,
    ],
  ])('fails closed on invalid visualizer auth configuration', async (authEnv, pattern) => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured', ...authEnv },
      dependencies: dependencies(),
    });

    expect(report.checks.find((check) => check.id === 'viz-auth')).toMatchObject({
      status: 'fail',
      detail: expect.stringMatching(pattern),
      remedy: expect.stringContaining('ATOMA_VIZ_TRUSTED_PROXIES'),
    });
    expect(report.ready).toBe(false);
  });

  it('checks Claude CLI in the API-key-free environment the transport uses', async () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const runCommand = async (
      command: string,
      _args: readonly string[],
      options?: DoctorCommandOptions
    ): Promise<{ stdout: string; stderr: string }> => {
      if (command === 'docker') throw new Error('not installed');
      observedEnv = options?.env;
      return {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
        }),
        stderr: '',
      };
    };
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...CLAUDE_CLI_PINS, ANTHROPIC_API_KEY: 'stale-key' },
      dependencies: dependencies({ runCommand }),
    });

    expect(report.ready).toBe(true);
    expect(observedEnv?.['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(
      report.checks.find((check) => check.id === 'provider-key-precedence')?.status
    ).toBe('warn');
    expect(report.checks.find((check) => check.id === 'docker')?.status).toBe('warn');
  });

  it('models ATOMA_AUTH=cli by discounting the shadowed key, not by claiming a profile', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...ANTHROPIC_PINS,
        ATOMA_AUTH: 'cli',
        ANTHROPIC_API_KEY: 'shadowing-key',
      },
      dependencies: dependencies(),
    });

    // ATOMA_AUTH=cli means the exported key will be ignored at run time, so
    // doctor must not count it as the credential source. What remains is an
    // ant OAuth profile, which resolves on the first REQUEST and therefore
    // cannot be proven by a quota-free check.
    const check = report.checks.find((c) => c.id === 'provider:anthropic-api');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('ATOMA_AUTH=cli');
    expect(check?.remedy).toContain('ant auth status');
  });

  it('never reports an unproven ant OAuth profile as a passing credential source', async () => {
    // Regression: the check ran `new Anthropic()` in a child process and read
    // exit 0 as proof. That constructor never throws — it resolves credentials
    // on the first request — so a machine with NO credential at all reported
    // `pass · credential source available · ant OAuth profile`.
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS },
      dependencies: dependencies(),
    });

    const check = report.checks.find((c) => c.id === 'provider:anthropic-api');
    expect(check?.status).toBe('warn');
    expect(check?.detail).not.toContain('credential source available');
  });

  it('passes and names the source when the environment actually carries one', async () => {
    const withKey = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });
    expect(withKey.checks.find((c) => c.id === 'provider:anthropic-api')?.detail).toBe(
      'credential source available · ANTHROPIC_API_KEY'
    );

    const withToken = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_AUTH_TOKEN: 'bearer' },
      dependencies: dependencies(),
    });
    expect(withToken.checks.find((c) => c.id === 'provider:anthropic-api')?.detail).toBe(
      'credential source available · ANTHROPIC_AUTH_TOKEN'
    );
  });

  it('fails when a boundary is required but the mode resolves to local (T1)', async () => {
    // Doctor's contract is to diagnose the mode the runner will ACTUALLY use.
    // A deployment demanding isolation must hear about an unjailed run before
    // it starts, not from the trace afterwards.
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...ANTHROPIC_PINS,
        ANTHROPIC_API_KEY: 'configured',
        ATOMA_REQUIRE_ISOLATION: '1',
      },
      dependencies: dependencies(),
    });

    expect(report.checks.find((c) => c.id === 'isolation')?.status).toBe('fail');
    expect(report.ready).toBe(false);
  });

  it('raises no isolation check when the deployment does not require one', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });

    expect(report.checks.find((c) => c.id === 'isolation')).toBeUndefined();
  });

  it.each([
    ['linux', 'pass', true],
    ['darwin', 'pass', true],
    ['win32', 'fail', false],
  ] as const)('reports %s as a run host (%s)', async (platform, status, ready) => {
    // The audit's worst state was SILENCE: on win32 every check passed and no
    // run could start. Doctor must say so before a run dies several
    // processes deep, and must say it for a platform this suite is not on.
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ platform }),
    });

    const host = report.checks.find((check) => check.id === 'run-host');
    expect(host?.status).toBe(status);
    expect(report.ready).toBe(ready);
    if (status === 'fail') {
      // Detail is the mechanical fact, remedy is the way out — the renderer
      // prints both, so a detail that also carried the remedy said it twice.
      expect(host?.detail).toContain('win32');
      expect(host?.detail).not.toContain('WSL2');
      expect(host?.remedy).toMatch(/WSL2/);
      expect(host?.remedy).toMatch(/development-setup\.md/);
    }
  });

  it('warns when python3 is absent, since start_static_server spawns it', async () => {
    const runCommand = async (
      command: string
    ): Promise<{ stdout: string; stderr: string }> => {
      if (command === 'python3') throw new Error('spawn python3 ENOENT');
      return { stdout: '', stderr: '' };
    };
    const missing = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ runCommand }),
    });
    const check = missing.checks.find((c) => c.id === 'python');
    expect(check?.status).toBe('warn');
    expect(check?.remedy).toContain('python3');
    // A warning, not a failure: tasks that never serve a page are unaffected.
    expect(missing.ready).toBe(true);

    // Present is a pass…
    const present = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });
    expect(present.checks.find((c) => c.id === 'python')?.status).toBe('pass');

    // …and a reply that is not a python version is not a python (a `python3`
    // shim answering nothing at all is the Windows Store stub's behaviour).
    const stub = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ runCommand: async () => ({ stdout: '', stderr: '' }) }),
    });
    expect(stub.checks.find((c) => c.id === 'python')?.status).toBe('warn');

    // The host's python is irrelevant in container mode: the worker ships one.
    const containerised = await diagnoseDoctor({
      mode: { container: true, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ runCommand }),
    });
    expect(containerised.checks.find((c) => c.id === 'python')).toBeUndefined();
  });

  it('requires Docker and a bootable worker in container mode', async () => {
    const runCommand = async (
      command: string
    ): Promise<{ stdout: string; stderr: string }> => {
      if (command === 'docker') throw new Error('docker unavailable');
      return { stdout: '', stderr: '' };
    };
    const report = await diagnoseDoctor({
      mode: { container: true, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ runCommand }),
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'provider:anthropic-api')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'docker')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'worker')?.status).toBe('fail');
  });

  it('boots the worker and reports its announced tool count', async () => {
    const report = await diagnoseDoctor({
      mode: { container: true, egress: true },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });

    expect(report.ready).toBe(true);
    expect(report.mode).toBe('container+egress');
    expect(report.checks.find((check) => check.id === 'worker')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('10 tools'),
    });
    expect(report.checks.find((check) => check.id === 'egress')?.status).toBe('warn');
  });

  it('fails egress closed on Docker 27 while ordinary container mode remains available', async () => {
    const oldDocker = dependencies({
      runCommand: async (command, args) => {
        if (command === 'docker' && args[0] === 'version') {
          return { stdout: '27.5.1\n', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'image') {
          return { stdout: 'sha256:test\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });
    const egress = await diagnoseDoctor({
      mode: { container: true, egress: true },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: oldDocker,
    });
    const isolated = await diagnoseDoctor({
      mode: { container: true, egress: false },
      env: { ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'configured' },
      dependencies: oldDocker,
    });

    expect(egress.ready).toBe(false);
    expect(egress.checks.find((check) => check.id === 'docker')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('too old'),
    });
    expect(isolated.checks.find((check) => check.id === 'docker')?.status).toBe('pass');
  });

  it('checks every explicitly routed provider without making an LLM call', async () => {
    const commands: string[] = [];
    const runCommand = async (
      command: string,
      args: readonly string[]
    ): Promise<{ stdout: string; stderr: string }> => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'claude') {
        return { stdout: '{"loggedIn":true}', stderr: '' };
      }
      if (command === 'docker' && args[0] === 'version') {
        return { stdout: '28.0.0', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ATOMA_MODEL_L1: 'sub:anthropic:haiku',
        ATOMA_MODEL_L2: 'api:zai:glm-5',
        ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol',
        ZAI_API_KEY: 'configured',
      },
      dependencies: dependencies({ runCommand }),
    });

    expect(report.providers).toEqual(['claude-cli', 'zai-api', 'codex-cli']);
    expect(report.ready).toBe(true);
    expect(commands.some((command) => command.startsWith('codex login status'))).toBe(true);
  });

  it('rejects Codex on tier 1 before a run reaches the tool loop', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...CLAUDE_CLI_PINS,
        ATOMA_MODEL_L1: 'sub:openai:gpt-5.6-sol',
      },
      dependencies: dependencies(),
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'provider-config')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('Codex cannot expose tools'),
    });
  });

  it('warns when the Claude debug override flattens the tier gradient', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...CLAUDE_CLI_PINS,
        ATOMA_CLAUDE_MODEL: 'sonnet',
      },
      dependencies: dependencies(),
    });

    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.id === 'claude-model-override')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('flattens every Claude CLI tier'),
    });
  });

  it('probes the configured Ollama endpoint and renders a usable summary', async () => {
    let fetched = '';
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ...OLLAMA_PINS,
        OLLAMA_BASE_URL: 'http://ollama.example:11434/',
      },
      dependencies: dependencies({
        fetchStatus: async (url) => {
          fetched = url;
          return { ok: true, status: 200 };
        },
      }),
    });

    expect(fetched).toBe('http://ollama.example:11434/api/version');
    expect(renderDoctorReport(report)).toContain('READY');
    expect(renderDoctorReport(report)).not.toContain('API_KEY');
  });

  it('fails when the store predates the atom_id column', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-doctor-store-'));
    const dbPath = join(dir, 'old.db');
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE atom_types (
        tier INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (tier, ordinal)
      )`
    );
    db.close();
    try {
      expect(inspectAtomStoreSchema(dbPath)).toBe('pre-t4');
      expect(inspectAtomStoreSchema(join(dir, 'missing.db'))).toBe('missing');
      const report = await diagnoseDoctor({
        mode: { container: false, egress: false },
        env: {
          ...ANTHROPIC_PINS,
          ANTHROPIC_API_KEY: 'configured',
          ATOMA_DB_PATH: dbPath,
        },
        dependencies: dependencies(),
      });
      const check = report.checks.find((c) => c.id === 'store-schema');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toMatch(/atom_id/);
      expect(report.ready).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
