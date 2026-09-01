import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  ArtifactPolicyError,
  DEFAULT_ARTIFACT_LIMITS,
  normalizeArtifactPath,
  secretLike,
  secureReadWorkspaceFile,
  type ArtifactLimits,
  type WorkspacePathPolicy,
} from '../projects/artifacts.js';
import { PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';

/**
 * WHAT A PREVIEW MAY READ, COPY AND SERVE.
 *
 * Three exclusion policies over ONE path jail. The jail — traversal, every
 * symlink component, the real-path re-check, the stable-fd read — is
 * `src/projects/artifacts.ts` and is not restated here; only the exclusion
 * list differs, and it differs for reasons worth writing down:
 *
 *   CLASSIFY  may read `.atoma-probes.json`, because that record is how the
 *             host learns what the run built. It is the one `.atoma-*` file
 *             any preview code touches, and it is never served or copied.
 *   COPY      excludes `.atoma*` and secrets but KEEPS `node_modules`:
 *             executing a Node deliverable needs its dependencies, and this
 *             copy is mounted into an isolate, not handed to anybody.
 *   SERVE     excludes `node_modules` too. A static preview is the workspace
 *             read through an HTTP surface, and publication does not put a
 *             dependency tree on the internet either.
 *
 * `.git` and `secretLike` are refused by all three. Publication and preview
 * are the two ways workspace bytes leave the run that produced them; a file
 * publication refuses must not become readable by serving it instead.
 */

export type PreviewPolicyCode =
  | 'path'
  | 'excluded'
  | 'missing'
  | 'symlink'
  | 'special'
  | 'limit';

export class PreviewPolicyError extends Error {
  constructor(
    readonly code: PreviewPolicyCode,
    message: string
  ) {
    super(message);
    this.name = 'PreviewPolicyError';
  }
}

/** Refused by every preview policy, whatever the caller is doing. */
function alwaysExcluded(segment: string): boolean {
  return segment.toLowerCase() === '.git' || secretLike(segment);
}

function refuse(canonicalPath: string): never {
  throw new PreviewPolicyError(
    'excluded',
    `path is excluded from the preview: ${canonicalPath}`
  );
}

/**
 * The classifier's policy: the probe manifest at the workspace ROOT is
 * readable, every other `.atoma*` path is not.
 *
 * Anchored at the root on purpose. `sandbox.resolve(PROBE_MANIFEST_FILENAME)`
 * is where every manifest writer puts it, so a nested `.atoma-probes.json`
 * was written by something else and is not this run's record.
 */
export const assertPreviewClassifiablePath: WorkspacePathPolicy = (canonicalPath) => {
  if (canonicalPath === PROBE_MANIFEST_FILENAME) return;
  for (const segment of canonicalPath.split('/')) {
    const lower = segment.toLowerCase();
    if (alwaysExcluded(segment) || lower === '.atoma' || lower.startsWith('.atoma-')) {
      refuse(canonicalPath);
    }
  }
};

/** What may enter the ephemeral copy an isolate mounts. `node_modules` may. */
export const assertPreviewCopyablePath: WorkspacePathPolicy = (canonicalPath) => {
  for (const segment of canonicalPath.split('/')) {
    const lower = segment.toLowerCase();
    if (alwaysExcluded(segment) || lower === '.atoma' || lower.startsWith('.atoma-')) {
      refuse(canonicalPath);
    }
  }
};

/** What the gateway may serve on the static path. `node_modules` may not. */
export const assertPreviewServablePath: WorkspacePathPolicy = (canonicalPath) => {
  for (const segment of canonicalPath.split('/')) {
    const lower = segment.toLowerCase();
    if (
      alwaysExcluded(segment) ||
      lower === 'node_modules' ||
      lower === '.atoma' ||
      lower.startsWith('.atoma-')
    ) {
      refuse(canonicalPath);
    }
  }
};

/**
 * Reads the classifier makes are SMALL by contract and the cap says so.
 *
 * 256 KiB, from design §6, and it is a real bound rather than a formality: the
 * manifest is machine-written, one entry per probe, and a document larger than
 * this is not a record the classifier should be parsing whole. The trace's
 * lesson applies in reverse here — bound a file whose size is bounded by
 * contract, never one whose size grows with the work.
 */
export const PREVIEW_CLASSIFIER_LIMITS: ArtifactLimits = {
  ...DEFAULT_ARTIFACT_LIMITS,
  maxFileBytes: 256 * 1024,
};

/**
 * Read one classifier input, or `null` when it simply is not there.
 *
 * ABSENCE IS AN ANSWER, refusal is not: a workspace with no `package.json` is
 * ordinary and must classify, while a `package.json` that is a symlink, a
 * device node, or something that changed mid-read is a workspace the host
 * declines to describe. So a missing file returns null and every other policy
 * failure propagates.
 */
export function readPreviewClassifierFile(
  workspaceRoot: string,
  relativePath: string
): string | null {
  try {
    const read = secureReadWorkspaceFile(
      workspaceRoot,
      relativePath,
      PREVIEW_CLASSIFIER_LIMITS,
      assertPreviewClassifiablePath
    );
    return read.bytes.toString('utf8');
  } catch (error) {
    if (error instanceof ArtifactPolicyError && error.code === 'missing') return null;
    throw error;
  }
}

/** Does this workspace hold a regular, non-symlinked file at `relativePath`? */
export function previewWorkspaceHasFile(workspaceRoot: string, relativePath: string): boolean {
  let canonical: string;
  try {
    canonical = normalizeArtifactPath(relativePath);
  } catch {
    return false;
  }
  const root = path.resolve(workspaceRoot);
  let cursor = root;
  for (const segment of canonical.split('/')) {
    cursor = path.join(cursor, segment);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch {
      return false;
    }
    // A symlink anywhere on the way makes the answer ambiguous, and an
    // ambiguous answer must never become an entry a container then executes.
    if (stat.isSymbolicLink()) return false;
  }
  try {
    return lstatSync(cursor).isFile();
  } catch {
    return false;
  }
}

/* ─────────────────────────── the materialised copy ────────────────────────── */

export interface PreviewCopyLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

/** Design §5. Overridable per deployment through `ATOMA_PREVIEW_COPY_MAX_BYTES`. */
export const DEFAULT_PREVIEW_COPY_LIMITS: PreviewCopyLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 50_000,
};

export interface PreviewCopyResult {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
}

/**
 * A workspace deep enough to exhaust the call stack is not a deliverable
 * anybody wrote. Bounding the walk keeps a hostile tree from turning a preview
 * into a control-plane crash.
 */
const MAX_COPY_DEPTH = 64;

/**
 * Copy one regular file through descriptors that cannot be redirected.
 *
 * `copyFileSync` resolves its source path AGAIN, so a path that was a regular
 * file at `lstat` and is a symlink a moment later would be followed — and the
 * bytes it pulled in from outside the workspace would then be mounted into a
 * container. Opening `O_NOFOLLOW` and copying from the descriptor closes that
 * window: the file this reads is the file that was checked, or the open fails.
 *
 * Streamed rather than `readFileSync`'d because the per-copy budget is 512 MiB
 * and a copy must not need that much resident memory to move it.
 */
function copyRegularFileNoFollow(source: string, destination: string): number {
  const from = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(from);
    if (!opened.isFile()) {
      throw new PreviewPolicyError('special', 'source stopped being a regular file mid-copy');
    }
    const to = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let copied = 0;
      for (;;) {
        const read = readSync(from, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) {
          written += writeSync(to, buffer, written, read - written);
        }
        copied += read;
      }
      return copied;
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

/**
 * Copy a delivered workspace into a fresh ephemeral directory an isolate can
 * mount read-write.
 *
 * THE ORIGINAL IS NEVER TOUCHED. The delivered workspace is the durable
 * deliverable AND the seed of the next run (`previousDeliveredWorkspace`), so
 * the app writes to the copy and the copy is deleted at teardown. Everything
 * here is `lstat`-driven: a symlink is SKIPPED rather than followed, because
 * following one would let a link inside the workspace pull bytes from outside
 * it into a directory that is about to be mounted into a container.
 *
 * Caps are refusals, not truncations. A copy that silently stopped at the cap
 * would mount a half-application and report `ready`, and the member would be
 * debugging our bookkeeping instead of their app.
 */
export function materializePreviewWorkspace(input: {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly limits?: Partial<PreviewCopyLimits>;
}): PreviewCopyResult {
  const limits = { ...DEFAULT_PREVIEW_COPY_LIMITS, ...(input.limits ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PreviewPolicyError('limit', `${name} must be a positive safe integer`);
    }
  }

  const source = path.resolve(input.sourceRoot);
  const destination = path.resolve(input.destinationRoot);
  let sourceStat: Stats;
  try {
    sourceStat = lstatSync(source);
  } catch {
    throw new PreviewPolicyError('missing', 'the delivered workspace does not exist');
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new PreviewPolicyError('special', 'the delivered workspace is not a real directory');
  }
  // Refuse to write into or through the source. A destination under the source
  // would copy the copy; a source under the destination would be erased by a
  // teardown that believes it owns everything below it.
  const sourceToDestination = path.relative(source, destination);
  const destinationToSource = path.relative(destination, source);
  if (
    destination === source ||
    (sourceToDestination !== '' && !sourceToDestination.startsWith('..') && !path.isAbsolute(sourceToDestination)) ||
    (destinationToSource !== '' && !destinationToSource.startsWith('..') && !path.isAbsolute(destinationToSource))
  ) {
    throw new PreviewPolicyError('path', 'the preview copy must not nest with its source');
  }

  let files = 0;
  let bytes = 0;
  let skipped = 0;

  const walk = (relative: string, depth: number): void => {
    if (depth > MAX_COPY_DEPTH) {
      throw new PreviewPolicyError(
        'limit',
        `the delivered workspace nests deeper than ${MAX_COPY_DEPTH} directories`
      );
    }
    const absoluteSource = relative === '' ? source : path.join(source, relative);
    mkdirSync(relative === '' ? destination : path.join(destination, relative), {
      recursive: true,
    });
    for (const dirent of readdirSync(absoluteSource, { withFileTypes: true })) {
      const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      try {
        assertPreviewCopyablePath(childRelative);
      } catch (error) {
        if (error instanceof PreviewPolicyError && error.code === 'excluded') {
          skipped += 1;
          continue;
        }
        throw error;
      }
      const childSource = path.join(source, ...childRelative.split('/'));
      // lstat, and lstat ONLY: `dirent.isFile()` on some platforms reflects a
      // cached type, and the decision that a path is an ordinary file is the
      // decision to copy its bytes into a mount.
      let stat: Stats;
      try {
        stat = lstatSync(childSource);
      } catch {
        // Vanished between readdir and lstat: a run's own leftover temp file,
        // not a reason to fail a preview of a delivered workspace.
        skipped += 1;
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        skipped += 1;
        continue;
      }
      if (stat.isDirectory()) {
        walk(childRelative, depth + 1);
        continue;
      }
      files += 1;
      if (files > limits.maxFiles) {
        throw new PreviewPolicyError(
          'limit',
          `the delivered workspace holds more than ${limits.maxFiles} files`
        );
      }
      // Count what was ACTUALLY copied, not what `lstat` predicted. A file
      // that grew between the two would otherwise let the copy exceed a cap
      // the caller was told it respected.
      bytes += copyRegularFileNoFollow(
        childSource,
        path.join(destination, ...childRelative.split('/'))
      );
      if (bytes > limits.maxBytes) {
        throw new PreviewPolicyError(
          'limit',
          `the delivered workspace exceeds ${limits.maxBytes} bytes`
        );
      }
    }
  };

  walk('', 0);
  return { files, bytes, skipped };
}
