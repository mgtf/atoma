# Project retrieval: opt-in coordinator activation

Date: 2026-09-09. Implements the project launch portion of
[Steps 8–9](project-retrieval-action-plan-2026-09-08.md#step-8--wire-the-element-through-the-real-atoma-execution-path).
This follows the [host boundary](project-retrieval-host-contract-2026-09-09.md)
and [SQLite ingestion/backend](project-retrieval-sqlite-2026-09-09.md).
Retrieval remains opt-in; no embedding, reranking or LLM context call is added.

## Activation and source admission

Set `ATOMA_PROJECT_RETRIEVAL=1` in the host environment of the project
coordinator, including the compiled `projects` CLI or viz server that owns it.
The switch defaults to off; `0` disables it and any other defined value is a
configuration error. It applies to all new project runs of that coordinator;
there is no tenant-controlled switch or account/organisation inheritance yet.
Restart a long-running coordinator to change its captured host configuration.
Standalone operator runs and the benchmark CLI do not resolve project receipts.
The existing explicit `startTask` library injection remains available.

The coordinator selects the same previous delivered run used to seed the new
workspace. Only non-executable `.md` and `.txt` entries in that source run's
stored artifact manifest enter the corpus. The existing publishable-path
policy, hash/size validation and ingestion limits apply. Unlisted files,
traces, logs, arbitrary repository files and skills are not scanned. If there
is no previous delivered source, the admitted corpus is empty. Missing
documentation is therefore an empty search, not a claim about the whole project.

Before spawning the child, the host copies admitted bytes into a newly reserved
`retrieval-source/` directory beside the new run's `workspace/`. Files use mode
`0400`, directories `0700`. The archive is outside the worker mount. Each
document is captured with the existing bounded, symlink-refusing reader and
verified again by corpus preparation. Changed source bytes fail preparation.
The archive and source manifest preserve the consulted snapshot if the older
workspace later changes. Paths, source contents and receipt JSON do not enter
the launch environment.

The new run ID identifies the snapshot; its digest binds organisation, project,
source run, source manifest hash and admitted documents. Index generation also
binds the existing ingestion configuration. This version builds a fresh
generation per run, even when documents are unchanged. Preparation consumes
the project run's existing time budget and holds its normal global lease.
Cancellation or failed preparation prevents the child from spawning, records
the ordinary run failure/cancellation and releases the lease. Partial archives
and unpublished cache data are retained rather than overwriting evidence.

## Authoritative receipt and current access

`project_retrieval_launches` is an additive table in the existing product SQLite
file. It stores one immutable receipt per project run and a revocation flag;
a SQL trigger refuses updates to the receipt identity. Receipts are source
records, separate from reconstructible FTS tables. Their existence grants no
access by itself.

Only after preparation and publication succeed does the coordinator forward
the activation marker alongside the existing run ID. The child resolves that
ID in a separate read-only connection to the same product file. It checks:

- The exact run, organisation, project and requesting principal match.
- The run is running, its project active, and the requester currently holds
  at least the organisation member role.
- The receipt is unrevoked, its source binding and generation are consistent,
  and its source run is still delivered in the same project with the recorded
  artifact manifest hash.
- Workspace, trace directory and project-local skills directory match the
  registered run layout. Container isolation is selected, strategy prefilter
  caching is off, and skill promotion/direct dispatch are off.

These checks happen before provider or workspace construction. An absent,
forged, stale or unreadable receipt fails closed, without operator fallback or
host paths in the error. The preflight connection closes immediately; the
run-owned query connection opens lazily and closes on backend cleanup.

The host element rechecks current database authority before and after every
search. Revoking membership, archiving the project, ending the run, revoking
the receipt or deleting its source denies an already-open service. Bytes
returned before a later revocation cannot be recalled. Query/result caching
is not introduced. `ProjectRetrievalLaunchStore.revoke` is currently a host
library operation, not a new tenant API or operator CLI command.

## Runtime scope and downstream limits

The composite executor still intercepts only `search_project_docs` on the
host. File/shell tools retain their worker dispatch and ordinary isolation;
there is no worker protocol addition, extra mount or new network route.
The worker environment receives neither the product-store path nor the
retrieval activation marker.

Build bootstrap adds a dedicated document/maintenance molecule when the host
declaration is present. Existing web, HTTP and file-scribe scopes are not
widened. Repeated bootstrap preserves the dedicated type's trust if its
contract is unchanged. Disabling retrieval removes that declaration from the
dedicated molecule and current build root; runtime dispatch remains the final
boundary for persisted custom scopes. The fixed prompt treats returned text
as untrusted source data, requests citations, and requires reading the current
workspace before editing it. Supervisors, validation, observations and skill
credit retain their existing execution paths.

Existing project-local skill storage and lifecycle restrictions are preserved.
This does **not** complete the planned tenant-fixture audit of distillation,
shared registry content and catalogue export. Search isolation alone cannot
certify the safety of derived recipes or prompt-injection resistance. Broader
activation must also finish the registered A/B treatment, operational
diagnostics/rebuild/retention and that downstream privacy audit. No production
environment is enabled by this code change.

## Verification and rollback

Focused source tests exercise coordinator preparation/cancellation, registered
path checks, empty corpora, source mutation, cross-project and cross-organisation
admission in one database, live revocation, canonical bootstrap/trust and real
`startTask` receipt resolution with mocked providers.

`scripts/retrieval-project-smoke.mjs` imports compiled modules and runs the real
coordinator and `spawnRun` across a child process. A mocked provider drives the
real L1 transport/dispatch through search and a file/shell call; the parent then
revokes access while the child is alive. It also exercises the compiled runner's
pre-provider refusal of a forged workspace. The default host smoke is included
in `release:check` on supported run hosts. `--container` runs the same probe with
the real worker in `network none`, checks inaccessible host source files and
absent control-plane environment, then cleans up the worker. This is a boundary
probe, not a three-tier delivery run or a retrieval-quality benchmark.

Verified on Node 24.20.0: `npm run release:check` passed (3,746 tests passed,
4 skipped, both TypeScript configurations, lint/docs checks, no npm audit
vulnerabilities, build and compiled smokes). The final `dist/` then passed
`npm run build:worker`, `node scripts/retrieval-project-smoke.mjs --container`
and `npm run release:container-smoke` (allowed external request returned 200;
control-plane access was blocked). Providers in these probes are mocked.

Disable the host switch for subsequent runs to roll back activation. Existing
admitted runs continue under their bound policy and live authority checks.
Receipts/archives remain evidence; old FTS generations can use the existing
bounded garbage collector. Automatic retention, coordinated source deletion,
operator rebuild commands and doctor/preflight reporting remain pending.
The additive receipt table is ignored by the preceding implementation; rollback
does not require deleting the table, source archives or the product store.
