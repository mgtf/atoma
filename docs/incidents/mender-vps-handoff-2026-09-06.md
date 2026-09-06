# Mender VPS handoff — 2026-09-06

## Resume here

The operator is leaving the session. They confirmed running the updated
`sudo bash /home/atoma/current/deploy/install-mender.sh` after deployment of
`c74208c1114ebf9512cb9aa5ff24aabfa345470c`. **No post-install service output has
been inspected yet. No automated correction PR has been confirmed.**

The next task is to verify this installation, preserve the existing failed
attempt, and finish a genuine run → analyst → mender → correction PR test.
Do not infer success from the installer acknowledgement or a running service.

## Environment and constraints

- Production: Debian, `https://atoma.run`; MCP: `https://atoma.run/mcp`.
  The old `atoma.iotanet.net` MCP configuration returns an invalid Host error.
- Account: `atoma`, nologin shell; use an explicit shell for operator commands.
- Product release: `/home/atoma/current`; dedicated clone: `/home/atoma/mender`.
- Services: `atoma.service` and `atoma-mender.service`.
- Config: `/home/atoma/config/atoma.env` and `/home/atoma/config/mender.env`.
- Durable supervisor state: `/home/atoma/state/supervisor`.
- Codex binary: `/home/atoma/state/.local/bin/codex`.
- Dedicated mender profile: `/home/atoma/state/codex/mender`.
- Use the ChatGPT Pro subscription, not a billed OpenAI API key. Do not share
  the analyst profile or refresh the mender profile elsewhere.
- The operator replaced the `GH_TOKEN` example with their publisher PAT and
  restarted the service. Actual GitHub publication with that token is unproven.
  Required repository access: `mgtf/atoma`, Contents and Pull requests write.
- `ATOMA_MENDER_CMD_CHECK="env NODE_OPTIONS=--max-old-space-size=1536 npm run check"`
  was added to mender.env. It is now redundant with the corrected executor's
  default, but remains valid; removing it is not a prerequisite.
- Do not print PATs, auth.json contents, complete environments or host secrets.
- Reserve the existing global run lease for every maintenance check. Do not
  bypass the idle gate or run tests alongside product/analyst/mender work.
- MCP cannot modify system configuration or inspect Docker. Debian operations
  require the operator unless an authorized host connection becomes available.

## Evidence to preserve

| Item | Identity / location |
| --- | --- |
| Genuine run | `50e88072-8ae1-422d-9379-8174113d2405` |
| Project | `Atoma literal edit check`, `7e61db08-298c-4a2e-9eb5-5a8f58017927` |
| Selected finding | index `0`, high confidence, “Skill distillation token cap caused two costly empty results” |
| Defect key | `6912d7fc9c03` |
| Verdict | `/home/atoma/state/supervisor/verdicts/50e88072-8ae1-422d-9379-8174113d2405.json` |
| Attempt record | `/home/atoma/state/supervisor/mender/50e88072-8ae1-422d-9379-8174113d2405.0.json` |
| Preserved worktree | `/home/atoma/mender/.worktrees/mender-8174113d-0` |
| Branch | `mender/8174113d-0-skill-distillation-token-cap-caused-two` |
| Attempt base | `20da8060613aaf229b606bbdfb2f3d4914037ebb` |
| Retained diagnostic log | `/home/atoma/state/supervisor/mender/recheck-tests.log` |

Codex proposed changing the skill distillation output budget from 1600 to 3200
in `src/skills/lifecycle.ts`, with changes to `tests/skill-auto-creation.test.ts`.
Its report said `fixed`; the authoritative harness record said `refused` because
the full check failed. Do not equate the model's report with verified correctness.
Review whether the tests prove the claimed behavior, not merely the configured
token value; retain the supervisor policy and cooling-off rules.

The original literal-edit run also exposed replacement-string expansion of
dollar sequences in single replacements. The analyst selected the different
distillation finding above. Do not fabricate a verdict or relabel it to force a PR.

## What was fixed and validated

[PR #3](https://github.com/mgtf/atoma/pull/3) merged as `c74208c`:

1. Chromium and its libraries live in the mender image. Puppeteer uses
   `/usr/bin/chromium` and skips downloads into disposable `/tmp`.
2. Synthetic read-only passwd/group entries describe the executing UID/GID.
   Node can resolve its home even when a test deliberately unsets HOME.
3. The executor sets a 1536 MiB Node heap within the existing 2 GiB container
   limit. The original check exhausted its approximately 1 GiB default heap.
4. The browser orphan test follows tracked PIDs and descendants instead of
   assuming an executable under `.cache/puppeteer`.

The initial install stalled in Puppeteer's `unzip`. Interrupting that child
allowed the attempt to continue, but did not validate browser installation.
Even a successful download would have vanished with that container's tmpfs.

A manual full recheck with the larger heap passed TypeScript and lint, then
failed eight tests across four files. The cache timestamp was 12:49:42 UTC.
The targeted rerun confirmed missing Chrome and missing passwd identity.

Validation of the infrastructure fix:

- Local release:check: 3459 tests passed, zero audit vulnerabilities.
- CI passed on Node 22 and Node 24, plus fresh worker build/isolation.
- Real mender Docker tests install a clean worktree in one container and run
  all four failing suites in a second offline container. These passed.
- Separate Docker checks prove Chromium works across fresh containers, HOME
  fallback, memory settings, credential isolation and process cleanup.
- [Main CI](https://github.com/mgtf/atoma/actions/runs/34043366662): successful.
- [Production deployment](https://github.com/mgtf/atoma/actions/runs/34043650495):
  successful, including the public TLS check for atoma.run.

These results validate the infrastructure fix, **not the preserved proposal's
full check or an automated PR**. PR #3 is the infrastructure repair, not the
mender-produced correction being sought.

## Next actions, in order

1. Inspect the installation acknowledged by the operator:

   ```sh
   sudo systemctl status atoma-mender --no-pager -l
   sudo journalctl -u atoma-mender -n 40 --no-pager
   sudo -H -u atoma git -C /home/atoma/mender rev-parse HEAD
   sudo docker image inspect atoma-mender:local --format '{{.Id}}'
   ```

   Confirm the clone includes c74208c and the rebuilt image is selected. Check
   current activity before any further commands that execute work. No need to
   rerun the installer merely because the previous turn ended.

2. Preserve the failed attempt **before retrying**: verdict, attempt JSON,
   retained log, worktree diff including binary changes, untracked files and
   base/branch SHAs. Store the snapshot outside the worktree. A plain git diff
   does not include untracked files. Do not erase the journal or lease database.

3. Inspect the current proposal and decide whether to reuse it or request a
   fresh mend. Prefer rechecking the preserved proposal without model inference
   first. Its old base still contains the cache-path-dependent orphan test;
   updating the image alone will not update that test. Integrate the relevant
   upstream fix into a preserved copy/branch, with conflict review, before
   treating another full-check failure as a proposal defect.

4. Run checks through `runIsolatedMenderCommand`, under the existing activity
   gate and `acquireRunLeaseWithoutRecovery`; do not execute proposal code on
   the host with publisher credentials. Recheck the four suites, then the full
   check on the exact candidate intended for publication. Save stdout, stderr,
   exit status, command and commit identities to durable files.

   The previous `systemd-run --pipe` procedure lost its final output when the
   terminal disappeared. Docker containers use `--rm`, so docker logs is not an
   archive. Persist results before exiting; a clean service start is not a test
   result. Old transient units may already exist: inspect them rather than
   starting duplicate checks.

5. Inspect CLI/pipeline retry behavior before using `--force`:
   `node dist/cli/mender.js --help`, `src/cli/mender.ts`, and
   `src/supervisor/mender.ts`. A refused attempt is not automatically replayed.
   **Force retry currently removes the existing worktree, resets the proposal
   branch, overwrites its attempt JSON and calls the model again.** It is not a
   verification-only resume command. Do not use it until step 2 is complete.
   Preserve full regression-before-fix/full-check-after-fix verification. Do
   not manually change the record to `pr-opened` or bypass a failed check.

6. Complete publication through the trusted harness after validation. Verify
   the PAT can push the branch and create the PR without exposing its value.
   Record the real PR URL and the `mender.pr_opened` journal event, and inspect
   the diff and test evidence. A person reviews and merges; no automatic merge.

7. Record the final result here. Until an actual correction PR is verified,
   the requested end-to-end acceptance remains incomplete. Keep infrastructure
   repair evidence separate from evidence about the generated code change.

## Retired configuration

The GitHub Actions mender was retired. Repository secrets
`ATOMA_MENDER_CODEX_AUTH_JSON` and `ATOMA_MENDER_GITHUB_TOKEN` were removed earlier;
the installer removes `ATOMA_MENDER_DISPATCH_*` from atoma.env. Do not recreate
them. The repository's unrelated `OPENAI_API_KEY` for translation CI and deploy
credentials were intentionally retained. Deleting a stored secret does not
revoke the underlying PAT; do not revoke a token still used by the VPS publisher.

See [production setup](../supervisor-codex-production.md) and the normative
[supervisor contract](../../src/supervisor/AGENTS.md) before changes.
