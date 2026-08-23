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
import { snapshotProviderRegistry } from '../auth/providers.js';
import { isSubscriptionTransport, ProjectRunCoordinator } from '../projects/coordinator.js';
import { GitHubPublisher } from '../projects/publisher.js';
import { ProjectStore } from '../projects/store.js';
import { GitHubStore } from '../github/store.js';
import { GitHubAppClient } from '../github/client.js';
import { snapshotGitHubAppConfig } from '../github/config.js';
import { resolveGitHubUserAccessToken } from '../github/tokens.js';
import { PlatformEventLog } from '../platform/events.js';
import { eventLabel } from '../contracts/platformEvents.js';
import {
  createProjectInputSchema,
  DEFAULT_REPOSITORY_VISIBILITY,
  projectSlugFromName,
} from '../contracts/projects.js';
import { storeDbPath } from '../core/stores.js';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';

const USAGE = `atoma projects — organisation-scoped runs

usage:
  npm run projects -- list [--db path]
  npm run projects -- create --as <who> --name "<name>" [--repo <repo-name>]
                             [--visibility private|public] [--installation <id>]
                             [--slug <slug>] [--family <family>] [--prompt "<text>"]
  npm run projects -- run --project <slug-or-id> --as <principal-id-or-email> "<goal>" [--db path]
  npm run projects -- publish --project <slug-or-id> --as <who> --run <run-id> [--db path]

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

create:
  Enforces the same rules as the browser route: the repository target must be
  an ACTIVE GitHub installation linked to the principal's organisation, the
  payload goes through the one create schema, and a duplicate slug is refused
  rather than suffixed. The repository itself is created at the first
  PUBLICATION, not here, so a fresh project sits at repository status
  \`pending\`.

  --visibility is chosen ONCE and cannot be changed afterwards: nothing in this
  product can move it, and changing it on GitHub breaks the project. It
  defaults to private, because nothing here reviews what a run publishes.

publish:
  A delivered run publishes automatically. \`publish\` re-drives one whose
  publication never reached GitHub — an App configured after the fact, a
  network failure, a name clash since cleared. The publication row is the
  idempotency boundary: 'published' returns as-is, a concurrent 'publishing'
  is left alone, and the manifest is revalidated byte-for-byte against the
  workspace, so a workspace that changed since delivery is refused.

flags:
  --db <path>                use this product store
  --name "<name>"            project name (create only)
  --slug <slug>              slug, derived from the name when omitted
  --repo <repo-name>         GitHub repository name, defaults to the slug
  --installation <id>        GitHub installation; required only if several
  --visibility <v>           private (default) or public — permanent
  --family <family>          run family, default build
  --prompt "<text>"          the project's initial prompt, optional
  --project <slug-or-id>     target project (required for run and publish)
  --as <id-or-email>         principal the run is attributed to (required)
  --run <run-id>             the delivered run to publish (publish only)
  --timeout <seconds>        run budget, 60..7200, default 900 (run only)
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
 * Create a project from the terminal, under the SAME rules as the browser
 * route (`ProjectService.createProject`): one create schema, an installation
 * that must be active and belong to the principal's organisation, and a
 * duplicate slug refused rather than suffixed.
 *
 * It exists because the CLI could list, run and publish — everything except
 * the step that starts it all — so an operator with no browser could not use
 * their own product end to end. The rules are restated here rather than
 * shared, because the service's method takes an HTTP request and a session
 * viewer; what IS shared is the schema and the store method that enforce them.
 */
function createProject(
  auth: AuthStore,
  projects: ProjectStore,
  dbPath: string,
  flags: Record<string, string | undefined>
): void {
  const asRef = flags['as'];
  if (typeof asRef !== 'string' || asRef.length === 0) fail('--as <principal-id-or-email> is required');
  const name = (flags['name'] ?? '').trim();
  if (name.length === 0) fail('--name "<project name>" is required');

  let principal: { principalId: string; displayName: string };
  try {
    principal = auth.resolvePrincipalRef(asRef);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const memberships = auth.listOrganisationsForPrincipal(principal.principalId);
  if (memberships.length === 0) fail(`principal ${principal.principalId} belongs to no organisation`);
  if (memberships.length > 1) {
    fail(
      `${safeTerminal(principal.displayName)} belongs to ${memberships.length} organisations; ` +
        'this command creates in one, so it refuses to guess'
    );
  }
  const orgId = memberships[0]!.orgId;

  // The GitHub App is required, exactly as the route requires it: a project
  // with no repository target is a project that can never publish.
  const github = GitHubStore.open(dbPath);
  const active = github.listInstallations(orgId).filter((row) => row.status === 'active');
  const installationRef = flags['installation'];
  const installation =
    typeof installationRef === 'string' && installationRef.length > 0
      ? active.find((row) => row.installationId === installationRef)
      : active.length === 1
        ? active[0]
        : undefined;
  if (!installation) {
    if (active.length === 0) {
      fail(`organisation ${orgId} has no active GitHub installation — connect one in the visualizer`);
    }
    fail(
      `--installation <id> is required: ${active.length} active installations (` +
        `${active.map((row) => `${row.installationId}=${row.accountLogin}`).join(', ')})`
    );
  }

  const slug = (flags['slug'] ?? projectSlugFromName(name)).trim();
  const repository = (flags['repo'] ?? slug).trim();
  const rawVisibility = flags['visibility'];
  if (rawVisibility !== undefined && rawVisibility !== 'private' && rawVisibility !== 'public') {
    fail('--visibility must be private or public');
  }
  const visibility = rawVisibility ?? DEFAULT_REPOSITORY_VISIBILITY;

  const parsed = createProjectInputSchema.safeParse({
    name,
    slug,
    initialPrompt: flags['prompt'] ?? '',
    ...(flags['family'] ? { family: flags['family'] } : {}),
    repositoryTarget: {
      installationId: installation.installationId,
      owner: installation.accountLogin,
      name: repository,
      visibility,
    },
  });
  if (!parsed.success) {
    fail(
      `invalid project: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
        .join('; ')}`
    );
  }

  const events = PlatformEventLog.open(dbPath);
  let project;
  try {
    project = projects.createProject({
      orgId,
      principalId: principal.principalId,
      project: parsed.data,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: projects\.org_id, projects\.slug/.test(error.message)
    ) {
      fail(`a project with slug "${safeTerminal(slug)}" already exists in this organisation`);
    }
    throw error;
  }
  // Same row the route writes, `cli` actor — because that is what asked.
  events.append({
    kind: 'project.created',
    actorType: 'cli',
    actorId: null,
    orgId,
    projectId: project.projectId,
    summary: `Project "${eventLabel(project.name)}" created from the CLI`,
    detail: {
      slug: project.slug,
      family: project.family,
      visibility: project.repositoryTarget.visibility,
    },
  });

  process.stdout.write(
    `created ${project.slug} (${project.projectId})\n` +
      `  org          ${orgId}\n` +
      `  as           ${safeTerminal(principal.displayName)}\n` +
      `  repository   ${project.repositoryTarget.owner}/${project.repositoryTarget.name}` +
      ` (${project.repositoryTarget.visibility}, permanent)\n` +
      `  installation ${installation.installationId} ${installation.accountLogin}` +
      ` (${installation.targetType})\n` +
      `  status       repository ${project.repositoryStatus} — created at the first publication\n` +
      `\nstart a run:\n` +
      `  npm run projects -- run --project ${project.slug} --as ${safeTerminal(asRef)} "<goal>"\n`
  );
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
    valueFlags: [
      'db',
      'project',
      'as',
      'run',
      'name',
      'slug',
      'repo',
      'installation',
      'visibility',
      'family',
      'prompt',
      'timeout',
    ],
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
        // HOW FAR BEHIND THE REPOSITORY IS. `repository_status = 'ready'` means
        // the repository EXISTS and never that it is current, so a project can
        // sit green over a repository several delivered runs old. This is a
        // COUNT over rows that already exist, not a stored pointer: a stored
        // head would be a cache of state only GitHub owns.
        const published = projects.lastPublishedCommitForProject(org.orgId, project.projectId);
        const delivered = runs.filter((run) => run.status === 'delivered');
        const behind = published
          ? delivered.filter((run) => run.createdAt > published.runCreatedAt).length
          : delivered.length;
        if (behind > 0) {
          process.stdout.write(
            `  ${' '.repeat(28)} repository is ${behind} delivered run(s) behind` +
              `${published ? ` (published ${published.commitSha.slice(0, 7)})` : ' (never published)'}\n`
          );
        }
      }
    }
    return;
  }

  if (command === 'create') {
    createProject(auth, projects, dbPath, args.flags);
    return;
  }

  if (command !== 'run' && command !== 'publish') {
    fail(`unknown command "${safeTerminal(String(command))}"`);
  }

  const goal = args.positional.join(' ').trim();
  if (command === 'run' && goal.length === 0) {
    fail('a goal is required: npm run projects -- run --project <slug> --as <who> "<goal>"');
  }
  const runRef = args.flags['run'];
  if (command === 'publish' && (typeof runRef !== 'string' || runRef.length === 0)) {
    fail('--run <run-id> is required: npm run projects -- publish --project <slug> --as <who> --run <id>');
  }
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
  // PUBLICATION, wired exactly as the viz server wires it — same publisher,
  // same token resolution, same journal sink. Without it this command could
  // start a run and deliver an artifact, and the artifact went nowhere: the
  // repository stayed `pending` for ever and no journal row said why. A CLI
  // that starts a project run must finish it the same way the browser does,
  // or "started from a terminal" quietly means "half a product".
  //
  // Absent App configuration it stays undefined and the run still delivers —
  // the same degradation the server accepts, and the same one `doctor`
  // reports.
  const githubStore = GitHubStore.open(dbPath);
  const githubProvider = snapshotProviderRegistry(process.env).providers.find(
    (provider) => provider.id === 'github'
  );
  // Same presence probe as the server, and the same fail-closed rule behind
  // it: `snapshotGitHubAppConfig` THROWS on a half-configured App rather than
  // degrading, so it is only called when at least one of its variables is set.
  const appConfigPresent = [
    'ATOMA_GITHUB_APP_ID',
    'ATOMA_GITHUB_APP_SLUG',
    'ATOMA_GITHUB_APP_PRIVATE_KEY',
    'ATOMA_GITHUB_APP_PRIVATE_KEY_PATH',
    'ATOMA_GITHUB_WEBHOOK_SECRET',
    'ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY',
  ].some((name) => process.env[name] !== undefined);
  const appConfig = appConfigPresent
    ? snapshotGitHubAppConfig(process.env, {
        ...(githubProvider
          ? {
              oauth: {
                clientId: githubProvider.clientId,
                clientSecret: githubProvider.clientSecret ?? '',
              },
            }
          : {}),
      })
    : null;
  const publisher =
    appConfig
      ? new GitHubPublisher({
          client: new GitHubAppClient({
            appId: appConfig.appId,
            appSlug: appConfig.appSlug,
            privateKey: appConfig.privateKey,
            apiBaseUrl: appConfig.apiBaseUrl,
          }),
          github: githubStore,
          store: projects,
          events: (input) => events.append(input),
          ...(githubProvider
            ? {
                resolveUserAccessToken: (principalId: string) =>
                  resolveGitHubUserAccessToken({
                    github: githubStore,
                    config: appConfig,
                    provider: githubProvider,
                    principalId,
                  }),
              }
            : {}),
        })
      : undefined;

  // THE OPERATOR'S BUDGET, said out loud. Seconds on the command line because
  // that is how the runner prints it; milliseconds across the boundary because
  // that is what every deadline downstream is in. An unparsable value is a
  // refusal here rather than a silent 15 minutes.
  const timeoutFlag = args.flags['timeout'];
  let timeoutMs: number | undefined;
  if (typeof timeoutFlag === 'string' && timeoutFlag.trim().length > 0) {
    const seconds = Number(timeoutFlag.trim());
    if (!Number.isSafeInteger(seconds) || seconds < 1) {
      fail(`invalid --timeout "${timeoutFlag}" (expected whole seconds)`);
    }
    timeoutMs = seconds * 1_000;
  }

  const coordinator = new ProjectRunCoordinator({
    store: projects,
    dbPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(publisher ? { publisher } : {}),
    platformAdmins: (id) => auth.isPlatformAdmin(id),
    tierModelsFor: (id) => auth.modelPins(id),
    // The run's own outcome, journaled from the process that drove it — the
    // server's `onRunFinished` twin. A `run.finished` row is what makes the
    // publication attempt (and its failure) answerable after the fact.
    onRunFinished: (event) => {
      events.append({
        kind: 'run.finished',
        actorType: 'cli',
        actorId: null,
        orgId: event.orgId,
        projectId: event.projectId,
        runId: event.projectRunId,
        summary: `Run ${event.status} from the CLI`,
        detail: { status: event.status, goal: eventLabel(goal, 120) },
      });
    },
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
      (command === 'publish'
        ? `run      ${safeTerminal(String(runRef))}\n\n`
        : `goal     ${safeTerminal(goal)}\n\n`)
  );

  if (command === 'publish') {
    // The missing caller. `retryPublication` shipped with a route, a role
    // check and a test, and nothing in the product ever called it — so a
    // delivered run whose artifact never reached GitHub had no way back.
    if (!publisher) {
      fail(
        'no GitHub App in this process environment, so nothing can be published — ' +
          'the compiled CLI does not read checkout .env: use npm run projects:dev ' +
          'or export ATOMA_GITHUB_APP_*'
      );
    }
    let published;
    try {
      published = await coordinator.retryPublication(target.orgId, String(runRef));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (!published) fail(`no run ${safeTerminal(String(runRef))} in this project's organisation`);
    const publication = projects.getPublicationForRun(target.orgId, String(runRef));
    process.stdout.write(`publication ${publication?.status ?? 'unknown'}\n`);
    if (publication?.repositoryUrl) {
      process.stdout.write(`  ${safeTerminal(publication.repositoryUrl)}\n`);
    }
    if (publication?.commitSha) process.stdout.write(`  commit ${publication.commitSha}\n`);
    if (publication?.error) process.stdout.write(`  ${safeTerminal(publication.error)}\n`);
    const project = projects.getProject(target.orgId, target.projectId);
    if (project) {
      process.stdout.write(
        `  repository ${project.repositoryStatus} (${project.repositoryTarget.visibility})` +
          `${project.repositoryFullName ? ` ${project.repositoryFullName}` : ''}\n`
      );
      if (project.repositoryError) {
        process.stdout.write(`  ${safeTerminal(project.repositoryError)}\n`);
      }
    }
    if (publication?.status !== 'published') process.exitCode = 1;
    return;
  }

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
  // THE OTHER HALF. A delivered run whose artifact never reached GitHub is
  // exactly the outcome this command used to report as success, so the
  // publication's own state is printed beside the run's.
  if (status === 'delivered') {
    const publication = projects.getPublicationForRun(target.orgId, run.projectRunId);
    if (!publication) {
      process.stdout.write(
        publisher
          ? '  no publication was recorded for this delivered run\n'
          : '  not published: no GitHub App in this process environment.\n' +
            '  The COMPILED cli does not read checkout .env by contract — run\n' +
            '  npm run projects:dev, or export ATOMA_GITHUB_APP_*.\n'
      );
    } else {
      process.stdout.write(`  publication ${publication.status}\n`);
      if (publication.repositoryUrl) {
        process.stdout.write(`  ${safeTerminal(publication.repositoryUrl)}\n`);
      }
      if (publication.error) process.stdout.write(`  ${safeTerminal(publication.error)}\n`);
      if (publication.commitSha) {
        process.stdout.write(
          `  commit ${publication.commitSha}` +
            (publication.baseSha === null
              ? ' (created the branch)\n'
              : publication.baseSha === publication.commitSha
                ? ' (already published — nothing to add)\n'
                : ` on ${publication.baseSha.slice(0, 7)}\n`)
        );
      }
      // A delivered run whose artifacts never reached GitHub is a FAILURE of
      // this command's job, and `projects publish` already exits non-zero for
      // exactly that. Only when a publisher is configured: without one, "not
      // published" is a configuration statement, not a failure.
      if (publisher && publication.status !== 'published') process.exitCode = 1;
      const project = projects.getProject(target.orgId, target.projectId);
      if (project) {
        process.stdout.write(
          `  repository ${project.repositoryStatus} (${project.repositoryTarget.visibility})\n`
        );
        if (project.repositoryError) {
          process.stdout.write(`  ${safeTerminal(project.repositoryError)}\n`);
        }
      }
    }
  }
  process.stdout.write('watch it in the visualizer: npm run viz:dev\n');
  if (status !== 'delivered') process.exitCode = 1;
}

await main();
