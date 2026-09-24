# CLI — AGENTS.md

`src/cli/` owns the operator commands: doctor, auth, registry, ledger, skills,
burn-in, curriculum, benchmark, backup and friction.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
The command list and the release contract live at the root.

Neighbours:

- [`src/run`](../run/AGENTS.md) — the run shells these commands drive
- [`src/skills`](../skills/AGENTS.md) — skill lifecycle semantics
- [`src/registry`](../registry/AGENTS.md) — registry identity

## Conventions

- CLI unknown commands print help and exit non-zero; `--help` exits zero.

## Doctor

`atoma doctor` is quota-free. It proves configuration and local prerequisites,
not that a provider will accept the next billable request. The run-host check
is a hard failure on an unsupported platform and quotes
[`src/run/platform.ts`](../run/platform.ts), which owns that list. `python3` is
a WARNING: `start_static_server` spawns it and `run_shell` admits it, so a host
without it fails web-serving tasks mid-run — but a task that never serves a
page is unaffected, and doctor does not fail a run that would succeed. Local Docker failures
are warnings; container/egress modes make them hard failures. Egress implies
container. A pre-T4 store (no `atom_id` column) is a hard failure — the schema
is the schema and `CREATE TABLE IF NOT EXISTS` will not migrate it. Do not add
remote completion calls to doctor.

`--preview` is OPT-IN because it is the one check here that ALLOCATES rather
than observes: it starts a real container. Two things make it different from
every other check, and both are the reason it exists.

- **It asks the HOST, not the container.** `docker inspect
  .HostConfig.Runtime` on a unit doctor started is the only trustworthy answer
  to "is this really gVisor?" — a process inside a sandbox can be told anything
  about its own sandbox, so a check that asked it would be asking the thing
  under test. For the same reason the runtime list comes from `docker info`,
  never from `$PATH`: gVisor installed is not gVisor registered, and that is
  exactly the gap a Docker Desktop machine falls into.
- **The origin check is about a SECURE CONTEXT, not a scheme.** The grant
  cookie is set on the PREVIEW origin, which is HTTPS by construction; what the
  visualizer's own origin decides is whether the browser keeps a partitioned
  third-party cookie for the frame it embeds. Loopback is trustworthy, so it
  warns rather than fails — a check that failed there would tell an operator
  their working development setup was broken.
- **The passing result is a REFUSAL.** The root filesystem must reject a write
  and a `--network none` container must fail to resolve a name. A probe that
  only proved a container starts would pass on a container with no isolation at
  all.

A missing runtime or image reports the isolation as NOT PROBED rather than
skipping the line: an unprobed boundary is not a verified one. The Docker seam
is injected like the rest of doctor's, so the suite can diagnose the two
machines this repository cannot have at once. The preconditions themselves
belong to [`src/preview`](../preview/AGENTS.md). `npm run preview:demo` is the
laptop counterpart — the harness that makes the surface clickable where doctor
can only report that it cannot be.

## Deployment preflight

- `deploy:preflight` is quota-free and read-only unless `--hold` is explicit.
  Hold mode takes the machine-global run lease without stale recovery, checks
  queued/running project rows and live preview rows, then keeps the lease until
  its supervising deploy process releases it. The hold process also removes
  the admission marker when its parent disappears, so an untrappable host
  activator death cannot leave every write on 503. Existing work always blocks
  an activation; deployment never reaps it.

## Backup

- `npm run backup` is the COMPILED command (`node dist/cli/backup.js`), like
  `auth` and `projects`: the production host installs with `npm ci --omit=dev`
  and has no tsx, so a source-path default silently made the documented
  collection impossible there until 2026-09-14. `backup:dev` is the source
  path; `release:check` runs the compiled `--help` smoke.
- It snapshots the legacy six tiers into one dated directory: skills, operator runs, the
  `~/.atoma/archive` tier, the org-scoped project corpus, the supervisor
  records, and the store LAST (SQLite online backup, never a raw copy). Last
  on purpose since W4 (2026-09-18): skill trust is rows in the store while
  skill bodies are files in the skills tier, every file+row mutation writes
  its file before its row, so rows that are never older than the bodies can
  only pair a body with a state the registry already tolerates — the reverse
  could restore a freshly compiled script with the llm recipe's earned trust.
  The projects tier is the `orgs/` child of `ATOMA_PROJECTS_ROOT`,
  not the root — the default root is `~/.atoma`, which also holds the build
  workspace and the MCP lease — and it excludes `node_modules`, recorded in
  the manifest under `excluded`. The supervisor tier follows
  `supervisorDirPath`. Both were missing until 2026-09-14, when the
  [value audit](../../docs/value-audit-2026-09-14.md) found the corpus it had
  to reconcile outside every captured tier.
- With `ATOMA_LAUNCHER_WORKSPACE_ROOT`, it also captures the `projects/`
  projection as mandatory `workspaces.tar.gz` (layout version 2). Older snapshots
  retain the six-tier contract; missing projected workspaces fail restoration.
- The manifest is an inventory, not a completeness claim: per-tier source,
  SHA-256, top-level entries and recursive file count, the `captured`,
  `skipped` and `notApplicable` lists, the `optionalTiers` declaration, and
  the host-held key the copied store still needs to be usable. Each artefact
  is consistent with itself; nothing makes the set atomic across roots, so the
  operator captures while no run, publication or analyst pass mutates them —
  without touching the run lease to make room.
- A tier absent from a host is either a shape fact or a loss, and only the
  deployment knows which, so it DECLARES its absences in
  `ATOMA_BACKUP_OPTIONAL_TIERS`. A server runs no benchmarks and has no
  `~/.atoma/archive`; the same server missing `skills/` has lost months.
  Everything undeclared is mandatory: missing, it is a loud skip naming the
  resolved path, the summary refuses the word complete, and the restore drill
  fails. The store can never be declared optional.
- The destination is required and refused inside the repository.
- A snapshot must be readable by a reader that is not us. Two producer defects
  broke that silently until 2026-09-22, both invisible on the machine that
  wrote the archive: the online backup inherits the source's journal mode, so a
  WAL store yielded a WAL-flagged `store.db` that SQLite refuses to open
  `mode=ro` when carried alone, which is exactly how recovery carries it; and
  macOS `tar` stores extended attributes as AppleDouble sidecars (`._skills`
  beside `skills`) that its own `tar -t` HIDES and every other reader sees as
  an entry outside the tier root. The store is settled into rollback mode in
  `core/sqliteBackup.ts` and the tar runs under `COPYFILE_DISABLE`. Verify a
  snapshot with a FOREIGN reader, never with the tool that produced it.
- The offline recovery exercise is `python3 scripts/restore-drill.py <snapshot>
  --dest <new-directory>`, not a service start or a compiled product command.
  It verifies hashes, extracts regular files into an isolated destination and
  checks SQLite plus project-file correspondence without migrations or writes
  to the source. Scope and exit dispositions: [recovery exercise](../../docs/recovery-drill-2026-09-14.md).

## Burn-in and friction

- Burn-in CSVs belong to exactly one writer/schema. Refuse foreign headers
  before append. Measurements committed to the repo must remain parseable.
- The friction report is offline and includes recency. Fix recurring real tool
  errors at their source; do not erase successful recovery evidence.
- Act on friction signatures only when they recur across two consecutive batches
  and their root cause lives inside the sandbox. Host, repository, and harness
  defects require structural fixes rather than learned workarounds.
## Organisation-scoped runs

- `projects run --project <slug-or-id> --as <principal>` is the only
  non-browser path into an organisation's run corpus. It exists because
  `run:build` writes the operator `./runs` corpus, which the gated visualizer
  never mixes with project traces, so a terminal-started run was invisible to
  the account owning the instance.
- Like `auth`, it is an OPERATOR tool reading the store on disk: possession of
  the machine is the credential. The run is ATTRIBUTED to `--as`, and the
  subscription-transport door still asks the coordinator's authority — the CLI
  refuses early, naming BOTH ways in (`grant-admin`, `grant-subscription`),
  rather than letting the coordinator reject it later.
- A project slug is unique per organisation, not per instance. An ambiguous
  reference is refused, never guessed.
- It PUBLISHES too, wired exactly as the viz server wires it — same publisher,
  same token resolution, same journal sink. Without that this command could
  deliver an artifact that went nowhere: the repository stayed `pending` for
  ever and no journal row said why. A CLI that starts a project run must
  finish it the way the browser does, or "started from a terminal" quietly
  means half a product. It prints the publication's own state beside the run's.
- PUBLICATION NEEDS THE APP IN THE PROCESS ENVIRONMENT, so the compiled
  `npm run projects` cannot publish on a checkout: only source launchers fill
  unset keys from `.env`, by contract. A delivered run then reports
  `not published` and names the way out (`projects:dev`, or export the App
  variables). The run itself is unaffected — the transports are chosen by the
  three `ATOMA_MODEL_L*` selectors, which a caller passes explicitly.
- `publish --run <id>` re-drives a delivered run whose publication never
  reached GitHub. `retryPublication` shipped with a route, a role check and a
  test, and NOTHING called it; this is that caller. The publication row stays
  the idempotency boundary, and the manifest is revalidated against the
  workspace, so a workspace that changed since delivery is refused.

## Reading a run's outcome from its log

- `parseRunLog` prefers the runner's machine epilogue. Its PROSE fallback is
  reached only when no epilogue exists — a hard reap, or a crash before
  teardown — and it ranks three markers, which do NOT rank the way a flat list
  would:
  1. the RUNNER'S OWN verdict (`--- run failed ---`, `⏱ TIMEOUT after`) wins
     over everything, because a run takes one path and a completion banner
     beside a failure means one of them was not printed by the runner. The
     reachable way that happens is a TENANT'S GOAL: it is echoed verbatim at
     second zero and `projectGoalSchema` permits newlines. Reproduced
     2026-08-23 — a goal carrying `✓ build finished` read `delivered` out of a
     log whose own verdict was `✖ build failed`.
  2. then `✓ build finished`.
  3. then the HARNESS'S `--- hard timeout ---`, which must rank below the
     banner: a delivered run keeps a server alive on purpose, so the harness
     reaps it, and its marker would otherwise relabel a healthy run. The
     marker's own text says the runner printed nothing, so a banner falsifies
     its premise.
- The runner's timeout is matched WITH its `⏱`, never by the bare `TIMEOUT
  after` those two markers share. Conflating them breaks the reap race, and
  there is a test for each direction.
- This makes forging the banner USELESS, not impossible. Nothing in a text
  stream can be unforgeable; the durable fix is a receipt the tenant cannot
  write, which is registered in
  [`docs/decided-not-built-2026-08-23.md`](../../docs/decided-not-built-2026-08-23.md).

## Sentinel

- `npm run sentinel` is one of TWO hosts for the same watch: the gated viz
  server arms it in-process ([src/viz](../viz/AGENTS.md)), and this command
  covers what a server cannot — an ungated checkout, another machine, another
  store, a burn-in batch that owns the machine and must not also run a
  browser, and `--once` in cron.
- Resident, it TAKES the store's watch over from a viz server: typing the
  command is the deliberate act and a browser tab left open must not refuse
  it. It yields to another live sentinel and exits non-zero naming the
  incumbent. `--once` takes no lease and still journals.
- It carries the journal's RETENTION on its own tick, every five minutes. The
  age cut and the row cap otherwise ride the viz server's sweep timer, which
  exists only behind the gate — so an ungated watch was the one journal writer
  in the repository with no retention at all.
- `ATOMA_SENTINEL_COST_ALERT_USD` is the default for `--cost-alert`, read
  through the one helper both hosts share. The flag wins, and a threshold is
  recorded with any result it influenced.
- `--trajectory-min-score <0..1|off>` is the floor of the `trajectory-drift`
  rule, defaulting to `ATOMA_SENTINEL_TRAJECTORY_MIN_SCORE` and then to the
  contract's provisional `TRAJECTORY_DRIFT_DEFAULT_MIN_SCORE`, through the one
  helper both hosts share. Armed by default because the rule exists to collect
  calibration rows; `off` disarms it. `--once` prints, per corpus, how many
  finished runs and credited trajectories the reference held.

## Project maintenance

`projects:maintenance` is compiled; `projects:maintenance:dev` uses source.
Retention plans are read-only. Apply requires stopped services, a restorable
backup and the existing global run lease without recovery. Limits are
operator-owned and updated atomically with their audit receipt.
[Commands and preconditions](../../docs/project-maintenance.md).
## Reaping a parked child

- `runTask` parks forever on EVERY success-side outcome, printing one of two
  banners first: `✓ build finished` or `◐ build LANDED`. `DELIVERED_BANNER` and
  `LANDED_BANNER` are the one home for both, and three readers key on them —
  the prose fallback parser, the provider-limit screen and `spawnRun`'s kill
  timer. Any future outcome that parks is added THERE, never at one call site.
- Until 2026-09-24 all three knew only the delivery banner. A landed child
  therefore armed nothing and parked until `timeoutMs +
  DEFAULT_HARD_KILL_MARGIN_MS` — for a project run at a 30-minute ceiling, a
  33-minute stall holding the machine-global run lease and its container while
  the row stayed `running`. Measured: 30 s against 1.8 s on a real child
  (`tests/burnin.test.ts`). It never bit because no project run had ever
  landed; depth routing, which is what lands, only reached project runs on
  2026-09-23.
- The prose parser can now say `partial`. It could not before, so a landed run
  whose epilogue never reached the log read as `error` — the one thing it
  certainly was not. It stays ranked below `delivered`: the runner prints
  exactly one banner, so a log carrying both is a goal echoing one of them.

## Intentional choices and rejected shortcuts

- Remote completion calls in doctor: refused. Doctor is quota-free, and a
  diagnostic that spends is one nobody runs when it matters.
- Failing doctor on a missing static-server binary: refused, it is a WARNING.
  A task that never serves a page is unaffected, and doctor must not fail a
  run that would succeed. Container and egress modes are where the same
  finding becomes hard, because there the capability is the point.
- Reading the container runtime list from `$PATH`: refused, it comes from
  `docker info`. gVisor installed is not gVisor registered, and that gap is
  exactly where a Docker Desktop machine sits.
- Migrating a pre-T4 store on the fly: refused, it is a hard failure. The
  schema is the schema, and `CREATE TABLE IF NOT EXISTS` will not migrate it —
  a silent half-migration is worse than a refusal.
- `--preview` on by default: refused. It is the one check that ALLOCATES
  rather than observing, so it stays opt-in.
- Backing the store up first, or copying its file raw: refused on both counts.
  The store goes LAST, through SQLite's online backup — since W4
  (2026-09-18), because every file+row mutation writes its file before its
  row. Rows never older than the bodies can only pair a body with a state the
  registry already tolerates; the reverse would restore a freshly compiled
  script carrying the llm recipe's earned trust.
- Declaring the store optional in a snapshot, or allowing the destination
  inside the repository: refused. Without the store at its resolved path the
  summary refuses the word complete and the restore drill fails.
- Verifying a snapshot with the tool that wrote it: refused, and this is not
  theory. Two producer defects were invisible on the writing machine until
  2026-09-22 — the online backup inherits the source's journal mode, and macOS
  metadata rode into the tar. A snapshot must be readable by a FOREIGN reader,
  which is why the drill is `python3 scripts/restore-drill.py` and not a
  product command.
- Erasing successful recovery evidence while fixing friction: refused. A
  recovered error is proof the recovery works; act on a signature only when it
  recurs across two consecutive batches and its root cause lives inside the
  sandbox.
