import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubApiError, type GitHubAppClient } from '../github/client.js';
import { GitHubStore } from '../github/store.js';
import { publicationCommitMessage } from './commitMessage.js';
import { ProjectStateConflict, type ProjectStore } from './store.js';
import {
  revalidateArtifactManifest,
  readManifestArtifact,
} from './artifacts.js';
import type { RepositoryTarget, Project, ProjectRun, Publication } from '../contracts/projects.js';
import { eventLabel, type PlatformEventSink } from '../contracts/platformEvents.js';

/**
 * GITHUB PUBLISHER — turns EVERY delivered run's artifact manifest into a
 * commit on the project's repository.
 *
 * Contract (see AGENTS.md):
 * - The repository is created only AFTER the run was delivered and validated;
 *   a failed run never leaves an empty repo behind.
 * - Creation is idempotent per project: a retry finds the existing repository
 *   and proceeds to publish; it never creates a second one.
 * - PUBLICATION IS A SEQUENCE, one row per run. The first run creates the
 *   branch; every later delivered run commits on top of what this project last
 *   published, merging its manifest onto the parent's tree. `expectedHead` —
 *   this project's own last published commit — is the authority for that, and
 *   it is NOT `repository_status = 'ready'`, which says only that the
 *   repository exists. Reading the second as the first is what made
 *   publication single-shot.
 * - Publishing a run OLDER than the one already published is refused, because
 *   it would move the branch back to older artifacts. A later run's workspace
 *   is seeded from the earlier one, so its artifacts already contain that work.
 * - The manifest is re-read byte-for-byte right before each blob upload;
 *   a file that changed after delivery is a refusal, never a silent revision.
 *
 * The publisher receives resolved tokens (installation token from the GitHub
 * App client); it never handles app credentials itself.
 */

/**
 * Refused because a NEWER run of this project is already published. Not a
 * transport failure and not a divergence: a policy refusal, so the HTTP layer
 * answers 409 rather than 502.
 */
export class PublicationSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationSupersededError';
  }
}

export const PUBLISHER_TOKEN_MARGIN_MS = 60_000;

export interface GitHubPublisherDeps {
  readonly client: GitHubAppClient;
  readonly github: GitHubStore;
  readonly store: ProjectStore;
  /**
   * User-to-server token for the principal that installed the App. Required
   * to create repositories on a personal account; organisation repositories
   * use the installation token instead.
   */
  readonly resolveUserAccessToken?: (principalId: string) => Promise<string>;
  /**
   * Optional audit sink. Its ABSENCE was the blind spot this closes: the
   * publisher's throw is swallowed by the coordinator (whose catch only
   * transitions runs still `running`), so before this hook a failed
   * publication existed solely as a column on a row nobody watched.
   */
  readonly events?: PlatformEventSink;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/**
 * Resolve the installation the project's repository target names, inside the
 * project's organisation. A target pointing at an installation linked to
 * ANOTHER organisation is an IDOR attempt and fails closed.
 */
export function resolveProjectInstallation(
  github: GitHubStore,
  project: Project
): { installationId: string; targetType: 'User' | 'Organization' } | null {
  const installation = github.getInstallation(project.repositoryTarget.installationId);
  if (!installation) return null;
  if (installation.orgId !== project.orgId) return null;
  if (installation.status !== 'active') return null;
  return { installationId: installation.installationId, targetType: installation.targetType };
}

/** Ensure the target repository exists (idempotent) and return its identity. */
async function ensureRepository(
  client: GitHubAppClient,
  input: {
    installationId: string;
    targetType: 'User' | 'Organization';
    owner: string;
    name: string;
    visibility: 'private' | 'public';
  },
  tokens: { readonly createToken: string; readonly lookupToken: string }
): Promise<{ repositoryId: string; fullName: string; url: string; defaultBranch: string }> {
  try {
    const repository =
      input.targetType === 'Organization'
        ? await client.createOrganisationRepository(tokens.createToken, input.owner, {
            name: input.name,
            private: input.visibility === 'private',
          })
        : await client.createUserRepository(tokens.createToken, {
            name: input.name,
            private: input.visibility === 'private',
          });
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      url: repository.htmlUrl,
      defaultBranch: repository.defaultBranch,
    };
  } catch (error) {
    // 422 from /user/repos or /orgs/:org/repos means the name is taken. The
    // idempotent path then resolves the existing repository; a repository we
    // cannot resolve is a hard failure, not a guessed identity.
    if (error instanceof GitHubApiError && error.status === 422) {
      const existing = await client.getRepository(
        tokens.lookupToken,
        input.owner,
        input.name
      );
      if (!existing) {
        // 422 IS NOT ONLY "the name is taken". A GitHub organisation can
        // forbid repository creation, or forbid one visibility — and
        // `GitHubApiError` carries no response body, so the two are
        // indistinguishable here. Saying "already exists" would tell an
        // operator something affirmatively false about their own account, on
        // the very path a public/private choice makes reachable. State what is
        // known instead.
        throw new Error(
          `repository creation was refused (HTTP 422) and ${input.owner}/${input.name} is not visible to this installation: the name may be taken by a repository outside its scope, or this account may not allow creating a ${input.visibility} repository`
        );
      }
      // The idempotent path must not silently change the audience: publishing
      // a private-targeted artifact into a pre-existing PUBLIC repository (or
      // the reverse) is a refusal, never a convergence.
      if (existing.private !== (input.visibility === 'private')) {
        throw new Error(
          `repository ${existing.fullName} already exists but is ${
            existing.private ? 'private' : 'public'
          } while the project targets a ${input.visibility} repository`
        );
      }
      return {
        repositoryId: existing.id,
        fullName: existing.fullName,
        url: existing.htmlUrl,
        defaultBranch: existing.defaultBranch,
      };
    }
    throw error;
  }
}

export class GitHubPublisher {
  private readonly client: GitHubAppClient;
  private readonly github: GitHubStore;
  private readonly store: ProjectStore;
  private readonly resolveUserAccessToken?: (principalId: string) => Promise<string>;
  private readonly events: PlatformEventSink;

  constructor(deps: GitHubPublisherDeps) {
    this.client = deps.client;
    this.github = deps.github;
    this.store = deps.store;
    this.resolveUserAccessToken = deps.resolveUserAccessToken;
    this.events = deps.events ?? (() => undefined);
  }

  /** Creation-time read: resolve actual visibility and the source's immutable identity. */
  async inspectTarget(target: RepositoryTarget, orgId: string, principalId: string): Promise<RepositoryTarget> {
    const source = target.source;
    if (!source) return target;
    const installation = this.github.getInstallation(target.installationId);
    if (!installation || installation.orgId !== orgId || installation.status !== 'active') {
      throw new Error('GitHub installation is not linked to this organisation or is inactive');
    }
    if (target.owner.toLowerCase() !== installation.accountLogin.toLowerCase()) {
      throw new Error('Repository destination must belong to the selected GitHub account');
    }
    if (source.mode === 'pull-request' &&
      `${target.owner}/${target.name}`.toLowerCase() !== `${source.owner}/${source.name}`.toLowerCase()) {
      throw new Error('Pull requests must target the selected source repository');
    }
    if (source.mode === 'fork' && target.owner.toLowerCase() === source.owner.toLowerCase()) {
      throw new Error('Choose another GitHub account for the fork');
    }
    const token = source.mode === 'pull-request'
      ? (await this.client.createInstallationToken(target.installationId, true)).token
      : await this.userAccessToken(principalId);
    const repository = await this.client.getRepository(token, source.owner, source.name);
    if (!repository) throw new Error('Source repository is not accessible; check the GitHub App repository access');
    return { ...target, visibility: repository.private ? 'private' : 'public',
      source: { owner: repository.owner, name: repository.name, mode: source.mode, repositoryId: repository.id } };
  }

  /** Prepare an immutable snapshot outside the worker workspace, before any model work. */
  async prepareRun(project: Project, run: ProjectRun, signal: AbortSignal): Promise<string> {
    try {
      return await this.prepareRepositoryRun(project, run, signal);
    } catch (error) {
      const current = this.store.getProject(project.orgId, project.projectId);
      if (current && current.repositoryStatus !== 'ready' && current.repositoryStatus !== 'failed') {
        this.store.transitionRepository({ orgId: project.orgId, projectId: project.projectId,
          from: current.repositoryStatus, to: 'failed', error: errorMessage(error) });
      }
      throw error;
    }
  }

  private async prepareRepositoryRun(project: Project, run: ProjectRun, signal: AbortSignal): Promise<string> {
    const source = project.repositoryTarget.source;
    if (!source?.repositoryId) throw new Error('Project source must be verified before starting a run');
    const target = project.repositoryTarget;
    const installation = resolveProjectInstallation(this.github, project);
    if (!installation) throw new Error('GitHub installation is not linked to this organisation or is inactive');
    const linked = this.github.getInstallation(installation.installationId)!;
    if (target.owner.toLowerCase() !== linked.accountLogin.toLowerCase()) throw new Error('Repository account does not match its installation');
    let token = (await this.client.createInstallationToken(installation.installationId, source.mode === 'pull-request')).token;
    let repository = await this.client.getRepository(token, target.owner, target.name);
    signal.throwIfAborted();
    if (!repository && source.mode === 'fork' && project.repositoryStatus !== 'ready') {
      const createToken = await this.userAccessToken(run.requestedByPrincipalId);
      repository = await this.client.createFork({ token: createToken, owner: source.owner, name: source.name,
        targetName: target.name, ...(installation.targetType === 'Organization' ? { organisation: target.owner } : {}) });
      // Fork creation is asynchronous. A retry observes the same target and
      // verifies its parent, never adopts an unrelated name collision.
      token = (await this.client.createInstallationToken(installation.installationId)).token;
      const readyUntil = Date.now() + 30_000;
      do {
        signal.throwIfAborted();
        repository = await this.client.getRepository(token, target.owner, target.name);
        if (repository) {
          const head = await this.client.readBranchHead(token, target.owner, target.name, repository.defaultBranch);
          if (head.state === 'head') break;
        }
        await delay(1000, undefined, { signal });
      } while (Date.now() < readyUntil);
    }
    if (!repository) throw new Error('Repository is not ready or is outside the GitHub App installation; grant access and retry the run');
    if (`${target.owner}/${target.name}`.toLowerCase() !== repository.fullName.toLowerCase() ||
      repository.private !== (target.visibility === 'private') ||
      (source.mode === 'fork' ? repository.parentId !== source.repositoryId : repository.id !== source.repositoryId) ||
      (project.repositoryId && repository.id !== project.repositoryId)) {
      throw new Error('Repository identity, fork parent or visibility no longer matches this project');
    }
    const status = this.store.getProject(project.orgId, project.projectId)!.repositoryStatus;
    if (status !== 'ready') {
      if (status !== 'creating') this.store.transitionRepository({ orgId: project.orgId, projectId: project.projectId, from: status, to: 'creating' });
      this.store.transitionRepository({ orgId: project.orgId, projectId: project.projectId, from: 'creating', to: 'ready',
        receipt: { repositoryId: repository.id, fullName: repository.fullName, url: repository.htmlUrl, defaultBranch: repository.defaultBranch } });
    }
    const head = await this.client.readBranchHead(token, target.owner, target.name, repository.defaultBranch);
    if (head.state !== 'head') throw new Error('Repository branch is empty or the fork is still being prepared; retry when it is ready');
    const files = await this.client.readRepositoryFiles({ token, owner: target.owner, name: target.name, commitSha: head.sha, signal });
    signal.throwIfAborted();
    const seedPath = path.join(path.dirname(run.hostPaths.workspacePath), 'repository-seed');
    try {
      await mkdir(seedPath, { recursive: true, mode: 0o700 });
      for (const file of files) {
        signal.throwIfAborted();
        const destination = path.join(seedPath, file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
      }
    } catch {
      signal.throwIfAborted();
      // Run errors are served to tenants: filesystem exceptions contain host paths.
      throw new Error('Repository snapshot could not be written on this host');
    }
    this.store.saveRepositoryRunBase(project.orgId, run.projectRunId, {
      repositoryId: repository.id, branch: repository.defaultBranch, commitSha: head.sha,
    });
    return seedPath;
  }

  /**
   * Publish one delivered run. Safe to retry: the publication row is the
   * idempotency boundary (one per run), the repository is created at most
   * once per project, and an existing branch refuses to be overwritten.
   */
  async publish(input: {
    readonly project: Project;
    readonly run: ProjectRun;
    readonly workspaceRoot: string;
    readonly manifestHash: string;
  }): Promise<Publication | null> {
    const { project, run } = input;
    if (run.status !== 'delivered' || !run.artifactManifest) {
      throw new Error('publication requires a delivered run with an artifact manifest');
    }

    const reservation = this.store.reservePublication({
      orgId: project.orgId,
      projectRunId: run.projectRunId,
      idempotencyKey: `publish:${run.projectRunId}`,
    });
    if (!reservation) return null;
    const { publication } = reservation;

    if (publication.status === 'published') return publication;
    if (publication.status === 'publishing') {
      // A concurrent publish is in flight; the retry will converge. Do not
      // attempt a second concurrent publication of the same run.
      return publication;
    }

    // pending or failed → (re)publish.
    const from = publication.status === 'failed' ? 'failed' : 'pending';
    let publishing = this.store.transitionPublication({
      orgId: project.orgId,
      publicationId: publication.publicationId,
      from,
      to: 'publishing',
    });
    if (!publishing) return null;

    try {
      const installation = resolveProjectInstallation(this.github, project);
      if (!installation) {
        throw new Error('GitHub installation is not linked to this organisation or is inactive');
      }
      const installationToken = await this.client.createInstallationToken(
        installation.installationId, project.repositoryTarget.source?.mode === 'pull-request'
      );
      const linked = this.github.getInstallation(installation.installationId);
      if (!linked) {
        throw new Error('GitHub installation disappeared after resolution');
      }
      const createToken =
        installation.targetType === 'User' && !project.repositoryTarget.source
          ? await this.userAccessToken(linked.connectedByPrincipalId)
          : installationToken.token;

      // Repository lifecycle: pending → creating → ready (idempotent replay ok).
      // The status is read FRESH from the store, not from the `project` the
      // caller handed in: a retry's snapshot is as old as the attempt that
      // failed, and every transition here is a compare-and-set. This was
      // invisible while a failed repository row could not exist — the moment
      // failures started being recorded, a retry compared 'pending' against a
      // row that said 'failed' and refused itself.
      const currentRepositoryStatus =
        this.store.getProject(project.orgId, project.projectId)?.repositoryStatus ??
        project.repositoryStatus;
      let receipt: {
        repositoryId: string;
        fullName: string;
        url: string;
        defaultBranch: string;
      } | null = null;
      if (project.repositoryTarget.source && currentRepositoryStatus !== 'ready') {
        throw new Error('Imported repository was not prepared for this run');
      }
      if (currentRepositoryStatus === 'ready') {
        // ALREADY RESOLVED, and `ready` is terminal by design
        // (`REPOSITORY_TRANSITIONS.ready = []`). Re-deriving the identity would
        // call GitHub again and then fail its own compare-and-set, which is
        // what broke a retry whose repository existed and whose COMMIT had
        // failed. The row is the identity.
        const stored = this.store.getProject(project.orgId, project.projectId);
        // The store's CHECK constraint already ties `ready` to a complete
        // receipt, so a missing field here is a corrupted row, not a state.
        if (!stored?.repositoryId || !stored.repositoryFullName || !stored.repositoryUrl || !stored.defaultBranch) {
          throw new Error(
            `repository for project ${project.slug} is ready but carries no receipt to publish into`
          );
        }
        receipt = {
          repositoryId: stored.repositoryId,
          fullName: stored.repositoryFullName,
          url: stored.repositoryUrl,
          defaultBranch: stored.defaultBranch,
        };
      } else {
        if (currentRepositoryStatus === 'pending' || currentRepositoryStatus === 'failed') {
          this.store.transitionRepository({
            orgId: project.orgId,
            projectId: project.projectId,
            from: currentRepositoryStatus,
            to: 'creating',
          });
        }
        const repository = await ensureRepository(
          this.client,
          {
            installationId: installation.installationId,
            targetType: installation.targetType,
            owner: project.repositoryTarget.owner,
            name: project.repositoryTarget.name,
            visibility: project.repositoryTarget.visibility,
          },
          {
            createToken,
            lookupToken: installation.targetType === 'User' ? createToken : installationToken.token,
          }
        );
        if (!repository.repositoryId) {
          throw new Error(
            `repository ${repository.fullName} already exists but its identity could not be resolved`
          );
        }
        receipt = {
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          url: repository.url,
          defaultBranch: repository.defaultBranch,
        };
        this.store.transitionRepository({
          orgId: project.orgId,
          projectId: project.projectId,
          from: 'creating',
          to: 'ready',
          receipt,
        });
      }
      const repository = receipt;
      if (project.repositoryTarget.source) {
        const remote = await this.client.getRepository(installationToken.token, project.repositoryTarget.owner, project.repositoryTarget.name);
        if (!remote || remote.id !== repository.repositoryId || remote.private !== (project.repositoryTarget.visibility === 'private')) {
          throw new Error('Repository identity or visibility changed since this run started');
        }
      }

      // Revalidate the manifest against disk immediately before upload.
      revalidateArtifactManifest({
        workspaceRoot: input.workspaceRoot,
        manifest: run.artifactManifest,
        expectedHash: input.manifestHash,
      });

      // THE ORDER GATE. Every entry point (in-run publish, the HTTP retry, the
      // `projects publish` CLI) accepts any delivered run whose publication is
      // pending or failed, with no notion of sequence — so without this,
      // publishing an older run would move the branch back to older artifacts.
      // It is a refusal with no override flag: the newest delivered workspace
      // is cumulative by seeding, so the published run's artifacts already
      // contain the older run's work.
      const branch = repository.defaultBranch || 'main';
      const previous = this.store.lastPublishedCommitForProject(project.orgId, project.projectId);
      if (
        project.repositoryTarget.source?.mode !== 'pull-request' && previous &&
        previous.projectRunId !== run.projectRunId &&
        (run.createdAt < previous.runCreatedAt ||
          (run.createdAt === previous.runCreatedAt && run.projectRunId <= previous.projectRunId))
      ) {
        throw new PublicationSupersededError(
          `run ${run.projectRunId.slice(0, 8)} was created before run ${previous.projectRunId.slice(0, 8)}, whose artifacts are already published as ${previous.commitSha.slice(0, 7)}: publishing it now would move ${repository.fullName}@${branch} back to older artifacts`
        );
      }

      const commitInput = {
        token: installationToken.token,
        repository: {
          owner: project.repositoryTarget.owner,
          name: project.repositoryTarget.name,
        },
        branch,
        message: publicationCommitMessage({
          project,
          run,
          manifest: run.artifactManifest,
        }),
        expectedHead: previous?.commitSha ?? null,
        // The manifest's recorded mode travels all the way to the tree:
        // `readManifestArtifact` refuses a file whose on-disk mode diverged,
        // so dropping it here silently published executables as 100644.
        files: run.artifactManifest.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          content: readManifestArtifact({
            workspaceRoot: input.workspaceRoot,
            expected: file,
          }),
        })),
      };
      const base = this.store.getProjectRun(project.orgId, run.projectRunId)?.repositoryBase;
      if (project.repositoryTarget.source && (!base || base.repositoryId !== repository.repositoryId)) {
        throw new Error('Imported run has no matching repository base');
      }
      const commit = project.repositoryTarget.source && base
        ? await this.client.publishRepositoryRun({ ...commitInput,
            branch: project.repositoryTarget.source.mode === 'pull-request' ? `atoma/run-${run.projectRunId}` : base.branch,
            baseBranch: base.branch, baseSha: base.commitSha,
            pullRequest: project.repositoryTarget.source.mode === 'pull-request' })
        : await this.client.publishManifestCommit(commitInput);

      publishing = this.store.transitionPublication({
        orgId: project.orgId,
        publicationId: publication.publicationId,
        from: 'publishing',
        to: 'published',
        receipt: {
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          url: repository.url,
          defaultBranch: repository.defaultBranch,
          commitSha: commit.commitSha,
          baseSha: commit.baseSha,
          ...('pullRequestUrl' in commit ? { pullRequestUrl: commit.pullRequestUrl as string | null } : {}),
        },
      });
      this.events({
        kind: 'publication.published',
        actorType: 'principal',
        actorId: run.requestedByPrincipalId,
        orgId: project.orgId,
        projectId: project.projectId,
        runId: run.projectRunId,
        summary:
          commit.publishKind === 'unchanged'
            ? `No change to publish on ${eventLabel(repository.fullName, 80)}`
            : `Published to ${eventLabel(repository.fullName, 80)}`,
        detail: {
          repository: repository.fullName,
          url: repository.url,
          commitSha: commit.commitSha,
          baseSha: commit.baseSha,
          publishKind: commit.publishKind,
          files: run.artifactManifest.files.length,
        },
      });
      return publishing;
    } catch (error) {
      // Emitted BEFORE the state transition below, and outside its try: the
      // transition can itself fail (that is why it has its own catch), and a
      // publication failure nobody is told about is the exact defect this
      // hook exists to remove.
      this.events({
        kind: 'publication.failed',
        actorType: 'principal',
        actorId: run.requestedByPrincipalId,
        orgId: project.orgId,
        projectId: project.projectId,
        runId: run.projectRunId,
        summary: `Publication failed: ${eventLabel(errorMessage(error), 120)}`,
        detail: { project: project.slug },
      });
      try {
        const current = this.store.getPublication(project.orgId, publication.publicationId);
        if (current && current.status === 'publishing') {
          this.store.transitionPublication({
            orgId: project.orgId,
            publicationId: publication.publicationId,
            from: 'publishing',
            to: 'failed',
            error: errorMessage(error),
          });
        }
      } catch (transitionError) {
        process.stderr.write(
          `[atoma publisher] failed to record publication failure for ${publication.publicationId}: ${String(transitionError)}\n`
        );
      }
      // AND THE REPOSITORY ROW. Without this, a repository that could not be
      // created stayed at `creating` with a NULL error — for ever, and
      // indistinguishable from a publish still in flight, sitting above a
      // green `delivered` run. `failed` was reachable only in tests.
      // `ready` is terminal on purpose (`REPOSITORY_TRANSITIONS.ready = []`),
      // so a failure after the repository exists is a publication failure and
      // must not touch this row.
      try {
        const currentProject = this.store.getProject(project.orgId, project.projectId);
        if (
          currentProject &&
          (currentProject.repositoryStatus === 'pending' ||
            currentProject.repositoryStatus === 'creating')
        ) {
          this.store.transitionRepository({
            orgId: project.orgId,
            projectId: project.projectId,
            from: currentProject.repositoryStatus,
            to: 'failed',
            error: errorMessage(error),
          });
        }
      } catch (transitionError) {
        process.stderr.write(
          `[atoma publisher] failed to record repository failure for ${project.projectId}: ${String(transitionError)}\n`
        );
      }
      throw error;
    }
  }

  private userAccessToken(principalId: string): Promise<string> {
    if (!this.resolveUserAccessToken) {
      throw new Error(
        'creating a personal GitHub repository requires a stored user-to-server token'
      );
    }
    return this.resolveUserAccessToken(principalId);
  }
}

/**
 * Wire a publisher onto a coordinator when the deployment configured the
 * GitHub App. Exported for the server; tests inject their own.
 */
export function publisherPath(run: ProjectRun, workspaceRoot: string): string {
  return path.join(workspaceRoot, '.atoma-publish', run.projectRunId);
}

export { ProjectStateConflict };
