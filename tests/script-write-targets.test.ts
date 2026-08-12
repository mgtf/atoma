import { describe, it, expect } from 'vitest';
import {
  scriptWriteTargets,
  subtaskNamedPaths,
  subtaskMutationTargets,
  scriptCanServeSubtask,
} from '../src/skills/scriptTargets.js';

/**
 * Per-DESTINATION capability test for compiled scripts.
 *
 * Round 6 shipped an any-write predicate ("does this body write?"). Round 7
 * measured it firing ZERO times: every compiled verifier merges observations
 * back into `.atoma-probes.json`, so it is classified a writer and the filter
 * is inert on the whole class it was built for.
 *
 * The fixture below is the SHAPE of the real round-7 compiled body
 * (`Lithium/recheck-invocations-vs-probes`): it WRITES the manifest and only
 * READS the README. That distinction is the entire point.
 */

/** Faithful reduction of the archived round-7 verifier. */
const REAL_VERIFIER = `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const manifestPath = path.join(cwd, '.atoma-probes.json');
const readmePath = path.join(cwd, 'README.md');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const readme = fs.readFileSync(readmePath, 'utf8');
for (const entry of manifest.entries) {
  const r = spawnSync('node', ['wclite.js'], { encoding: 'utf8' });
  if (r.status !== entry.exitCode) process.exit(1);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output: { ok: true }, summary: 'replayed' }));
`;

describe('scriptWriteTargets — which file does this body actually write', () => {
  it('separates the manifest it WRITES from the README it only READS', () => {
    // The exact miss of the any-write predicate: this body contains the
    // literal 'README.md', but only as a read.
    const { paths, opaque } = scriptWriteTargets(REAL_VERIFIER);
    expect([...paths]).toEqual(['.atoma-probes.json']);
    expect(paths.has('README.md')).toBe(false);
    expect(opaque).toBe(false);
  });

  it('resolves the shapes the corpus actually uses', () => {
    const cases: Array<[string, string]> = [
      [`fs.writeFileSync('README.md', body);`, 'README.md'],
      [`fs.writeFileSync(path.join(cwd, '.atoma-probes.json'), s);`, '.atoma-probes.json'],
      ['fs.writeFileSync(`${cwd}/package.json`, s);', 'package.json'],
      [`const out = 'docs/INDEX.md';\nfs.writeFileSync(out, s);`, 'INDEX.md'],
      [`fs.renameSync(tmp, 'README.md');`, 'README.md'], // destination is arg 1
    ];
    for (const [body, expected] of cases) {
      const { paths, opaque } = scriptWriteTargets(body);
      expect([...paths], body).toEqual([expected]);
      expect(opaque, body).toBe(false);
    }
  });

  it('reports OPAQUE rather than guessing, for every unresolvable destination', () => {
    const opaqueBodies = [
      `fs.writeFileSync(path.join(cwd, name), s);`, // runtime variable
      `fs.writeFileSync(matches[0], s);`, // glob result — a real corpus body
      `for (const f of files) fs.writeFileSync(f, s);`,
      `fs.writeFileSync(base + '.md', s);`, // empty stem: '.md' is a phantom
    ];
    for (const body of opaqueBodies) {
      const { paths, opaque } = scriptWriteTargets(body);
      expect(opaque, body).toBe(true);
      expect(paths.size, body).toBe(0);
    }
  });

  it('does not count mkdir — a directory is not a deliverable', () => {
    expect(scriptWriteTargets(`fs.mkdirSync(path.join(cwd, 'docs'));`).paths.size).toBe(0);
  });

  it('is not confused by a comma inside a string argument', () => {
    const { paths } = scriptWriteTargets(`fs.writeFileSync('a,b.md', 'x, y, z');`);
    expect([...paths]).toEqual(['a,b.md']);
  });
});

describe('subtaskNamedPaths', () => {
  it('reuses the extractor the deliverable gate uses, down to its traps', () => {
    expect(subtaskNamedPaths('update README.md and wclite.js')).toEqual(['README.md', 'wclite.js']);
    // `1.0.0` must not parse as a filename (letter-initial extension rule).
    expect(subtaskNamedPaths('bump the version to 1.0.0')).toEqual([]);
  });

  it('reduces to basenames so a path.join body still matches a docs/ subtask', () => {
    expect(subtaskNamedPaths('rewrite docs/INDEX.md')).toEqual(['INDEX.md']);
  });
});

describe('subtaskMutationTargets — outputs, not every mentioned file', () => {
  it('separates a destination from the source file it is derived from', () => {
    expect(subtaskMutationTargets('update README.md from package.json')).toEqual(['README.md']);
    expect(subtaskMutationTargets('using package.json, rewrite README.md')).toEqual(['README.md']);
    expect(subtaskMutationTargets('read package.json and write README.md')).toEqual(['README.md']);
  });

  it('recognises passive and multi-target mutation grammar', () => {
    expect(subtaskMutationTargets('README.md must be updated')).toEqual(['README.md']);
    expect(
      subtaskMutationTargets('update README.md, refresh .atoma-probes.json and edit wclite.js')
    ).toEqual(['README.md', '.atoma-probes.json', 'wclite.js']);
  });
});

describe('scriptCanServeSubtask — the match-time decision', () => {
  it('REFUSES the manifest-only verifier for a README update — the round-6/7 fallback', () => {
    expect(
      scriptCanServeSubtask(
        REAL_VERIFIER,
        'Using the verdicts from the previous phase, update README.md so that only the invocations whose behaviour legitimately changed are corrected'
      )
    ).toBe(false);
  });

  it('REFUSES it for the code-edit subtask too', () => {
    expect(scriptCanServeSubtask(REAL_VERIFIER, 'apply ONE minimal edit to wclite.js')).toBe(false);
  });

  it('OFFERS it for the re-verification subtask it exists to serve', () => {
    // Both legitimate dispatches of rounds 6-7 read like this, and neither
    // carries a mutating verb — so the path comparison never even runs.
    expect(
      scriptCanServeSubtask(
        REAL_VERIFIER,
        'Re-execute every invocation documented in the README and report which produced output identical to the recorded run'
      )
    ).toBe(true);
  });

  it('OFFERS a genuine writer for the file it genuinely writes', () => {
    const writer = `
      const readme = path.join(cwd, 'README.md');
      const pkg = path.join(cwd, 'package.json');
      fs.writeFileSync(readme, body);
      fs.writeFileSync(pkg, JSON.stringify(manifest));
    `;
    expect(scriptCanServeSubtask(writer, 'add package.json and write README.md')).toBe(true);
  });

  it('does not require a documentation generator to overwrite its input file', () => {
    const readPackageWriteReadme = `
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      fs.writeFileSync('README.md', render(pkg));
    `;
    expect(
      scriptCanServeSubtask(
        readPackageWriteReadme,
        'update README.md from the current package.json'
      )
    ).toBe(true);
  });

  it('requires ALL named files, not merely one — the round-6 three-file fallback', () => {
    // A subtask naming the manifest ALONGSIDE two files the verifier can never
    // write. Under an ANY rule the non-empty intersection lets it through.
    const both = 'update README.md, refresh .atoma-probes.json and edit wclite.js';
    expect(subtaskNamedPaths(both)).toContain('.atoma-probes.json');
    expect(scriptCanServeSubtask(REAL_VERIFIER, both)).toBe(false);
  });

  it('OFFERS whenever the destination is unprovable — refuse only on proof', () => {
    // A false refusal is permanent (lost dispatch AND lost credit); a false
    // offer costs two tool calls before the deliverable gate catches it.
    expect(
      scriptCanServeSubtask(`fs.writeFileSync(matches[0], body);`, 'update README.md')
    ).toBe(true);
  });

  it('OFFERS when the subtask names no file at all', () => {
    expect(scriptCanServeSubtask(REAL_VERIFIER, 'update the documented behaviour')).toBe(true);
  });
});
