import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The worker image must contain everything the worker imports.
 *
 * THE INCIDENT (F9): `record_probe` landed, `builtin.ts` gained an import of
 * `../contracts/probeManifest.js` — the probe-manifest schemas, which exist
 * precisely so the manifest has ONE definition — and the Dockerfile still
 * copied only `dist/tools` and `dist/core`. A clean rebuild therefore
 * produced an image that died at startup with ERR_MODULE_NOT_FOUND, and
 * `zod` (that contract's only dependency) was missing from the image's
 * package.json as well.
 *
 * WHY NOTHING CAUGHT IT. `container-isolation.test.ts` drives a REAL
 * container, which is the right call for a claim about the container — but
 * it SKIPS when the image is absent, and it passes against a STALE image
 * built before the import existed. That is the staleness trap this file
 * already records for the egress-proxy fix: "the image carries compiled
 * dist/, so a host-side fix does nothing until `npm run build:worker:dev`".
 *
 * So this test never touches Docker and never skips. It walks the worker's
 * REAL import graph and asserts the Dockerfile and the image's package.json
 * cover it. Cheap, always-on, and it fails on the NEXT cross-directory
 * import rather than on this one.
 *
 * Conservative on purpose: `import type` is dropped (tsc erases it, so it
 * cannot make the image fail), while a value-syntax import is counted even
 * if it happens to bind only types. Over-counting costs one COPY line;
 * under-counting costs a broken image.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SRC = resolve(REPO, 'src');
/**
 * EVERY entry point the image can be started at, not only the worker.
 *
 * The image is launched three ways — the worker over stdio, and two long-
 * running relays the launcher starts with an explicit `node <file>` command
 * — and each is a root of its own import graph. Walking only the worker
 * would let a relay gain a cross-directory import and die at startup on a
 * clean rebuild, which is exactly the incident this file exists for.
 */
const ENTRIES = [
  resolve(SRC, 'tools/worker.ts'),
  resolve(SRC, 'tools/egressProxy.ts'),
  resolve(SRC, 'tools/previewIngress.ts'),
];

interface Closure {
  /** Top-level `src/<dir>` directories reached, e.g. 'tools', 'contracts'. */
  readonly dirs: Set<string>;
  /** Bare specifiers reached — npm packages, `node:` builtins excluded. */
  readonly external: Set<string>;
  readonly files: Set<string>;
}

/**
 * Follow value imports from `entry`, mirroring what `tsc` emits.
 *
 * Matches `import ... from '<spec>'` and `export ... from '<spec>'`, skipping
 * `import type` / `export type`. Relative specifiers carry the compiled `.js`
 * extension (NodeNext), so they map back to `.ts` on the way in.
 */
function importClosure(entry: string): Closure {
  const dirs = new Set<string>();
  const external = new Set<string>();
  const files = new Set<string>();

  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);

    const top = relative(SRC, file).split(sep)[0];
    if (top) dirs.add(top);

    const source = readFileSync(file, 'utf8');
    const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) continue; // `import type` — erased by tsc
      const spec = match[2];
      if (!spec || spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        external.add(spec);
        continue;
      }
      visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };

  visit(entry);
  return { dirs, external, files };
}

/** `COPY dist/<dir> ...` lines, as the directory names alone. */
function copiedDistDirs(dockerfile: string): Set<string> {
  const copied = new Set<string>();
  const pattern = /^\s*COPY\s+dist\/([A-Za-z0-9_-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dockerfile)) !== null) {
    if (match[1]) copied.add(match[1]);
  }
  return copied;
}

/** npm package name from a specifier: '@scope/pkg/sub.js' → '@scope/pkg'. */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

const closure = ENTRIES.map(importClosure).reduce<Closure>(
  (merged, one) => ({
    dirs: new Set([...merged.dirs, ...one.dirs]),
    external: new Set([...merged.external, ...one.external]),
    files: new Set([...merged.files, ...one.files]),
  }),
  { dirs: new Set(), external: new Set(), files: new Set() }
);
const dockerfile = readFileSync(resolve(REPO, 'docker/worker.Dockerfile'), 'utf8');
const workerPkg = JSON.parse(
  readFileSync(resolve(REPO, 'docker/worker-package.json'), 'utf8')
) as { dependencies?: Record<string, string> };
const rootPkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

describe('worker image closure — everything the worker imports must be in the image', () => {
  it('reaches the imports the incident was about', () => {
    // A guard whose walk found nothing would pass vacuously forever. Pin the
    // two facts F9 was: the contract module is reached, and it is reached
    // from the tool layer rather than being some stray edge.
    expect(closure.files.has(resolve(SRC, 'contracts/probeManifest.ts'))).toBe(true);
    expect(closure.files.has(resolve(SRC, 'tools/builtin.ts'))).toBe(true);
    expect(closure.dirs.has('contracts')).toBe(true);
  });

  it('walks every container entry point, not only the worker', () => {
    // A relay that is started by its own `node <file>` command is a root the
    // worker's graph never reaches.
    expect(closure.files.has(resolve(SRC, 'tools/egressProxy.ts'))).toBe(true);
    expect(closure.files.has(resolve(SRC, 'tools/previewIngress.ts'))).toBe(true);
  });

  it('COPYs every src/ directory the worker imports', () => {
    const copied = copiedDistDirs(dockerfile);
    const missing = [...closure.dirs].filter((d) => !copied.has(d)).sort();
    // The message names the fix, because the failure surfaces far from its
    // cause: the image builds fine and dies only at startup.
    expect(missing, `add to docker/worker.Dockerfile: ${missing.map((d) => `COPY dist/${d} ./dist/${d}`).join('; ')}`).toEqual([]);
  });

  it('declares every npm package the worker imports', () => {
    const declared = new Set(Object.keys(workerPkg.dependencies ?? {}));
    const needed = [...closure.external].map(packageName);
    const missing = [...new Set(needed)].filter((p) => !declared.has(p)).sort();
    expect(missing, `add to docker/worker-package.json dependencies: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('keeps shared dependency ranges in step with the root package.json', () => {
    // The image installs its own tree but runs the SAME compiled dist/, so a
    // drifted major would break inside the container only — the hardest
    // place to see it. Any package in both manifests must carry one range.
    const drifted = Object.entries(workerPkg.dependencies ?? {})
      .filter(([name]) => rootPkg.dependencies?.[name] !== undefined)
      .filter(([name, range]) => rootPkg.dependencies?.[name] !== range)
      .map(([name, range]) => `${name}: worker ${range} vs root ${rootPkg.dependencies?.[name]}`);
    expect(drifted).toEqual([]);
  });

  it('builds the worker from packaged dist without requiring source files', () => {
    expect(rootPkg.scripts?.['build:worker']).toBe(
      'docker build -f docker/worker.Dockerfile -t atoma-worker:latest .'
    );
    expect(rootPkg.scripts?.['build:worker:dev']).toBe(
      'npm run build && npm run build:worker'
    );
  });
});

/**
 * The PREVIEW image is the opposite guard: the worker's must CONTAIN
 * everything it imports, and this one must contain NOTHING of ours.
 *
 * The process it starts is not our code. It is whatever a run produced, and
 * every line of atoma reachable from inside it is a line a member's generated
 * application inherits. The isolation lives in the launcher's flags; the image
 * only has to stay empty.
 */
describe('preview image — it must hold nothing of atoma', () => {
  const preview = readFileSync(resolve(REPO, 'docker/preview.Dockerfile'), 'utf8');
  // The INSTRUCTIONS, not the prose. This file explains at length why it
  // installs nothing, and an assertion that read the comments would fail on
  // its own rationale.
  const instructions = preview
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('copies no compiled output, no source and no package manifest', () => {
    const copies = [...instructions.matchAll(/^COPY\s+(.+)$/gm)].map((m) => m[1]!.trim());
    expect(copies).toEqual([]);
  });

  it('installs nothing', () => {
    // No `npm install` layer: a deliverable brings its own node_modules in the
    // copied workspace or it does not run. Installing at open time would put a
    // network operation on a member's click, in a container with no egress.
    // No apt layer either: every package is surface the generated code gets.
    expect(instructions).not.toMatch(/npm\s+(install|ci)/);
    expect(instructions).not.toMatch(/apt-get\s+install/);
  });

  it('runs as a non-root user distinct from the worker’s', () => {
    // Both images are mounted by the same host process; a shared uid would let
    // a file written for one be written by the other.
    const previewUid = /useradd.*-u (\d+)/.exec(preview)?.[1];
    const workerUid = /useradd.*-u (\d+)/.exec(dockerfile)?.[1];
    expect(previewUid).toBeDefined();
    expect(previewUid).not.toBe(workerUid);
    expect(preview).toMatch(/^USER preview$/m);
  });

  it('declares no command of its own', () => {
    // The launcher passes `--entrypoint node` and the ONE start command the
    // profile allows. An ENTRYPOINT here would wrap it, and a preview that
    // could choose its own command would be a remote shell with a nice name.
    expect(preview).toMatch(/^ENTRYPOINT \[\]$/m);
    expect(preview).toMatch(/^CMD \[\]$/m);
  });

  it('is built by a script, so an operator does not hand-write the build', () => {
    expect(rootPkg.scripts?.['build:preview']).toContain('docker/preview.Dockerfile');
  });
});
