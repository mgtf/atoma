import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ProjectStore } from '../projects/store.js';
import { SkillRegistry, parseFrontmatter, readMetaChecked } from './registry.js';
import { appendLedgerStrict, LEDGER_TABLE_DDL } from '../core/ledger.js';
import type { SkillMeta } from './types.js';

/** Copy preserved project recipes into the commons; never delete or overwrite originals. */
export function migratePlatformSkills(input: { dbPath: string; projectsRoot: string; skillsRoot: string }): number {
  const db = new Database(input.dbPath, { fileMustExist: true });
  try {
    const projects = new ProjectStore(db, { initialize: false }).listAllProjects();
    const catalog = new SkillRegistry(input.skillsRoot);
    let imported = 0;
    for (const project of projects) {
      const source = join(resolve(input.projectsRoot), 'orgs', project.orgId, 'projects', project.projectId, 'skills');
      const receipt = join(catalog.rootDir, '.migrations', `${project.projectId}.json`);
      if (!existsSync(source) || existsSync(receipt)) continue;
      let ancestor = resolve(input.projectsRoot);
      for (const component of ['', ...relative(ancestor, source).split(sep)]) {
        ancestor = join(ancestor, component);
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`unsafe skills ancestor: ${ancestor}`);
      }
      assertRegularTree(source);
      if (existsSync(catalog.rootDir)) assertRegularTree(catalog.rootDir);
      const legacy = new SkillRegistry(source);
      const scoped = new SkillRegistry(catalog.rootDir, project.projectId);
      // Runtime readers tolerate broken recipes; migration must retain a retry
      // instead of marking an omitted recipe as successfully imported.
      for (const namespace of legacy.listNamespaces()) {
        for (const entry of readdirSync(join(source, namespace), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = join(source, namespace, entry.name);
          if (!existsSync(join(dir, 'SKILL.md'))) continue;
          const { frontmatter } = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
          if (frontmatter.id !== entry.name || readMetaChecked(join(dir, '_meta.json')).corrupt) {
            throw new Error(`invalid legacy skill: ${namespace}/${entry.name}`);
          }
        }
      }
      const entries = legacy.listNamespaces().flatMap(namespace => legacy.loadFor(namespace).map(skill => ({ namespace, skill })));
      if (entries.length === 0) continue;
      // Check all collisions before the first catalog write. A different body
      // under the same persisted identity requires an explicit reconciliation.
      for (const { namespace, skill } of entries) {
        const from = join(source, namespace, skill.id, 'SKILL.md');
        const to = join(catalog.rootDir, namespace, skill.id, 'SKILL.md');
        if (existsSync(to) && !readFileSync(from).equals(readFileSync(to))) {
          throw new Error(`platform skills migration conflict: ${namespace}/${skill.id}`);
        }
      }
      const backup = join(dirname(source), `skills-before-platform-${Date.now()}-${randomUUID()}`);
      cpSync(source, backup, { recursive: true, errorOnExist: true, force: false });
      for (const { namespace, skill } of entries) {
        const from = join(source, namespace, skill.id);
        const to = join(catalog.rootDir, namespace, skill.id);
        mkdirSync(to, { recursive: true });
        for (const file of ['SKILL.md', '_fallback.md', '_demoted-script.md']) {
          if (existsSync(join(from, file)) && !existsSync(join(to, file))) cpSync(join(from, file), join(to, file), { errorOnExist: true, force: false });
        }
        const oldMeta = join(from, '_meta.json');
        const trustMeta = scoped.trustMetaPath(join(to, '_meta.json'));
        if (existsSync(oldMeta) && !existsSync(trustMeta)) {
          mkdirSync(dirname(trustMeta), { recursive: true });
          cpSync(oldMeta, trustMeta, { errorOnExist: true, force: false });
        }
        if (!existsSync(join(to, '_meta.json'))) {
          // Retire the old unscoped ledger identity before zeroing catalog
          // trust. Original counters remain in the project/hash sidecar and
          // backup; the historical events remain append-only evidence.
          db.exec(LEDGER_TABLE_DDL);
          appendLedgerStrict({ kind: 'counters-reset', entity: `${namespace}/${skill.id}`,
            detail: { reason: 'platform-skills-migration', projectId: project.projectId,
              trustPath: relative(catalog.rootDir, trustMeta), backup } }, db);
          const publicMeta: SkillMeta = { successes: 0, failures: 0, updatedAt: skill.updatedAt,
            ...(skill.provenance ? { provenance: skill.provenance } : {}),
            ...(skill.compiledGeneration ? { compiledGeneration: skill.compiledGeneration } : {}),
            ...(skill.declaredWrites ? { declaredWrites: skill.declaredWrites } : {}) };
          writeFileSync(join(to, '_meta.json'), JSON.stringify(publicMeta), { flag: 'wx' });
        }
        let info: { name: string; tools_json: string } | undefined;
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='atom_types'").get()) {
          info = db.prepare('SELECT name, tools_json FROM atom_types WHERE atom_id = ?').get(namespace) as typeof info;
        }
        if (info) {
          const tools = JSON.parse(info.tools_json) as Array<{ name: string }>;
          catalog.registerNamespace(namespace, { name: info.name, tools: tools.map(tool => tool.name) });
        }
        imported++;
      }
      mkdirSync(dirname(receipt), { recursive: true });
      const temp = `${receipt}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ backup, count: entries.length }));
      renameSync(temp, receipt);
    }
    return imported;
  } finally { db.close(); }
}

function assertRegularTree(directory: string): void {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`unsafe skills directory: ${directory}`);
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`unsafe skills entry: ${file}`);
    if (stat.isDirectory()) assertRegularTree(file);
  }
}
