import { previewRuntimeSchema, type PreviewRuntime } from '../contracts/preview.js';
import { isLoopbackHost, isLoopbackOrigin } from '../auth/providers.js';

/**
 * WHAT A DEPLOYMENT MUST STATE BEFORE IT MAY RUN PREVIEWS.
 *
 * Resolved ONCE, from the host environment, and every precondition is checked
 * together: there is no partial insecure mode. The shape follows
 * `snapshotGitHubAppConfig` — one snapshot, read at boot, so a single process
 * can never mix two generations of configuration — and the tri-state boolean
 * follows `vizAuthEnabled`, which refuses a value it does not recognise rather
 * than treating it as off.
 *
 * HALF A CONFIGURATION IS A HARD FAILURE, not a silent "disabled". Any
 * preview-specific variable arms the check; a deployment that set four of the
 * six wanted previews and would otherwise be told nothing.
 */

export const PREVIEW_ENV = {
  enabled: 'ATOMA_PREVIEW',
  domain: 'ATOMA_PREVIEW_DOMAIN',
  gatewayHost: 'ATOMA_PREVIEW_GATEWAY_HOST',
  gatewayPort: 'ATOMA_PREVIEW_GATEWAY_PORT',
  image: 'ATOMA_PREVIEW_IMAGE',
  runtime: 'ATOMA_PREVIEW_RUNTIME',
  allowRuncDev: 'ATOMA_PREVIEW_ALLOW_RUNC_DEV',
  allowHttpDev: 'ATOMA_PREVIEW_ALLOW_HTTP_DEV',
  maxGlobal: 'ATOMA_PREVIEW_MAX_GLOBAL',
  maxPerOrg: 'ATOMA_PREVIEW_MAX_PER_ORG',
  idleMs: 'ATOMA_PREVIEW_IDLE_MS',
  hardMs: 'ATOMA_PREVIEW_HARD_MS',
  copyMaxBytes: 'ATOMA_PREVIEW_COPY_MAX_BYTES',
} as const;

export const PREVIEW_DEFAULTS = {
  maxGlobal: 4,
  maxPerOrg: 2,
  idleMs: 900_000,
  hardMs: 7_200_000,
  copyMaxBytes: 536_870_912,
} as const;

export interface PreviewConfig {
  readonly domain: string;
  /**
   * The scheme a preview URL is built with. `https` everywhere except the
   * loopback development profile below, and never a caller's choice.
   */
  readonly publicScheme: 'https' | 'http';
  /**
   * The port a browser reaches the gateway on, when it is not the default for
   * `publicScheme`. Null in production, where a proxy terminates on 443.
   */
  readonly publicPort: number | null;
  readonly gatewayHost: string;
  readonly gatewayPort: number;
  readonly image: string;
  readonly runtime: PreviewRuntime;
  readonly maxGlobal: number;
  readonly maxPerOrg: number;
  readonly idleMs: number;
  readonly hardMs: number;
  readonly copyMaxBytes: number;
}

export class PreviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewConfigError';
  }
}

/** The same tri-state discipline as the auth gate: an unknown value throws. */
export function previewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PREVIEW_ENV.enabled];
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new PreviewConfigError(`${PREVIEW_ENV.enabled} must be one of: 0, false, 1, true`);
}

/** Is ANY preview variable present? Half a configuration must not read as off. */
export function previewConfigPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.values(PREVIEW_ENV).some((name) => env[name] !== undefined);
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new PreviewConfigError(`${name} is required when ${PREVIEW_ENV.enabled}=1`);
  return value;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  // REFUSES rather than falls back. A deployment that asked for a two-hour
  // idle bound and silently got fifteen minutes is the same defect the
  // project-run timeout records, wearing a different hat.
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PreviewConfigError(`${name}="${raw}" is not an integer in ${min}..${max}`);
  }
  return parsed;
}

const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The lowest two labels of a host — a deliberately CONSERVATIVE stand-in for
 * the registrable domain.
 *
 * A correct answer needs the Public Suffix List, and taking that dependency is
 * its own decision. Two labels over-groups multi-label suffixes (`co.uk`), and
 * over-grouping makes this check refuse MORE configurations than strictly
 * necessary — which is the safe direction for a check whose whole job is to
 * keep a session cookie away from generated code.
 */
export function conservativeRegistrableDomain(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');
}

/**
 * Do the visualizer and the previews share a registrable domain?
 *
 * THE ORIGIN IS THE ASSET. The session cookie is host-only, so it is never
 * sent to a preview host — but a shared registrable domain puts generated code
 * within reach of cookie-scoping tricks and same-site assumptions the design
 * relies on. Refused at boot, where it is a configuration mistake, rather than
 * discovered as a security property nobody has.
 */
export function previewDomainCollides(previewDomain: string, visualizerOrigin: string): boolean {
  let visualizerHost: string;
  try {
    visualizerHost = new URL(visualizerOrigin).hostname;
  } catch {
    // An unparseable origin is not proof of safety.
    return true;
  }
  const preview = previewDomain.toLowerCase().replace(/\.$/, '');
  const visualizer = visualizerHost.toLowerCase().replace(/\.$/, '');
  if (preview === visualizer) return true;
  if (preview.endsWith(`.${visualizer}`) || visualizer.endsWith(`.${preview}`)) return true;
  return conservativeRegistrableDomain(preview) === conservativeRegistrableDomain(visualizer);
}

/**
 * Resolve every preview input at once, or refuse.
 *
 * `visualizerOrigin` is passed rather than read here: the auth gate owns that
 * value, and one origin resolved twice is one origin that can disagree with
 * itself. Omit it only where there is no gate — the domain-separation check is
 * then not applicable, and the caller is on the developer path.
 */
export function snapshotPreviewConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly visualizerOrigin?: string } = {}
): PreviewConfig {
  const domain = requiredText(env, PREVIEW_ENV.domain).toLowerCase().replace(/\.$/, '');
  if (!DNS_NAME.test(domain)) {
    throw new PreviewConfigError(`${PREVIEW_ENV.domain} must be a dotted DNS name`);
  }
  if (options.visualizerOrigin && previewDomainCollides(domain, options.visualizerOrigin)) {
    throw new PreviewConfigError(
      `${PREVIEW_ENV.domain} must be a separate registrable domain from the visualizer origin; ` +
        'previews serve model-authored code and must never share an origin family with the session cookie'
    );
  }

  const image = requiredText(env, PREVIEW_ENV.image);
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new PreviewConfigError(
      `${PREVIEW_ENV.image} must be pinned by digest (name@sha256:...); a mutable tag is not an identity`
    );
  }

  const requestedRuntime = env[PREVIEW_ENV.runtime]?.trim() || 'runsc';
  const runtimeParsed = previewRuntimeSchema.safeParse(requestedRuntime);
  if (!runtimeParsed.success) {
    throw new PreviewConfigError(`${PREVIEW_ENV.runtime} must be runsc or runc`);
  }
  const runtime = runtimeParsed.data;
  // Read here rather than at the bottom: the carve-out below is about where
  // the gateway LISTENS, so the value has to exist before the decision.
  const gatewayHost = env[PREVIEW_ENV.gatewayHost]?.trim() || '127.0.0.1';
  const gatewayPort = boundedInteger(env, PREVIEW_ENV.gatewayPort, 4_311, 1, 65_535);
  if (runtime !== 'runsc') {
    // THE LOUD DEV-ONLY ESCAPE HATCH, and it stays loud: `runsc` is still the
    // default, `runc` still needs this flag written out, and NOTHING ever
    // falls back to `runc` when `runsc` is missing — that failure surfaces as
    // a refusal to start, not as a weaker sandbox.
    if (env[PREVIEW_ENV.allowRuncDev] !== '1') {
      throw new PreviewConfigError(
        `${PREVIEW_ENV.runtime}=${runtime} requires ${PREVIEW_ENV.allowRuncDev}=1; production requires gVisor and there is no silent fallback`
      );
    }
    // WHAT CHANGED, AND WHY IT IS NOT A WEAKENING.
    //
    // The rule this enforces is "a deployment with TENANTS never gets `runc`",
    // and the original test for that was "is the auth gate on?". That test was
    // too coarse in one direction and it made the hatch UNREACHABLE: previews
    // REQUIRE the gate, so `runc` was refused everywhere, on every machine —
    // including the one-person laptop the hatch exists for. A developer whose
    // engine cannot register gVisor (Docker Desktop cannot) had no way to run
    // the feature at all.
    //
    // The sharper test is REACHABILITY, and a loopback public origin settles
    // it: the session is what gates a claim, a claim is the only way to reach
    // a preview origin, and a session can only be obtained by completing an
    // OAuth round trip against THAT origin. An origin nobody else can resolve
    // is an origin nobody else can log in to, so there are no other tenants to
    // hand a weaker sandbox to. The gateway's own bind is checked as well, so
    // the isolate is not listening on a public interface either.
    //
    // An HTTPS origin, a LAN address, any public hostname, or a gateway bound
    // to 0.0.0.0 still throws. This is the same loopback exemption the auth
    // gate and the provider registry already make, using their definition.
    const reachableGate =
      options.visualizerOrigin !== undefined &&
      !(isLoopbackOrigin(options.visualizerOrigin) && isLoopbackHost(gatewayHost));
    if (reachableGate) {
      throw new PreviewConfigError(
        `${PREVIEW_ENV.allowRuncDev} refuses to boot behind a REACHABLE auth gate ` +
          `(origin ${options.visualizerOrigin}, gateway ${gatewayHost}): it is a development ` +
          'escape hatch for a single-operator machine, never a production fallback'
      );
    }
  }

  /**
   * THE LOOPBACK DEVELOPMENT PROFILE: previews over plain HTTP.
   *
   * It exists because the production shape needs wildcard DNS, a wildcard
   * certificate and a reverse proxy trusted by the operating system — three
   * pieces of administrator-level setup between a developer and looking at
   * their own result.
   *
   * WHY IT IS SOUND, and it is a browser rule rather than our opinion: W3C
   * Secure Contexts makes any host that is `localhost` or ends in `.localhost`
   * POTENTIALLY TRUSTWORTHY. So the grant cookie keeps EVERY attribute it has
   * in production — `__Host-`, `Secure`, `SameSite=None`, `Partitioned` — and
   * the browser still stores and returns it, inside the cross-site iframe,
   * over http. Measured in Chrome 152 rather than reasoned about: the frame
   * reported `isSecureContext === true` and the cookie survived the bootstrap
   * page's `location.replace('/')`. Browsers resolve the family to loopback
   * themselves (RFC 6761 reserves it, so no registrar can ever sell one),
   * which is what removes the DNS half too.
   *
   * WHAT IT COSTS, stated rather than glossed: the claim secret travels as a
   * cleartext POST body and the grant rides every request in the clear. That
   * is the exposure already accepted for the visualizer's own
   * `http://127.0.0.1:5173`, extended to one more loopback port on the same
   * machine. `Secure` becomes a guarantee about the cookie's SHAPE, not about
   * the wire.
   *
   * FOUR CONDITIONS, ALL OF THEM, and it throws rather than falling back —
   * the same loudness as the `runc` hatch above, because two shapes for
   * "dev-only relaxation" is one concept with two definitions:
   *
   *   1. the flag, written out exactly;
   *   2. a `.localhost` domain, which is the part browsers make trustworthy;
   *   3. a visualizer origin that is PRESENT and loopback — present matters,
   *      because an absent origin is the ungated caller and must not qualify;
   *   4. a gateway bound to loopback, so the isolate is not on a public
   *      interface even if something else is.
   */
  const wantsHttp = env[PREVIEW_ENV.allowHttpDev] === '1';
  if (wantsHttp) {
    const reasons: string[] = [];
    if (!domain.endsWith('.localhost')) {
      reasons.push(`${PREVIEW_ENV.domain}="${domain}" is not under .localhost`);
    }
    if (options.visualizerOrigin === undefined) {
      reasons.push('there is no visualizer origin to prove this deployment is loopback');
    } else if (!isLoopbackOrigin(options.visualizerOrigin)) {
      reasons.push(`the visualizer origin ${options.visualizerOrigin} is not loopback`);
    }
    if (!isLoopbackHost(gatewayHost)) {
      reasons.push(`${PREVIEW_ENV.gatewayHost}="${gatewayHost}" is not loopback`);
    }
    if (reasons.length > 0) {
      throw new PreviewConfigError(
        `${PREVIEW_ENV.allowHttpDev}=1 serves previews in cleartext and is for a single ` +
          `machine only, so it refuses this deployment: ${reasons.join('; ')}`
      );
    }
  }

  const maxGlobal = boundedInteger(env, PREVIEW_ENV.maxGlobal, PREVIEW_DEFAULTS.maxGlobal, 1, 64);
  const maxPerOrg = boundedInteger(env, PREVIEW_ENV.maxPerOrg, PREVIEW_DEFAULTS.maxPerOrg, 1, 64);
  if (maxPerOrg > maxGlobal) {
    // A per-org cap above the global one is a cap that never applies, and an
    // operator who wrote it meant something the deployment cannot do.
    throw new PreviewConfigError(
      `${PREVIEW_ENV.maxPerOrg} (${maxPerOrg}) cannot exceed ${PREVIEW_ENV.maxGlobal} (${maxGlobal})`
    );
  }
  const idleMs = boundedInteger(env, PREVIEW_ENV.idleMs, PREVIEW_DEFAULTS.idleMs, 60_000, 3_600_000);
  const hardMs = boundedInteger(
    env,
    PREVIEW_ENV.hardMs,
    PREVIEW_DEFAULTS.hardMs,
    300_000,
    28_800_000
  );
  if (idleMs >= hardMs) {
    // The idle bound would never fire, so a preview nobody is watching would
    // live to its hard expiry — the opposite of what both settings exist for.
    throw new PreviewConfigError(
      `${PREVIEW_ENV.idleMs} (${idleMs}) must be shorter than ${PREVIEW_ENV.hardMs} (${hardMs})`
    );
  }

  return {
    domain,
    gatewayHost,
    gatewayPort,
    publicScheme: wantsHttp ? 'http' : 'https',
    // In production a proxy terminates on 443 and the origin carries no port.
    // In the dev profile the browser talks to the gateway directly, so the
    // port it listens on IS part of the origin.
    publicPort: wantsHttp ? gatewayPort : null,
    image,
    runtime,
    maxGlobal,
    maxPerOrg,
    idleMs,
    hardMs,
    copyMaxBytes: boundedInteger(
      env,
      PREVIEW_ENV.copyMaxBytes,
      PREVIEW_DEFAULTS.copyMaxBytes,
      1_048_576,
      8_589_934_592
    ),
  };
}
