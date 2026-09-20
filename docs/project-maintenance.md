# Run retention and organisation admission (W9/W10)

Implemented and regression-tested in CI at `4788dfd` on 2026-09-20.
No production bytes have been deleted and no organisation
limit has been changed by this implementation work.

## W9: offline retention

Finished project runs become eligible 90 days after `ended_at`. The command
deletes the run-owned directory (traces, log, declared manifest and legacy
workspace) and, for launcher layouts, the separate run-owned workspace parent
(including its retrieval snapshot/index). It never touches the shared skill
catalogue, operator runs, registry, payer rows, publications, verdicts or
`lifecycle_events`. Project run rows and artifact manifest metadata survive.

Two references hold bytes beyond eligibility: the newest delivered run of an
active project (the next run's seed), and an unfinished publication. The plan
names these holds; there is no force flag. Archive the project to release its
seed hold, or complete the publication to release its hold. This is a
dependency-aware 90-day retention window, not an unconditional erasure deadline.

```bash
npm run projects:maintenance -- retention
# After a verified restorable backup and stopping all services:
npm run projects:maintenance -- retention --apply --services-stopped
```

The first command opens SQLite read-only and prints candidate paths and holds;
it performs no migration or deletion. Application requires an explicit offline
acknowledgement: stop web, launcher, analyst, sentinel and every other writer,
including CLI runs, before starting it. A machine-global run lease is held
without stale recovery. Queued/running run rows, publishing rows and live
preview rows refuse the entire application. This does not automatically stop
services or certify that a process is absent: the operator must satisfy the
offline precondition. Restart only after the command exits.

The apply path recomputes the plan. It accepts only the canonical recorded
layout under `ATOMA_PROJECTS_ROOT` (default `~/.atoma`) and, when configured,
`ATOMA_LAUNCHER_WORKSPACE_ROOT`. UUIDs, exact recorded paths, root containment
and all symlink/junction ancestors are checked before recursive removal.
A mismatched legacy layout refuses the batch rather than guessing.

Each deletion first requires a durable `run.retention` started receipt in
the platform journal, then marks `bytes_expired_at`. Successful removal
requires a deleted receipt before marking `bytes_deleted_at`. Failure leaves
the run eligible for an idempotent retry, including a crash after removing
only one of its directories. The public run metadata exposes
`bytesExpiredAt`; expired workspaces cannot become retrieval sources or
publication retries. The run's delivery status and accounting are unchanged.
Journal receipts follow the existing platform-event retention; the expiry
columns remain with the run row.

W8-a proves the fixture restore mechanism, not this host's backup. Before a
real purge, capture the affected roots and verify their restoration, including
the launcher workspace projection. W8-b and W13 remain separate hosted
acceptance work. Never point this command at a live deployment.

## W10: per-organisation admission

The default is one concurrent queued/running project run per organisation.
An operator can set zero to suspend new admission. Values above one are
refused because the machine-global lease still permits only one run across
all organisations and operator runs. There is no scheduler or financial
budget: the owner's BYO-key decision remains in force.

```bash
npm run projects:maintenance -- limits --org <uuid>
npm run projects:maintenance -- limits --org <uuid> --max-concurrent 0
npm run projects:maintenance -- limits --org <uuid> --max-concurrent 1
```

The limit lives in `org_run_limits` in the primary product store. The CLI
updates it and the `org.run_limit_changed` receipt in one immediate
transaction; a failed audit rolls back the update. Existing runs continue,
including when the limit becomes zero. Admission checks before acquiring the
global lease and again inside the run reservation's immediate transaction.
Identical request retries return their existing run before either check.

The organisation settings page displays active runs and the allowed count
from its own scoped `GET /api/org` response. HTTP, MCP and the projects CLI
all use the coordinator and therefore the same admission check. Ordinary
members cannot change the limit; setting it is an operator CLI operation.
The display is refreshed with the existing organisation settings fetch, not
a separate live quota poll.

The compiled command ships as `projects:maintenance`; checkout use is
`projects:maintenance:dev`. Both accept `--db`. The compiled help is included
in `release:check`.

## Executed evidence

`tests/project-maintenance.test.ts` covers suspended coordinator admission
before the lease, persistence, transactional reservation and idempotency,
organisation isolation, dry planning, seed holds, audited byte deletion,
metadata preservation, repeat application, active-run refusal, forged paths
and symlink ancestors. These checks passed in [CI at `4788dfd`](https://github.com/mgtf/atoma/actions/runs/35478666242).

The cutoff and launcher projection have a dedicated fixture. The restore-drill
suite also passed a backup/restore round trip after production retention,
distinguishing completed expiry from interrupted deletion. No live purge is
claimed; see the [receipt](saas-acceptance-2026-09-20.md).
