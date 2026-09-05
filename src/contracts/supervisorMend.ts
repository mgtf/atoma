import { z } from 'zod';
import { jsonSchemaFromZod } from './jsonSchema.js';

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
