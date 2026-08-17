import { describe, expect, it } from 'vitest';
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
    nodeVersion: 'v22.13.0',
    runCommand: async (command, args) => {
      if (command === 'docker' && args[0] === 'version') {
        return { stdout: '28.0.0\n', stderr: '' };
      }
      if (command === 'docker' && args[0] === 'image') {
        return { stdout: 'sha256:test\n', stderr: '' };
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
    ['22.13.0', true],
    ['v23.9.0', false],
    ['v24.0.0', true],
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
      env: { ATOMA_LLM: 'claude-cli', ANTHROPIC_API_KEY: 'stale-key' },
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
        ATOMA_LLM: 'anthropic',
        ATOMA_AUTH: 'cli',
        ANTHROPIC_API_KEY: 'shadowing-key',
      },
      dependencies: dependencies(),
    });

    // ATOMA_AUTH=cli means the exported key will be ignored at run time, so
    // doctor must not count it as the credential source. What remains is an
    // ant OAuth profile, which resolves on the first REQUEST and therefore
    // cannot be proven by a quota-free check.
    const check = report.checks.find((c) => c.id === 'provider:anthropic');
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
      env: { ATOMA_LLM: 'anthropic' },
      dependencies: dependencies(),
    });

    const check = report.checks.find((c) => c.id === 'provider:anthropic');
    expect(check?.status).toBe('warn');
    expect(check?.detail).not.toContain('credential source available');
  });

  it('passes and names the source when the environment actually carries one', async () => {
    const withKey = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });
    expect(withKey.checks.find((c) => c.id === 'provider:anthropic')?.detail).toBe(
      'credential source available · ANTHROPIC_API_KEY'
    );

    const withToken = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_AUTH_TOKEN: 'bearer' },
      dependencies: dependencies(),
    });
    expect(withToken.checks.find((c) => c.id === 'provider:anthropic')?.detail).toBe(
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
        ATOMA_LLM: 'anthropic',
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
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies(),
    });

    expect(report.checks.find((c) => c.id === 'isolation')).toBeUndefined();
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
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
      dependencies: dependencies({ runCommand }),
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'provider:anthropic')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'docker')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'worker')?.status).toBe('fail');
  });

  it('boots the worker and reports its announced tool count', async () => {
    const report = await diagnoseDoctor({
      mode: { container: true, egress: true },
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
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
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
      dependencies: oldDocker,
    });
    const isolated = await diagnoseDoctor({
      mode: { container: true, egress: false },
      env: { ATOMA_LLM: 'anthropic', ANTHROPIC_API_KEY: 'configured' },
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
        ATOMA_LLM: 'claude-cli',
        ATOMA_MODEL_L2: 'zai:glm-5',
        ATOMA_MODEL_L3: 'codex:gpt-5.6-sol',
        ZAI_API_KEY: 'configured',
      },
      dependencies: dependencies({ runCommand }),
    });

    expect(report.providers).toEqual(['claude-cli', 'zai', 'codex']);
    expect(report.ready).toBe(true);
    expect(commands.some((command) => command.startsWith('codex login status'))).toBe(true);
  });

  it('rejects Codex on tier 1 before a run reaches the tool loop', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ATOMA_LLM: 'claude-cli',
        ATOMA_MODEL_L1: 'codex:gpt-5.6-sol',
      },
      dependencies: dependencies(),
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === 'provider-config')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('cannot use codex'),
    });
  });

  it('warns when the Claude debug override flattens the tier gradient', async () => {
    const report = await diagnoseDoctor({
      mode: { container: false, egress: false },
      env: {
        ATOMA_LLM: 'claude-cli',
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
        ATOMA_LLM: 'ollama',
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
});
