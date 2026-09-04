import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_NODE_DESCRIPTOR,
  EXAMPLE_UNAVAILABLE_DESCRIPTOR,
  previewDescriptorSchema,
  previewEgressHostSchema,
  previewEgressHostsSchema,
  previewEntrySchema,
  previewInstanceSchema,
  previewSummarySchema,
} from '../src/contracts/preview.js';

/**
 * THE PREVIEW CONTRACTS, HELD AT THE SCHEMA BOUNDARY.
 *
 * `src/contracts/preview.ts` is where three row shapes and one browser
 * projection are defined once. Everything worth pinning here is a REFUSAL: the
 * descriptor's cross-field agreement (an "available" preview that names no kind
 * would be served as a broken frame; an "unavailable" one that still names an
 * entry is a path nothing reads and therefore a value that drifts), the entry
 * schema's last-line path refusal, the egress schema's insistence that an
 * allowlist is a list of PUBLIC NAMES, and — the safety property the whole
 * module is arranged around — that the summary a browser receives cannot be
 * made to carry runtime attribution.
 *
 * These are pure schema tests: no store, no filesystem, no platform-specific
 * path behaviour, so they read identically on Windows and on Linux.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const AT = '2026-08-31T12:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A valid available/node descriptor, with one field replaced at a time. */
function descriptor(overrides: Record<string, unknown> = {}): unknown {
  return {
    projectRunId: RUN_ID,
    projectId: PROJECT_ID,
    orgId: ORG_ID,
    availability: 'available',
    kind: 'node',
    entry: 'server.js',
    unavailableReason: null,
    requestedHosts: ['api.example.com'],
    createdAt: AT,
    ...overrides,
  };
}

/** A valid ready instance, with one field replaced at a time. */
function instance(overrides: Record<string, unknown> = {}): unknown {
  return {
    projectRunId: RUN_ID,
    orgId: ORG_ID,
    state: 'ready',
    generation: 1,
    imageDigest: DIGEST,
    runtime: 'runsc',
    startedAt: AT,
    readyAt: AT,
    lastActivityAt: AT,
    expiresAt: null,
    errorCode: null,
    lastStopReason: null,
    updatedAt: AT,
    ...overrides,
  };
}

/** A valid summary, with one field replaced or added at a time. */
function summary(overrides: Record<string, unknown> = {}): unknown {
  return {
    availability: 'available',
    kind: 'node',
    reason: null,
    state: 'ready',
    generation: 1,
    readyAt: AT,
    expiresAt: null,
    errorCode: null,
    requestedHosts: ['api.example.com'],
    allowedHosts: ['api.example.com'],
    blockedHosts: [],
    ...overrides,
  };
}

describe('previewDescriptorSchema — availability and kind are one agreement', () => {
  it('accepts the three shapes delivery is allowed to observe', () => {
    expect(previewDescriptorSchema.safeParse(descriptor()).success).toBe(true);
    // A static deliverable is served from a filtered copy: no container, and
    // therefore no start command to name.
    expect(
      previewDescriptorSchema.safeParse(descriptor({ kind: 'static', entry: null })).success
    ).toBe(true);
    expect(
      previewDescriptorSchema.safeParse(
        descriptor({
          availability: 'unavailable',
          kind: null,
          entry: null,
          unavailableReason: 'not-runnable',
        })
      ).success
    ).toBe(true);
  });

  it('refuses an available node preview with no resolved entry', () => {
    const parsed = previewDescriptorSchema.safeParse(descriptor({ entry: null }));
    expect(parsed.success).toBe(false);
    // The refusal must land on the field an operator has to fix.
    expect(parsed.success === false && parsed.error.issues.some((i) => i.path[0] === 'entry')).toBe(
      true
    );
  });

  it('refuses an available static preview that still names an entry', () => {
    expect(
      previewDescriptorSchema.safeParse(descriptor({ kind: 'static', entry: 'server.js' })).success
    ).toBe(false);
    // Not even an empty-ish one: the field is either null or the schema's problem.
    expect(
      previewDescriptorSchema.safeParse(descriptor({ kind: 'static', entry: 'index.html' })).success
    ).toBe(false);
  });

  it('refuses an available preview with no kind, or with an unavailability reason', () => {
    expect(previewDescriptorSchema.safeParse(descriptor({ kind: null })).success).toBe(false);
    expect(
      previewDescriptorSchema.safeParse(descriptor({ kind: null, entry: null })).success
    ).toBe(false);
    expect(
      previewDescriptorSchema.safeParse(descriptor({ unavailableReason: 'not-runnable' })).success
    ).toBe(false);
    // Availability is the axis; a reason must never hide inside a valid kind.
    expect(
      previewDescriptorSchema.safeParse(
        descriptor({ kind: 'static', entry: null, unavailableReason: 'unsupported-deliverable' })
      ).success
    ).toBe(false);
  });

  it('refuses an unavailable preview that says nothing, or that still names kind or entry', () => {
    const silent = previewDescriptorSchema.safeParse(
      descriptor({ availability: 'unavailable', kind: null, entry: null, unavailableReason: null })
    );
    expect(silent.success).toBe(false);
    expect(
      silent.success === false &&
        silent.error.issues.some((i) => i.path[0] === 'unavailableReason')
    ).toBe(true);

    expect(
      previewDescriptorSchema.safeParse(
        descriptor({
          availability: 'unavailable',
          kind: 'node',
          entry: null,
          unavailableReason: 'not-runnable',
        })
      ).success
    ).toBe(false);
    expect(
      previewDescriptorSchema.safeParse(
        descriptor({
          availability: 'unavailable',
          kind: null,
          entry: 'server.js',
          unavailableReason: 'not-runnable',
        })
      ).success
    ).toBe(false);
    expect(
      previewDescriptorSchema.safeParse(
        descriptor({
          availability: 'unavailable',
          kind: 'static',
          entry: 'server.js',
          unavailableReason: 'manifest-unreadable',
        })
      ).success
    ).toBe(false);
  });

  it('is strict: a descriptor cannot smuggle a field the contract never declared', () => {
    expect(previewDescriptorSchema.safeParse(descriptor({ workspacePath: '/srv/x' })).success).toBe(
      false
    );
    expect(previewDescriptorSchema.safeParse(descriptor({ availability: 'maybe' })).success).toBe(
      false
    );
  });
});

describe('previewEntrySchema — the last-line refusal for a workspace-relative file', () => {
  it('accepts a plain and a nested workspace-relative entry', () => {
    for (const entry of ['server.js', 'src/app.js', 'a/b/c/index.mjs']) {
      expect(previewEntrySchema.safeParse(entry).success, entry).toBe(true);
    }
  });

  it('refuses everything that must never reach a row', () => {
    const refusals: Array<[string, string]> = [
      ['absolute', '/etc/passwd'],
      ['absolute workspace-looking', '/srv/workspace/server.js'],
      ['traversal', 'a/../b'],
      ['leading traversal', '../server.js'],
      ['bare traversal', '..'],
      ['backslash', 'src\\app.js'],
      ['windows-style absolute', 'C:\\app\\server.js'],
      ['NUL', 'server.js\u0000'],
      ['embedded NUL', 'src/\u0000app.js'],
      ['trailing slash', 'src/'],
      ['directory', 'public/assets/'],
      ['dot segment', './server.js'],
      ['interior dot segment', 'src/./app.js'],
      ['bare dot', '.'],
      ['empty segment', 'src//app.js'],
      ['leading empty segment via slash', '//server.js'],
      ['padded left', ' server.js'],
      ['padded right', 'server.js '],
      ['padded with newline', 'server.js\n'],
      ['empty', ''],
      ['over-length', `${'a'.repeat(509)}/x.js`],
    ];
    for (const [label, entry] of refusals) {
      expect(previewEntrySchema.safeParse(entry).success, label).toBe(false);
    }
    // 512 is the boundary and it is inclusive.
    expect(previewEntrySchema.safeParse('a'.repeat(512)).success).toBe(true);
    expect(previewEntrySchema.safeParse('a'.repeat(513)).success).toBe(false);
  });
});

describe('previewEgressHostSchema — an allowlist is a list of public names', () => {
  it('accepts an exact lower-case public DNS name at two levels or more', () => {
    for (const host of ['api.example.com', 'a.b.example.co.uk', 'cdn.example.io']) {
      expect(previewEgressHostSchema.safeParse(host).success, host).toBe(true);
    }
  });

  it('refuses anything that is not one exact public name', () => {
    const refusals: Array<[string, string]> = [
      ['uppercase', 'API.example.com'],
      ['mixed case', 'api.Example.com'],
      ['trailing dot', 'api.example.com.'],
      ['IPv4 literal', '192.168.1.5'],
      ['public IPv4 literal', '8.8.8.8'],
      ['port', 'api.example.com:8443'],
      ['IPv6 literal', '2001:db8::1'],
      ['scheme', 'https://api.example.com'],
      ['single label', 'localhost'],
      ['single label service', 'gateway'],
      ['numeric last label', 'example.123'],
      ['wildcard', '*.example.com'],
      ['subdomain form', '.example.com'],
      ['reserved .local', 'svc.local'],
      ['reserved .internal', 'x.internal'],
      ['reserved .localhost', 'x.localhost'],
      ['reserved .home.arpa', 'x.home.arpa'],
      ['reserved .onion', 'x.onion'],
      ['empty labels', 'a..b'],
      ['label starts with hyphen', '-api.example.com'],
      ['label ends with hyphen', 'api-.example.com'],
      ['trailing hyphen on last label', 'api.example.com-'],
      ['underscore label', 'api_1.example.com'],
      ['space', 'api example.com'],
      ['too short', 'a.b'],
      ['over-length', `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`],
    ];
    for (const [label, host] of refusals) {
      expect(previewEgressHostSchema.safeParse(host).success, label).toBe(false);
    }
  });
});

describe('previewEgressHostsSchema — requested hosts are a bounded set', () => {
  it('accepts an empty list: a run may ask for nothing at all', () => {
    expect(previewEgressHostsSchema.safeParse([]).success).toBe(true);
  });

  it('refuses duplicates, because it is a set and not a bag', () => {
    expect(
      previewEgressHostsSchema.safeParse(['api.example.com', 'api.example.com']).success
    ).toBe(false);
    expect(
      previewEgressHostsSchema.safeParse(['api.example.com', 'cdn.example.com']).success
    ).toBe(true);
  });

  it('is bounded at sixteen', () => {
    const hosts = (count: number) =>
      Array.from({ length: count }, (_unused, index) => `h${index}.example.com`);
    expect(previewEgressHostsSchema.safeParse(hosts(16)).success).toBe(true);
    expect(previewEgressHostsSchema.safeParse(hosts(17)).success).toBe(false);
  });

  it('refuses a list whose members are individually refused', () => {
    expect(previewEgressHostsSchema.safeParse(['api.example.com', 'svc.local']).success).toBe(
      false
    );
  });
});

describe('previewInstanceSchema — the live row and its attribution', () => {
  it('accepts a ready instance and a stopped one', () => {
    expect(previewInstanceSchema.safeParse(instance()).success).toBe(true);
    expect(
      previewInstanceSchema.safeParse(
        instance({
          state: 'stopped',
          readyAt: null,
          startedAt: null,
          lastActivityAt: null,
          lastStopReason: 'idle',
        })
      ).success
    ).toBe(true);
  });

  it('allows an error code only on a failed instance, and requires one there', () => {
    for (const state of ['stopped', 'starting', 'ready', 'stopping']) {
      const withCode = previewInstanceSchema.safeParse(
        instance({ state, readyAt: AT, errorCode: 'internal' })
      );
      expect(withCode.success, state).toBe(false);
      expect(
        withCode.success === false && withCode.error.issues.some((i) => i.path[0] === 'errorCode'),
        state
      ).toBe(true);
    }
    const silentFailure = previewInstanceSchema.safeParse(
      instance({ state: 'failed', readyAt: null, errorCode: null })
    );
    expect(silentFailure.success).toBe(false);
    expect(
      silentFailure.success === false &&
        silentFailure.error.issues.some((i) => i.path[0] === 'errorCode')
    ).toBe(true);
    expect(
      previewInstanceSchema.safeParse(
        instance({ state: 'failed', readyAt: null, errorCode: 'readiness-timeout' })
      ).success
    ).toBe(true);
    // The codes stay bounded: no raw container output ever becomes one.
    expect(
      previewInstanceSchema.safeParse(
        instance({ state: 'failed', readyAt: null, errorCode: 'Error: connect ECONNREFUSED' })
      ).success
    ).toBe(false);
  });

  it('requires a ready instance to record when it became ready', () => {
    const parsed = previewInstanceSchema.safeParse(instance({ readyAt: null }));
    expect(parsed.success).toBe(false);
    expect(
      parsed.success === false && parsed.error.issues.some((i) => i.path[0] === 'readyAt')
    ).toBe(true);
  });

  it('keeps generation a positive integer, because it is an origin identity', () => {
    for (const generation of [0, -1, 1.5, Number.NaN, '1', null]) {
      expect(previewInstanceSchema.safeParse(instance({ generation })).success, String(generation))
        .toBe(false);
    }
    expect(previewInstanceSchema.safeParse(instance({ generation: 1 })).success).toBe(true);
    expect(previewInstanceSchema.safeParse(instance({ generation: 42 })).success).toBe(true);
  });

  it('pins the image by digest or not at all — a mutable tag is not an identity', () => {
    expect(previewInstanceSchema.safeParse(instance({ imageDigest: DIGEST })).success).toBe(true);
    // Static previews run no container, so null is the honest answer.
    expect(previewInstanceSchema.safeParse(instance({ imageDigest: null })).success).toBe(true);
    const refusals: Array<[string, unknown]> = [
      ['tag', 'atoma-worker:latest'],
      ['no algorithm prefix', 'a'.repeat(64)],
      ['wrong algorithm', `sha512:${'a'.repeat(64)}`],
      ['too short', `sha256:${'a'.repeat(63)}`],
      ['too long', `sha256:${'a'.repeat(65)}`],
      ['upper-case hex', `sha256:${'A'.repeat(64)}`],
      ['non-hex', `sha256:${'g'.repeat(64)}`],
      ['padded', ` sha256:${'a'.repeat(64)}`],
    ];
    for (const [label, imageDigest] of refusals) {
      expect(previewInstanceSchema.safeParse(instance({ imageDigest })).success, label).toBe(false);
    }
  });

  it('records which isolation served the generation, and only the two that exist', () => {
    expect(previewInstanceSchema.safeParse(instance({ runtime: 'runsc' })).success).toBe(true);
    expect(previewInstanceSchema.safeParse(instance({ runtime: 'runc' })).success).toBe(true);
    expect(previewInstanceSchema.safeParse(instance({ runtime: null })).success).toBe(true);
    for (const runtime of ['gvisor', 'RUNSC', 'kata', 'docker', '']) {
      expect(previewInstanceSchema.safeParse(instance({ runtime })).success, runtime).toBe(false);
    }
  });

  it('is strict about the row shape too', () => {
    expect(previewInstanceSchema.safeParse(instance({ containerId: 'abc123' })).success).toBe(
      false
    );
  });
});

describe('previewSummarySchema — the only shape a browser receives', () => {
  it('accepts the allowlisted projection', () => {
    expect(previewSummarySchema.safeParse(summary()).success).toBe(true);
    expect(
      previewSummarySchema.safeParse(
        summary({
          availability: 'unavailable',
          kind: null,
          reason: 'legacy-run',
          state: 'stopped',
          generation: 0,
          readyAt: null,
          requestedHosts: [],
          allowedHosts: [],
          blockedHosts: [],
        })
      ).success
    ).toBe(true);
  });

  it('is strict: an unknown key is refused rather than carried', () => {
    expect(previewSummarySchema.safeParse(summary({ note: 'hello' })).success).toBe(false);
  });

  it('refuses runtime attribution by name — it must never cross to a browser', () => {
    // This is the safety property, not a typo guard: `imageDigest` and
    // `runtime` are on the instance ON PURPOSE and stay server-side, and
    // `entry` is a workspace path shape nothing in a browser needs to learn.
    for (const [key, value] of [
      ['imageDigest', DIGEST],
      ['runtime', 'runsc'],
      ['entry', 'server.js'],
    ] as const) {
      expect(previewSummarySchema.safeParse(summary({ [key]: value })).success, key).toBe(false);
    }
    // And the same names are not silently accepted as nulls either.
    for (const key of ['imageDigest', 'runtime', 'entry'] as const) {
      expect(previewSummarySchema.safeParse(summary({ [key]: null })).success, key).toBe(false);
    }
    // Neither do the host-side identities of the rows behind it.
    for (const key of ['projectRunId', 'orgId', 'projectId', 'workspacePath'] as const) {
      expect(previewSummarySchema.safeParse(summary({ [key]: RUN_ID })).success, key).toBe(false);
    }
  });

  it('holds the three host lists to the same bounded-set rule', () => {
    expect(
      previewSummarySchema.safeParse(summary({ blockedHosts: ['svc.local'] })).success
    ).toBe(false);
    expect(
      previewSummarySchema.safeParse(
        summary({ requestedHosts: ['api.example.com', 'api.example.com'] })
      ).success
    ).toBe(false);
  });
});

describe('the module examples still parse', () => {
  it('re-parses EXAMPLE_NODE_DESCRIPTOR unchanged', () => {
    const parsed = previewDescriptorSchema.safeParse(EXAMPLE_NODE_DESCRIPTOR);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(EXAMPLE_NODE_DESCRIPTOR);
    expect(EXAMPLE_NODE_DESCRIPTOR.availability).toBe('available');
    expect(EXAMPLE_NODE_DESCRIPTOR.kind).toBe('node');
    expect(EXAMPLE_NODE_DESCRIPTOR.entry).toBe('server.js');
    expect(EXAMPLE_NODE_DESCRIPTOR.unavailableReason).toBeNull();
  });

  it('re-parses EXAMPLE_UNAVAILABLE_DESCRIPTOR unchanged', () => {
    const parsed = previewDescriptorSchema.safeParse(EXAMPLE_UNAVAILABLE_DESCRIPTOR);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(EXAMPLE_UNAVAILABLE_DESCRIPTOR);
    expect(EXAMPLE_UNAVAILABLE_DESCRIPTOR.availability).toBe('unavailable');
    expect(EXAMPLE_UNAVAILABLE_DESCRIPTOR.kind).toBeNull();
    expect(EXAMPLE_UNAVAILABLE_DESCRIPTOR.entry).toBeNull();
    expect(EXAMPLE_UNAVAILABLE_DESCRIPTOR.unavailableReason).toBe('unsupported-deliverable');
  });
});
