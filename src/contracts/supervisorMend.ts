import { z } from 'zod';
import { jsonSchemaFromZod } from './jsonSchema.js';
import { findingConfidenceSchema, findingKindSchema, verdictGradeSchema, verdictRunStatusSchema } from './supervisorVerdict.js';

/**
 * THE MENDER'S REPORT — what the headless session must end with (supervisor
 * stage 3, `docs/supervisor-design.md`).
 *
 * It is a REPORT, not a verdict: the harness never acts on it alone. `fixed`
 * means "the worktree holds what I claim"; the harness then proves the
 * regression test fails without the source change and the full check passes
 * with it, and only that proof opens a pull request. `declined` is a good
 * outcome — a wrong fix costs a reviewer more than no PR — and it must carry
 * its reason, because "declined" with nothing behind it is the same as a
 * timeout.
 *
 * `checkedIntentionalChoices` is required for the same reason it is on the
 * analyst's proposals: reading a subsystem's intentional-choices section was
 * measurably not enough, so the report must name the file it read.
 */
export const SUPERVISOR_MEND_SCHEMA_TAG = 'atoma.supervisor.mend/v1';

export const mendOutcomeSchema = z.enum(['fixed', 'declined']);

const mendReportShape = z
  .object({
    schema: z.enum([SUPERVISOR_MEND_SCHEMA_TAG]),
    outcome: mendOutcomeSchema,
    /** Conventional-commit subject WITHOUT the type prefix; the harness adds `fix(<area>): `. */
    title: z.string().min(1).max(120),
    /** What was wrong, what changed, how the test proves it — the commit body and the PR text. */
    summary: z.string().min(1).max(6000),
    /** Which subsystem AGENTS.md was read, and why this is not a recorded rejected shortcut. */
    checkedIntentionalChoices: z.string().min(1).max(2000),
    /** Required when declined. */
    declineReason: z.string().max(2000).optional(),
    /** Test files the model added or changed. Informational; the harness reads the diff. */
    regressionTests: z.array(z.string().max(300)).optional(),
    /** Anything the diff does not say by itself. */
    reviewerNotes: z.string().max(2000).optional(),
  })
  .strict();

export const supervisorMendReportSchema = mendReportShape.superRefine((report, ctx) => {
  if (report.outcome === 'declined' && !report.declineReason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['declineReason'],
      message: 'a declined report must say why',
    });
  }
});

export type MendOutcome = z.infer<typeof mendOutcomeSchema>;
export type SupervisorMendReport = z.infer<typeof supervisorMendReportSchema>;

/** What the headless session is held to. Derived from the shape above. */
export const SUPERVISOR_MEND_JSON_SCHEMA = jsonSchemaFromZod(supervisorMendReportSchema);

/**
 * Every way one mend attempt can end. The record on disk and the journal row
 * both carry one of these, so an operator reading either knows which stage
 * stopped it and whether anything left the machine.
 */
export const mendRecordOutcomeSchema = z.enum([
  /** A pull request exists. The only outcome with something on the remote. */
  'pr-opened',
  /** Committed and pushed, but `gh pr create` failed: the branch is on the remote, unreviewed. */
  'pushed-no-pr',
  /** The model said no, with a reason. Nothing left the worktree. */
  'declined',
  /** The harness said no: diff policy, test that already passes, red check. Worktree kept. */
  'refused',
  /** An open PR or a local record already carries this defect's key. */
  'skipped-duplicate',
  /** The session exited non-zero. */
  'model-failed',
  /** The session ended without a valid report. Raw output kept. */
  'invalid-report',
  /** Install, stash or another harness step failed. */
  'harness-failed',
  /** `--dry-run`: worktree prepared, nothing spent. */
  'dry-run',
]);
export type MendRecordOutcome = z.infer<typeof mendRecordOutcomeSchema>;

/**
 * THE FINDING AS THE MENDER'S MODEL MAY SEE IT. Evidence quotes survive only
 * for refs into the repository source; every other quote is the withheld
 * marker. This is the shape the analyst hands across a process or a network
 * boundary, so the mender never has to decide what to strip.
 */
export const WITHHELD_QUOTE = '[trace excerpt withheld from the mender by design]';

export const sanitisedFindingSchema = z
  .object({
    kind: findingKindSchema,
    title: z.string().min(1).max(400),
    detail: z.string().min(1).max(4400),
    confidence: findingConfidenceSchema,
    proposedFix: z
      .object({
        where: z.string().min(1).max(400),
        what: z.string().min(1).max(2200),
        checkedIntentionalChoices: z.string().min(1).max(1200),
      })
      .strict(),
    evidence: z.array(z.object({ ref: z.string().min(1).max(400), quote: z.string().max(400) }).strict()).max(12),
  })
  .strict();
export type SanitisedFinding = z.infer<typeof sanitisedFindingSchema>;

/**
 * ONE MEND, REQUESTED ACROSS A BOUNDARY: what a production analyst sends to
 * the repository's mender workflow (`repository_dispatch` client payload) and
 * what `npm run mender -- --finding-file` reads. Flat, at most ten top-level
 * keys (GitHub's payload rule), and never trace text: `finding` is already
 * sanitised. `key` is the analyst's own computation of the defect key so the
 * two sides agree on duplicates.
 */
export const MEND_REQUEST_SCHEMA_TAG = 'atoma.supervisor.mend-request/v1';

export const mendRequestSchema = z
  .object({
    schema: z.enum([MEND_REQUEST_SCHEMA_TAG]),
    runId: z.string().min(1).max(128),
    findingIndex: z.number().int().min(0),
    key: z.string().regex(/^[0-9a-f]{12}$/),
    runStatus: verdictRunStatusSchema,
    runGrade: verdictGradeSchema,
    finding: sanitisedFindingSchema,
    /** Which deployment asked, for the PR body and the reviewer. Not an authority. */
    instance: z.string().max(200).optional(),
  })
  .strict();
export type MendRequest = z.infer<typeof mendRequestSchema>;

export const EXAMPLE_MEND_REQUEST: MendRequest = mendRequestSchema.parse({
  schema: MEND_REQUEST_SCHEMA_TAG,
  runId: '2026-08-21T11-02-26-148-48faa963',
  findingIndex: 0,
  key: '0123456789ab',
  runStatus: 'failed',
  runGrade: 'deficient',
  finding: {
    kind: 'defect',
    title: 'validate_html accepts a pre-flight rejection as a pass',
    detail: 'The tool reports ok on a rejected smoke when the body parses.',
    confidence: 'high',
    proposedFix: {
      where: 'src/tools/browserProbe.ts',
      what: 'Check the pre-flight verdict before the body.',
      checkedIntentionalChoices: 'src/tools/AGENTS.md — a tool verdict fix, not the rejected prompt shortcut.',
    },
    evidence: [
      { ref: 'src/tools/browserProbe.ts:88', quote: 'if (parsed) return { ok: true }' },
      { ref: 'supervisor/work/x/events.ndjson:9', quote: WITHHELD_QUOTE },
    ],
  },
  instance: 'atoma.example.com',
});

/** Schema-validated example, parsed at module load (contracts convention). */
export const EXAMPLE_SUPERVISOR_MEND_REPORT: SupervisorMendReport = supervisorMendReportSchema.parse({
  schema: SUPERVISOR_MEND_SCHEMA_TAG,
  outcome: 'fixed',
  title: 'check the pre-flight verdict before the body in validate_html',
  summary:
    'validate_html returned ok when the smoke body parsed even after the pre-flight had rejected it. The verdict is now read first; tests/browser-probe.test.ts fails on the old order.',
  checkedIntentionalChoices:
    'src/tools/AGENTS.md read; this changes the tool verdict, not prompt guidance, so it is not the recorded rejected shortcut.',
  regressionTests: ['tests/browser-probe.test.ts'],
});
