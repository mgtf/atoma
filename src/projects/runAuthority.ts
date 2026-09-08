import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { roleAtLeast, type OrgRole } from '../auth/store.js';
import { projectRunIdSchema, type ProjectRun } from '../contracts/projects.js';
import type { RegistryOwner } from '../contracts/registryOwner.js';
import { ProjectStore } from './store.js';

/** Current run, project and requesting member; stored identifiers alone grant nothing. */
export function eligibleProjectRun(db: Database.Database, runId: string): ProjectRun | null {
  const projects = new ProjectStore(db, { initialize: false });
  const run = projects.getProjectRunAnyOrg(projectRunIdSchema.parse(runId));
  if (!run || run.status !== 'running' || projects.getProject(run.orgId, run.projectId)?.status !== 'active') return null;
  const member = db.prepare(`SELECT role FROM auth_memberships WHERE org_id = ? AND principal_id = ?`)
    .get(run.orgId, run.requestedByPrincipalId) as { role: OrgRole } | undefined;
  return member && roleAtLeast(member.role, 'org:member') ? run : null;
}

export interface ProjectRunPaths {
  dbPath: string; runId: string; workspacePath: string; skillsPath: string; runsPath: string;
}

export function projectRunPathsMatch(run: ProjectRun, input: ProjectRunPaths): boolean {
  return resolve(input.workspacePath) === resolve(run.hostPaths.workspacePath) &&
    resolve(input.runsPath) === resolve(run.hostPaths.runsPath) &&
    resolve(input.skillsPath) === join(dirname(dirname(dirname(resolve(run.hostPaths.workspacePath)))), 'skills');
}

/** Resolves before any writable handle or provider is opened, even with retrieval disabled. */
export function resolveProjectRegistryOwner(input: ProjectRunPaths): RegistryOwner {
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const run = eligibleProjectRun(db, input.runId);
    if (!run || !projectRunPathsMatch(run, input)) throw new Error('denied');
    return { kind: 'project', orgId: run.orgId, projectId: run.projectId };
  } finally { db.close(); }
}
