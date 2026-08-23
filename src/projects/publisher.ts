import path from 'node:path';
import { GitHubApiError, type GitHubAppClient } from '../github/client.js';
import { GitHubStore } from '../github/store.js';
import { ProjectStateConflict, type ProjectStore } from './store.js';
import {
  revalidateArtifactManifest,
  readManifestArtifact,
} from './artifacts.js';
import type { Project, ProjectRun, Publication } from '../contracts/projects.js';
import { eventLabel, type PlatformEventSink } from '../contracts/platformEvents.js';

/**
 * GITHUB PUBLISHER — turns a delivered run's artifact manifest into a GitHub
 * repository with one initial commit.
 *
 * Contract (see AGENTS.md):
 * - The repository is created only AFTER the run was delivered and validated;
 *   a failed run never leaves an empty repo behind.
 * - Creation is idempotent per project: a retry finds the existing repository
 *   and proceeds to publish; it never creates a second one.
 * - The initial publish is atomic in the "no half state" sense: the branch is
 *   created LAST, so a failure mid-way leaves an empty repo (no default
 *   branch) that the next attempt can repopulate via `getReference === null`.
 * - The manifest is re-read byte-for-byte right before each blob upload;
 *   a file that changed after delivery is a refusal, never a silent revision.
 *
 * The publisher receives resolved tokens (installation token from the GitHub
 * App client); it never handles app credentials itself.
 */

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
        installation.installationId
      );
      const linked = this.github.getInstallation(installation.installationId);
      if (!linked) {
        throw new Error('GitHub installation disappeared after resolution');
      }
      const createToken =
        installation.targetType === 'User'
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

      // Revalidate the manifest against disk immediately before upload.
      revalidateArtifactManifest({
        workspaceRoot: input.workspaceRoot,
        manifest: run.artifactManifest,
        expectedHash: input.manifestHash,
      });

      const commit = await this.client.publishInitialCommit({
        token: installationToken.token,
        repository: {
          owner: project.repositoryTarget.owner,
          name: project.repositoryTarget.name,
        },
        branch: repository.defaultBranch || 'main',
        message: `atoma: publish artifacts for run ${run.projectRunId}`,
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
      });

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
        },
      });
      this.events({
        kind: 'publication.published',
        actorType: 'principal',
        actorId: run.requestedByPrincipalId,
        orgId: project.orgId,
        projectId: project.projectId,
        runId: run.projectRunId,
        summary: `Published to ${eventLabel(repository.fullName, 80)}`,
        detail: {
          repository: repository.fullName,
          url: repository.url,
          commitSha: commit.commitSha,
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
