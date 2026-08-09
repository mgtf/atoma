/**
 * What a containerised run is allowed to reach.
 *
 * The run itself sits on a `--internal` docker network with no route
 * anywhere; this policy is enforced by the ONE peer it can reach, the egress
 * proxy. So this file is the whole boundary between "the run can fetch its
 * dependencies" and "the run can call the control plane" — measured:
 * a default `bridge` network reaches `host.docker.internal`, which is the
 * same reachability that made an HTTP-served launch token worthless.
 *
 * DEFAULT DENY, and deliberately not configurable by the run: the allowlist
 * is supplied by the operator when the container is created, and nothing
 * inside the container can widen it.
 */

/** Destinations every run may reach. Package registries only, by default. */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'registry.npmjs.org',
  '.npmjs.org',
  'registry.yarnpkg.com',
];

export interface EgressDecision {
  readonly allowed: boolean;
  readonly host: string;
  readonly port: number;
  readonly reason: string;
}

/**
 * Split a proxy target into host and port.
 *
 * Accepts the two shapes a proxy actually receives: `host:port` from a
 * CONNECT line, and an absolute URL from a plain-HTTP request line. Returns
 * null on anything else rather than guessing — an unparseable target is
 * denied, never interpreted.
 */
export function parseTarget(raw: string, defaultPort: number): { host: string; port: number } | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      if (!u.hostname || !Number.isInteger(port)) return null;
      return { host: u.hostname.toLowerCase(), port };
    } catch {
      return null;
    }
  }
  // `host:port` — rightmost colon, so IPv6 literals do not split wrongly.
  const i = s.lastIndexOf(':');
  if (i <= 0) return { host: s.toLowerCase(), port: defaultPort };
  const host = s.slice(0, i).toLowerCase();
  const port = Number(s.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Does `host` match one allowlist entry?
 *
 * Two forms only, both anchored so no prefix trick works:
 *   `registry.npmjs.org` — exactly that host
 *   `.npmjs.org`         — that domain and its subdomains
 *
 * The attack this shape exists to refuse is `registry.npmjs.org.evil.com`,
 * which a naive `includes()` or unanchored regex would allow. It is also why
 * a bare `npmjs.org` entry does NOT imply its subdomains: widening has to be
 * written down, never inferred.
 */
export function hostMatchesEntry(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ''); // a trailing dot is the same name
  const e = entry.toLowerCase().replace(/\.$/, '');
  if (!h || !e) return false;
  if (e.startsWith('.')) {
    const domain = e.slice(1);
    return h === domain || h.endsWith(`.${domain}`);
  }
  return h === e;
}

/**
 * IP literals are never implicitly allowed.
 *
 * An allowlist is a list of NAMES; a run asking for `192.168.1.5:80` or
 * `[::1]:4111` is not asking for a dependency, it is probing the network the
 * proxy sits on — which is the one place the proxy can reach and the run
 * cannot. Denying literals outright means a mis-typed allowlist entry cannot
 * accidentally open a subnet.
 */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  return h.includes(':'); // IPv6 — a hostname can never contain a colon here
}

/**
 * Ports egress may use. 80/443 by default — a run asking for 5432 or 4111 is
 * not fetching a dependency, it is probing the network the proxy sits on.
 * Configurable because a private registry on a non-standard port is a real
 * deployment, and because a test needs an ephemeral one; the DEFAULT stays
 * strict, which is what matters.
 */
export const DEFAULT_EGRESS_PORTS: readonly number[] = [80, 443];

export function decideEgress(
  target: string,
  opts: { allowlist?: readonly string[]; defaultPort?: number; allowedPorts?: readonly number[] } = {}
): EgressDecision {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const allowedPorts = opts.allowedPorts ?? DEFAULT_EGRESS_PORTS;
  const parsed = parseTarget(target, opts.defaultPort ?? 443);
  if (!parsed) return { allowed: false, host: target, port: 0, reason: 'unparseable target' };
  const { host, port } = parsed;
  if (isIpLiteral(host)) {
    return { allowed: false, host, port, reason: 'IP literals are never allowed — allowlist names only' };
  }
  if (!allowedPorts.includes(port)) {
    return { allowed: false, host, port, reason: `port ${port} not allowed (${allowedPorts.join('/')} only)` };
  }
  const hit = allowlist.find((e) => hostMatchesEntry(host, e));
  return hit
    ? { allowed: true, host, port, reason: `matched allowlist entry "${hit}"` }
    : { allowed: false, host, port, reason: 'not in the egress allowlist' };
}
