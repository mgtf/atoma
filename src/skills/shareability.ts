import type { Skill } from './types.js';
import { hostAllowsLoopbackNetwork, scanScriptBody } from './scriptScan.js';
import { undeclaredToolMentions } from '../atoms/verdict.js';

/**
 * Would this skill body be safe to offer to a DIFFERENT organisation?
 *
 * The mechanical half of the review gate `docs/saas-architecture.md` §4.2
 * specifies. It exists BEFORE there is a second organisation on purpose: the
 * gate itself would never fire today, but the CRITERION applied today is what
 * stops the catalog filling with recipes nobody ever judged by it. A recipe
 * distilled, promoted and trusted for months is far more expensive to reject
 * later than one flagged the week it was learned.
 *
 * WHAT THIS IS NOT. It is not the gate, and it must never be cited as one.
 * §4.2 is explicit that both kinds require a HUMAN to read the body — the
 * script kind because it is code another tenant's sandbox will execute, the
 * llm kind because it is an instruction set injected into another tenant's
 * system prompt. A clean verdict here means "a reviewer's time will not be
 * wasted", never "approved". The same rule the repo already applies to
 * `scanScriptBody` (CLAUDE.md R5: never cite a hygiene filter as a security
 * control) applies to this file.
 */

export type ShareVerdict =
  /** A mechanical finding that a reviewer would reject on. Fix before offering. */
  | 'blocked'
  /** Nothing mechanical found; a human must still read the body. */
  | 'review-required'
  /** Structurally local — offering it elsewhere is meaningless, not merely unsafe. */
  | 'not-shareable';

export interface ShareFinding {
  readonly code: string;
  readonly detail: string;
}

export interface ShareAssessment {
  readonly verdict: ShareVerdict;
  /** Why a reviewer would say no. Empty on `review-required`. */
  readonly blockers: ShareFinding[];
  /** Worth a reviewer's attention; not disqualifying on its own. */
  readonly warnings: ShareFinding[];
  /** What a human still has to do, in one line. */
  readonly humanMustCheck: string;
}

/**
 * Literals that betray the run a recipe was distilled FROM.
 *
 * This is the leakage channel that makes "runs are partitioned but skills are
 * shared" a contradiction rather than a policy: a skill body is written by an
 * LLM summarising one tenant's run. The distillation prompt carries a
 * generalisation rule and it demonstrably works — measured 2026-08-09, 0 of
 * 25 bodies on disk carried one — but it is an instruction, not a mechanism,
 * and the repo documents a case where a literal survived it
 * (`document-cli-from-source` shipping `node index.js sample.txt` into a
 * Caesar-cipher README). "Works most of the time" is not a confidentiality
 * property when the failure mode is another customer's data.
 */
const LEAK_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  {
    code: 'leak:concrete-file-arg',
    re: /\b(?:node|python3?|sh|bash)\s+\S*\.(?:js|mjs|cjs|py|sh)\s+[\w-]+\.(?:txt|csv|json|md|log|tsv)\b/i,
    why: 'names a concrete input filename from the originating run',
  },
  {
    code: 'leak:absolute-path',
    re: /(?:\/Users\/[\w.-]+|\/home\/[\w.-]+|[A-Z]:\\Users\\)/,
    why: 'contains an absolute path from the machine it was learned on',
  },
  {
    code: 'leak:pinned-port',
    re: /\b(?:localhost|127\.0\.0\.1):\d{4,5}\b/,
    why: 'pins a port that was assigned for one run',
  },
  {
    code: 'leak:external-host',
    // Loopback and example domains are fine; a real third-party host in a
    // recipe means the originating task's integration came along with it.
    re: /https?:\/\/(?!localhost|127\.0\.0\.1|example\.(?:com|org))[a-z0-9.-]+\.[a-z]{2,}/i,
    why: 'references an external host from the originating task',
  },
];

export interface ShareabilityInput {
  readonly skill: Skill;
  /** Tools the OWNING L1 declares — the scope the body may legitimately use. */
  readonly ownerToolNames: readonly string[];
}
// Counters are read off the Skill, NOT passed alongside it. They were
// separate fields for one revision and the author's own test immediately
// forgot to pass them, silently disabling the free-ride warning — a shape
// that lets a caller omit data the callee already has is a trap, not an
// option.

export function assessShareability(input: ShareabilityInput): ShareAssessment {
  const { skill, ownerToolNames } = input;
  const blockers: ShareFinding[] = [];
  const warnings: ShareFinding[] = [];
  const body = skill.body ?? '';
  const prose = `${skill.description}\n${skill.whenToUse}\n${body}`;

  // Event skills are matched mid-run by a local token matcher against THIS
  // deployment's validator wording. Offering one to another org ships a
  // trigger that will never fire there — not dangerous, just meaningless.
  if (skill.trigger) {
    return {
      verdict: 'not-shareable',
      blockers: [],
      warnings: [],
      humanMustCheck:
        'event-driven recovery guidance — coupled to the local mid-run matcher, not a portable recipe',
    };
  }

  for (const p of LEAK_PATTERNS) {
    const m = p.re.exec(prose);
    if (m) blockers.push({ code: p.code, detail: `${p.why}: ${JSON.stringify(m[0]).slice(0, 80)}` });
  }

  // A body naming a tool its own host cannot declare will misfire wherever it
  // lands. Already enforced at distillation and revision; re-checked here
  // because a body can also be hand-authored or edited on disk.
  const undeclared = undeclaredToolMentions(prose, ownerToolNames);
  for (const t of undeclared) {
    blockers.push({
      code: 'scope:undeclared-tool',
      detail: `names "${t}", which the owning L1 does not declare`,
    });
  }

  if (skill.kind === 'script') {
    // The scan is a hygiene filter with a documented, deliberate hole
    // (child_process is permitted because the probe-manifest contract needs
    // it). Its findings are worth surfacing; its silence proves nothing.
    // Same loopback allowance the promotion path uses: an HTTP-bucket host's
    // scripts probe the server they just booted, so blanket network flags
    // would refuse that whole family.
    const flags = scanScriptBody(body, {
      allowLoopbackNetwork: hostAllowsLoopbackNetwork(ownerToolNames),
    });
    for (const f of flags) blockers.push({ code: `scan:${f}`, detail: 'static scan flagged this body' });
  }

  // How much of this skill's trust is backed by runs it demonstrably drove.
  //
  // REPORT THE OBSERVATION, NOT A CAUSE. An earlier wording said "N credited
  // without driving", which asserts the adherence gate withheld the credit.
  // Checked against the traces: `probe-crud` (gap 3) and
  // `document-api-from-server-source` (gap 1) match their recorded
  // `credit-withheld` events exactly, but the two Hydrogen gaps have none —
  // a run that died before its hook leaves the same arithmetic. The number
  // is worth a reviewer's eye; the explanation is not ours to give.
  const driven = (skill.successes ?? 0) + (skill.failures ?? 0);
  const matches = skill.matches ?? 0;
  if (matches > driven && driven > 0) {
    warnings.push({
      code: 'trust:unmatched-credit',
      detail: `${matches} matches vs ${driven} driven runs — ${matches - driven} match(es) moved no counter`,
    });
  } else if (matches > 0 && matches < driven) {
    // SILENCE HERE WAS THE BUG. `matches` cannot legitimately trail the runs
    // it gated, so the two counters cover different periods: `matches` was
    // added to the schema after those successes accrued, or a
    // `promoteToScript` / `resetCounters` zeroed one era and not the other.
    // Measured today: `build-argv-file-cli` reads 10 matches against 23
    // successes. Saying nothing let a reviewer read "no warning" as "the
    // counters agree", which is the opposite of what is true.
    warnings.push({
      code: 'trust:counter-eras',
      detail:
        `${matches} matches BELOW ${driven} driven runs — impossible within one era, so the ` +
        `counters span different periods and this ratio cannot be used as evidence`,
    });
  }

  const humanMustCheck =
    skill.kind === 'script'
      ? 'READ THE NODE SOURCE — this body is executed in another tenant\'s sandbox with no validator in the loop'
      : 'read the instruction text — it is injected into another tenant\'s system prompt';

  return {
    verdict: blockers.length > 0 ? 'blocked' : 'review-required',
    blockers,
    warnings,
    humanMustCheck,
  };
}
