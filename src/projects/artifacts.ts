import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  artifactFileSchema,
  artifactManifestSchema,
  sha256Schema,
  type ArtifactFile,
  type ArtifactManifest,
} from '../contracts/projects.js';

/**
 * Machine-owned publication manifest builder.
 *
 * The input is the accepted root plan's structured `outputs` list. We never
 * infer files from model prose, tool-event payloads, or the whole workspace.
 * A declared path is either a bounded regular file inside the real workspace
 * or the publication is refused with a precise policy error.
 */

export interface ArtifactLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathChars: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxFiles: 256,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxPathChars: 512,
};

export type ArtifactPolicyCode =
  | 'empty'
  | 'path'
  | 'excluded'
  | 'missing'
  | 'symlink'
  | 'special'
  | 'limit'
  | 'changed'
  | 'hash';

export class ArtifactPolicyError extends Error {
  constructor(
    readonly code: ArtifactPolicyCode,
    message: string
  ) {
    super(message);
    this.name = 'ArtifactPolicyError';
  }
}

export interface BuiltArtifactManifest {
  readonly manifest: ArtifactManifest;
  readonly hash: string;
}

function resolvedLimits(overrides: Partial<ArtifactLimits> | undefined): ArtifactLimits {
  const limits = { ...DEFAULT_ARTIFACT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ArtifactPolicyError('limit', `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

/** Canonical Git path or a fail-closed policy error. */
export function normalizeArtifactPath(raw: string, maxPathChars = DEFAULT_ARTIFACT_LIMITS.maxPathChars): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxPathChars) {
    throw new ArtifactPolicyError('path', 'artifact path is empty or exceeds the path limit');
  }
  if (raw.includes('\0') || raw.includes('\\')) {
    throw new ArtifactPolicyError('path', `artifact path is not portable: ${JSON.stringify(raw)}`);
  }
  if (raw !== raw.trim()) {
    throw new ArtifactPolicyError('path', `artifact path has leading or trailing whitespace: ${JSON.stringify(raw)}`);
  }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new ArtifactPolicyError('path', `artifact path must be relative: ${JSON.stringify(raw)}`);
  }
  if (raw.split('/').includes('..')) {
    throw new ArtifactPolicyError('path', `artifact path contains traversal: ${JSON.stringify(raw)}`);
  }
  const canonical = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (
    canonical === '.' ||
    canonical === '..' ||
    canonical.startsWith('../') ||
    canonical.includes('/../') ||
    canonical.length > maxPathChars
  ) {
    throw new ArtifactPolicyError('path', `artifact path leaves the workspace: ${JSON.stringify(raw)}`);
  }
  return canonical;
}

function secretLike(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower === '.env' || (lower.startsWith('.env.') && !lower.endsWith('.example'))) return true;
  if (
    [
      '.npmrc',
      '.netrc',
      '.pypirc',
      'credentials',
      'credentials.json',
      'secrets',
      '.secrets',
      'id_rsa',
      'id_ed25519',
    ].includes(lower)
  ) {
    return true;
  }
  if (/^(?:secret|secrets)\.(?:json|ya?ml|toml|txt)$/i.test(segment)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(segment);
}

/** Internal, dependency, VCS and likely-secret paths never cross publication. */
export function assertPublishableArtifactPath(canonicalPath: string): void {
  const segments = canonicalPath.split('/');
  if (
    segments.length >= 2 &&
    segments[0]!.toLowerCase() === '.github' &&
    segments[1]!.toLowerCase() === 'workflows'
  ) {
    throw new ArtifactPolicyError(
      'excluded',
      `GitHub Actions workflow publication requires the GitHub App Workflows permission, which the MVP does not grant: ${canonicalPath}`
    );
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (
      lower === '.git' ||
      lower === 'node_modules' ||
      lower === '.atoma' ||
      lower.startsWith('.atoma-') ||
      secretLike(segment)
    ) {
      throw new ArtifactPolicyError(
        'excluded',
        `artifact path is excluded from publication: ${canonicalPath}`
      );
    }
  }
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

interface WorkspacePath {
  readonly root: string;
  readonly realRoot: string;
  readonly canonical: string;
  readonly absolute: string;
}

function resolveWorkspaceFile(
  workspaceRoot: string,
  declaredPath: string,
  limits: ArtifactLimits
): WorkspacePath {
  const root = path.resolve(workspaceRoot);
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new ArtifactPolicyError('missing', `workspace does not exist: ${root}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ArtifactPolicyError('special', `workspace root must be a real directory: ${root}`);
  }
  const realRoot = realpathSync(root);
  const canonical = normalizeArtifactPath(declaredPath, limits.maxPathChars);
  assertPublishableArtifactPath(canonical);
  const absolute = path.resolve(root, ...canonical.split('/'));
  const lexicalRelative = path.relative(root, absolute);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    throw new ArtifactPolicyError('path', `artifact path escapes workspace: ${canonical}`);
  }

  // Reject every symlink component, even one whose final target happens to
  // remain inside the workspace. Publication must have one unambiguous byte
  // source and must not change meaning when a link is retargeted.
  let cursor = root;
  for (const segment of canonical.split('/')) {
    cursor = path.join(cursor, segment);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new ArtifactPolicyError('missing', `declared artifact does not exist: ${canonical}`);
    }
    if (stat.isSymbolicLink()) {
      throw new ArtifactPolicyError('symlink', `artifact path contains a symlink: ${canonical}`);
    }
  }

  const real = realpathSync(absolute);
  const realRelative = path.relative(realRoot, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new ArtifactPolicyError('path', `artifact real path escapes workspace: ${canonical}`);
  }
  return { root, realRoot, canonical, absolute };
}

interface ReadArtifact {
  readonly file: ArtifactFile;
  readonly bytes: Buffer;
}

function secureRead(
  workspaceRoot: string,
  declaredPath: string,
  limits: ArtifactLimits
): ReadArtifact {
  const target = resolveWorkspaceFile(workspaceRoot, declaredPath, limits);
  const before = lstatSync(target.absolute);
  if (!before.isFile()) {
    throw new ArtifactPolicyError('special', `artifact is not a regular file: ${target.canonical}`);
  }
  if (before.size > limits.maxFileBytes) {
    throw new ArtifactPolicyError(
      'limit',
      `artifact exceeds ${limits.maxFileBytes} bytes: ${target.canonical}`
    );
  }

  let fd: number | null = null;
  try {
    fd = openSync(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new ArtifactPolicyError('changed', `artifact changed while it was opened: ${target.canonical}`);
    }

    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > limits.maxFileBytes) {
        throw new ArtifactPolicyError(
          'limit',
          `artifact grew beyond ${limits.maxFileBytes} bytes: ${target.canonical}`
        );
      }
      const bytes = chunk.subarray(0, count);
      chunks.push(bytes);
      hash.update(bytes);
    }

    const afterFd = fstatSync(fd);
    const afterPath = lstatSync(target.absolute);
    if (
      total !== afterFd.size ||
      !sameIdentity(opened, afterFd) ||
      !sameIdentity(afterFd, afterPath) ||
      afterPath.isSymbolicLink()
    ) {
      throw new ArtifactPolicyError('changed', `artifact changed while it was read: ${target.canonical}`);
    }

    return {
      file: artifactFileSchema.parse({
        path: target.canonical,
        size: total,
        sha256: hash.digest('hex'),
        mode: (opened.mode & 0o111) !== 0 ? '100755' : '100644',
      }),
      bytes: Buffer.concat(chunks, total),
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function artifactManifestHash(manifest: ArtifactManifest): string {
  const parsed = artifactManifestSchema.parse(manifest);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}

export function buildArtifactManifest(input: {
  readonly workspaceRoot: string;
  readonly declaredPaths: readonly string[];
  readonly limits?: Partial<ArtifactLimits>;
}): BuiltArtifactManifest {
  const limits = resolvedLimits(input.limits);
  if (input.declaredPaths.length === 0) {
    throw new ArtifactPolicyError('empty', 'no artifact paths were declared by the accepted plan');
  }
  // Bound work before canonical deduplication too: ten thousand repetitions
  // of one path are still ten thousand untrusted input entries to inspect.
  if (input.declaredPaths.length > limits.maxFiles * 4) {
    throw new ArtifactPolicyError('limit', 'too many declared artifact paths');
  }
  const canonical = [
    ...new Set(
      input.declaredPaths.map((declaredPath) =>
        normalizeArtifactPath(declaredPath, limits.maxPathChars)
      )
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (canonical.length === 0) {
    throw new ArtifactPolicyError('empty', 'no publishable artifact paths were declared');
  }
  if (canonical.length > limits.maxFiles) {
    throw new ArtifactPolicyError('limit', `artifact count exceeds ${limits.maxFiles}`);
  }

  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  for (const declaredPath of canonical) {
    const read = secureRead(input.workspaceRoot, declaredPath, limits);
    totalBytes += read.file.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ArtifactPolicyError(
        'limit',
        `artifact bytes exceed the ${limits.maxTotalBytes}-byte total limit`
      );
    }
    files.push(read.file);
  }
  const manifest = artifactManifestSchema.parse({ version: 1, files, totalBytes });
  return { manifest, hash: artifactManifestHash(manifest) };
}

/**
 * Re-read every manifest file through O_NOFOLLOW and compare the complete
 * entry. Call immediately before creating Git blobs; a changed byte, mode,
 * inode or path is a refusal, never a silently revised publication.
 */
export function revalidateArtifactManifest(input: {
  readonly workspaceRoot: string;
  readonly manifest: ArtifactManifest;
  readonly expectedHash?: string;
  readonly limits?: Partial<ArtifactLimits>;
}): BuiltArtifactManifest {
  const expected = artifactManifestSchema.parse(input.manifest);
  const expectedHash = input.expectedHash
    ? sha256Schema.parse(input.expectedHash)
    : artifactManifestHash(expected);
  if (artifactManifestHash(expected) !== expectedHash) {
    throw new ArtifactPolicyError('hash', 'artifact manifest hash does not match its contents');
  }
  const rebuilt = buildArtifactManifest({
    workspaceRoot: input.workspaceRoot,
    declaredPaths: expected.files.map((file) => file.path),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  if (rebuilt.hash !== expectedHash || JSON.stringify(rebuilt.manifest) !== JSON.stringify(expected)) {
    throw new ArtifactPolicyError('changed', 'artifact files changed after the manifest was recorded');
  }
  return rebuilt;
}

/**
 * Read one exact manifest entry for upload. It performs the same stable-fd
 * checks as manifest construction and refuses a byte or mode mismatch.
 */
export function readManifestArtifact(input: {
  readonly workspaceRoot: string;
  readonly expected: ArtifactFile;
  readonly limits?: Partial<ArtifactLimits>;
}): Buffer {
  const expected = artifactFileSchema.parse(input.expected);
  const actual = secureRead(input.workspaceRoot, expected.path, resolvedLimits(input.limits));
  if (JSON.stringify(actual.file) !== JSON.stringify(expected)) {
    throw new ArtifactPolicyError('changed', `artifact no longer matches its manifest: ${expected.path}`);
  }
  return actual.bytes;
}
