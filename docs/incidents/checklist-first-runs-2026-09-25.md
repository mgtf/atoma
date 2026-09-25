# The acceptance checklist on its first real runs — 2026-09-25

Status: evidence collected in one session; two fixes landed (`a4a2c40`,
`07d80a4`); everything else is recorded for ONE design pass under the
COOLING-OFF contract (root `AGENTS.md`), not built here.

Code under test: `75d0150` (checklist), `10f866f` (seed inheritance),
`1c81f8e` (publication pre-flight and installation rebinding). Local runs on
the platform admin's `sub:anthropic:{haiku,sonnet,opus}` pins with
`--container`; production runs on atoma.run under `own:openai:gpt-5.6-luna`,
revision `a772b3e` (recorded provenance).

## Local runs — the same ETag goal as `d677d824`, three times

| run | code actually executed | cost | LLM calls | HTTP items covered | outcome |
|---|---|---:|---:|---|---|
| `d677d824` (2026-09-24) | before the fixes | $1.12 | 23 | — | delivered after one root refusal on inherited manifest entries |
| `7a784e9e` | host `dist/` of 09-24 23:18 | $0.29 | 4 | no checklist | delivered, published |
| `91331e7d` | fresh `dist/`, worker image of 09-12 | $0.24 | 5 | **0 / 7** | delivered, published |
| `d041486c` | fresh `dist/` and worker image | $0.21 | 4 | **7 / 7** | delivered, published |

The two middle rows measured stale code, and nothing said so. A project run
started with `projects:dev` runs its publication from source, its runner from
`dist/` (`node dist/cli/build-app.js`), and its L1 elements inside
`atoma-worker:latest`, which carries its own `dist/`. `fetch_url`'s `servedBy`
lives in the worker, so the drafted checklist of `91331e7d` found no
attributable observation at all. Production is not exposed: `host-deploy.sh`
builds the worker per revision. The seed filter (host side) held on both
fresh-host runs: zero `MALFORMED` where `d677d824` was refused once.

Publication: `expenses-node-api` was bound to the deleted installation
`155229027`; the first publication recorded it deleted, moved the project to
`158307021` and created `mgtf/expenses-node-api`.

## A harder authored goal — `flags-service`, `29b5dd57`

A new local project, a feature-flag service naming twelve status codes plus a
restart and a page. Delivered on the first attempt, $0.24, six haiku calls,
141 s, 19 `fetch_url` covering every status the goal names and a restart.
The drafted list holds 12 items — the `MAX_CHECKLIST_ITEMS` cap — and the
drafter spent three on review items first, in goal order, so the TAIL was cut
without a signal: PATCH 404, both DELETE codes and the restart are not in the
list. The run proved them anyway; a longer goal would not be protected.

## Production — the exact goal of a failed run

`927444e1`, the notes/ETag goal of `cc894dad` (failed 2026-09-21, $2.83, 25
calls): delivered on the first attempt, $0.12, six calls, 593 s, published.
8 / 8 HTTP items covered. Two weaknesses, both visible in the acceptance row:

- Items are COMPOUND ("returns 428 absent, 412 on mismatch, and 200 on
  success") and each is covered by ONE status-only observation, so the list
  proved the 200 and not the 428 or the 412.
- The acceptor approved while writing "incomplete restart and unknown-route
  probes are not proof of failure": both behaviours were review items, and a
  review item binds nothing.

`af127f37`, the flags goal of `69f6f608` (refused twice on 2026-09-23), on
revision `07d80a4`: delivered on the first attempt, $0.07, four calls, 474 s,
7 / 7 HTTP items covered. It is a continuation, not a rebuild: `flags.mjs`
was already delivered by `e3fe4fb3` the evening before. Its list shows the
worst case of the compound-item weakness: `c6` "POST /flags returns per-field
errors for invalid input and 409 for duplicate keys" carries NO status, so it
means any 2xx, and it is `covered` by the same two observations as `c5`, the
successful creates. The drafting prompt says "give status only when the goal
states it"; the goal states 400 and 409, the drafter merged them under the
12-item cap and dropped the status. The list reads covered for two error
paths it never saw.

`cc922a60`, a responsive goal on the same project (the task list in
`index.html` at 320/375/768px), revision `1959763`. The viewport parameter did
its job: Water laid the page out at each width and measured `innerWidth` 320
and `scrollWidth` 320 with every control at 44px. Root acceptance refused the
delivery once, correctly, for the ephemeral port copied into the README. The
remediation then did the worst thing this session saw:

- Its prefilter excluded Water — "Already tried and failed THIS task (do NOT
  pick these): Water" — although Water's work was sound and refused only for
  one README line, and picked Glucose.
- Glucose is a molecule branched on 2026-09-07, the day before `1d6ac6e` made
  branched registry rows tier- and tool-scoped. Its PERSISTED system prompt
  still reads "Your current subtask: Create index.html as a small, polished,
  self-contained static page that clearly confirms completion", followed by a
  PRIOR ATTEMPT DIAGNOSIS from that other run. Sucrose, branched the same
  night, is the only other row of that vintage.
- Glucose followed its system prompt over the task and REPLACED the task
  list with a "Task complete" page (`index.html` 4754 → 2256 bytes). The L2
  result validator approved it, credited Glucose and distilled a skill ("adapt
  a static page for narrow screens"); the root refused again with the FIRST
  refusal's reasoning, "responsive browser checks otherwise pass".
- The run landed `partial`, unpublished, and the destroyed page is now the
  corpus the next run of this project is seeded from.

The project corpus carries every earlier deliverable (`flags.mjs`,
`bookmarks.mjs`, `inventory.mjs`…) into each new run's manifest. That is the
continuation contract working as designed, noted because it makes a
"same-goal" comparison on this project a continuation, not a fresh build.

## Analyst pass — ten verdicts, no defect

`glm-5.3`, ten runs, all verdicts written. Themes that recur across runs:

1. `validate_html` had no viewport, so 320/375/768px proof was impossible and
   was nonetheless CLAIMED by an L2 fallback and a root acceptance (`2fac992c`,
   `0e89e0ce`). Fixed as a capability in `07d80a4`; the false claims are the
   design question below.
2. Validators invent requirements, and the skill loop learns them: a result
   validator demanded `<port>` placeholders against a goal asking for a
   concrete port (`7ec691c8`), and a plan validator called a declared
   `validate_html` undeclared (`0e89e0ce`). Both refusals were distilled into
   durable skills (`recover-durable-doc-uses-numeric-port`, a revision of
   `document-static-site-readme`).
3. The trust fast path accepted a result that declared itself incomplete
   ("BROWSER VALIDATION NOT COMPLETED", `2fac992c`), recorded a success, and
   the run read `delivered`.
4. Restart persistence claimed and never exercised (`584e3fdc`).
5. A narrow rejection re-enters the whole loop and re-runs every probe
   (`d677d824`).
6. A hand-seeded fixture with zero model calls is analysed at full price
   (`54d3decf`). Not fixed: a delivered run with zero calls is also what a
   trusted compiled dispatch produces, so "skip zero-call runs" needs a
   provenance fact, not a count.

## Landed in this session

- `a4a2c40` — an analyst batch stops on the provider's account refusal
  (`api_error_status: 429`), and watch mode gives the run its attempt back and
  pauses. The 2026-09-24 backlog item 6.
- `07d80a4` — `validate_html` takes `viewport` and always reports the size it
  laid the page out at.

## For the design pass — not built here

- Checklist items: one status per HTTP item (split compound behaviours — an
  item naming error statuses must never read covered on a 2xx, `af127f37`
  `c6`), a signal when the cap truncates the goal, whether 12 is the right cap
  for goals naming a dozen statuses, and review items for behaviours that are
  HTTP-observable (an unknown route) but carry no path in the goal.
- An acceptance or L2 verdict claiming coverage the attestations do not hold
  (viewport widths, a restart): what, mechanically, may contradict prose.
- Skills distilled from a refusal that was itself wrong: whether a recovery
  skill needs the refusal to be corroborated before it is kept, and whether
  the two named above are retired.
- The trust fast path and a self-declared incomplete result.
- Root remediation (`cc922a60`): whether the molecule the root refused is
  excluded from the pass meant to fix one line of its work; what a remediation
  that REPLACES the deliverable may land (the pre-remediation workspace was
  the better one); and why the L2 validator approved a page that no longer
  did what the goal asked while the root reasoned from its first verdict.
- Registry rows persisted before `1d6ac6e` (Glucose, Sucrose) carry another
  run's subtask in their system prompt. Current code never writes one; the
  rows are data, and the prototype rule is a reset rather than a repair path —
  an operator decision on the production store.
- A warning when `dist/` or `atoma-worker:latest` is older than the source a
  local project run is meant to exercise.
