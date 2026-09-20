#!/usr/bin/env node
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStoreHandles, openStoreHandle, storeDbPath } from '../core/stores.js';
import { acquireRunLeaseWithoutRecovery } from '../mcp/runLock.js';
import { orgRunLimitSchema, organisationIdSchema } from '../contracts/projects.js';
import { PlatformEventLog } from '../platform/events.js';
import { ProjectStore } from '../projects/store.js';
import { applyRetention, retentionPlan } from '../projects/retention.js';

const HELP = `atoma project maintenance

  npm run projects:maintenance -- limits --org <uuid> [--max-concurrent <0|1>]
  npm run projects:maintenance -- retention [--apply --services-stopped]
  Both commands accept --db <path>.

Retention defaults to a read-only plan. Before --apply, stop web, launcher,
analyst and all other writers; verify a restorable backup. --services-stopped
acknowledges this offline precondition. Active runtime rows or a held run lease
refuse application; nothing is reaped. Never delete lifecycle_events.
Roots: ATOMA_PROJECTS_ROOT and optional ATOMA_LAUNCHER_WORKSPACE_ROOT.
Limits default to one; zero suspends new runs without cancelling existing work.
`;

export function maintenanceMain(argv: string[]): void {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return; }
  const [command, ...args] = argv;
  if (command !== 'limits' && command !== 'retention') throw new Error(HELP);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (command === 'retention' && (arg === '--apply' || arg === '--services-stopped')) {
      if (flags.has(arg)) throw new Error('duplicate argument: ' + arg);
      flags.add(arg);
    } else if (arg === '--db' || (command === 'limits' && (arg === '--org' || arg === '--max-concurrent'))) {
      const value = args[++index];
      if (!value || value.startsWith('--') || values.has(arg)) throw new Error('invalid argument: ' + arg);
      values.set(arg, value);
    } else throw new Error('unknown argument: ' + arg);
  }
  const dbPath = resolve(values.get('--db') ?? storeDbPath());
  if (!existsSync(dbPath)) throw new Error('product store does not exist');
  if (command === 'retention' && !flags.has('--apply')) {
    const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const root = process.env['ATOMA_PROJECTS_ROOT'] ?? join(homedir(), '.atoma');
      process.stdout.write(JSON.stringify(retentionPlan(reader, root, process.env['ATOMA_LAUNCHER_WORKSPACE_ROOT']), null, 2) + '\n');
    } finally { reader.close(); }
    return;
  }
  if (command === 'retention' && !flags.has('--services-stopped')) throw new Error('--apply requires --services-stopped; stop all services and verify a restorable backup first');
  // Opening the product schema performs additive migrations, never state replacement.
  const projects = ProjectStore.open(dbPath);
  const db = openStoreHandle(dbPath, '');
  if (command === 'limits') {
    const orgId = organisationIdSchema.parse(values.get('--org'));
    if (!db.prepare('SELECT 1 FROM auth_organisations WHERE org_id = ?').get(orgId)) throw new Error('unknown organisation');
    const raw = values.get('--max-concurrent');
    if (raw !== undefined) {
      if (!/^[01]$/.test(raw)) throw new Error('--max-concurrent must be 0 or 1');
      const limit = orgRunLimitSchema.parse(Number(raw));
      const events = PlatformEventLog.open(dbPath);
      db.transaction(() => {
        const previous = projects.runCapacity(orgId).maxConcurrent;
        projects.setRunLimit(orgId, limit);
        if (!events.append({ kind: 'org.run_limit_changed', actorType: 'cli', actorId: null,
          orgId, projectId: null, runId: null, summary: 'Organisation run admission limit changed',
          detail: { previous, maxConcurrent: limit } })) throw new Error('limit audit unavailable');
      }).immediate();
    }
    process.stdout.write(JSON.stringify(projects.runCapacity(orgId), null, 2) + '\n');
    return;
  }
  const root = process.env['ATOMA_PROJECTS_ROOT'] ?? join(homedir(), '.atoma');
  const workspaceRoot = process.env['ATOMA_LAUNCHER_WORKSPACE_ROOT'];
  const lease = acquireRunLeaseWithoutRecovery('maintenance:retention');
  try {
    const events = PlatformEventLog.open(dbPath);
    const count = applyRetention(db, root, workspaceRoot, input => events.append(input));
    process.stdout.write(JSON.stringify({ deleted: count }) + '\n');
  } finally { lease.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { maintenanceMain(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
  finally { closeStoreHandles(); }
}
