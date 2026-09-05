// The mender's PURE half (supervisor stage 3, docs/supervisor-design.md).
//
// Everything here is a function of its arguments: which verdict findings may
// be mended, what the model may and may not have touched, how the branch, the
// commit and the pull request are named and worded. `scripts/mender.mjs` is
// the shell that owns the worktree, the child processes and the network; this
// file is what the tests can hold without any of that.

import { createHash } from 'node:crypto';
import { truncate } from './supervisor-common.mjs';

export const MEND_SCHEMA_TAG = 'atoma.supervisor.mend/v1';
export const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

/**
 * What the mender may be asked to fix, and — the load-bearing half — what it
 * must never be asked to fix.
 *
 *   - `defect` only. A `mechanism_candidate` is, by the root COOLING-OFF
 *     contract, never designed the same day it is found; the analyst already
 *     routes it to `supervisor/backlog.jsonl`, and a mender that took it would
 *     be a same-day gate with a commit button. There is deliberately no flag
 *     to include them.
 *   - `security_incident` is an alert for a human, not a patch.
 *   - a `proposedFix` with `checkedIntentionalChoices` is REQUIRED: the
 *     analyst's citation rule exists because reading intentional-choices was
 *     measurably not enough, and a fix with no cited file inherits that gap.
 *   - confidence at or above the floor (`high` by default: a mend costs real
 *     quota and ten minutes of a dedicated machine).
 */
export function eligibleFindings(verdict, { minConfidence = 'high' } = {}) {
  const floor = CONFIDENCE_RANK[minConfidence];
  if (floor === undefined) throw new Error(`unknown confidence floor: ${minConfidence}`);
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const out = [];
  findings.forEach((finding, index) => {
    if (!finding || typeof finding !== 'object') return;
    if (finding.kind !== 'defect') return;
    if ((CONFIDENCE_RANK[finding.confidence] ?? -1) < floor) return;
    const fix = finding.proposedFix;
    const cited =
      fix && typeof fix === 'object' &&
      typeof fix.where === 'string' && fix.where.trim() &&
      typeof fix.what === 'string' && fix.what.trim() &&
      typeof fix.checkedIntentionalChoices === 'string' && fix.checkedIntentionalChoices.trim();
    if (!cited) return;
    out.push({ index, finding });
  });
  return out;
}

/** Repository paths the mender may quote verbatim to the model. */
const SOURCE_REF = /^(src|tests|docs|scripts|benchmark|deploy|docker)\//;

/**
 * The finding as the mender's model is allowed to see it.
 *
 * The analyst's `evidence[].quote` fields carry verbatim trace text — model
 * and tool output, fetched pages, error prose — and the design rule is that
 * stage 3 never receives raw trace prose. A quote whose `ref` points into the
 * repository source is kept (it is our own code); every other quote is
 * dropped and only its `path:line` pointer survives. The model still cannot
 * open those pointers: its worktree has no `runs/` and no `supervisor/`.
 */
export function sanitiseFinding(finding) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  return {
    kind: finding.kind,
    title: truncate(String(finding.title ?? ''), 200),
    detail: truncate(String(finding.detail ?? ''), 4000),
    confidence: finding.confidence,
    proposedFix: {
      where: truncate(String(finding.proposedFix?.where ?? ''), 300),
      what: truncate(String(finding.proposedFix?.what ?? ''), 2000),
      checkedIntentionalChoices: truncate(
        String(finding.proposedFix?.checkedIntentionalChoices ?? ''),
        1000
      ),
    },
    evidence: evidence
      .filter((item) => item && typeof item.ref === 'string')
      .slice(0, 12)
      .map((item) => {
        const ref = truncate(item.ref, 300);
        if (SOURCE_REF.test(ref) && typeof item.quote === 'string') {
          return { ref, quote: truncate(item.quote, 200) };
        }
        return { ref, quote: '[trace excerpt withheld from the mender by design]' };
      }),
  };
}

/**
 * One defect, across runs. Two runs that surface the same bug must not open
 * two pull requests, and the finding has no id, so the key is derived from
 * WHERE the fix lands and what the analyst called it — normalised so casing,
 * punctuation and run-specific numbers do not split one defect in two. It is
 * an approximation and is documented as one; the PR body carries it as a
 * `Defect-Key:` line for `gh pr list --search`.
 */
export function defectKey(finding) {
  const norm = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/\d+/g, 'n')
      .replace(/[^a-z\s/._-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const material = `${norm(finding.proposedFix?.where)}|${norm(finding.title)}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

export function slugify(text, max = 40) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'fix';
}

export function branchName(runId, findingIndex, finding) {
  const shortRun = String(runId).split('-').pop()?.slice(0, 8) ?? 'run';
  return `mender/${shortRun}-${findingIndex}-${slugify(finding.title)}`;
}

/**
 * WHAT THE MODEL MAY HAVE CHANGED. An allowlist, not a denylist: a fix for a
 * run-time defect lives in `src/` with its regression test in `tests/`, and a
 * dated note may land under `docs/incidents/`. Everything else — workflows,
 * the deploy scripts, the hooks, dependencies, the supervisor's own scripts —
 * is a decision a person makes, and a "fix" that needs one is not a fix the
 * mender may ship. The cap on changed lines is the same idea by size: a
 * defect fix is small, and a rewrite wearing that name goes to a human.
 */
export const ALLOWED_PATH = /^(src\/|tests\/|docs\/incidents\/)/;

export function checkDiffPolicy({ files, numstat, maxLines = 600 }) {
  const problems = [];
  if (files.length === 0) {
    problems.push('the model reported a fix but changed no file');
    return { ok: false, problems, testFiles: [], sourceFiles: [], changedLines: 0 };
  }
  const outside = files.filter((file) => !ALLOWED_PATH.test(file));
  if (outside.length > 0) {
    problems.push(`changes outside src/, tests/, docs/incidents/: ${outside.join(', ')}`);
  }
  const testFiles = files.filter((file) => /^tests\/.*\.test\.[cm]?[jt]sx?$/.test(file));
  const sourceFiles = files.filter((file) => !testFiles.includes(file));
  if (testFiles.length === 0) {
    problems.push('no regression test under tests/ — the exit contract requires one');
  }
  if (sourceFiles.filter((file) => file.startsWith('src/')).length === 0) {
    problems.push('no change under src/ — a test alone does not fix a defect');
  }
  const changedLines = numstat.reduce((total, row) => total + row.added + row.deleted, 0);
  if (changedLines > maxLines) {
    problems.push(`${changedLines} changed lines exceed the ${maxLines}-line cap for an autonomous fix`);
  }
  return { ok: problems.length === 0, problems, testFiles, sourceFiles, changedLines };
}

/** `git diff --numstat` rows. Binary files report `-` and count as one line each. */
export function parseNumstat(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      return {
        added: added === '-' ? 1 : Number(added) || 0,
        deleted: deleted === '-' ? 1 : Number(deleted) || 0,
        file: rest.join('\t'),
      };
    });
}

/** The structured report the model must end with. Enforced by --json-schema. */
export const MEND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'outcome', 'title', 'summary', 'checkedIntentionalChoices'],
  properties: {
    schema: { enum: [MEND_SCHEMA_TAG] },
    outcome: { enum: ['fixed', 'declined'] },
    /** Conventional-commit subject without the type prefix, ≤ 72 chars. */
    title: { type: 'string', minLength: 1, maxLength: 120 },
    /** What was wrong, what changed, how the regression test proves it. */
    summary: { type: 'string', minLength: 1 },
    /** Which AGENTS.md was read for the touched subsystem and why this is not a recorded rejected shortcut. */
    checkedIntentionalChoices: { type: 'string', minLength: 1 },
    /** Required when declined: why no safe fix exists (not a defect, needs a mechanism, needs a human decision). */
    declineReason: { type: 'string' },
    /** The regression test files the model added or changed. */
    regressionTests: { type: 'array', items: { type: 'string' } },
    /** Anything a reviewer must weigh that the diff does not say by itself. */
    reviewerNotes: { type: 'string' },
  },
};

export function validateMend(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return ['mend report is not an object'];
  if (report.schema !== MEND_SCHEMA_TAG) problems.push('bad schema tag');
  if (!['fixed', 'declined'].includes(report.outcome)) problems.push('bad outcome');
  if (typeof report.title !== 'string' || !report.title.trim()) problems.push('title missing');
  if (typeof report.summary !== 'string' || !report.summary.trim()) problems.push('summary missing');
  if (
    typeof report.checkedIntentionalChoices !== 'string' ||
    !report.checkedIntentionalChoices.trim()
  ) {
    problems.push('checkedIntentionalChoices missing');
  }
  if (report.outcome === 'declined' && !(typeof report.declineReason === 'string' && report.declineReason.trim())) {
    problems.push('declined without a declineReason');
  }
  return problems;
}

/**
 * Which provider the mender's child session uses. ALL-OR-NOTHING: a mender
 * model id paired with the analyst's base URL would send a Claude id to a
 * GLM endpoint, so the three ATOMA_MENDER_* variables are read as a set, the
 * three ATOMA_ANALYST_* variables are the fallback set (same operator-owned
 * subscription, same quota rationale), and the default is the subscription
 * with a pinned Claude id.
 */
export function menderProvider(env) {
  const own = ['ATOMA_MENDER_MODEL', 'ATOMA_MENDER_BASE_URL', 'ATOMA_MENDER_AUTH_TOKEN'];
  const analyst = ['ATOMA_ANALYST_MODEL', 'ATOMA_ANALYST_BASE_URL', 'ATOMA_ANALYST_AUTH_TOKEN'];
  const pick = (names) => ({
    model: env[names[0]] ?? null,
    baseUrl: env[names[1]] ?? null,
    authToken: env[names[2]] ?? null,
  });
  if (own.some((name) => env[name] !== undefined)) {
    const set = pick(own);
    return { ...set, model: set.model ?? 'claude-sonnet-5', source: 'mender' };
  }
  if (analyst.some((name) => env[name] !== undefined)) {
    const set = pick(analyst);
    return { ...set, model: set.model ?? 'claude-sonnet-5', source: 'analyst' };
  }
  return { model: 'claude-sonnet-5', baseUrl: null, authToken: null, source: 'default' };
}

export function buildMenderPrompt(template, { runId, verdict, findingIndex, finding }) {
  const safe = sanitiseFinding(finding);
  return template
    .replaceAll('{{RUN_ID}}', runId)
    .replaceAll('{{RUN_STATUS}}', String(verdict.runStatus ?? 'unknown'))
    .replaceAll('{{RUN_GRADE}}', String(verdict.runAssessment?.grade ?? 'unknown'))
    .replaceAll('{{FINDING_INDEX}}', String(findingIndex))
    .replaceAll('{{FINDING_JSON}}', JSON.stringify(safe, null, 2));
}

/** `fix(area): title` — area is the first path segment under src/. */
export function commitSubject(report, sourceFiles) {
  const first = sourceFiles.find((file) => file.startsWith('src/')) ?? '';
  const segments = first.split('/');
  // `src/atoms/plan.ts` → atoms; `src/index.ts` → index (a file straight under src/).
  const area = (segments[1] ?? 'core').replace(/.[cm]?[jt]sx?$/, '') || 'core';
  const title = String(report.title).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return truncate(`fix(${area}): ${title}`, 72);
}

export function commitMessage({ report, sourceFiles, runId, key, verification }) {
  return [
    commitSubject(report, sourceFiles),
    '',
    report.summary.trim(),
    '',
    `Run: ${runId}`,
    `Regression test fails before the fix: ${verification.testFailedBefore ? 'yes' : 'no'}`,
    `Full check after the fix: ${verification.checkPassed ? 'green' : 'red'}`,
    `Defect-Key: ${key}`,
    'Authored-By: atoma mender (supervisor stage 3, docs/supervisor-design.md)',
  ].join('\n');
}

export function pullRequestBody({
  report,
  finding,
  runId,
  key,
  verification,
  provider,
  served,
  costUsd,
  diffStat,
}) {
  const safe = sanitiseFinding(finding);
  const evidence = safe.evidence.map((item) => `- \`${item.ref}\` — ${item.quote}`).join('\n');
  const servedLine = served
    ? served.map((entry) => `${entry.model}${entry.costUsd != null ? ` ($${entry.costUsd.toFixed(4)})` : ''}`).join(', ')
    : 'not reported';
  return [
    '## What the analyst found',
    '',
    `**${safe.title}** (\`defect\`, confidence ${safe.confidence}) on run \`${runId}\`.`,
    '',
    safe.detail,
    '',
    '### Evidence',
    '',
    evidence || '- (none recorded)',
    '',
    '### Proposed direction',
    '',
    `- where: ${safe.proposedFix.where}`,
    `- what: ${safe.proposedFix.what}`,
    `- intentional choices checked by the analyst: ${safe.proposedFix.checkedIntentionalChoices}`,
    '',
    '## What the mender changed',
    '',
    report.summary.trim(),
    '',
    `Intentional choices checked by the mender: ${report.checkedIntentionalChoices.trim()}`,
    ...(report.reviewerNotes ? ['', `**Reviewer notes:** ${report.reviewerNotes.trim()}`] : []),
    '',
    '## Verification (harness-run, not model-reported)',
    '',
    `- regression test FAILS before the fix: ${verification.testFailedBefore ? '✅' : '❌'} (${verification.testFiles.join(', ')})`,
    `- full \`${verification.checkCommand}\` after the fix: ${verification.checkPassed ? '✅ green' : '❌ red'}`,
    `- files changed: ${diffStat.files} · lines: +${diffStat.added} −${diffStat.deleted}`,
    '',
    '## Provenance',
    '',
    `- model requested: \`${provider.model}\` (${provider.source} provider${provider.baseUrl ? `, ${provider.baseUrl}` : ''})`,
    `- models served: ${servedLine}`,
    `- mend cost: ${costUsd != null ? `$${costUsd.toFixed(4)}` : 'not reported'}`,
    `- Defect-Key: ${key}`,
    '',
    '---',
    '',
    'Opened by the atoma mender (supervisor stage 3). The model edited files in an',
    'isolated worktree and ran the checks; the harness re-ran them, wrote the commit,',
    'pushed the branch and opened this PR. **A person owns the merge** — the mender',
    'has no auto-merge path, by design (`docs/supervisor-design.md`, open decision 2).',
    'Trace text never reached the model: it saw the structured finding above only.',
  ].join('\n');
}
