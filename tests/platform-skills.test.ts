import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from '../src/skills/registry.js';
import { migratePlatformSkills } from '../src/skills/migratePlatform.js';
import { visibleSkillNamespaces } from '../src/skills/visibility.js';
import { asStoredNamespace } from '../src/skills/namespace.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectCounters, readLedger } from '../src/core/ledger.js';
import { randomUUID } from 'node:crypto';
import { resolveProjectRegistryOwner } from '../src/projects/runAuthority.js';

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'atoma-platform-skills-')); roots.push(path); return path; }
const recipe = { id: 'recover-missing-live-browser-proof', description: 'Establish browser proof', whenToUse: 'When browser proof is missing', kind: 'llm' as const, body: 'Run the browser probe and inspect its result.' };
afterEach(() => { closeStoreHandles(); vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('platform skill bodies and project trust', () => {
  it('authorizes the global catalog recorded by the host, and refuses a substituted path', () => {
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
    expect(resolveProjectRegistryOwner(input)).toEqual({ kind: 'project', orgId: fixture.viewer.orgId, projectId: fixture.project.projectId });
    expect(() => resolveProjectRegistryOwner({ ...input, skillsPath: layout.skillsPath })).toThrow('denied');
  });

  it('shares one body and its capability metadata without transferring trust', () => {
    const path = root();
    vi.stubEnv('ATOMA_LEDGER_DB', join(path, 'ledger.db'));
    const author = new SkillRegistry(path, 'project-a');
    const reader = new SkillRegistry(path, 'project-b');
    const catalog = new SkillRegistry(path);
    author.registerNamespace('molecule-a', { name: 'Water', tools: ['write_file'] });
    author.save('molecule-a', recipe);
    author.recordSuccess('molecule-a', recipe.id);
    author.markMatched('molecule-a', recipe.id);
    expect(author.loadFor('molecule-a')[0]).toMatchObject({ successes: 1, matches: 1 });
    expect(reader.loadFor('molecule-a')[0]).toMatchObject({ body: recipe.body, successes: 0, failures: 0 });
    expect(reader.loadFor('molecule-a')[0]?.matches).toBeUndefined();
    expect(catalog.loadFor('molecule-a')[0]?.body).toBe(recipe.body);
    expect(catalog.listNamespaces()).toEqual(['molecule-a']);
    const visible = visibleSkillNamespaces({ home: asStoredNamespace('molecule-b'), readerToolNames: ['write_file'],
      namespaces: reader.listNamespaces(), toolNamesFor: ns => reader.namespaceInfo(ns)?.tools ?? null });
    expect(visible).toContain('molecule-a');
    reader.recordFailure('molecule-a', recipe.id);
    expect(author.loadFor('molecule-a')[0]?.failures).toBe(0);
    expect(reader.loadFor('molecule-a')[0]?.failures).toBe(1);
    const projected = projectCounters(readLedger());
    for (const { entity, meta } of catalog.scopedCounterRecords()) {
      expect(projected.get(entity)).toMatchObject({ successes: meta.successes, failures: meta.failures });
    }
    author.save('molecule-a', { ...recipe, body: 'A revised browser procedure.' });
    expect(author.loadFor('molecule-a')[0]?.successes).toBe(0);
    expect(reader.loadFor('molecule-a')[0]?.failures).toBe(0);
  });

  it('migrates existing project recipes once, preserving their original bytes and scoped counters', () => {
    const path = root();
    const fixture = projectRetrievalFixture(path);
    vi.stubEnv('ATOMA_LEDGER_DB', fixture.dbPath);
    const { layout } = fixture.makeRun();
    const legacy = new SkillRegistry(layout.skillsPath);
    legacy.save('molecule-a', recipe);
    legacy.recordSuccess('molecule-a', recipe.id);
    const original = readFileSync(join(layout.skillsPath, 'molecule-a', recipe.id, '_meta.json'));
    const skillsRoot = join(path, 'platform-skills');
    const input = { dbPath: fixture.dbPath, projectsRoot: path, skillsRoot };
    expect(migratePlatformSkills(input)).toBe(1);
    expect(migratePlatformSkills(input)).toBe(0);
    expect(projectCounters(readLedger()).get(`molecule-a/${recipe.id}`)).toEqual({ successes: 0, failures: 0 });
    expect(readLedger().some(event => event.detail?.['reason'] === 'platform-skills-migration')).toBe(true);
    expect(new SkillRegistry(skillsRoot).loadFor('molecule-a')[0]).toMatchObject({ id: recipe.id, body: recipe.body, successes: 0 });
    expect(new SkillRegistry(skillsRoot, fixture.project.projectId).loadFor('molecule-a')[0]?.successes).toBe(1);
    expect(new SkillRegistry(skillsRoot, 'other-project').loadFor('molecule-a')[0]?.successes).toBe(0);
    expect(readFileSync(join(layout.skillsPath, 'molecule-a', recipe.id, '_meta.json')).equals(original)).toBe(true);
    expect(readdirSync(layout.projectRoot).some(name => name.startsWith('skills-before-platform-'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'molecule-a', recipe.id, 'SKILL.md'))).toBe(true);
    new SkillRegistry(skillsRoot, fixture.project.projectId).save('molecule-a', { ...recipe, body: 'New global revision.' });
    expect(migratePlatformSkills(input)).toBe(0);
    expect(new SkillRegistry(skillsRoot).loadFor('molecule-a')[0]?.body).toBe('New global revision.');
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
});
