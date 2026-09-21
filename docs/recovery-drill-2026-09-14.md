# Offline recovery exercise — 2026-09-14

> **Amended 2026-09-17.** As written, this exercise could not pass on the
> deployed shape. It required all six tiers, while `~/.atoma/archive` holds
> pre/post-benchmark store archives and does not exist on a server that runs
> no benchmarks — so a snapshot taken there reported `incomplete` and exited
> 2. Forgiving every skip would have made the drill silent about real loss,
> which is the failure the archive tier itself recorded. The deployment now
> DECLARES the tiers it does not have (`ATOMA_BACKUP_OPTIONAL_TIERS`) and
> everything undeclared stays mandatory. The manifest also names the
> host-held key the restored store still needs. A production-shaped fixture
> proves the fix in `tests/restore-drill.test.ts`; a snapshot from the real
> host is a separate claim and is not made here.

The backup now includes store, skills, operator runs, archives, project corpus
and supervisor records. [`scripts/restore-drill.py`](../scripts/restore-drill.py)
adds a repeatable **offline exercise**, without starting the viz, applying
migrations, reconciling interrupted runs or enabling publication/provider work.
It uses Python 3's standard library; it is an operator/development script,
not a new compiled product CLI or a production failover command.

```bash
python3 scripts/restore-drill.py /absolute/snapshot --dest /absolute/new-recovery-directory
```

The destination parent must exist and the destination must not. Snapshot and
destination must be separate trees. Verify the source release and the effective
state roots when collecting the backup; a pushed commit does not prove which
version is running on a host. Collection still requires quiescent state across
SQLite and directory writers; the exercise cannot make a torn capture atomic.

## What is verified

1. The manifest's captured inventory agrees with its tier records. `store.db`
   is required and can never be declared optional. Every other tier the
   deployment did not declare in `ATOMA_BACKUP_OPTIONAL_TIERS` must be
   present: a declared absence is a shape fact, an undeclared one is a loss.
2. Every captured file's byte size and SHA-256 match before destination
   allocation. Only known snapshot basenames are accepted.
3. Archives contain only regular files/directories beneath their recorded
   root. Links, devices, absolute paths and parent traversal are refused.
   A snapshot with legitimate links therefore needs an explicit recovery
   decision; this tool does not silently dereference or discard them.
   Windows drive/alternate-stream spellings and trailing-dot/space aliases
   are refused on every platform, before allocating the destination.
4. Inputs are copied into `verified-input` and checked again before extraction,
   preventing a later change to the original snapshot from being trusted.
5. The copied SQLite store opens with `mode=ro` and `query_only`; integrity
   and foreign keys are checked. No product store helper is invoked.
6. Project rows are matched to restored files through org/project/run IDs,
   rather than by following their original host paths. Started runs need logs;
   referenced traces need files; delivered runs need workspaces. Queued/running
   rows are reported, never repaired by the observer.

`restore-report.json` records manifest digest, tier digests, skipped/excluded
coverage, per-run file presence, integrity, elapsed seconds and the fact that
no service started. Exit 0 means these checks passed for every tier this
deployment expects (`expectedTiers` in the report, with `notApplicableTiers`
naming what it declared it does not have);
exit 2 means the exercise produced a report with incomplete inventory or
unresolved run/file correspondence; exit 1 means an invalid/unsafe input or
an operational failure. A partial destination after failure remains evidence
and is never automatically used for another attempt.

This is not semantic validation of every trace or verdict, an application
acceptance badge, or a production recovery-time objective. `node_modules`
remains excluded from project backups. Source absolute paths in the restored
database remain unchanged: starting a service against it needs a separate
reviewed relocation/configuration step. No credentials are copied into a
running service, and no restored application is executed by this script.

## Regression evidence

[`tests/restore-drill.test.ts`](../tests/restore-drill.test.ts) creates a real
ProjectStore with a finished run, uses the production backup writer and starts
the Python exercise as a separate process. It verifies restored file bytes,
unchanged source status, corruption refusal before allocation, destination
overwrite refusal, missing delivered-trace reporting, and a checksum-valid
archive whose symlink must still be refused. These fixtures are synthetic and
do not count as production delivery observations.

The script requires Python 3, as documented by its invocation. Its tests report
a skip when that interpreter is absent; a skipped exercise is not recovery
evidence. Full platform restoration and recent production-corpus analysis
remain dependent on an authenticated export from the production host.

## Live exercise

The [dated live-run record](incidents/recovery-live-2026-09-14.md) preserves two
real operator runs, including one deadline failure, their generic artifacts,
compressed traces, independent DOM and pointer checks, and the recovery report.
The six-tier snapshot restored successfully; its project/supervisor tiers were
empty, which is explicit evidence scope rather than a production claim.
