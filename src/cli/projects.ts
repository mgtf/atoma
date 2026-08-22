#!/usr/bin/env tsx
/**
 * atoma projects CLI — start and inspect ORGANISATION-SCOPED runs.
 *
 * Why this exists: the operator runner (`npm run run:build`) writes to the
 * `./runs` corpus, which the gated visualizer deliberately never mixes with
 * an organisation's project traces (`src/projects/AGENTS.md`). So a run an
 * operator starts from a terminal was, until now, invisible to the account
 * that owns the instance. Browser launches lived only on the authenticated
 * project routes, and there was no way to start one on somebody's behalf
 * without a session.
 *
 * This CLI is that missing path. It is an OPERATOR tool, like `auth`: it
 * reads the store on disk, so possession of the machine is the credential.
 * The run is attributed to the principal named by `--as`, appears in that
 * organisation's project corpus, and shows up in the gated visualizer next
 * to browser-started runs.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AuthStore } from '../auth/store.js';
import { isSubscriptionTransport, ProjectRunCoordinator } from '../projects/coordinator.js';
import { ProjectStore } from '../projects/store.js';
import { PlatformEventLog } from '../platform/events.js';
import { eventLabel } from '../contracts/platformEvents.js';
import { storeDbPath } from '../core/stores.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma projects — organisation-scoped runs

usage:
  npm run projects -- list [--db path]
  npm run projects -- run --project <slug-or-id> --as <principal-id-or-email> "<goal>" [--db path]

why not run:build:
  \`run:build\` writes the OPERATOR corpus (./runs). A project run is stored
  under the organisation, so it appears in the gated visualizer for the
  account that owns it. The two corpora are never mixed.

subscription transport:
  A project run normally requires ATOMA_LLM=anthropic plus a per-run
  credential, because a machine-bound transport (claude-cli) spends the HOST
  login session and cannot honour one. That is refused for a tenant and
  allowed for a PLATFORM ADMIN, whose own instance's subscription it is. The
  permission comes from the platform-admin flag, which only \`auth
  grant-admin\` can mint, and every such run is journaled as
  \`run.host_subscription\`.

flags:
  --db <path>                use this product store
  --project <slug-or-id>     target project (required for run)
  --as <id-or-email>         principal the run is attributed to (required)
  --help                     show this help`;

function safeTerminal(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? '�' : character;
  })
    .join('')
    .slice(0, 300);
}

function fail(message: string): never {
  process.stderr.write(`atoma projects: ${message}\n`);
  process.exit(1);
}

/**
 * The project the operator meant, by slug or id, searched across every
 * organisation the principal belongs to. A slug is unique per organisation,
 * not per instance, so an ambiguous reference is refused rather than guessed.
 */
function resolveProject(
  projects: ProjectStore,
  auth: AuthStore,
  principalId: string,
  reference: string
): { orgId: string; projectId: string; name: string; slug: string } {
  const memberships = auth.listOrganisationsForPrincipal(principalId);
  if (memberships.length === 0) {
    fail(`principal ${principalId} belongs to no organisation`);
  }
  const matches: Array<{ orgId: string; projectId: string; name: string; slug: string }> = [];
  for (const membership of memberships) {
    for (const project of projects.listProjects(membership.orgId)) {
      if (project.slug === reference || project.projectId === reference) {
        matches.push({
          orgId: membership.orgId,
          projectId: project.projectId,
          name: project.name,
          slug: project.slug,
        });
      }
    }
  }
  if (matches.length === 0) fail(`no project "${safeTerminal(reference)}" for that principal`);
  if (matches.length > 1) {
    fail(
      `"${safeTerminal(reference)}" matches ${matches.length} projects across organisations; use the project id`
    );
  }
  return matches[0]!;
}

async function main(): Promise<void> {
  applyCheckoutDotenvForSourceEntry();
  const args = parseCliArgs(process.argv, {
    booleanFlags: ['help'],
    valueFlags: ['db', 'project', 'as'],
    undeclared: 'discard',
  });
  const command = args.command ?? 'help';
  if (args.flags['help'] === 'true' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.undeclaredFlags.length > 0) fail(`unknown flag: ${args.undeclaredFlags[0]!}`);
  const dbFlag = args.flags['db'];
  const dbPath = typeof dbFlag === 'string' && dbFlag.length > 0 ? dbFlag : storeDbPath();
  if (!existsSync(dbPath)) {
    fail(`no product store at ${dbPath} — start the visualizer once, or pass --db`);
  }
  const auth = AuthStore.open(dbPath);
  const projects = ProjectStore.open(dbPath);

  if (command === 'list') {
    for (const org of auth.listOrganisations()) {
      process.stdout.write(`${safeTerminal(org.name)}  (${org.orgId})\n`);
      const rows = projects.listProjects(org.orgId);
      if (rows.length === 0) process.stdout.write('  (no projects)\n');
      for (const project of rows) {
        const runs = projects.listProjectRuns(org.orgId, project.projectId) ?? [];
        process.stdout.write(
          `  ${project.slug.padEnd(28)} ${project.status.padEnd(10)} ${runs.length} run(s)  ${project.projectId}\n`
        );
      }
    }
    return;
  }

  if (command !== 'run') fail(`unknown command "${safeTerminal(String(command))}"`);

  const goal = args.positional.join(' ').trim();
  if (goal.length === 0) fail('a goal is required: npm run projects -- run --project <slug> --as <who> "<goal>"');
  const asRef = args.flags['as'];
  if (typeof asRef !== 'string' || asRef.length === 0) fail('--as <principal-id-or-email> is required');
  const projectRef = args.flags['project'];
  if (typeof projectRef !== 'string' || projectRef.length === 0) fail('--project <slug-or-id> is required');

  let principal: { principalId: string; displayName: string };
  try {
    principal = auth.resolvePrincipalRef(asRef);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const target = resolveProject(projects, auth, principal.principalId, projectRef);
  const admin = auth.isPlatformAdmin(principal.principalId);
  const transport = process.env['ATOMA_LLM'];
  if (isSubscriptionTransport(transport) && !admin) {
    fail(
      `ATOMA_LLM=${String(transport)} spends this machine's own login session, and ` +
        `${safeTerminal(principal.displayName)} is not a platform admin. Either set ` +
        'ATOMA_LLM=anthropic with a per-run credential, or grant the flag: ' +
        'npm run auth -- grant-admin --principal <id-or-email>'
    );
  }

  const events = PlatformEventLog.open(dbPath);
  const coordinator = new ProjectRunCoordinator({
    store: projects,
    dbPath,
    platformAdmins: (id) => auth.isPlatformAdmin(id),
    tierModelsFor: (id) => auth.modelPins(id),
    // Same audit rule as the HTTP path: a run billed to the host subscription
    // leaves a journal row. `cli` actor, because that is what asked.
    onSubscriptionTransport: (use) => {
      events.append({
        kind: 'run.host_subscription',
        actorType: 'cli',
        actorId: null,
        orgId: use.orgId,
        projectId: use.projectId,
        runId: use.projectRunId,
        summary: `Run billed to the host subscription (${use.transport}) for ${eventLabel(principal.displayName, 60)}`,
      });
    },
  });

  process.stdout.write(
    `project ${target.slug} (${target.name})\n` +
      `as       ${safeTerminal(principal.displayName)}${admin ? ' [platform admin]' : ''}\n` +
      `store    ${dbPath}\n` +
      `goal     ${safeTerminal(goal)}\n\n`
  );

  const run = await coordinator.start({
    orgId: target.orgId,
    principalId: principal.principalId,
    projectId: target.projectId,
    request: { goal, idempotencyKey: randomUUID() },
  });
  events.append({
    kind: 'run.started',
    actorType: 'cli',
    actorId: null,
    orgId: target.orgId,
    projectId: target.projectId,
    runId: run.projectRunId,
    summary: `Run started from the CLI: ${eventLabel(goal, 120)}`,
  });
  process.stdout.write(`run ${run.projectRunId} ${run.status}\n`);

  // The coordinator drives the run in the background; wait for it so the
  // command's exit code means something, and so the operator sees the end.
  await coordinator.waitForIdle();
  const finished = projects.getProjectRun(target.orgId, run.projectRunId);
  const status = finished?.status ?? 'unknown';
  process.stdout.write(`\nrun ${run.projectRunId} ${status}\n`);
  if (finished?.error) process.stdout.write(`  ${safeTerminal(finished.error)}\n`);
  process.stdout.write('watch it in the visualizer: npm run viz:dev\n');
  if (status !== 'delivered') process.exitCode = 1;
}

await main();
