import { describe, expect, it } from 'vitest';
import { diagnosePreview } from '../src/cli/doctorPreview.js';
import { parseDoctorOptions, type DoctorCheck, type DoctorDependencies } from '../src/cli/doctor.js';

/**
 * `doctor --preview` is what an operator asks BEFORE inviting anyone to click.
 *
 * Two properties are asserted here that no other doctor check has, and both
 * are the point of the command:
 *
 * 1. THE HOST IS ASKED, NOT THE CONTAINER. `docker inspect` answers "is this
 *    really gVisor?"; a process inside a sandbox can be told anything about
 *    its own sandbox, so a check that asked it would be asking the thing
 *    under test.
 * 2. THE PASSING RESULT IS A REFUSAL. A write that succeeded and a name that
 *    resolved are FAILURES. A probe that only proved a container starts would
 *    pass on a container with no isolation at all.
 *
 * The Docker seam is injected, so this suite diagnoses a machine it is not on
 * — including the two this repository cannot have at once: an engine with
 * runsc registered, and one without.
 */

const DIGEST = `atoma-preview@sha256:${'a'.repeat(64)}`;

const GATED_ENV = {
  ATOMA_VIZ_AUTH: '1',
  ATOMA_VIZ_PUBLIC_ORIGIN: 'https://atoma.example.com',
  ATOMA_AUTH_GITHUB_CLIENT_ID: 'id',
  ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'secret',
  ATOMA_PREVIEW: '1',
  ATOMA_PREVIEW_DOMAIN: 'previews.example.net',
  ATOMA_PREVIEW_IMAGE: DIGEST,
} as const;

interface EngineState {
  /** What `docker info` says the engine offers. */
  readonly runtimes: readonly string[];
  readonly imagePresent?: boolean;
  /** What `docker inspect` says the probe container ACTUALLY ran under. */
  readonly ranUnder?: string;
  readonly rootWritable?: boolean;
  readonly dnsResolves?: boolean;
  readonly startFails?: boolean;
}

function engine(state: EngineState): Partial<DoctorDependencies> {
  const commands: string[][] = [];
  return {
    nodeVersion: 'v22.14.0',
    platform: 'linux',
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (command !== 'docker') return { stdout: '', stderr: '' };
      if (args[0] === 'info') {
        return {
          stdout: JSON.stringify(Object.fromEntries(state.runtimes.map((n) => [n, {}]))),
          stderr: '',
        };
      }
      if (args[0] === 'image') {
        if (state.imagePresent === false) throw new Error('No such image');
        return { stdout: 'sha256:test\n', stderr: '' };
      }
      if (args[0] === 'run') {
        if (state.startFails) throw new Error('unknown or invalid runtime name');
        return { stdout: 'container-id\n', stderr: '' };
      }
      if (args[0] === 'inspect') {
        return { stdout: `${state.ranUnder ?? 'runsc'}\n`, stderr: '' };
      }
      if (args[0] === 'exec') {
        const script = args[args.length - 1] ?? '';
        if (script.includes('WROTE')) {
          return { stdout: state.rootWritable ? 'WROTE\n' : '', stderr: '' };
        }
        return { stdout: state.dnsResolves ? 'REACHED\n' : '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    fetchStatus: async () => ({ ok: true, status: 200 }),
    probeWorker: async () => ({ toolCount: 10 }),
    // Exposed for the cleanup assertion below.
    ...({ commands } as unknown as Partial<DoctorDependencies>),
  };
}

async function run(
  env: Record<string, string>,
  state: EngineState = { runtimes: ['runc', 'runsc'] }
): Promise<DoctorCheck[]> {
  const deps = engine(state) as DoctorDependencies;
  return diagnosePreview(env, deps);
}

function find(checks: readonly DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`no check "${id}" in ${checks.map((c) => c.id).join(', ')}`);
  return check;
}

describe('doctor --preview', () => {
  it('is opt-in and does not disturb the container/egress precedence', () => {
    expect(parseDoctorOptions([], {}).preview).toBe(false);
    expect(parseDoctorOptions(['--preview'], {}).preview).toBe(true);
    // It starts a real container, so it must never ride along on a bare
    // `npm run doctor`, and it must not imply a run mode either.
    expect(parseDoctorOptions(['--preview'], {}).mode).toEqual({
      container: false,
      egress: false,
    });
  });

  it('says nothing about a deployment that never asked for previews', async () => {
    const checks = await run({});

    expect(checks).toHaveLength(1);
    expect(find(checks, 'preview-config').status).toBe('pass');
    expect(find(checks, 'preview-config').detail).toBe('disabled');
  });

  it('warns rather than reporting "off" for HALF a configuration', async () => {
    // An operator who set the domain and the image but not the switch wanted
    // previews. Reading that as "disabled" tells them nothing at all.
    const checks = await run({ ATOMA_PREVIEW_DOMAIN: 'previews.example.net' });

    expect(find(checks, 'preview-config').status).toBe('warn');
  });

  it('refuses previews without the auth gate, which owns the organisations', async () => {
    const { ATOMA_VIZ_AUTH: _auth, ...ungated } = GATED_ENV;
    const checks = await run(ungated);

    const origin = find(checks, 'preview-origin');
    expect(origin.status).toBe('fail');
    expect(origin.detail).toContain('auth gate');
  });

  it('accepts a loopback origin, which IS a secure context, with a caveat', async () => {
    // WHAT MATTERS IS THE SECURE CONTEXT, not the scheme. The grant cookie is
    // set on the PREVIEW origin, which is https by construction; the
    // visualizer's own origin decides whether the browser keeps a partitioned
    // third-party cookie for the frame it embeds, and browsers treat loopback
    // as trustworthy. A check that failed here would tell an operator their
    // working development setup was broken.
    const checks = await run({ ...GATED_ENV, ATOMA_VIZ_PUBLIC_ORIGIN: 'http://localhost:5173' });

    const origin = find(checks, 'preview-origin');
    expect(origin.status).toBe('warn');
    expect(origin.detail).toContain('secure context');
    // And it still says what changes the moment anyone else is meant to reach it.
    expect(origin.remedy).toContain('HTTPS');
    // A warning must not sink the whole report.
    expect(checks.some((check) => check.id === 'preview-origin' && check.status === 'fail')).toBe(
      false
    );
  });

  it('passes an HTTPS origin without a caveat', async () => {
    const checks = await run(GATED_ENV);

    expect(find(checks, 'preview-origin').status).toBe('pass');
    expect(find(checks, 'preview-origin').remedy).toBeUndefined();
  });

  it('refuses a preview domain sharing a registrable domain with the visualizer', async () => {
    const checks = await run({
      ...GATED_ENV,
      ATOMA_PREVIEW_DOMAIN: 'previews.example.com',
    });

    const config = find(checks, 'preview-config');
    expect(config.status).toBe('fail');
    expect(config.detail).toContain('separate registrable domain');
  });

  it('reads the runtime list from the ENGINE, not from $PATH', async () => {
    // gVisor installed is not gVisor registered, and that gap is exactly what
    // a Docker Desktop machine hits: `runsc --version` works, `--runtime=runsc`
    // does not.
    const checks = await run(GATED_ENV, { runtimes: ['runc'] });

    const runtime = find(checks, 'preview-runtime');
    expect(runtime.status).toBe('fail');
    expect(runtime.detail).toContain('NOT registered');
    expect(runtime.remedy).toContain('Docker Desktop');
  });

  it('does not call an unprobed boundary a verified one', async () => {
    const checks = await run(GATED_ENV, { runtimes: ['runc', 'runsc'], imagePresent: false });

    expect(find(checks, 'preview-image').status).toBe('fail');
    const isolation = find(checks, 'preview-isolation');
    expect(isolation.status).toBe('fail');
    expect(isolation.detail).toContain('not probed');
  });

  it('passes only when the host confirms the runtime and BOTH probes are refused', async () => {
    const checks = await run(GATED_ENV);

    expect(checks.every((check) => check.status !== 'fail')).toBe(true);
    const isolation = find(checks, 'preview-isolation');
    expect(isolation.status).toBe('pass');
    expect(isolation.detail).toContain('refused');
  });

  it('fails when the engine ran the probe under a DIFFERENT runtime than asked', async () => {
    // The container is not asked what it is running under — it can be told
    // anything. This is the host's own answer disagreeing with the request.
    const checks = await run(GATED_ENV, { runtimes: ['runc', 'runsc'], ranUnder: 'runc' });

    const isolation = find(checks, 'preview-isolation');
    expect(isolation.status).toBe('fail');
    expect(isolation.detail).toContain('"runc"');
  });

  it('fails on a writable root filesystem', async () => {
    const checks = await run(GATED_ENV, { runtimes: ['runc', 'runsc'], rootWritable: true });

    expect(find(checks, 'preview-isolation').status).toBe('fail');
    expect(find(checks, 'preview-isolation').detail).toContain('accepted a write');
  });

  it('fails when a container with no network resolves a name', async () => {
    const checks = await run(GATED_ENV, { runtimes: ['runc', 'runsc'], dnsResolves: true });

    expect(find(checks, 'preview-isolation').status).toBe('fail');
    expect(find(checks, 'preview-isolation').detail).toContain('DNS resolved');
  });

  it('reports a probe that would not start, rather than a pass', async () => {
    const checks = await run(GATED_ENV, { runtimes: ['runc', 'runsc'], startFails: true });

    const isolation = find(checks, 'preview-isolation');
    expect(isolation.status).toBe('fail');
    expect(isolation.detail).toContain('would not start');
  });

  it('always removes its probe container, including after a finding', async () => {
    const seen: string[][] = [];
    const deps = {
      ...engine({ runtimes: ['runc', 'runsc'], rootWritable: true }),
      runCommand: async (command: string, args: readonly string[]) => {
        seen.push([command, ...args]);
        const inner = engine({ runtimes: ['runc', 'runsc'], rootWritable: true });
        return inner.runCommand!(command, args);
      },
    } as DoctorDependencies;

    await diagnosePreview(GATED_ENV, deps);

    // A leaked probe is an operator annoyance; a probe that leaks because the
    // finding threw is a finding nobody sees.
    expect(seen.some((call) => call[1] === 'rm' && call[2] === '--force')).toBe(true);
  });

  it('warns, and does not fail, on the loud development runtime', async () => {
    const { ATOMA_VIZ_AUTH: _auth, ATOMA_VIZ_PUBLIC_ORIGIN: _origin, ...ungated } = GATED_ENV;
    const checks = await run(
      { ...ungated, ATOMA_PREVIEW_RUNTIME: 'runc', ATOMA_PREVIEW_ALLOW_RUNC_DEV: '1' },
      { runtimes: ['runc'] }
    );

    const config = find(checks, 'preview-config');
    expect(config.status).toBe('warn');
    expect(config.remedy).toContain('production requires runsc');
    // The runtime check follows the CONFIG, so an escape hatch that the engine
    // does offer is not also reported as a missing runtime.
    expect(find(checks, 'preview-runtime').status).toBe('pass');
  });
});
