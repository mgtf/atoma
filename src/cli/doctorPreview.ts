import { randomBytes } from 'node:crypto';
import {
  PREVIEW_ENV,
  previewConfigPresent,
  previewEnabled,
  snapshotPreviewConfig,
} from '../preview/config.js';
import { authPublicOrigin, vizAuthEnabled } from '../auth/gate.js';
import { isLoopbackOrigin } from '../auth/providers.js';
import type { DoctorCheck, DoctorDependencies } from './doctor.js';

/**
 * `doctor --preview` — CAN THIS DEPLOYMENT SERVE PREVIEWS?
 *
 * A preview runs model-authored code on hardware an operator owns, reachable
 * from a browser they invited people into. Every precondition below is one a
 * deployment either has or does not, and the whole point of asking here is to
 * be told BEFORE a member clicks rather than after.
 *
 * TWO THINGS THIS DOES DIFFERENTLY FROM THE REST OF DOCTOR:
 *
 * 1. IT INSPECTS A REAL CONTAINER FROM THE HOST. `docker inspect` on a unit we
 *    started is the only trustworthy answer to "is this actually gVisor?" — a
 *    process inside a sandbox can be told anything about its own sandbox, so a
 *    check that asked the container would be asking the thing under test.
 * 2. IT PROBES ADVERSARIALLY. Reaching the control plane must FAIL and the
 *    root filesystem must be READ-ONLY, so the passing result is the refusal.
 *    A smoke that only proved a container starts would pass on a container
 *    with no isolation at all.
 *
 * Quota-free, like the rest of doctor: nothing here calls a model.
 */

/** Long enough for an image pull-less start on a cold engine, short enough to fail. */
const PREVIEW_PROBE_TIMEOUT_MS = 20_000;

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Is the deployment even asking for previews?
 *
 * HALF A CONFIGURATION IS NOT "OFF". `previewConfigPresent` is what separates
 * an operator who never wanted this from one who set four variables of six and
 * would otherwise be told nothing at all.
 */
function checkConfig(env: NodeJS.ProcessEnv): DoctorCheck[] {
  let enabled: boolean;
  try {
    enabled = previewEnabled(env);
  } catch (error) {
    return [
      {
        id: 'preview-config',
        label: 'Preview configuration',
        status: 'fail',
        detail: detailOf(error),
        remedy: `Set ${PREVIEW_ENV.enabled} to 0, false, 1 or true.`,
      },
    ];
  }
  if (!enabled) {
    return [
      {
        id: 'preview-config',
        label: 'Preview configuration',
        status: previewConfigPresent(env) ? 'warn' : 'pass',
        detail: previewConfigPresent(env)
          ? `disabled, but ${PREVIEW_ENV.enabled} is unset while other preview variables are set`
          : 'disabled',
        ...(previewConfigPresent(env)
          ? { remedy: `Set ${PREVIEW_ENV.enabled}=1 to enable previews, or remove the other ${PREVIEW_ENV.enabled.split('_')[0]}_PREVIEW_* variables.` }
          : {}),
      },
    ];
  }

  // The gate is a PRECONDITION, not a companion setting: a preview belongs to
  // an organisation's run, and there are no organisations without the gate.
  const gated = vizAuthEnabled(env);
  const checks: DoctorCheck[] = [];
  let visualizerOrigin: string | undefined;
  if (gated) {
    try {
      const origin = authPublicOrigin(env);
      visualizerOrigin = origin.origin;
      // WHAT ACTUALLY MATTERS IS A SECURE CONTEXT, not the scheme.
      //
      // The grant cookie is `__Host-` + `Secure` + `SameSite=None` +
      // `Partitioned`, and it is set on the PREVIEW origin, which is always
      // https by construction. What the visualizer's own origin decides is
      // whether the browser will keep a partitioned third-party cookie for the
      // frame it embeds — and browsers treat loopback as trustworthy, so
      // `http://127.0.0.1` works while `http://atoma.internal` would not.
      //
      // The gate itself already refuses remote plain HTTP, so the third case
      // is defensive rather than reachable. Saying it out loud is still worth
      // a line: this is the check an operator reads when previews 404 with
      // nothing in the logs.
      const secure = origin.origin.startsWith('https://');
      const trustworthy = secure || isLoopbackOrigin(origin.origin);
      checks.push({
        id: 'preview-origin',
        label: 'Preview public origin',
        status: secure ? 'pass' : trustworthy ? 'warn' : 'fail',
        detail: secure
          ? `visualizer on ${origin.origin}`
          : trustworthy
            ? `visualizer on ${origin.origin} — a secure context because it is loopback, so the preview grant cookie is kept`
            : `visualizer on ${origin.origin}, which is neither HTTPS nor loopback`,
        ...(secure
          ? {}
          : trustworthy
            ? {
                remedy:
                  'Fine for one machine. Any deployment other people reach needs HTTPS, or the browser drops the partitioned grant cookie and every preview 404s.',
              }
            : {
                remedy:
                  'Serve the visualizer over HTTPS. Outside loopback a plain-HTTP page is not a secure context, so the browser will not keep the preview grant cookie.',
              }),
      });
    } catch (error) {
      checks.push({
        id: 'preview-origin',
        label: 'Preview public origin',
        status: 'fail',
        detail: detailOf(error),
        remedy: 'Set ATOMA_VIZ_PUBLIC_ORIGIN to the origin members actually reach.',
      });
    }
  } else {
    checks.push({
      id: 'preview-origin',
      label: 'Preview public origin',
      status: 'fail',
      detail: 'the visualizer auth gate is off, so there are no organisations to own a preview',
      remedy: 'Enable ATOMA_VIZ_AUTH, or disable previews.',
    });
  }

  try {
    const config = snapshotPreviewConfig(env, visualizerOrigin ? { visualizerOrigin } : {});
    checks.unshift({
      id: 'preview-config',
      label: 'Preview configuration',
      status: config.runtime === 'runsc' ? 'pass' : 'warn',
      detail:
        `enabled · *.${config.domain} · ${config.runtime} · ` +
        `${config.maxGlobal} global / ${config.maxPerOrg} per org · ` +
        `idle ${Math.round(config.idleMs / 1000)}s, hard ${Math.round(config.hardMs / 1000)}s`,
      ...(config.runtime === 'runsc'
        ? {}
        : {
            remedy:
              'This is the development escape hatch. runc is not the boundary previews promise a tenant; production requires runsc.',
          }),
    });
  } catch (error) {
    checks.unshift({
      id: 'preview-config',
      label: 'Preview configuration',
      status: 'fail',
      detail: detailOf(error),
      remedy: 'Correct the ATOMA_PREVIEW_* variables; there is no partial preview mode.',
    });
  }
  return checks;
}

/**
 * Is the runtime the config names actually registered with this engine?
 *
 * `docker info` is the ENGINE's own list. `runsc` present on `$PATH` proves
 * only that gVisor is installed, not that Docker will accept `--runtime=runsc`
 * — and that gap is exactly what a developer machine hits.
 */
async function checkRuntime(
  runtime: string,
  deps: DoctorDependencies
): Promise<DoctorCheck> {
  try {
    const { stdout } = await deps.runCommand(
      'docker',
      ['info', '--format', '{{json .Runtimes}}'],
      { timeoutMs: 8_000 }
    );
    let names: string[] = [];
    try {
      names = Object.keys(JSON.parse(stdout.trim() || '{}') as Record<string, unknown>);
    } catch {
      names = [];
    }
    const registered = names.includes(runtime);
    return {
      id: 'preview-runtime',
      label: 'Preview container runtime',
      status: registered ? 'pass' : 'fail',
      detail: registered
        ? `${runtime} is registered · engine offers ${names.sort().join(', ')}`
        : `${runtime} is NOT registered · engine offers ${names.sort().join(', ') || 'nothing'}`,
      ...(registered
        ? {}
        : {
            remedy:
              'Install gVisor and register it: `runsc install` then restart the Docker daemon. Docker Desktop cannot register an alternative runtime — use a Linux host or VM.',
          }),
    };
  } catch (error) {
    return {
      id: 'preview-runtime',
      label: 'Preview container runtime',
      status: 'fail',
      detail: `engine unreachable · ${detailOf(error)}`,
      remedy: 'Start Docker, then re-run `npm run doctor -- --preview`.',
    };
  }
}

/** The image must be present AND pinned to the digest the config named. */
async function checkImage(image: string, deps: DoctorDependencies): Promise<DoctorCheck> {
  try {
    await deps.runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: 8_000,
    });
    return {
      id: 'preview-image',
      label: 'Preview image',
      status: 'pass',
      detail: `${image} is present`,
    };
  } catch {
    return {
      id: 'preview-image',
      label: 'Preview image',
      status: 'fail',
      detail: `${image} is not installed`,
      remedy:
        'Pull or build the preview image and pin it by digest. A preview never pulls at open time — a member’s click is not the moment to go to a registry.',
    };
  }
}

/**
 * THE ADVERSARIAL PROBE. It starts one real container under the configured
 * runtime and asserts three things, of which two are refusals:
 *
 * 1. the HOST says `.HostConfig.Runtime` is what we asked for — asked of
 *    Docker, never of the container, which could be told anything;
 * 2. the root filesystem REFUSES a write;
 * 3. the network REFUSES to resolve or reach anything.
 *
 * A probe that only proved a container starts would pass on a container with
 * no isolation at all, which is the failure this exists to catch.
 */
async function probeIsolation(
  image: string,
  runtime: string,
  deps: DoctorDependencies
): Promise<DoctorCheck> {
  const name = `atoma-doctor-preview-${randomBytes(6).toString('hex')}`;
  const findings: string[] = [];
  try {
    try {
      await deps.runCommand(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          name,
          `--runtime=${runtime}`,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '256m',
          '--pids-limit',
          '128',
          '--entrypoint',
          'sleep',
          image,
          '20',
        ],
        { timeoutMs: PREVIEW_PROBE_TIMEOUT_MS }
      );
    } catch (error) {
      return {
        id: 'preview-isolation',
        label: 'Preview isolation',
        status: 'fail',
        detail: `the probe container would not start · ${detailOf(error)}`,
        remedy: `Confirm the engine accepts --runtime=${runtime} for ${image}.`,
      };
    }

    // 1. THE HOST'S ANSWER, not the container's.
    const inspected = await deps.runCommand(
      'docker',
      ['inspect', '--format', '{{.HostConfig.Runtime}}', name],
      { timeoutMs: 8_000 }
    );
    const actual = inspected.stdout.trim();
    if (actual !== runtime) {
      findings.push(`the engine ran it under "${actual}", not ${runtime}`);
    }

    // 2. THE ROOT FILESYSTEM MUST REFUSE A WRITE.
    const wrote = await deps
      .runCommand('docker', ['exec', name, 'sh', '-c', 'echo x > /probe 2>/dev/null && echo WROTE'], {
        timeoutMs: 8_000,
      })
      .then((result) => result.stdout.includes('WROTE'))
      .catch(() => false);
    if (wrote) findings.push('the root filesystem accepted a write');

    // 3. THE NETWORK MUST REFUSE. `--network none` leaves loopback only, so a
    // reachable outside address means the container is not on the network the
    // profile asked for.
    const reached = await deps
      .runCommand(
        'docker',
        ['exec', name, 'sh', '-c', 'getent hosts example.com >/dev/null 2>&1 && echo REACHED'],
        { timeoutMs: 8_000 }
      )
      .then((result) => result.stdout.includes('REACHED'))
      .catch(() => false);
    if (reached) findings.push('DNS resolved from a container that should have no network');

    return findings.length === 0
      ? {
          id: 'preview-isolation',
          label: 'Preview isolation',
          status: 'pass',
          detail: `${runtime} confirmed by the host · root filesystem and network both refused`,
        }
      : {
          id: 'preview-isolation',
          label: 'Preview isolation',
          status: 'fail',
          detail: findings.join(' · '),
          remedy:
            'Do not serve previews from this host. Each finding is a boundary the design assumes and this engine did not provide.',
        };
  } catch (error) {
    return {
      id: 'preview-isolation',
      label: 'Preview isolation',
      status: 'fail',
      detail: detailOf(error),
      remedy: 'Re-run with Docker reachable; an unfinished probe is not a pass.',
    };
  } finally {
    // Best effort, and deliberately silent: a leaked probe container is an
    // operator annoyance, while a thrown error here would hide the finding
    // this function exists to report.
    await deps.runCommand('docker', ['rm', '--force', name], { timeoutMs: 8_000 }).catch(() => {});
  }
}

/**
 * Every preview precondition, in the order a failure makes the rest moot.
 *
 * Configuration and origin are answered offline; the engine checks run only
 * once the configuration resolved, because probing a runtime nobody named is
 * measuring the wrong machine.
 */
export async function diagnosePreview(
  env: NodeJS.ProcessEnv,
  deps: DoctorDependencies
): Promise<DoctorCheck[]> {
  const checks = checkConfig(env);
  if (checks.some((check) => check.id === 'preview-config' && check.status === 'fail')) {
    return checks;
  }
  let config;
  try {
    config = previewEnabled(env) ? snapshotPreviewConfig(env) : null;
  } catch {
    return checks;
  }
  if (!config) return checks;

  checks.push(await checkRuntime(config.runtime, deps));
  const image = await checkImage(config.image, deps);
  checks.push(image);
  if (
    image.status === 'pass' &&
    checks.find((check) => check.id === 'preview-runtime')?.status === 'pass'
  ) {
    checks.push(await probeIsolation(config.image, config.runtime, deps));
  } else {
    checks.push({
      id: 'preview-isolation',
      label: 'Preview isolation',
      status: 'fail',
      detail: 'not probed, because the runtime or the image is missing',
      remedy: 'Fix the checks above; an unprobed boundary is not a verified one.',
    });
  }
  return checks;
}
