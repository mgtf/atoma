import { eventLabel } from '../contracts/platformEvents.js';
import type { ArtifactManifest, Project, ProjectRun } from '../contracts/projects.js';

/**
 * WHAT A PUBLISHED COMMIT SAYS FOR ITSELF.
 *
 * It used to say `atoma: publish artifacts for run <uuid>` and nothing else, so
 * a repository's history explained neither what changed nor why. This renders a
 * message that carries the three things a reader cannot get anywhere else.
 *
 * 1. WHY the file changed, in the tenant's own words. The goal is the only
 *    sentence in the system that says that.
 * 2. WHAT THE RUN DECLARED. This is the one that matters, and it is specific to
 *    merge semantics: publication commits the manifest ONTO the parent's tree
 *    (`base_tree`), so the tree carries paths from earlier runs and the diff
 *    shows only what changed. The declared output set is therefore NOT
 *    RECOVERABLE FROM GIT. Recording it is the whole reason this has a body.
 * 3. PROVENANCE, because in six months `git log` has to say that a machine
 *    wrote this, from which run of which project.
 *
 * WHAT IT DELIBERATELY OMITS. The PARENT and whether this commit created the
 * branch are first-class git fields — a root commit has no parent — so naming
 * them in prose would duplicate the commit's own metadata, and would be a claim
 * made BEFORE the head is read and therefore wrong if the branch moved. Cost and
 * call counts are omitted too: they are parsed from the run log, a channel a
 * tenant's own goal can write into (`src/cli/AGENTS.md`), so publishing them
 * into a git history would publish a number the tenant can influence. Those
 * belong to the journal. The trace id means nothing outside this instance.
 */

/** Git's practical subject bound. Longer subjects are truncated by every UI. */
export const COMMIT_SUBJECT_MAX_CHARS = 72;

/** Git's practical body width. The quoted goal is rewrapped to it. */
export const COMMIT_BODY_WIDTH = 72;

/**
 * `createCommit` and `putContentsFile` refuse a message over 65_536 characters,
 * so this is the budget the renderer must stay inside. A 256-file manifest at
 * the artifact policy's limit plus a 4_000-character goal lands far below it;
 * the bound is asserted by a test rather than trusted.
 */
export const MAX_COMMIT_MESSAGE_CHARS = 65_536;

/**
 * The subject, cut at a WORD boundary. `eventLabel` does the flattening and the
 * bounding, but a bare bound ends mid-word — `"…switches the c…"` — which reads
 * as damage rather than as an abbreviation. Nothing is lost either way: the goal
 * follows in full below.
 */
function subjectFromGoal(goal: string): string {
  const bounded = eventLabel(goal, COMMIT_SUBJECT_MAX_CHARS);
  if (!bounded.endsWith('…')) return bounded;
  const body = bounded.slice(0, -1).trimEnd();
  const lastSpace = body.lastIndexOf(' ');
  // Only back off to the word boundary when one exists late enough to keep the
  // subject informative; a single 72-character word stays cut.
  return lastSpace >= COMMIT_SUBJECT_MAX_CHARS / 2 ? `${body.slice(0, lastSpace)}…` : `${body}…`;
}

/**
 * Rewrap one paragraph to the body width, preserving the tenant's own line
 * breaks. Their words are all kept and none is reordered; only the wrapping is
 * this renderer's, which is why the message says "in full" rather than claiming
 * a byte-identical layout.
 */
function wrapParagraph(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const wrapped: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      wrapped.push(current);
      current = word;
    }
  }
  if (current.length > 0) wrapped.push(current);
  return wrapped;
}

/**
 * Strip what a commit message may not carry, keeping the shape the tenant wrote.
 *
 * NUL is refused outright by the client, and other C0 controls render as
 * mojibake in every git UI — but newline and tab are the goal's own formatting
 * and are kept, because the point of quoting the goal is to quote what was
 * written, not a flattened version of it.
 */
function sanitiseGoalText(goal: string): string {
  return [...goal]
    .map((character) => {
      if (character === '\n' || character === '\t') return character;
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export interface PublicationCommitMessageInput {
  readonly project: Pick<Project, 'slug' | 'name'>;
  readonly run: Pick<ProjectRun, 'projectRunId' | 'goal'>;
  readonly manifest: ArtifactManifest;
}

/**
 * Render the message for one publication.
 *
 * The subject is the goal through `eventLabel`, which flattens control
 * characters, collapses whitespace and marks a truncation with an ellipsis. A
 * truncated subject used to be a hazard on its own — a real trace carried
 * `"…tiles that swap colour w"` and every surface repeated the lie
 * (`src/viz/trace.ts`, 2026-08-15) — and here it cannot mislead, because the
 * goal follows IN FULL two paragraphs down. The subject also backs off to a word
 * boundary, so it abbreviates rather than looking damaged.
 */
export function publicationCommitMessage(input: PublicationCommitMessageInput): string {
  const { project, run, manifest } = input;
  const subject = subjectFromGoal(run.goal);
  const shortRun = run.projectRunId.slice(0, 8);

  const pathWidth = Math.max(...manifest.files.map((file) => file.path.length));
  const sizeWidth = Math.max(...manifest.files.map((file) => String(file.size).length));
  const declared = manifest.files
    .map(
      (file) =>
        `  ${file.path.padEnd(pathWidth)}  ${String(file.size).padStart(sizeWidth)} bytes  ${file.mode}`
    )
    .join('\n');
  const plural = manifest.files.length === 1 ? 'path' : 'paths';

  const goal = sanitiseGoalText(run.goal);
  // INDENTED, and that is a guard rather than a style. Git trailers are
  // unindented `Key: value` lines at the end of a message, so a goal carrying a
  // line like `Atoma-Run: <another uuid>` would otherwise forge one. Two spaces
  // make every line of tenant text structurally incapable of being a trailer.
  const quotedGoal = goal
    .split('\n')
    .flatMap((line) => wrapParagraph(line, COMMIT_BODY_WIDTH - 2))
    .map((line) => (line.length > 0 ? `  ${line}` : ''))
    .join('\n');

  const message = [
    subject,
    '',
    `Published by atoma from run ${shortRun} of project ${project.slug}.`,
    '',
    `Declared by this run — ${manifest.files.length} ${plural}, ${manifest.totalBytes} bytes.`,
    'These are committed onto what the previous run published, so a path this',
    'repository holds that is absent below came from an earlier run and is',
    'not in this diff.',
    '',
    declared,
    '',
    'Goal, in full:',
    '',
    quotedGoal,
    '',
    `Atoma-Project: ${project.slug}`,
    `Atoma-Run: ${run.projectRunId}`,
  ].join('\n');

  if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
    // Unreachable from the artifact policy's own limits, which is why this
    // raises rather than truncating: a message this long means a bound moved.
    throw new Error(
      `publication commit message is ${message.length} characters, over the ${MAX_COMMIT_MESSAGE_CHARS} the GitHub client accepts`
    );
  }
  return message;
}
