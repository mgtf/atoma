import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactPolicyError,
  artifactManifestHash,
  buildArtifactManifest,
  buildWorkspaceArtifactManifest,
  normalizeArtifactPath,
  readManifestArtifact,
  revalidateArtifactManifest,
} from '../src/projects/artifacts.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-project-artifacts-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectPolicyError(
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

describe('project artifact manifest construction', () => {
  it('publishes only declared regular files with stable hashes, modes and ordering', () => {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'README.md'), 'hello\n');
    writeFileSync(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hello\n');
    chmodSync(join(root, 'bin', 'run.sh'), 0o755);
    writeFileSync(join(root, 'not-declared.txt'), 'must stay private');
    writeFileSync(join(root, '.env'), 'TOKEN=must-not-leak');

    const built = buildArtifactManifest({
      workspaceRoot: root,
      declaredPaths: ['README.md', 'bin/run.sh', './README.md'],
    });

    expect(built.manifest).toEqual({
      version: 1,
      files: [
        {
          path: 'bin/run.sh',
          size: 21,
          sha256: sha256('#!/bin/sh\necho hello\n'),
          mode: '100755',
        },
        {
          path: 'README.md',
          size: 6,
          sha256: sha256('hello\n'),
          mode: '100644',
        },
      ],
      totalBytes: 27,
    });
    expect(built.hash).toBe(artifactManifestHash(built.manifest));
    expect(
      readManifestArtifact({
        workspaceRoot: root,
        expected: built.manifest.files[0]!,
      }).toString('utf8')
    ).toBe('#!/bin/sh\necho hello\n');
  });

  it('rejects absolute, traversal, non-portable and ambiguous declared paths', () => {
    for (const declaredPath of [
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      '../outside.txt',
      'public/../secret.txt',
      'nested\\file.txt',
      ' index.html',
      'index.html ',
      '\0index.html',
    ]) {
      expectPolicyError(() => normalizeArtifactPath(declaredPath), 'path');
    }
  });

  it('refuses declared VCS, dependency, Atoma-internal and secret paths', () => {
    for (const declaredPath of [
      '.git/config',
      'node_modules/pkg/index.js',
      '.atoma/state.json',
      '.atoma-probes.json',
      '.env',
      'config/.env.production',
      '.npmrc',
      'credentials.json',
      'tls/server.pem',
    ]) {
      expectPolicyError(
        () => buildArtifactManifest({ workspaceRoot: root, declaredPaths: [declaredPath] }),
        'excluded'
      );
    }

    writeFileSync(join(root, '.env.example'), 'TOKEN=replace-me\n');
    expect(
      buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['.env.example'] }).manifest
        .files[0]?.path
    ).toBe('.env.example');
  });

  it('refuses GitHub Actions workflows while the MVP app has no Workflows permission', () => {
    const error = expectPolicyError(
      () =>
        buildArtifactManifest({
          workspaceRoot: root,
          declaredPaths: ['.github/workflows/deploy.yml'],
        }),
      'excluded'
    );
    expect(error.message).toMatch(/Workflows permission.*MVP does not grant/);
  });

  it('refuses final and intermediate symlinks as well as non-regular files', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'inside.txt'), 'inside');
    symlinkSync(join(root, 'real', 'inside.txt'), join(root, 'linked-file.txt'));
    symlinkSync(join(root, 'real'), join(root, 'linked-dir'));
    mkdirSync(join(root, 'directory.txt'));

    expectPolicyError(
      () => buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['linked-file.txt'] }),
      'symlink'
    );
    expectPolicyError(
      () => buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['linked-dir/inside.txt'] }),
      'symlink'
    );
    expectPolicyError(
      () => buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['directory.txt'] }),
      'special'
    );
  });

  it('bounds untrusted declarations, individual files and aggregate bytes', () => {
    writeFileSync(join(root, 'a.txt'), 'aaa');
    writeFileSync(join(root, 'b.txt'), 'bbb');

    expectPolicyError(
      () =>
        buildArtifactManifest({
          workspaceRoot: root,
          declaredPaths: ['a.txt', 'b.txt'],
          limits: { maxFiles: 1 },
        }),
      'limit'
    );
    expectPolicyError(
      () =>
        buildArtifactManifest({
          workspaceRoot: root,
          declaredPaths: ['a.txt'],
          limits: { maxFileBytes: 2 },
        }),
      'limit'
    );
    expectPolicyError(
      () =>
        buildArtifactManifest({
          workspaceRoot: root,
          declaredPaths: ['a.txt', 'b.txt'],
          limits: { maxTotalBytes: 5 },
        }),
      'limit'
    );
    expectPolicyError(
      () =>
        buildArtifactManifest({
          workspaceRoot: root,
          declaredPaths: Array.from({ length: 5 }, () => 'a.txt'),
          limits: { maxFiles: 1 },
        }),
      'limit'
    );
  });
});

describe('project artifact publication revalidation', () => {
  it('re-reads the exact bytes and refuses mutation after manifest capture', () => {
    writeFileSync(join(root, 'index.html'), 'old');
    const built = buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['index.html'] });

    expect(
      revalidateArtifactManifest({
        workspaceRoot: root,
        manifest: built.manifest,
        expectedHash: built.hash,
      })
    ).toEqual(built);
    expect(
      readManifestArtifact({ workspaceRoot: root, expected: built.manifest.files[0]! }).toString()
    ).toBe('old');

    writeFileSync(join(root, 'index.html'), 'new');
    expectPolicyError(
      () =>
        revalidateArtifactManifest({
          workspaceRoot: root,
          manifest: built.manifest,
          expectedHash: built.hash,
        }),
      'changed'
    );
    expectPolicyError(
      () => readManifestArtifact({ workspaceRoot: root, expected: built.manifest.files[0]! }),
      'changed'
    );
  });

  it('refuses a mismatched manifest hash and a symlink replacement', () => {
    writeFileSync(join(root, 'index.html'), 'stable');
    writeFileSync(join(root, 'replacement.html'), 'stable');
    const built = buildArtifactManifest({ workspaceRoot: root, declaredPaths: ['index.html'] });

    expectPolicyError(
      () =>
        revalidateArtifactManifest({
          workspaceRoot: root,
          manifest: built.manifest,
          expectedHash: '0'.repeat(64),
        }),
      'hash'
    );

    unlinkSync(join(root, 'index.html'));
    symlinkSync(join(root, 'replacement.html'), join(root, 'index.html'));
    expectPolicyError(
      () => readManifestArtifact({ workspaceRoot: root, expected: built.manifest.files[0]! }),
      'symlink'
    );
  });
});


describe('finished workspace publication inventory', () => {
  it('includes nested assets and files absent from the root plan, excluding private and internal trees', () => {
    for (const name of ['public/assets', 'node_modules/pkg', '.git', '.github/workflows']) mkdirSync(join(root, name), { recursive: true });
    for (const [name, contents] of Object.entries({
      'server.js': 'server', 'index.html': 'page', 'app.js': 'client',
      'public/assets/icon.bin': 'binary', 'package-lock.json': 'lock',
      '.env': 'credential', '.atoma-probes.json': 'evidence',
      'node_modules/pkg/index.js': 'dependency', '.git/config': 'private',
      '.github/workflows/deploy.yml': 'workflow',
    })) writeFileSync(join(root, name), contents);
    const built = buildWorkspaceArtifactManifest({ workspaceRoot: root });
    expect(built.manifest.source).toBe('workspace');
    expect(built.manifest.files.map(file => file.path)).toEqual([
      'app.js', 'index.html', 'package-lock.json', 'public/assets/icon.bin', 'server.js',
    ]);
    expect(revalidateArtifactManifest({ workspaceRoot: root, manifest: built.manifest }).hash).toBe(built.hash);
    writeFileSync(join(root, 'late.js'), 'new asset');
    expectPolicyError(() => revalidateArtifactManifest({ workspaceRoot: root, manifest: built.manifest }), 'changed');
  });

  it('refuses symlinks rather than silently omitting an application dependency', () => {
    writeFileSync(join(root, 'app.js'), 'client');
    symlinkSync(join(root, 'app.js'), join(root, 'linked.js'));
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root }), 'symlink');
  });

  it('refuses oversized or empty inventories without truncating', () => {
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root }), 'empty');
    writeFileSync(join(root, '.env'), 'private');
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root }), 'empty');
    writeFileSync(join(root, 'one.js'), '1234');
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root, limits: { maxFileBytes: 3 } }), 'limit');
    writeFileSync(join(root, 'two.js'), '1234');
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root, limits: { maxFiles: 1 } }), 'limit');
    expectPolicyError(() => buildWorkspaceArtifactManifest({ workspaceRoot: root, limits: { maxTotalBytes: 7 } }), 'limit');
  });
});
