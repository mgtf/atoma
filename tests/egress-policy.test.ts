import { describe, it, expect } from 'vitest';
import {
  decideEgress,
  hostMatchesEntry,
  isIpLiteral,
  parseTarget,
  DEFAULT_EGRESS_ALLOWLIST,
} from '../src/tools/egressPolicy.js';

/**
 * This policy IS the boundary between "the run can fetch a dependency" and
 * "the run can call the control plane". The run sits on a --internal docker
 * network with no route anywhere; the proxy is the single peer it can reach,
 * and the proxy asks this file. So these tests are written as bypass
 * ATTEMPTS, not as happy paths — a policy that only proves it says yes to
 * npm has proven nothing.
 *
 * Measured motivation: on a default bridge network a container reaches
 * host.docker.internal, which is the same reachability that made an
 * HTTP-served launch token worthless (docs/saas-architecture.md §4).
 */

// On 4111 AND on 443: the port rule and the allowlist both deny the control
// plane, and a test that only uses 4111 cannot tell which one is doing the
// work. Isolating them matters — if the deployment ever moves the control
// plane behind 443, the port rule stops helping and the allowlist is alone.
const CONTROL_PLANE = [
  'host.docker.internal:4111',
  'localhost:4111',
  '127.0.0.1:4111',
  'host.docker.internal:443',
  'localhost:443',
];

describe('hostMatchesEntry — anchoring is the whole point', () => {
  it('matches an exact host', () => {
    expect(hostMatchesEntry('registry.npmjs.org', 'registry.npmjs.org')).toBe(true);
  });

  it('REFUSES the suffix-confusion attack', () => {
    // The classic: a name that merely CONTAINS the allowed one.
    expect(hostMatchesEntry('registry.npmjs.org.evil.com', 'registry.npmjs.org')).toBe(false);
    expect(hostMatchesEntry('registry.npmjs.org.evil.com', '.npmjs.org')).toBe(false);
    expect(hostMatchesEntry('notregistry.npmjs.org', 'registry.npmjs.org')).toBe(false);
    expect(hostMatchesEntry('evil-registry.npmjs.org.attacker.net', '.npmjs.org')).toBe(false);
  });

  it('a dot-prefixed entry covers the domain and its subdomains, nothing else', () => {
    expect(hostMatchesEntry('npmjs.org', '.npmjs.org')).toBe(true);
    expect(hostMatchesEntry('registry.npmjs.org', '.npmjs.org')).toBe(true);
    expect(hostMatchesEntry('a.b.npmjs.org', '.npmjs.org')).toBe(true);
    expect(hostMatchesEntry('npmjs.org.co', '.npmjs.org')).toBe(false);
  });

  it('a bare entry does NOT imply its subdomains — widening must be written', () => {
    expect(hostMatchesEntry('registry.npmjs.org', 'npmjs.org')).toBe(false);
  });

  it('is case-insensitive and tolerates the FQDN trailing dot', () => {
    expect(hostMatchesEntry('Registry.NPMJS.org', 'registry.npmjs.org')).toBe(true);
    expect(hostMatchesEntry('registry.npmjs.org.', 'registry.npmjs.org')).toBe(true);
  });
});

describe('parseTarget', () => {
  it('reads a CONNECT target', () => {
    expect(parseTarget('registry.npmjs.org:443', 443)).toEqual({
      host: 'registry.npmjs.org',
      port: 443,
    });
  });

  it('reads an absolute URL from a plain-HTTP request line', () => {
    expect(parseTarget('http://registry.npmjs.org/leftpad', 80)).toEqual({
      host: 'registry.npmjs.org',
      port: 80,
    });
  });

  it('returns null rather than guessing on garbage', () => {
    expect(parseTarget('', 443)).toBeNull();
    expect(parseTarget('host:notaport', 443)).toBeNull();
    expect(parseTarget('host:99999', 443)).toBeNull();
  });
});

describe('isIpLiteral', () => {
  it('recognises v4 and v6, bracketed or not', () => {
    expect(isIpLiteral('192.168.1.5')).toBe(true);
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[fe80::1]')).toBe(true);
  });

  it('does not mistake a hostname for an address', () => {
    expect(isIpLiteral('registry.npmjs.org')).toBe(false);
    expect(isIpLiteral('host.docker.internal')).toBe(false);
  });
});

describe('decideEgress — default deny', () => {
  it('allows the package registry', () => {
    const d = decideEgress('registry.npmjs.org:443');
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/matched allowlist/);
  });

  it.each(CONTROL_PLANE)('DENIES the control plane: %s', (target) => {
    // The one destination the proxy could physically reach and the run
    // must never be handed.
    expect(decideEgress(target).allowed).toBe(false);
  });

  it('denies the control plane on 443 by the ALLOWLIST, not the port rule', () => {
    const d = decideEgress('host.docker.internal:443');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not in the egress allowlist/);
    expect(d.reason).not.toMatch(/port/);
  });

  it('denies an arbitrary internet host', () => {
    expect(decideEgress('example.com:443').allowed).toBe(false);
    expect(decideEgress('evil.com:443').allowed).toBe(false);
  });

  it('denies every IP literal, even when a name for it is allowed', () => {
    const d = decideEgress('10.0.0.7:443', { allowlist: ['registry.npmjs.org', '.internal'] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/IP literals/);
  });

  it('denies ports other than 80 and 443', () => {
    expect(decideEgress('registry.npmjs.org:22').allowed).toBe(false);
    expect(decideEgress('registry.npmjs.org:4111').allowed).toBe(false);
    expect(decideEgress('registry.npmjs.org:80').allowed).toBe(true);
  });

  it('denies an unparseable target instead of interpreting it', () => {
    expect(decideEgress('').allowed).toBe(false);
    expect(decideEgress('::::').allowed).toBe(false);
  });

  it('the shipped default allowlist contains no wildcard and no control-plane name', () => {
    for (const e of DEFAULT_EGRESS_ALLOWLIST) {
      expect(e).not.toContain('*');
      expect(e).not.toMatch(/localhost|docker\.internal|^\.$/);
    }
  });
});
