import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROBE_MANIFEST_FILENAME } from '../src/contracts/probeManifest.js';
import {
  ArtifactPolicyError,
  buildArtifactManifest,
  type WorkspacePathPolicy,
} from '../src/projects/artifacts.js';
import {
  assertPreviewClassifiablePath,
  assertPreviewCopyablePath,
  assertPreviewServablePath,
  DEFAULT_PREVIEW_COPY_LIMITS,
  materializePreviewWorkspace,
  PREVIEW_CLASSIFIER_LIMITS,
  previewWorkspaceHasFile,
  PreviewPolicyError,
  readPreviewClassifierFile,
} from '../src/preview/policy.js';

/**
 * Symlink creation needs a privilege Windows does not grant by default. The
 * suite's home is Linux, so the POSIX cases stay POSIX-correct and are skipped
 * — never weakened — on a Windows host.
 */
const onPosix = it.skipIf(process.platform === 'win32');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-preview-policy-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectPreviewError(
  action: () => unknown,
  code: PreviewPolicyError['code']
): PreviewPolicyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewPolicyError);
    expect((error as PreviewPolicyError).code).toBe(code);
    return error as PreviewPolicyError;
  }
  throw new Error(`expected PreviewPolicyError(${code})`);
}

function expectArtifactError(
  action: () => unknown,
  code: ArtifactPolicyError['code']
): ArtifactPolicyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactPolicyError);
    expect((error as ArtifactPolicyError).code).toBe(code);
    return error as ArtifactPolicyError;
  }
  throw new Error(`expected ArtifactPolicyError(${code})`);
}

function expectDecision(
  policy: WorkspacePathPolicy,
  canonicalPath: string,
  permitted: boolean
): void {
  if (permitted) {
    expect(() => policy(canonicalPath)).not.toThrow();
    return;
  }
  expect(expectPreviewError(() => policy(canonicalPath), 'excluded').message).toContain(
    canonicalPath
  );
}

/**
 * ONE ROW PER PATH, THREE COLUMNS, NO GAPS.
 *
 * The three preview policies share a path jail and differ only here, so the
 * asymmetries are the contract and are stated as data:
 *   - classify READS the run's own record at the workspace root, and nothing
 *     else under `.atoma*` — a nested manifest was written by something else;
 *   - copy refuses all `.atoma*` but KEEPS node_modules, because executing a
 *     Node deliverable needs its dependencies inside the isolate;
 *   - serve refuses node_modules too: publication does not put a dependency
 *     tree on the internet, so neither does a static preview;
 *   - `.git` and secret-shaped names are refused by all three, because a file
 *     publication refuses must not become readable by serving it instead.
 */
const POLICY_TABLE: ReadonlyArray<{
  readonly path: string;
  readonly classify: boolean;
  readonly copy: boolean;
  readonly serve: boolean;
}> = [
  { path: '.git/config', classify: false, copy: false, serve: false },
  { path: '.env', classify: false, copy: false, serve: false },
  { path: 'id_rsa', classify: false, copy: false, serve: false },
  { path: 'a/secrets.json', classify: false, copy: false, serve: false },
  { path: '.atoma-probes.json', classify: true, copy: false, serve: false },
  { path: 'nested/.atoma-probes.json', classify: false, copy: false, serve: false },
  { path: 'node_modules/x/index.js', classify: true, copy: true, serve: false },
  { path: 'index.html', classify: true, copy: true, serve: true },
];

describe('preview exclusion policies', () => {
  for (const row of POLICY_TABLE) {
    it(`decides ${row.path} as classify=${row.classify} copy=${row.copy} serve=${row.serve}`, () => {
      expectDecision(assertPreviewClassifiablePath, row.path, row.classify);
      expectDecision(assertPreviewCopyablePath, row.path, row.copy);
      expectDecision(assertPreviewServablePath, row.path, row.serve);
    });
  }
});

describe('preview classifier reads', () => {
  it('returns bytes for a present file and null for an absent one', () => {
    writeFileSync(join(root, 'package.json'), '{"main":"server.js"}\n');
    expect(readPreviewClassifierFile(root, 'package.json')).toBe('{"main":"server.js"}\n');
    // ABSENCE IS AN ANSWER: a workspace with no package.json still classifies.
    expect(readPreviewClassifierFile(root, 'package.json.missing')).toBeNull();
    expect(readPreviewClassifierFile(root, 'no/such/dir/package.json')).toBeNull();
  });

  it('reads the root probe manifest and refuses a nested one', () => {
    writeFileSync(join(root, PROBE_MANIFEST_FILENAME), '[{"kind":"http"}]');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', PROBE_MANIFEST_FILENAME), '[{"kind":"http"}]');

    expect(readPreviewClassifierFile(root, PROBE_MANIFEST_FILENAME)).toBe('[{"kind":"http"}]');
    expect(readPreviewClassifierFile(root, `./${PROBE_MANIFEST_FILENAME}`)).toBe(
      '[{"kind":"http"}]'
    );
    expectPreviewError(
      () => readPreviewClassifierFile(root, `nested/${PROBE_MANIFEST_FILENAME}`),
      'excluded'
    );
  });

  it('propagates an exclusion instead of reporting it as absence', () => {
    writeFileSync(join(root, '.env'), 'TOKEN=must-not-leak\n');
    expectPreviewError(() => readPreviewClassifierFile(root, '.env'), 'excluded');
    // Refused on the path, not on the stat: an excluded name that is not even
    // present must not answer `null` and imply "ask again once it exists".
    expectPreviewError(() => readPreviewClassifierFile(root, 'id_rsa'), 'excluded');
  });

  it('bounds one classifier read at 256 KiB', () => {
    expect(PREVIEW_CLASSIFIER_LIMITS.maxFileBytes).toBe(256 * 1024);
    writeFileSync(join(root, 'at-cap.json'), 'x'.repeat(256 * 1024));
    writeFileSync(join(root, 'over-cap.json'), 'x'.repeat(256 * 1024 + 1));

    expect(readPreviewClassifierFile(root, 'at-cap.json')?.length).toBe(256 * 1024);
    expect(
      expectArtifactError(() => readPreviewClassifierFile(root, 'over-cap.json'), 'limit').message
    ).toContain('over-cap.json');
  });

  onPosix('propagates a symlinked classifier input rather than reading through it', () => {
    writeFileSync(join(root, 'real.json'), '{"main":"server.js"}');
    symlinkSync(join(root, 'real.json'), join(root, 'package.json'));
    expectArtifactError(() => readPreviewClassifierFile(root, 'package.json'), 'symlink');
  });
});

describe('previewWorkspaceHasFile', () => {
  it('is true only for a regular file inside the workspace', () => {
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'index.html'), '<h1>hi</h1>');

    expect(previewWorkspaceHasFile(root, 'public/index.html')).toBe(true);
    expect(previewWorkspaceHasFile(root, './public/index.html')).toBe(true);
    expect(previewWorkspaceHasFile(root, 'public')).toBe(false);
    expect(previewWorkspaceHasFile(root, 'public/missing.html')).toBe(false);
    expect(previewWorkspaceHasFile(root, 'missing/index.html')).toBe(false);
    expect(previewWorkspaceHasFile(join(root, 'no-such-workspace'), 'index.html')).toBe(false);
  });

  it('is false for a traversal or otherwise unusable path string', () => {
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>');
    for (const candidate of [
      '../index.html',
      'public/../index.html',
      '/etc/passwd',
      'nested\\index.html',
      '',
    ]) {
      expect(previewWorkspaceHasFile(root, candidate)).toBe(false);
    }
  });

  onPosix('is false when any component on the way is a symlink', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'server.js'), 'process.exit(0);\n');
    symlinkSync(join(root, 'real'), join(root, 'linked-dir'));
    symlinkSync(join(root, 'real', 'server.js'), join(root, 'linked-file.js'));

    expect(previewWorkspaceHasFile(root, 'real/server.js')).toBe(true);
    // An ambiguous answer must never become an entry a container executes.
    expect(previewWorkspaceHasFile(root, 'linked-dir/server.js')).toBe(false);
    expect(previewWorkspaceHasFile(root, 'linked-file.js')).toBe(false);
  });
});

describe('materialising the preview copy', () => {
  const INDEX = '<h1>hi</h1>';
  const APP = 'console.log("app");\n';
  const UTIL = 'export const util = 1;\n';

  let source: string;
  let destination: string;

  beforeEach(() => {
    source = join(root, 'workspace');
    destination = join(root, 'copy');
    mkdirSync(source);
  });

  it('copies regular files through nested directories and counts them exactly', () => {
    mkdirSync(join(source, 'src', 'lib'), { recursive: true });
    writeFileSync(join(source, 'index.html'), INDEX);
    writeFileSync(join(source, 'src', 'app.js'), APP);
    writeFileSync(join(source, 'src', 'lib', 'util.js'), UTIL);

    expect(materializePreviewWorkspace({ sourceRoot: source, destinationRoot: destination })).toEqual({
      files: 3,
      bytes: Buffer.byteLength(INDEX) + Buffer.byteLength(APP) + Buffer.byteLength(UTIL),
      skipped: 0,
    });
    expect(readFileSync(join(destination, 'index.html'), 'utf8')).toBe(INDEX);
    expect(readFileSync(join(destination, 'src', 'app.js'), 'utf8')).toBe(APP);
    expect(readFileSync(join(destination, 'src', 'lib', 'util.js'), 'utf8')).toBe(UTIL);
  });

  it('excludes VCS, secrets and .atoma records while keeping node_modules', () => {
    mkdirSync(join(source, '.git'));
    writeFileSync(join(source, '.git', 'config'), '[core]\n');
    writeFileSync(join(source, '.env'), 'TOKEN=must-not-leak\n');
    writeFileSync(join(source, 'id_rsa'), 'PRIVATE KEY\n');
    writeFileSync(join(source, PROBE_MANIFEST_FILENAME), '[]');
    mkdirSync(join(source, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'left-pad', 'index.js'), APP);
    writeFileSync(join(source, 'index.html'), INDEX);

    const result = materializePreviewWorkspace({
      sourceRoot: source,
      destinationRoot: destination,
    });

    // Two copied files; the four excluded entries are counted, not silently
    // dropped — an excluded DIRECTORY is one skip, never a walk.
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(Buffer.byteLength(INDEX) + Buffer.byteLength(APP));
    expect(result.skipped).toBe(4);
    for (const excluded of ['.git', '.env', 'id_rsa', PROBE_MANIFEST_FILENAME]) {
      expect(existsSync(join(destination, excluded))).toBe(false);
    }
    // Executing a Node deliverable needs its dependencies inside the isolate.
    expect(readFileSync(join(destination, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(APP);
    expect(readdirSync(destination).sort()).toEqual(['index.html', 'node_modules']);
  });

  onPosix('skips symlinks rather than following them out of the workspace', () => {
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'stolen.txt'), 'bytes from outside the workspace');
    writeFileSync(join(root, 'outside.txt'), 'more bytes from outside');
    writeFileSync(join(source, 'index.html'), INDEX);
    symlinkSync(join(root, 'outside.txt'), join(source, 'link.txt'));
    symlinkSync(join(root, 'elsewhere'), join(source, 'link-dir'));

    expect(materializePreviewWorkspace({ sourceRoot: source, destinationRoot: destination })).toEqual({
      files: 1,
      bytes: Buffer.byteLength(INDEX),
      skipped: 2,
    });
    expect(existsSync(join(destination, 'link.txt'))).toBe(false);
    expect(existsSync(join(destination, 'link-dir'))).toBe(false);
    expect(readdirSync(destination)).toEqual(['index.html']);
  });

  it('refuses rather than truncates when the file count exceeds the cap', () => {
    writeFileSync(join(source, 'a.txt'), 'aaa');
    writeFileSync(join(source, 'b.txt'), 'bbb');

    expect(
      expectPreviewError(
        () =>
          materializePreviewWorkspace({
            sourceRoot: source,
            destinationRoot: destination,
            limits: { maxFiles: 1 },
          }),
        'limit'
      ).message
    ).toContain('more than 1 files');
  });

  it('refuses rather than truncates when the byte total exceeds the cap', () => {
    writeFileSync(join(source, 'a.txt'), 'aaa');
    writeFileSync(join(source, 'b.txt'), 'bbb');

    expect(
      expectPreviewError(
        () =>
          materializePreviewWorkspace({
            sourceRoot: source,
            destinationRoot: destination,
            limits: { maxBytes: 4 },
          }),
        'limit'
      ).message
    ).toContain('exceeds 4 bytes');
    // Design §5 defaults, so a deployment override is a deliberate change.
    expect(DEFAULT_PREVIEW_COPY_LIMITS).toEqual({
      maxBytes: 512 * 1024 * 1024,
      maxFiles: 50_000,
    });
  });

  it('refuses a copy that nests with its source in either direction', () => {
    writeFileSync(join(source, 'index.html'), INDEX);

    // A destination under the source would copy the copy.
    expectPreviewError(
      () =>
        materializePreviewWorkspace({
          sourceRoot: source,
          destinationRoot: join(source, 'copy'),
        }),
      'path'
    );
    expectPreviewError(
      () =>
        materializePreviewWorkspace({
          sourceRoot: source,
          destinationRoot: join(source, 'nested', 'deep', 'copy'),
        }),
      'path'
    );
    expectPreviewError(
      () => materializePreviewWorkspace({ sourceRoot: source, destinationRoot: source }),
      'path'
    );

    // A source under the destination would be erased by a teardown that
    // believes it owns everything below it.
    const inner = join(root, 'outer', 'workspace');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'index.html'), INDEX);
    expectPreviewError(
      () =>
        materializePreviewWorkspace({
          sourceRoot: inner,
          destinationRoot: join(root, 'outer'),
        }),
      'path'
    );
  });

  it('refuses a source workspace that is not there', () => {
    expect(
      expectPreviewError(
        () =>
          materializePreviewWorkspace({
            sourceRoot: join(root, 'never-delivered'),
            destinationRoot: destination,
          }),
        'missing'
      ).message
    ).toContain('does not exist');
    expect(existsSync(destination)).toBe(false);
  });

  it('leaves the delivered workspace byte-identical when the copy is written to', () => {
    mkdirSync(join(source, 'src'));
    writeFileSync(join(source, 'index.html'), INDEX);
    writeFileSync(join(source, 'src', 'app.js'), APP);
    const beforeIndex = readFileSync(join(source, 'index.html'));
    const beforeApp = readFileSync(join(source, 'src', 'app.js'));

    materializePreviewWorkspace({ sourceRoot: source, destinationRoot: destination });

    // The app runs in the copy and writes there, as a running app does.
    writeFileSync(join(destination, 'index.html'), 'MUTATED BY THE PREVIEWED APP');
    writeFileSync(join(destination, 'app-wrote-this.log'), 'runtime output\n');
    mkdirSync(join(destination, 'data'));
    writeFileSync(join(destination, 'data', 'app.db'), 'rows');
    writeFileSync(join(destination, 'src', 'app.js'), 'console.log("mutated");\n');

    // The delivered workspace is the durable deliverable AND the seed of the
    // next run, so not one byte of it may move.
    expect(readFileSync(join(source, 'index.html')).equals(beforeIndex)).toBe(true);
    expect(readFileSync(join(source, 'src', 'app.js')).equals(beforeApp)).toBe(true);
    expect(existsSync(join(source, 'app-wrote-this.log'))).toBe(false);
    expect(existsSync(join(source, 'data'))).toBe(false);
    expect(readdirSync(source).sort()).toEqual(['index.html', 'src']);
    expect(readdirSync(join(source, 'src'))).toEqual(['app.js']);
  });
});

describe('publication policy after the preview helper extraction', () => {
  it('still refuses the probe manifest, secrets and dependencies, and still builds', () => {
    writeFileSync(join(root, PROBE_MANIFEST_FILENAME), '[]');
    writeFileSync(join(root, '.env'), 'TOKEN=must-not-leak\n');
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>');

    // The preview may read `.atoma-probes.json`; publication still may not,
    // and injecting the exclusion list changed no publication behaviour.
    for (const declaredPath of [
      PROBE_MANIFEST_FILENAME,
      '.env',
      'node_modules/left-pad/index.js',
      '.git/config',
    ]) {
      expect(
        expectArtifactError(
          () => buildArtifactManifest({ workspaceRoot: root, declaredPaths: [declaredPath] }),
          'excluded'
        ).message
      ).toContain('excluded from publication');
    }

    const built = buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['index.html'] });
    expect(built.manifest.files.map((file) => file.path)).toEqual(['index.html']);
    expect(built.manifest.totalBytes).toBe(11);
    expect(built.manifest.version).toBe(1);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
