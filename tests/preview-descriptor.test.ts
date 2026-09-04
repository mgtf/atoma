import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { previewDescriptorSchema } from '../src/contracts/preview.js';
import {
  PROBE_MANIFEST_FILENAME,
  validateProbeManifest,
} from '../src/contracts/probeManifest.js';
import {
  buildPreviewDescriptor,
  classifyDeliveredWorkspace,
  type PreviewClassification,
} from '../src/preview/descriptor.js';

/**
 * WHAT A DELIVERED WORKSPACE CLASSIFIES AS — on real bytes, never on mocks.
 *
 * Every case below builds an actual temp workspace and writes an actual
 * `.atoma-probes.json`, because the two inputs this classifier is allowed to
 * read are that machine-written record and the presence of files on disk
 * (`src/preview/AGENTS.md`, "Classification is machine-observed, and total").
 * A stubbed filesystem would pin the stub, not the jail: the symlink refusals,
 * the path canonicalisation and the read cap all live below the module under
 * test and are exactly what must not regress.
 *
 * Two properties get their own sweeps at the end: the answer is TOTAL (every
 * hostile workspace yields a bounded reason rather than an exception thrown
 * inside the delivery path), and the row it produces always parses.
 *
 * Symlink cases are skipped on Windows, where creating one needs privilege;
 * the assertions are written POSIX-first, for the suite's real home.
 */

const posixIt = it.skipIf(process.platform === 'win32');

const IDS = {
  projectRunId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
} as const;

const NOW = new Date('2026-08-31T12:00:00.000Z');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real delivered workspace holding exactly these files. */
function workspace(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-descriptor-'));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function manifest(...entries: readonly unknown[]): string {
  return JSON.stringify({ version: 1, entries });
}

function httpEntry(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { probe: 'http', method: 'GET', path: '/', status: 200, body: 'ok', ...extra };
}

const WEB_ENTRY = {
  probe: 'web',
  file: 'index.html',
  smoke: '() => true',
  expected: 'x',
} as const;

const SHELL_ENTRY = { cmd: 'node cli.js', exitCode: 0 } as const;

function descriptorFor(workspaceRoot: string): unknown {
  return buildPreviewDescriptor({ ...IDS, workspaceRoot, now: NOW });
}

describe('the manifest fixtures these tests classify', () => {
  it('are documents the probe contract itself calls well-formed', () => {
    // The classifier mirrors `validateProbeManifest`'s kind dispatch rather
    // than re-inventing it. If a fixture here were malformed, every
    // classification below would be pinning the classifier's behaviour on
    // input no real run could produce.
    expect(validateProbeManifest(manifest(httpEntry({ entry: 'server.js' })))).toEqual([]);
    expect(validateProbeManifest(manifest(WEB_ENTRY))).toEqual([]);
    expect(validateProbeManifest(manifest(SHELL_ENTRY))).toEqual([]);
  });
});

describe('an http probe classifies the deliverable as node', () => {
  it('takes the entry stamped on the probe, ahead of package.json main', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'server.js' })),
      'server.js': '// the server the run actually started\n',
      'package.json': JSON.stringify({ main: 'other.js' }),
      'other.js': '// never chosen\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'available',
      kind: 'node',
      entry: 'server.js',
      unavailableReason: null,
    });
  });

  it('takes package.json main when nothing was stamped, ahead of the conventional names', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'package.json': JSON.stringify({ main: 'lib/app.js' }),
      'lib/app.js': '// the declared main\n',
      'server.js': '// a conventional name that must not win here\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'available',
      kind: 'node',
      entry: 'lib/app.js',
      unavailableReason: null,
    });
  });

  it('falls back to each conventional entry name on its own', () => {
    for (const name of ['server.js', 'index.js', 'app.js']) {
      const root = workspace({
        [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
        [name]: '// entry\n',
      });
      expect(classifyDeliveredWorkspace(root), name).toEqual({
        availability: 'available',
        kind: 'node',
        entry: name,
        unavailableReason: null,
      });
    }
  });

  it('orders the conventional names: server.js beats index.js beats app.js', () => {
    const all = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'server.js': '// s\n',
      'index.js': '// i\n',
      'app.js': '// a\n',
    });
    expect(classifyDeliveredWorkspace(all).entry).toBe('server.js');

    const withoutServer = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'index.js': '// i\n',
      'app.js': '// a\n',
    });
    expect(classifyDeliveredWorkspace(withoutServer).entry).toBe('index.js');
  });

  it('takes the LAST stamp when a run restarted its server under a new name', () => {
    // HTTP entries are a SEQUENCE and never merge by route, so a restart
    // leaves both stamps behind; the newest describes the deliverable as it
    // ended (`src/contracts/probeManifest.ts`, merge semantics).
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(
        httpEntry({ entry: 'old.js' }),
        httpEntry({ path: '/health', entry: 'new.js' })
      ),
      'old.js': '// the first server\n',
      'new.js': '// the server that ended the run\n',
    });
    expect(classifyDeliveredWorkspace(root).entry).toBe('new.js');
  });

  it('canonicalises a stamped path rather than refusing it', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: './lib/app.js' })),
      'lib/app.js': '// entry\n',
    });
    expect(classifyDeliveredWorkspace(root).entry).toBe('lib/app.js');
  });

  it('accepts .mjs and .cjs stamps, because node runs those too', () => {
    for (const name of ['server.mjs', 'server.cjs']) {
      const root = workspace({
        [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: name })),
        [name]: '// entry\n',
      });
      expect(classifyDeliveredWorkspace(root).entry, name).toBe(name);
    }
  });

  it('treats a stamp naming a file that is not there as no stamp at all', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'ghost.js' })),
      'server.js': '// the file that is really there\n',
    });
    expect(classifyDeliveredWorkspace(root).entry).toBe('server.js');
  });

  it('treats a stamp node could not execute as no stamp at all', () => {
    // `node <entry>` is the only start command a preview will ever run, so a
    // present-but-unrunnable stamp must fall through instead of becoming an
    // entry a container later fails on.
    const falls = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'server.py' })),
      'server.py': 'print("hi")\n',
      'index.js': '// the runnable entry\n',
    });
    expect(classifyDeliveredWorkspace(falls).entry).toBe('index.js');

    const nothingLeft = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'server.py' })),
      'server.py': 'print("hi")\n',
    });
    expect(classifyDeliveredWorkspace(nothingLeft)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'not-runnable',
    });
  });

  it('ignores a package.json main that names no runnable file', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'package.json': JSON.stringify({ main: 'dist/bundle.py' }),
      'dist/bundle.py': 'print("hi")\n',
      'app.js': '// the runnable entry\n',
    });
    expect(classifyDeliveredWorkspace(root).entry).toBe('app.js');
  });

  it('reports not-runnable when an http deliverable resolves no entry at all', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'README.md': '# how to run it\n',
      'main.py': 'print("hi")\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'not-runnable',
    });
  });

  it('infers the http shape from a bare path entry, the way the validator does', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest({ method: 'GET', path: '/', status: 200 }),
      'server.js': '// entry\n',
    });
    expect(classifyDeliveredWorkspace(root).kind).toBe('node');
  });

  it('does not read an incidental path on a shell entry as an http probe', () => {
    // Dispatch order: the explicit discriminator wins, then `cmd` claims the
    // shell shape. A shell entry carrying an extra `path` is not http.
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest({ ...SHELL_ENTRY, path: '/' }),
      'server.js': '// present, and irrelevant to a CLI deliverable\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'unsupported-deliverable',
    });
  });

  it('prefers node over static when a run recorded both an http and a web probe', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(WEB_ENTRY, httpEntry({ entry: 'server.js' })),
      'server.js': '// serves the page\n',
      'index.html': '<!doctype html>\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'available',
      kind: 'node',
      entry: 'server.js',
      unavailableReason: null,
    });
  });

  it('stays not-runnable for an http deliverable even beside an index.html', () => {
    // An http probe means node (`src/preview/AGENTS.md`): the served page is
    // produced by a server, and serving its source statically would preview
    // something the run never validated.
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
      'index.html': '<!doctype html>\n',
    });
    expect(classifyDeliveredWorkspace(root).unavailableReason).toBe('not-runnable');
  });
});

describe('a web probe or a bare index.html classifies as static', () => {
  it('classifies a web probe as static with no entry', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(WEB_ENTRY),
      'index.html': '<!doctype html>\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'available',
      kind: 'static',
      entry: null,
      unavailableReason: null,
    });
  });

  it('classifies a web probe as static even when the page it names sits elsewhere', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest({ ...WEB_ENTRY, file: 'public/page.html' }),
      'public/page.html': '<!doctype html>\n',
    });
    expect(classifyDeliveredWorkspace(root).kind).toBe('static');
  });

  it('classifies a bare index.html as static with no manifest at all', () => {
    const root = workspace({ 'index.html': '<!doctype html>\n' });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'available',
      kind: 'static',
      entry: null,
      unavailableReason: null,
    });
  });

  it('classifies a bare index.html as static under a valid but empty manifest', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(),
      'index.html': '<!doctype html>\n',
    });
    expect(classifyDeliveredWorkspace(root).kind).toBe('static');
  });
});

describe('a deliverable no preview can open', () => {
  it('reports unsupported-deliverable for a verified CLI', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(SHELL_ENTRY),
      'cli.js': '// a CLI is delivered and published, but not previewable\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'unsupported-deliverable',
    });
  });

  it('reports unsupported-deliverable with neither a manifest nor an index.html', () => {
    const root = workspace({ 'notes.md': '# what I did\n' });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'unsupported-deliverable',
    });
  });

  it('reports unsupported-deliverable for a completely empty workspace', () => {
    expect(classifyDeliveredWorkspace(workspace()).unavailableReason).toBe(
      'unsupported-deliverable'
    );
  });
});

describe('a manifest the host cannot read back', () => {
  it('reports manifest-unreadable when the document is not JSON', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: '{"version": 1, "entries": [',
      'server.js': '// present, and never reached\n',
    });
    expect(classifyDeliveredWorkspace(root)).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'manifest-unreadable',
    });
  });

  it('reports manifest-unreadable for valid JSON that is not the manifest document', () => {
    const documents: Readonly<Record<string, string>> = {
      'a wrong version and a string entries': '{"version": 2, "entries": "x"}',
      'a missing entries array': '{"version": 1}',
      'entries as an object': '{"version": 1, "entries": {"0": {}}}',
      'a top-level array': '[{"probe": "http"}]',
      'a top-level string': '"entries"',
      'a top-level null': 'null',
    };
    for (const [label, document] of Object.entries(documents)) {
      const root = workspace({
        [PROBE_MANIFEST_FILENAME]: document,
        'server.js': '// present, and never reached\n',
      });
      expect(classifyDeliveredWorkspace(root), label).toEqual({
        availability: 'unavailable',
        kind: null,
        entry: null,
        unavailableReason: 'manifest-unreadable',
      });
    }
  });

  it('skips entries that are not objects instead of rejecting the manifest', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(null, 7, 'probe', [], httpEntry({ entry: 'server.js' })),
      'server.js': '// entry\n',
    });
    expect(classifyDeliveredWorkspace(root).entry).toBe('server.js');
  });
});

describe('a workspace the host declines to describe', () => {
  it('reports workspace-unreadable when the workspace root is not a directory', () => {
    const parent = workspace({ 'delivered': 'this is a file, not a workspace\n' });
    expect(classifyDeliveredWorkspace(join(parent, 'delivered'))).toEqual({
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'workspace-unreadable',
    });
  });

  it('reports workspace-unreadable when the manifest path is a directory', () => {
    const root = workspace({ 'server.js': '// present, and never reached\n' });
    mkdirSync(join(root, PROBE_MANIFEST_FILENAME));
    expect(classifyDeliveredWorkspace(root).unavailableReason).toBe('workspace-unreadable');
  });

  it('reports workspace-unreadable rather than parsing a manifest past the read cap', () => {
    // The classifier's read cap is 256 KiB and belongs to the READ policy, so
    // the refusal surfaces as the workspace being undescribable rather than as
    // a verdict about the manifest's contents — nothing parsed it.
    const oversize = JSON.stringify({
      version: 1,
      entries: [httpEntry({ body: 'x'.repeat(300 * 1024) })],
    });
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: oversize,
      'server.js': '// present, and never reached\n',
    });
    expect(classifyDeliveredWorkspace(root).unavailableReason).toBe('workspace-unreadable');
  });

  posixIt('reports workspace-unreadable when the manifest is a symlink', () => {
    const root = workspace({
      'real-probes.json': manifest(httpEntry({ entry: 'server.js' })),
      'server.js': '// entry\n',
    });
    symlinkSync(join(root, 'real-probes.json'), join(root, PROBE_MANIFEST_FILENAME));
    expect(classifyDeliveredWorkspace(root).unavailableReason).toBe('workspace-unreadable');
  });

  posixIt('never resolves an entry through a symlink', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'server.js' })),
      'real-server.js': '// the link target\n',
      'index.js': '// the one unambiguous entry\n',
    });
    symlinkSync(join(root, 'real-server.js'), join(root, 'server.js'));
    expect(classifyDeliveredWorkspace(root).entry).toBe('index.js');
  });

  posixIt('does not call a symlinked index.html a static deliverable', () => {
    const root = workspace({ 'real-index.html': '<!doctype html>\n' });
    symlinkSync(join(root, 'real-index.html'), join(root, 'index.html'));
    expect(classifyDeliveredWorkspace(root).unavailableReason).toBe('unsupported-deliverable');
  });

  it('still answers, bounded, for a workspace that is no longer on disk', () => {
    // Totality only. WHICH bounded reason a vanished workspace reports is
    // deliberately NOT pinned here — see the review note filed with this file.
    const root = workspace({ 'index.html': '<!doctype html>\n' });
    rmSync(root, { recursive: true, force: true });
    const classification = classifyDeliveredWorkspace(root);
    expect(classification.availability).toBe('unavailable');
    expect(classification.kind).toBeNull();
    expect(classification.entry).toBeNull();
    expect(classification.unavailableReason).not.toBeNull();
  });
});

describe('an unusable stamp is no stamp, never a refusal', () => {
  it('falls back for every stamp shape the path rule rejects', () => {
    const stamps: Readonly<Record<string, unknown>> = {
      traversal: '../../etc/passwd.js',
      'posix absolute': '/etc/init.js',
      'windows absolute': 'C:/windows/system32/init.js',
      backslash: 'lib\\app.js',
      'embedded NUL': 'lib/\u0000app.js',
      padded: ' server.js ',
      empty: '',
      'not a string': 12,
      'a nested object': { path: 'server.js' },
      'a bare directory': 'lib/',
      'a dot segment': 'lib/./app.js',
      null: null,
    };
    for (const [label, stamp] of Object.entries(stamps)) {
      const root = workspace({
        [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: stamp })),
        'server.js': '// the fallback that keeps the run previewable\n',
      });
      expect(classifyDeliveredWorkspace(root), label).toEqual({
        availability: 'available',
        kind: 'node',
        entry: 'server.js',
        unavailableReason: null,
      });
    }
  });

  it('falls back for every package.json the main rule cannot use', () => {
    const packages: Readonly<Record<string, string>> = {
      'not JSON': '{"main": "lib/app.js",',
      'a top-level array': '["lib/app.js"]',
      'a numeric main': '{"main": 3}',
      'a traversing main': '{"main": "../outside.js"}',
      'no main at all': '{"name": "delivered"}',
    };
    for (const [label, contents] of Object.entries(packages)) {
      const root = workspace({
        [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
        'package.json': contents,
        'server.js': '// the fallback\n',
      });
      expect(classifyDeliveredWorkspace(root).entry, label).toBe('server.js');
    }
  });
});

describe('building the immutable descriptor', () => {
  it('produces a schema-valid available row stamped from the injected instant', () => {
    const root = workspace({
      [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: 'server.js' })),
      'server.js': '// entry\n',
    });
    const descriptor = buildPreviewDescriptor({ ...IDS, workspaceRoot: root, now: NOW });
    expect(previewDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toEqual({
      ...IDS,
      availability: 'available',
      kind: 'node',
      entry: 'server.js',
      unavailableReason: null,
      requestedHosts: [],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
  });

  it('produces a schema-valid unavailable row carrying the classifier reason', () => {
    const root = workspace({ 'notes.md': '# what I did\n' });
    const descriptor = buildPreviewDescriptor({ ...IDS, workspaceRoot: root, now: NOW });
    expect(previewDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toEqual({
      ...IDS,
      availability: 'unavailable',
      kind: null,
      entry: null,
      unavailableReason: 'unsupported-deliverable',
      requestedHosts: [],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
  });

  it('defaults requestedHosts to empty, and copies the list it is given', () => {
    const root = workspace({ 'index.html': '<!doctype html>\n' });
    expect(buildPreviewDescriptor({ ...IDS, workspaceRoot: root, now: NOW }).requestedHosts).toEqual(
      []
    );

    const hosts = ['api.example.com', 'cdn.example.com'];
    const descriptor = buildPreviewDescriptor({
      ...IDS,
      workspaceRoot: root,
      requestedHosts: hosts,
      now: NOW,
    });
    expect(descriptor.requestedHosts).toEqual(hosts);
    expect(descriptor.requestedHosts).not.toBe(hosts);
    hosts.push('late.example.com');
    expect(descriptor.requestedHosts).toEqual(['api.example.com', 'cdn.example.com']);
  });

  it('refuses a requested host the egress contract does not allow', () => {
    const root = workspace({ 'index.html': '<!doctype html>\n' });
    for (const host of ['localhost', 'db.internal', '10.0.0.4', 'API.example.com']) {
      expect(
        () => buildPreviewDescriptor({ ...IDS, workspaceRoot: root, requestedHosts: [host], now: NOW }),
        host
      ).toThrow();
    }
  });

  it('stamps the current instant when no clock is injected', () => {
    const root = workspace({ 'index.html': '<!doctype html>\n' });
    const before = Date.now();
    const descriptor = buildPreviewDescriptor({ ...IDS, workspaceRoot: root });
    const stamped = Date.parse(descriptor.createdAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('classification is total', () => {
  it('answers with a bounded, persistable row for every hostile workspace', () => {
    // The delivery hook is fail-open and a preview is a convenience over work
    // already delivered and already paid for: an exception thrown here would
    // be the host failing to DESCRIBE a run, on the path that delivers it.
    const hostile: ReadonlyArray<readonly [string, () => string]> = [
      ['a manifest that is not JSON', () => workspace({ [PROBE_MANIFEST_FILENAME]: '{' })],
      ['an empty manifest file', () => workspace({ [PROBE_MANIFEST_FILENAME]: '' })],
      ['a manifest of only whitespace', () => workspace({ [PROBE_MANIFEST_FILENAME]: '   \n' })],
      ['a manifest that is a JSON array', () => workspace({ [PROBE_MANIFEST_FILENAME]: '[]' })],
      [
        'a manifest whose entries are not objects',
        () => workspace({ [PROBE_MANIFEST_FILENAME]: manifest(null, 7, 'x', [], true) }),
      ],
      [
        'an http entry with no fields at all',
        () => workspace({ [PROBE_MANIFEST_FILENAME]: manifest({ probe: 'http' }) }),
      ],
      [
        'a web entry with no fields at all',
        () => workspace({ [PROBE_MANIFEST_FILENAME]: manifest({ probe: 'web' }) }),
      ],
      [
        'a stamp that traverses out of the workspace',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: '../../../etc/passwd.js' })),
          }),
      ],
      [
        'a stamp longer than the path limit',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: manifest(httpEntry({ entry: `${'a'.repeat(4_096)}.js` })),
          }),
      ],
      [
        'a thousand stamped entries',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: manifest(
              ...Array.from({ length: 1_000 }, (_, i) => httpEntry({ entry: `gen-${i}.js` }))
            ),
          }),
      ],
      [
        'a package.json that is not JSON',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
            'package.json': 'not json at all',
          }),
      ],
      [
        'a package.json main pointing at a directory',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: manifest(httpEntry()),
            'package.json': JSON.stringify({ main: 'lib' }),
            'lib/app.js': '// not the declared main\n',
          }),
      ],
      [
        'a manifest larger than the read cap',
        () =>
          workspace({
            [PROBE_MANIFEST_FILENAME]: JSON.stringify({
              version: 1,
              entries: [httpEntry({ body: 'x'.repeat(300 * 1024) })],
            }),
          }),
      ],
      [
        'a manifest path that is a directory',
        () => {
          const root = workspace({ 'server.js': '// entry\n' });
          mkdirSync(join(root, PROBE_MANIFEST_FILENAME));
          return root;
        },
      ],
      [
        'a workspace root that is a regular file',
        () => join(workspace({ 'delivered': 'not a workspace\n' }), 'delivered'),
      ],
      [
        'a workspace root that vanished',
        () => {
          const root = workspace({ 'index.html': '<!doctype html>\n' });
          rmSync(root, { recursive: true, force: true });
          return root;
        },
      ],
      ['a workspace root that never existed', () => join(workspace(), 'nowhere', 'at', 'all')],
      ['an empty workspace root path', () => ''],
    ];

    for (const [label, make] of hostile) {
      const root = make();
      const classify = (): PreviewClassification => classifyDeliveredWorkspace(root);
      expect(classify, label).not.toThrow();
      const classification = classify();
      if (classification.availability === 'available') {
        expect(classification.kind, label).not.toBeNull();
        expect(classification.unavailableReason, label).toBeNull();
      } else {
        expect(classification.unavailableReason, label).not.toBeNull();
        expect(classification.kind, label).toBeNull();
        expect(classification.entry, label).toBeNull();
      }
      // And the row it yields is one the store would accept.
      expect(() => descriptorFor(root), label).not.toThrow();
      expect(previewDescriptorSchema.safeParse(descriptorFor(root)).success, label).toBe(true);
    }
  });
});
