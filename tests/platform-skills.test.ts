import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LEGACY_META_FILENAME, SkillRegistry, writeMetaAtomic } from '../src/skills/registry.js';
import { foldMergedNamespaces, foldScopedSkillTrust, migratePlatformSkills, reconcilePlatformSkills } from '../src/skills/migratePlatform.js';
import { visibleSkillNamespaces } from '../src/skills/visibility.js';
import { asStoredNamespace } from '../src/skills/namespace.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import { openDb } from '../src/registry/db.js';
import { assertProjectRunAuthority } from '../src/projects/runAuthority.js';

/**
 * ONE skills catalog, ONE trust, for every run on the platform
 * (`docs/platform-trust-2026-09-15.md`). What these hold:
 *   - two writers on one catalog share bodies AND counters;
 *   - a tenant run still proves it is the run the host registered, on the
 *     host's recorded catalog path;
 *   - the three folds bring every earlier partition into the one catalog —
 *     legacy per-project trees, `.trust/<project>/<sha>/` sidecars, and
 *     namespaces of atom identities the registry fold absorbed — each once,
 *     each keeping what it displaces beside the catalog.
 */

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'atoma-platform-skills-')); roots.push(path); return path; }
const recipe = { id: 'recover-missing-live-browser-proof', description: 'Establish browser proof', whenToUse: 'When browser proof is missing', kind: 'llm' as const, body: 'Run the browser probe and inspect its result.' };
afterEach(() => { closeStoreHandles(); vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('one platform skills catalog', () => {
  it('authorizes the run the host registered on its recorded catalog path, and refuses a substituted path', () => {
    const path = root();
    const fixture = projectRetrievalFixture(path);
    const { layout } = fixture.makeRun();
    const id = randomUUID();
    const skillsPath = join(path, 'shared-catalog');
    fixture.projects.createProjectRun({ orgId: fixture.viewer.orgId, projectId: fixture.project.projectId,
      principalId: fixture.viewer.principalId, projectRunId: id,
      request: { goal: 'Use the global catalog', idempotencyKey: id },
      hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath, skillsPath } });
    fixture.projects.transitionProjectRun({ orgId: fixture.viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
    const input = { dbPath: fixture.dbPath, runId: id, workspacePath: layout.workspacePath, runsPath: layout.runsPath, skillsPath };
    expect(assertProjectRunAuthority(input)).toMatchObject({ projectRunId: id, orgId: fixture.viewer.orgId, projectId: fixture.project.projectId });
    expect(() => assertProjectRunAuthority({ ...input, skillsPath: layout.skillsPath })).toThrow('denied');
  });

  it('shares one body, its capability metadata and its trust between every writer', () => {
    const path = root();
    vi.stubEnv('ATOMA_LEDGER_DB', join(path, 'ledger.db'));
    const author = new SkillRegistry(path);
    const reader = new SkillRegistry(path);
    author.registerNamespace('molecule-a', { name: 'Water', tools: ['write_file'] });
    author.save('molecule-a', recipe);
    author.recordSuccess('molecule-a', recipe.id);
    author.markMatched('molecule-a', recipe.id);
    expect(reader.loadFor('molecule-a')[0]).toMatchObject({ body: recipe.body, successes: 1, failures: 0, matches: 1 });
    const visible = visibleSkillNamespaces({ home: asStoredNamespace('molecule-b'), readerToolNames: ['write_file'],
      namespaces: reader.listNamespaces(), toolNamesFor: ns => reader.namespaceInfo(ns)?.tools ?? null });
    expect(visible).toContain('molecule-a');
    reader.recordFailure('molecule-a', recipe.id);
    expect(author.loadFor('molecule-a')[0]).toMatchObject({ successes: 1, failures: 1 });
    expect(projectCounters(readLedger()).get(`molecule-a/${recipe.id}`)).toEqual({ successes: 1, failures: 1 });
    // A body rewrite keeps the earned counters, as it always did on the platform.
    author.save('molecule-a', { ...recipe, body: 'A revised browser procedure.' });
    expect(reader.loadFor('molecule-a')[0]).toMatchObject({ body: 'A revised browser procedure.', successes: 1, failures: 1 });
    expect(existsSync(join(path, '.trust'))).toBe(false);
  });

  it('migrates legacy project recipes once, adding their counters to the catalog and keeping the originals', () => {
    const path = root();
    const fixture = projectRetrievalFixture(path);
    vi.stubEnv('ATOMA_LEDGER_DB', fixture.dbPath);
    const { layout } = fixture.makeRun();
    // A pre-2026-09-18 tree: the body, and its counters in a `_meta.json`
    // sidecar. Written by hand because no registry writes sidecars any more,
    // and because a live registry on this tree would share the catalog's rows.
    new SkillRegistry(layout.skillsPath, { db: openDb(':memory:') }).save('molecule-a', recipe);
    writeMetaAtomic(join(layout.skillsPath, 'molecule-a', recipe.id, LEGACY_META_FILENAME),
      { successes: 1, failures: 0, updatedAt: '2026-09-10T00:00:00.000Z' });
    const original = readFileSync(join(layout.skillsPath, 'molecule-a', recipe.id, LEGACY_META_FILENAME));
    const skillsRoot = join(path, 'platform-skills');
    // The catalog already holds the same body with one failure of its own.
    const catalog = new SkillRegistry(skillsRoot);
    catalog.save('molecule-a', recipe);
    catalog.recordFailure('molecule-a', recipe.id);
    const input = { dbPath: fixture.dbPath, projectsRoot: path, skillsRoot };
    expect(migratePlatformSkills(input)).toBe(1);
    expect(migratePlatformSkills(input)).toBe(0);
    expect(catalog.loadFor('molecule-a')[0]).toMatchObject({ id: recipe.id, body: recipe.body, successes: 1, failures: 1 });
    expect(readFileSync(join(layout.skillsPath, 'molecule-a', recipe.id, LEGACY_META_FILENAME)).equals(original)).toBe(true);
    expect(readdirSync(layout.projectRoot).some(name => name.startsWith('skills-before-platform-'))).toBe(true);
    expect(existsSync(join(skillsRoot, '.trust'))).toBe(false);
  });

  it('refuses conflicting identities instead of overwriting the platform body', () => {
    const path = root();
    const fixture = projectRetrievalFixture(path);
    const { layout } = fixture.makeRun();
    new SkillRegistry(layout.skillsPath).save('molecule-a', recipe);
    const skillsRoot = join(path, 'platform-skills');
    new SkillRegistry(skillsRoot).save('molecule-a', { ...recipe, body: 'Different existing body.' });
    expect(() => migratePlatformSkills({ dbPath: fixture.dbPath, projectsRoot: path, skillsRoot })).toThrow('conflict');
    expect(new SkillRegistry(skillsRoot).loadFor('molecule-a')[0]?.body).toBe('Different existing body.');
  });

  it('refuses corrupt legacy metadata without declaring migration complete', () => {
    const path = root();
    const fixture = projectRetrievalFixture(path);
    const { layout } = fixture.makeRun();
    new SkillRegistry(layout.skillsPath).save('molecule-a', recipe);
    writeFileSync(join(layout.skillsPath, 'molecule-a', recipe.id, '_meta.json'), '{broken');
    const skillsRoot = join(path, 'platform-skills');
    expect(() => migratePlatformSkills({ dbPath: fixture.dbPath, projectsRoot: path, skillsRoot })).toThrow('invalid legacy skill');
    expect(existsSync(join(skillsRoot, '.migrations', `${fixture.project.projectId}.json`))).toBe(false);
    expect(existsSync(join(skillsRoot, 'molecule-a', recipe.id, 'SKILL.md'))).toBe(false);
  });

  it('folds the per-project trust sidecars into the one sidecar and sets the tree aside', () => {
    const path = root();
    const catalog = new SkillRegistry(path);
    catalog.save('molecule-a', recipe);
    catalog.recordSuccess('molecule-a', recipe.id);
    // Two projects' scoped counters for this recipe, one for a recipe that no longer exists.
    for (const [project, digest, meta] of [
      ['project-a', 'sha-1', { successes: 2, failures: 1, matches: 3, updatedAt: '2026-09-15T10:00:00.000Z' }],
      ['project-b', 'sha-2', { successes: 1, failures: 0, updatedAt: '2026-09-15T09:00:00.000Z' }],
    ] as const) {
      const dir = join(path, '.trust', project, digest, 'molecule-a', recipe.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta));
    }
    const orphan = join(path, '.trust', 'project-a', 'sha-1', 'molecule-a', 'gone-recipe');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, '_meta.json'), JSON.stringify({ successes: 9, failures: 9, updatedAt: '2026-09-15T00:00:00.000Z' }));
    expect(foldScopedSkillTrust({ db: process.env['ATOMA_LEDGER_DB']!, skillsRoot: path })).toBe(2);
    expect(catalog.loadFor('molecule-a')[0]).toMatchObject({ successes: 4, failures: 1, matches: 3 });
    expect(existsSync(join(path, '.trust'))).toBe(false);
    const aside = readdirSync(path).filter(name => name.startsWith('.trust-before-platform-'));
    expect(aside).toHaveLength(1);
    expect(existsSync(join(path, aside[0]!, 'project-a', 'sha-1', 'molecule-a', 'gone-recipe', '_meta.json'))).toBe(true);
    // Idempotent, and a second reconcile touches nothing.
    expect(foldScopedSkillTrust({ db: process.env['ATOMA_LEDGER_DB']!, skillsRoot: path })).toBe(0);
    expect(catalog.loadFor('molecule-a')[0]).toMatchObject({ successes: 4, failures: 1 });
  });

  it('moves the recipes of an absorbed atom identity under the kept one, summing duplicates', () => {
    const path = root(); const dbPath = join(path, 'atoma.db');
    const kept = randomUUID(); const absorbed = randomUUID();
    const db = openDb(dbPath);
    db.prepare('INSERT INTO atom_id_merges VALUES (?, ?, ?, ?, ?)').run(absorbed, kept, 'Water', 'project:a:b', '2026-09-15T12:00:00.000Z');
    // The catalog's trust lives in the store the fold is handed (W4).
    const catalog = new SkillRegistry(join(path, 'skills'), { db });
    catalog.registerNamespace(absorbed, { name: 'Water', tools: ['write_file'] });
    catalog.save(absorbed, recipe);
    catalog.recordSuccess(absorbed, recipe.id);
    catalog.save(absorbed, { ...recipe, id: 'only-in-absorbed', body: 'Unique recipe.' });
    catalog.save(kept, { ...recipe, body: 'Kept body.' });
    catalog.recordFailure(kept, recipe.id);
    expect(reconcilePlatformSkills({ db, skillsRoot: join(path, 'skills') })).toMatchObject({ imported: 0, trust: 0, merged: 2 });
    const skills = catalog.loadFor(kept);
    expect(skills.map(skill => skill.id)).toEqual(['only-in-absorbed', recipe.id]);
    expect(skills.find(skill => skill.id === recipe.id)).toMatchObject({ body: 'Kept body.', successes: 1, failures: 1 });
    expect(catalog.listNamespaces()).toEqual([kept]);
    expect(existsSync(join(path, 'skills', absorbed))).toBe(false);
    const aside = join(path, 'skills', '.merged-before-platform');
    expect(readdirSync(aside).some(name => name.startsWith(absorbed))).toBe(true);
    // Idempotent: nothing left to move.
    expect(foldMergedNamespaces({ db: dbPath, skillsRoot: join(path, 'skills') })).toBe(0);
    // The moved trust is exact in the ledger too: the fold journaled what it
    // moved, so the projection meets the kept row and zeroes the absorbed key.
    const projected = projectCounters(readLedger(db));
    expect(projected.get(`${kept}/${recipe.id}`)).toEqual({ successes: 1, failures: 1 });
    expect(projected.get(`${absorbed}/${recipe.id}`)).toEqual({ successes: 0, failures: 0 });
    db.close();
  });
});
