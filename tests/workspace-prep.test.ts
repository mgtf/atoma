import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorkspace } from '../src/run/workspace.js';

describe('prepareWorkspace — stale build workspace handling', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'atoma-ws-'));
    root = join(base, 'app');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function seedStale(): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.js'), 'from a run three months ago');
    mkdirSync(join(root, 'views'));
  }

  it('is a no-op on a missing workspace', () => {
    expect(() => prepareWorkspace(root, true)).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it('is a no-op on an empty workspace', () => {
    mkdirSync(root, { recursive: true });
    prepareWorkspace(root, true);
    expect(readdirSync(base)).toEqual(['app']);
  });

  it('WARNS but never touches the workspace by default', () => {
    seedStale();
    prepareWorkspace(root, false);
    // The deliverable is still exactly where the user left it. This is the
    // load-bearing default: the example cannot know whether the artefact
    // has been collected yet.
    expect(readdirSync(root).sort()).toEqual(['server.js', 'views']);
    expect(readdirSync(base)).toEqual(['app']);
  });

  it('ARCHIVES by rename rather than deleting when asked to clean', () => {
    seedStale();
    prepareWorkspace(root, true);
    expect(existsSync(root)).toBe(false);
    const archived = join(base, 'app.prev1');
    expect(readdirSync(archived).sort()).toEqual(['server.js', 'views']);
  });

  it('never overwrites an earlier archive (monotonic suffix)', () => {
    seedStale();
    prepareWorkspace(root, true);
    // A second run leaves different debris behind.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'csv2json.js'), 'from the run after that');
    prepareWorkspace(root, true);

    expect(readdirSync(join(base, 'app.prev1')).sort()).toEqual(['server.js', 'views']);
    expect(readdirSync(join(base, 'app.prev2'))).toEqual(['csv2json.js']);
  });
});
