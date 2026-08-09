import { describe, it, expect } from 'vitest';
import { resolve, relative, isAbsolute } from 'node:path';
import { buildProfile, defaultWorkspaceRoot } from '../src/run/profiles/build.js';

/**
 * The workspace must not live inside the repository.
 *
 * `run_shell`'s child is NOT jailed to the workspace — it is spawned with
 * `cwd` and nothing more — so wherever the workspace sits, model-authored
 * code can walk up from it. With the old `./build/app` default that walk
 * reached the atom registry, every skill body, the ledger and the user's
 * uncommitted git work in two hops. REPRODUCED before the move:
 * `ls ../../atoma-build.db ../../skills` listed the registry and all three
 * skill namespaces; from the new default it lists nothing.
 *
 * This is blast-radius reduction, NOT a boundary — an absolute path still
 * reaches anything the user can read, and the real boundary is an OS one
 * (docs/saas-architecture.md, invariant T1). The test exists because the
 * cheap half is also the easy half to undo: "put the workspace back in
 * build/ so it's easier to inspect" is a natural, well-meaning regression.
 */
describe('the build workspace lives outside the repo', () => {
  const repoRoot = resolve('.');

  it('the default is an absolute path outside the repository', () => {
    const ws = defaultWorkspaceRoot();
    expect(isAbsolute(ws)).toBe(true);
    const rel = relative(repoRoot, ws);
    // Inside the repo <=> the relative path neither escapes nor is absolute.
    const insideRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    expect(insideRepo, `workspace ${ws} is inside the repo ${repoRoot}`).toBe(false);
  });

  it('the profile uses it', () => {
    expect(buildProfile.defaults.workspace).toBe(defaultWorkspaceRoot());
  });

  it('no ancestor of the workspace is the repo root', () => {
    // The specific property that made the stores reachable: an ancestor
    // holding atoma-build.db / skills/ / atoma-ledger.jsonl.
    let dir = defaultWorkspaceRoot();
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      seen.push(dir);
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    expect(seen, `repo root ${repoRoot} is an ancestor of the workspace`).not.toContain(repoRoot);
  });
});
