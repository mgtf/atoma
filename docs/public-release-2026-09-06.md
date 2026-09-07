# Public release — licence, protections and what remains, 2026-09-06

Status: **the repository is public since 2026-09-06.** This record says what
was decided before that, what was verified and switched on, what the
end-to-end contributor test showed, and which steps are still open and who
owns them. It replaces the working conversation that produced it; reopen this
file, not that conversation, to pick the thread up.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Licence | **AGPL-3.0-only**, verbatim gnu.org text in `LICENSE`, `license` field in `package.json` | atoma is meant to become a collaborative platform between developers. A source-available licence with a Competing-Use clause (the FSL, chosen first on 2026-09-04 and replaced on 2026-09-06) forbids exactly what such an ecosystem does. The AGPL keeps the network-service copyleft that protects the hosted business, and relaxing a licence later is free while tightening one is a reputational rug pull. |
| Business model | AGPL core in this repository; hosted service and control-plane pieces as revenue; commercial licence exceptions for closed embedding; a future thin client SDK would be Apache-2.0 | The model Grafana, MinIO, Mattermost, Cal.com and Plausible run. |
| Contributor agreement | `CLA.md`, Greek law and Athens jurisdiction, section 5 commits the project to staying under an OSI-approved licence while allowing commercial exceptions | The business is a Greek sole proprietorship in the author's own name, so the copyright holder is the natural person and legal texts follow Greek law. The OSI commitment answers the asymmetry objection contributors raise against CLAs. Lawyer review is still pending (§5). |
| Skills premise | Skills are a platform commons; the organisation bounds trust and execution rights, not knowledge; Track B is the product target | Recorded in [`saas-architecture.md`](saas-architecture.md) §2 *Skills are a commons* with owner decisions 7 and 8. Documentation only; the body/trust split is unchanged. |
| History rewrite | **Not done**, deliberately | Three commit messages and two internal reviews name a competitor whose public engineering blog was analysed. The reviews link every source, reproduce no text, code or screenshot, and rest on nothing confidential: referential use of a name and paraphrase of published ideas are lawful, and removing the citations would make the derived ideas less defensible, not more. Rewriting 133 commits, 8 cited SHAs and a public branch was not worth two commit subjects. |

## 2. Verified before publication

- **Secret scan of the full history** (838 commits at the time): only the
  `.env.example` placeholders and test fakes matched credential patterns.
- **Personal data**: one personal e-mail in the archived engineering record
  and one home path in `docs/development-setup.md` were redacted. Test
  fixtures use `example.com` / `example.test` addresses only.
- **Third-party licences**: every production dependency is MIT, ISC or
  Apache-2.0; the client bundle libraries too. `@anthropic-ai/claude-agent-sdk`
  is all-rights-reserved under Anthropic's terms, installed by the user and not
  redistributed; the README says so. 3D assets are CC0 and CC-BY-4.0 with
  sidecar notices, one asserted by `tests/viz-gpu-state.test.ts`.
- **Deployment files** (`deploy/`, `docker/`, workflows) name a generic
  service user and no host, address or provider. Deployment secrets live in
  the `production` environment, restricted to `main`; a fork's pull request
  can neither deploy nor read them.
- **Remote branches**: nine merged or superseded branches were deleted;
  `main`, `cla-signatures` and the one in-flight work branch remain.
- **Repository secrets**: `OPENAI_API_KEY` (translation job) and
  `ATOMA_I18N_PUSH_TOKEN` (see §4). Nothing else.

## 3. GitHub configuration in force

| Setting | State | Note |
|---|---|---|
| Wiki, Projects | off | Discussions on, Issues on |
| Default workflow token | read-only | Workflows that write declare it themselves |
| Ruleset `protect-main` | active | No deletion or force-push; pull request with resolved threads; required checks `Hermetic checks (Node 24)` (the Node 22 arm was dropped on 2026-09-07 with the move to Node 24 only), `Mender credential isolation`, `Fresh worker image`, `cla`; bypass for the repository admin only. Versioned in [`.github/rulesets/`](../.github/rulesets/README.md) |
| CLA Assistant Lite | active | `.github/workflows/cla.yml`, action pinned by commit (v2.6.1); signatures on the orphan `cla-signatures` branch; `mgtf` and bots allowlisted |
| Dependabot | alerts and security updates on | Its pull requests pass the CLA as bots and need the CI checks |
| Private vulnerability reporting | on | What `SECURITY.md` points to |
| Secret scanning | on, with push protection | Non-provider patterns need the paid tier and stay off |
| Fork pull-request workflows | approval required for first-time contributors | The CLA workflow runs without approval (`pull_request_target`); CI waits for a click |
| Topics, homepage | set | `https://atoma.run`; llm-agents, agent-orchestration, ai-agents, typescript, agpl, mcp, sandbox, cost-optimization |

## 4. Contributor path, tested end to end

Pull request #4 from a second account (`mgtf2`), opened from a fork with a
one-word change to `CONTRIBUTING.md`:

1. The CLA workflow commented within a minute and set the `cla` check red:
   "Committers of Pull Request number 4 have to sign the CLA".
2. The bot created `signatures/cla-v1.json` on `cla-signatures`.
3. The author posted the exact sentence; the check went green, the bot
   answered "All contributors have signed the CLA.", and commit
   `@mgtf2 has signed the CLA in mgtf/atoma#4` recorded name, account id,
   comment id, timestamp and pull request number.
4. The pull request stayed blocked on the CI checks, whose run awaited the
   owner's approval, as the fork policy intends.

Caveats worth knowing:

- The hermetic CI jobs are named by Node line so a patch bump does not orphan
  a required check; `tests/node-version-contract.test.ts` pins that shape.
- The `i18n` job commits translations straight to `main`. GitHub refuses the
  Actions app as a bypass actor on a user-owned repository, so the job pushes
  with the admin's fine-grained token `ATOMA_I18N_PUSH_TOKEN` (Contents:
  read/write on this repository). **When that token expires the job will
  fail on push with no explanation**; renew it and update the secret.
- GitHub added `require_extra_approval_for_unattributed_changes: true` to the
  ruleset by default: a pull request carrying commits whose author is not a
  GitHub account needs an explicit approval. The admin bypass covers the
  owner's own work.
- The CLA action targets Node 20 and is forced onto Node 24 by the runner;
  harmless today, update the pinned SHA when a newer release exists.
- The history contains the FSL commit before the AGPL one. Public and
  deliberate; it is a loosening.

## 5. Remaining steps, in order

| # | Step | Owner | Notes |
|---|---|---|---|
| 1 | File the trademark "atoma" at the EUIPO, classes 9 and 42, after a prior-rights search | owner | Filing date is what counts. A Belgian stationery brand holds the name in another class; a counsel should confirm no conflict. |
| 2 | Lawyer review of `CLA.md` under Greek law | owner | Moral-rights clause and section 5. Contributors who signed v1 are covered; a v2 applies to later contributions. Ideally before the first external merge. |
| 3 | Platform terms of service, and the licence an author grants on a skill offered to the catalogue plus the platform's distribution right | owner, with agent support | `saas-architecture.md` owner decision 7. Recommendation: Apache-2.0 or CC0 granted by the author, non-exclusive distribution right for the platform. Separate from the code licence. |
| 4 | Decide whether instruction-text skills may be admitted by a lighter path than compiled scripts | owner | Owner decision 8. A cold design decision, never in the session that surfaces an incident. |
| 5 | Close gate 0, hardened SQLite versus PostgreSQL | owner, with agent support | Blocks the body/trust split and therefore any cross-organisation sharing. First technical Track B work. |
| 6 | A page that says what is free (this repository under AGPL), what is paid (hosted service, commercial licence for closed embedding), and how to get in touch | owner | Needed before the announcement, not before publication. |
| 7 | Have someone outside run the README install on macOS or Linux without help | owner | The gate for step 8. |
| 8 | Announce | owner | Public is not launched: nothing in the repository triggers it. |

Housekeeping that recurs: approve first-time contributors' CI runs after
reading the diff; handle Dependabot pull requests; renew the i18n token before
it expires; export the ruleset back into `.github/rulesets/` whenever it is
edited in the UI.
