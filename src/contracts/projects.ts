import { z } from 'zod';
import { runStatsSchema } from './runStats.js';

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * PROJECT CONTROL-PLANE CONTRACTS.
 * ================================
 *
 * Projects are organisation-owned descriptions of work. Project runs are
 * immutable launch receipts whose workspace paths are chosen by the host,
 * never by an HTTP caller. Publications are a separate state machine: a
 * successful run can exist even when GitHub is temporarily unavailable.
 *
 * These schemas are the one runtime definition shared by the SQLite store and
 * future HTTP/client adapters. The public run projection deliberately omits
 * host filesystem paths; those paths are control-plane capabilities, not
 * product data a browser needs to learn.
 */

export const projectIdSchema = z.string().uuid();
export const projectRunIdSchema = z.string().uuid();
export const publicationIdSchema = z.string().uuid();
export const principalIdSchema = z.string().uuid();
export const organisationIdSchema = z.string().uuid();

export const projectNameSchema = z.string().trim().min(1).max(120);
export const projectSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'expected a lowercase kebab-case slug');
/**
 * How a project NAME becomes a slug — one definition, beside the schema that
 * says what a valid slug is, because the two are the same rule seen from
 * either side. The GL create form and the CLI both call it; a third copy is
 * how one of them starts truncating at a different length.
 *
 * It can return an empty string (a name of pure punctuation), which
 * `projectSlugSchema` then refuses. That refusal is the caller's to report.
 */
export function projectSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

export const projectPromptSchema = z.string().trim().max(4_000);
export const projectGoalSchema = z.string().trim().min(1).max(4_000);
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'idempotency keys must be opaque ASCII tokens');

export const githubInstallationIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'expected a positive decimal GitHub installation id');
/** Same wire shape as an installation id, but named for what it holds. */
export const githubRepositoryIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'expected a positive decimal GitHub repository id');
export const githubOwnerSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/);
export const githubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value !== '.' && value !== '..' && !value.endsWith('.git'), {
    message: 'invalid GitHub repository name',
  })
  .refine((value) => !value.includes('/') && !value.includes('\\') && !hasAsciiControl(value), {
    message: 'repository names cannot contain path separators or controls',
  });
export const repositoryVisibilitySchema = z.enum(['private', 'public']);

/**
 * ONE definition of what a project gets when nobody chooses. Flipping this
 * literal is the whole of that decision: the schema default and the create
 * form both read it, so a form cannot ship one thing while an API caller gets
 * another.
 *
 * IT IS `private`, AND THE OPERATOR ASKED FOR `public`. Recorded because
 * overriding a stated preference needs its reasons in the open, not in a
 * commit message nobody re-reads:
 *
 * 1. The reason given for `public` was that a private repository might need a
 *    paid GitHub plan. That has not been true since 7 January 2019 for
 *    personal accounts and 14 April 2020 for organisations — GitHub Free
 *    includes unlimited private repositories with unlimited collaborators, and
 *    a paid plan adds the feature SET on them (rulesets, required reviewers,
 *    Pages, Actions minutes), never the right to create one. The premise for
 *    the default was void, so the default was never really chosen.
 * 2. NOBODY IN THIS SYSTEM HAS EVER LOOKED AT WHAT GETS PUBLISHED. The file
 *    set is `plan.subtasks.flatMap(s => s.outputs)`, declared by a model at
 *    plan time before the files exist; the filter is filenames only
 *    (`secretLike`), not one byte of content; publication is automatic on
 *    delivery with no opt-out; and the manifest never crosses the API, so a
 *    tenant cannot review it before or after. A default is what happens when
 *    nobody looks, and here "nobody looks" is the entire pipeline.
 * 3. IT CANNOT BE TAKEN BACK. There is no update schema, no `UPDATE projects`
 *    statement touching this column, no PATCH route, and the HTTP transport
 *    has no PATCH method. Flipping it at GitHub instead permanently breaks the
 *    project, because `ensureRepository` refuses a repository whose visibility
 *    disagrees with the row ("never a convergence") and
 *    `REPOSITORY_TRANSITIONS.ready` is empty, so the row can never be
 *    reconciled.
 *
 * So the two errors are not symmetric. Defaulting to private and being wrong
 * costs one edit to this line. Defaulting to public and being wrong published
 * an unreviewed, model-chosen file set to the internet, permanently, for
 * somebody who never touched the control.
 */
export const DEFAULT_REPOSITORY_VISIBILITY: z.infer<typeof repositoryVisibilitySchema> =
  'private';

/** An existing repository is an explicit creation mode, never a name collision. */
export const repositorySourceSchema = z.object({
  owner: githubOwnerSchema,
  name: githubRepositoryNameSchema,
  mode: z.enum(['pull-request', 'fork']),
  repositoryId: githubRepositoryIdSchema.optional(),
}).strict();

export function parseGitHubRepository(value: string): { owner: string; name: string } {
  let text = value.trim();
  if (text.startsWith('https://')) {
    const url = new URL(text);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error('Enter a github.com repository URL or owner/repository');
    }
    text = url.pathname.replace(/^\/|\/$/g, '');
  }
  text = text.replace(/\.git$/, '');
  const parts = text.split('/');
  if (parts.length !== 2) throw new Error('Enter a github.com repository URL or owner/repository');
  return { owner: githubOwnerSchema.parse(parts[0]), name: githubRepositoryNameSchema.parse(parts[1]) };
}

export const repositoryTargetSchema = z
  .object({
    installationId: githubInstallationIdSchema,
    owner: githubOwnerSchema,
    name: githubRepositoryNameSchema,
    visibility: repositoryVisibilitySchema.default(DEFAULT_REPOSITORY_VISIBILITY),
    source: repositorySourceSchema.optional(),
  })
  .strict();

export const projectStatusSchema = z.enum(['active', 'archived']);
export const repositoryStatusSchema = z.enum(['pending', 'creating', 'ready', 'failed']);
export const projectRunStatusSchema = z.enum([
  'queued',
  'running',
  'delivered',
  'failed',
  'cancelled',
]);
export const publicationStatusSchema = z.enum([
  'pending',
  'publishing',
  'published',
  'failed',
]);

const instantSchema = z.string().datetime();
const boundedErrorSchema = z.string().max(2_000).nullable();
const httpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'expected an HTTPS URL',
});

export const createProjectInputSchema = z
  .object({
    name: projectNameSchema,
    slug: projectSlugSchema,
    initialPrompt: projectPromptSchema.default(''),
    family: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/).default('build'),
    repositoryTarget: repositoryTargetSchema,
  })
  .strict();

export const projectSchema = z
  .object({
    projectId: projectIdSchema,
    orgId: organisationIdSchema,
    createdByPrincipalId: principalIdSchema,
    name: projectNameSchema,
    slug: projectSlugSchema,
    initialPrompt: projectPromptSchema,
    family: z.string().min(1).max(40),
    status: projectStatusSchema,
    repositoryTarget: repositoryTargetSchema,
    repositoryStatus: repositoryStatusSchema,
    repositoryId: githubRepositoryIdSchema.nullable(),
    repositoryFullName: z.string().min(3).max(201).nullable(),
    repositoryUrl: httpsUrlSchema.nullable(),
    defaultBranch: z.string().min(1).max(255).nullable(),
    repositoryError: boundedErrorSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

/** Browser-authored run fields. Host paths and ids do not cross this schema. */
export const createProjectRunInputSchema = z
  .object({
    goal: projectGoalSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

/** Host-owned locations supplied only after a project-run UUID is reserved. */
export const projectRunHostPathsSchema = z
  .object({
    workspacePath: z.string().min(1).max(4_096),
    runsPath: z.string().min(1).max(4_096),
    logPath: z.string().min(1).max(4_096),
  })
  .strict();

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactPathSchema = z.string().min(1).max(512);
export const artifactFileSchema = z
  .object({
    path: artifactPathSchema,
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
    mode: z.enum(['100644', '100755']),
  })
  .strict();

export const artifactManifestSchema = z
  .object({
    version: z.literal(1),
    // Absent on legacy plan-only manifests. Never infer complete coverage.
    source: z.literal('workspace').optional(),
    files: z.array(artifactFileSchema).min(1),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    let total = 0;
    let previous = '';
    for (const [index, file] of manifest.files.entries()) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'artifact paths must be unique',
        });
      }
      if (index > 0 && file.path.localeCompare(previous) < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'artifact files must be sorted by canonical path',
        });
      }
      paths.add(file.path);
      previous = file.path;
      total += file.size;
    }
    if (total !== manifest.totalBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalBytes'],
        message: `totalBytes must equal the file-size sum (${total})`,
      });
    }
  });

/** One definition of a git commit sha, written twice before this. */
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const repositoryRunBaseSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  branch: z.string().min(1).max(255),
  commitSha: commitShaSchema,
}).strict();
export type RepositoryRunBase = z.infer<typeof repositoryRunBaseSchema>;

export const projectRunSchema = z
  .object({
    projectRunId: projectRunIdSchema,
    projectId: projectIdSchema,
    orgId: organisationIdSchema,
    requestedByPrincipalId: principalIdSchema,
    requestKey: idempotencyKeySchema,
    goal: projectGoalSchema,
    status: projectRunStatusSchema,
    hostPaths: projectRunHostPathsSchema,
    repositoryBase: repositoryRunBaseSchema.optional(),
    traceId: z.string().min(1).max(255).nullable(),
    stats: runStatsSchema.nullable(),
    artifactManifest: artifactManifestSchema.nullable(),
    artifactManifestHash: sha256Schema.nullable(),
    error: boundedErrorSchema,
    createdAt: instantSchema,
    startedAt: instantSchema.nullable(),
    endedAt: instantSchema.nullable(),
    updatedAt: instantSchema,
  })
  .strict();

/**
 * Safe browser projection: no host filesystem paths. `.omit` on a `.strict()`
 * object treats the dropped key as unknown and would 500 when parsing a full
 * `ProjectRun`; `.strip()` drops `hostPaths` (and any later internal-only
 * field) instead of rejecting the record.
 */
export const projectRunPublicSchema = projectRunSchema.omit({ hostPaths: true }).strip();

export const repositoryReceiptSchema = z
  .object({
    repositoryId: githubRepositoryIdSchema,
    fullName: z.string().min(3).max(201),
    url: httpsUrlSchema,
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();

export const publicationReceiptSchema = repositoryReceiptSchema
  .extend({
    commitSha: commitShaSchema,
    /**
     * The observed parent used for publication: the captured run base for
     * imported projects, otherwise the head read just before publication. Null
     * means the branch did not exist and this publication created it;
     * `commitSha === baseSha` means this ATTEMPT added no commit, because the
     * branch already held every byte the manifest declares.
     *
     * An observation, never a pointer anything decides from — the same rule
     * `src/contracts/attestation.ts` states for a tool observation. The
     * authority to publish onto an existing branch is read from GitHub at
     * publish time; this field only records what was found.
     *
     * A required KEY with a nullable VALUE on a `.strict()` object, so a writer
     * must state what it built on rather than omitting it.
     */
    baseSha: commitShaSchema.nullable(),
    pullRequestUrl: httpsUrlSchema.nullable().optional(),
  })
  .strict();

export const publicationSchema = z
  .object({
    publicationId: publicationIdSchema,
    projectRunId: projectRunIdSchema,
    orgId: organisationIdSchema,
    idempotencyKey: idempotencyKeySchema,
    manifestHash: sha256Schema,
    status: publicationStatusSchema,
    repositoryId: githubRepositoryIdSchema.nullable(),
    repositoryFullName: z.string().min(3).max(201).nullable(),
    repositoryUrl: httpsUrlSchema.nullable(),
    commitSha: commitShaSchema.nullable(),
    baseSha: commitShaSchema.nullable(),
    pullRequestUrl: httpsUrlSchema.nullable().optional(),
    error: boundedErrorSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
    publishedAt: instantSchema.nullable(),
  })
  .strict();

export type CreateProjectInput = z.input<typeof createProjectInputSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;
export type RepositoryVisibility = z.infer<typeof repositoryVisibilitySchema>;
export type RepositoryTarget = z.infer<typeof repositoryTargetSchema>;
export type RepositoryReceipt = z.infer<typeof repositoryReceiptSchema>;
export type CreateProjectRunInput = z.input<typeof createProjectRunInputSchema>;
export type ProjectRunHostPaths = z.infer<typeof projectRunHostPathsSchema>;
export type ProjectRun = z.infer<typeof projectRunSchema>;
export type ProjectRunPublic = z.infer<typeof projectRunPublicSchema>;
export type ProjectRunStatus = z.infer<typeof projectRunStatusSchema>;
export type ArtifactFile = z.infer<typeof artifactFileSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;
