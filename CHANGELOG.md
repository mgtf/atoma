# Changelog

## Unreleased

Acceptance criteria a person approves before launch, incomplete runs kept and
explained, comparison reruns on other models, complete MCP diagnostics, and the
corrections of the 2026-09-24 and 2026-09-25 code reviews.

### Added

- Acceptance criteria approved before launch, one per line in the console, the
  CLI (`--criteria <file>`) or over MCP; without them a run drafts its own
  checklist with one call to the cheapest tier. Criteria are stored immutably
  with the run and covered from the host's own HTTP observations.
- Incomplete (`partial`) runs: work cut by the budget, or refused at delivery
  after one remediation pass, is kept, explained in plain language and seeds
  the next run of a project created in atoma.
- Comparison reruns: rerun a delivered or incomplete run on other models, with
  its goal, criteria and starting workspace, beside the project's history.
- Every run records its tier pins and the models the provider served.
- MCP: complete, losslessly paged run diagnostics (metadata, events, runner
  log) and persisted Git publication destinations.
- `validate_html` lays a page out at a requested viewport.

### Fixed

- A rerun row naming a model the catalogue later retires no longer breaks its
  project's run list, later runs and offline retention.
- Work in hand at the deadline — landed or complete, a refused result whose
  remediation was cut, an interrupted synthesis — is finalized as a partial
  instead of being recorded as failed.
- MCP sessions answering a call survive a resumed stream and the per-caller
  ceiling; the request ceiling closes the stalled call only, and is
  configurable with `ATOMA_MCP_MAX_REQUEST_MS`.
- Validators see only the worker's attested calls, with browser observations
  always kept and the viewport they were laid out at.
- Approved criteria that name a status where it is not read, or a second
  status, are refused instead of becoming "any 2xx" checks.
- A deepening keeps the project's document search.
- Runner logs and publication errors served to tenants no longer carry host
  paths.

## v0.4.0 — 2026-09-17

Scoped document retrieval for every project run on a single Haystack backend,
GitHub repository imports, isolated preview hosting on its own subdomain,
opt-in supervision depth routing, and ONE registry, ONE skill catalog and ONE
trust for the whole platform. Everything landed since v0.3.0.

### Added

- Scoped project document retrieval. A host-side boundary admits a project's
  registered sources explicitly, and every project run must search them, with
  the requirement derived from stored run receipts. Haystack is the sole
  backend after a measured comparison; deterministic FTS5 indexing and paired
  BM25 were both built, measured and retired. Searches return exact copyable
  citations and accept document-metadata filters; failed attempts are retained
  with their accounting, and cancellation survives retrieval warmup. The seven
  dated pilot records — Anthropic agentic retrieval, the paired BM25 negative
  result, the Haystack comparison and agent pilot, the invocation-policy arms,
  the ten-minute diagnostics — are consolidated verbatim into one archive
  under `docs/incidents/`.
- GitHub repository imports and document extraction. Delivered workspaces are
  published complete, and an interrupted upload is recovered rather than
  leaving a partial repository.
- Isolated preview egress and secure subdomain hosting, with controlled
  preview network checks in CI, terminal preview availability and JSON exports.
- MCP OAuth login and client connection commands.
- Opt-in supervision depth routing with bound delivery proofs: deep and short
  entry paths compared under one bounded deepening, attempt-scoped evidence and
  common root acceptance, with browser observations bound to the final response
  and to the process holding its port. Build runs now default to short-first
  supervision with safe deepening.
- Trajectory drift journaling in the sentinel — stage A of
  `docs/trajectory-predictability-design-2026-09-09.md`: observe, journal,
  decide nothing. `src/contracts/trajectory.ts` owns the signature, key and
  score shapes and the pure derivation over trace events; the score is a
  length-normalised edit distance over element names, never args or results.
  The analyst digest gains a mechanical trajectories block, named as evidence
  and never as a threshold to design from.
- An offline recovery drill with preserved live validation evidence. The state
  backup gains two tiers — the `orgs/` project corpus and the supervisor
  records — and its manifest becomes an inventory (per-tier source, SHA-256,
  top-level entries, recursive file count, recorded exclusions, captured and
  skipped lists) rather than a completeness claim.
- Registered benchmarks run through MCP in the existing viz, and a run reports
  its project elapsed time.

### Changed

- ONE registry, ONE skill catalog, ONE trust for the whole platform — a run is
  a run (`docs/platform-trust-2026-09-15.md`). `atom_types` loses its owner
  column; `openDb` folds a partitioned store back with a whole-file backup,
  absorbing same-name project rows into the platform row with their counters
  added (`atom_id_merges` records the identities) and keeping every other
  project row whole. `SkillRegistry` loses its trust scope; the coordinator and
  the runner fold `.trust/…` sidecars and absorbed-identity namespaces into the
  catalog, setting aside what they displace. `AtomRegistry` and `SkillRegistry`
  constructors take only their store. A tenant run still proves it is the
  registered run (`assertProjectRunAuthority`). Execution follows: the
  coordinator no longer pins promotion, deterministic dispatch or the prefilter
  cache off for project runs and sends no veto flag; a tenant launch insists on
  `--container` and nothing else. Consequence, characterised rather than
  prevented: text a validator derives from one organisation's retrieval corpus
  and writes into a prompt reaches every organisation's next run — the corpus
  itself does not travel.
- The Registry is a workspace destination for every signed-in role, as Skills
  became: `/api/registries` and `/api/registry/:id` answer members and viewers,
  the store's host path reduced to its basename. Burn-in stays the platform
  admin's.
- The MCP commons readers follow: `atoma_registry_list`, `atoma_registry_show`,
  `atoma_registry_history`, `atoma_skills_list` and `atoma_skills_show` sit on
  the `viewer` tier, with `store` and `skillsDir` redacted to basenames below
  `platform`. Skill analytics, the four lifecycle writes and the prompt surface
  stay platform-tier, and a client that already saw these readers gets the same
  payload as before.
- Skill bodies are shared platform-wide and the catalog is exposed to members.
- Connecting a personal ChatGPT login arms that member's three tiers, only into
  emptiness: it walks the run's own chain (account pin, org default, host env)
  so it can never displace a member's choice, an organisation default or an
  operator pin, and follows the cost rule cheapest-rank-first — mini on L1,
  terra on L2, sol on L3. It is journaled under the kind a manual choice uses,
  marked `automatic`. Settings tabs now read in the order of a first setup:
  identity, what pays for a run, the models those choices unlock, then the MCP
  address.
- Planning and validator prompts are capability-first. The rule telling L2/L3
  to refuse reuse across task domains had nothing to match on capability labels
  and could only spawn identical clones with zero trust; both planning prompts
  now match on capability, the validator sections and examples are rewritten
  around capability defects, and validator-authored `descriptionReplace` passes
  through `resolveCreationDescription` at L2 and L3. Dynamically created L1s no
  longer receive two reporting contracts, the iteration cap is 4 everywhere,
  and the web branch template carries the web evidence contract.
- The two-call browser proof is taught from one contract constant,
  `SMOKE_TWO_CALL_SHAPE`: real interactions up to the milestone under a
  read-only smoke, then one change plus the reset under another, with the
  explicit statement that the self-driving IIFE shape executes no real
  interaction and covers nothing. No guard is relaxed and the refused set is
  byte-identical. The shared validation prompt's TOOLSET SCOPE rule now states
  that a declared tool may be called as many times as the plan needs.
- Obsolete releases are pruned after a successful deployment.
- CI fails when translations remain incomplete: hard translation failures
  propagate and every target catalog must be complete, while partial successful
  work is still committed through always-run cleanup steps.
- The GPU client suspends rendering while the window is inactive.
- The README and `SECURITY.md` present shared learning as the design rather
  than as missing tenant isolation, and state the price without softening it.
  The security scope now names what stays protected — projects, workspaces,
  traces, searchable documents, credentials — and excludes the shared commons
  explicitly. Mutually untrusted tenants are not a supported deployment shape.
- `docs/saas-architecture.md` is reconciled against source after the
  2026-09-15 owner decision, then corrected where five of its claims did not
  survive verification: skill counters are not single-writer, `lifecycle_events`
  carries `seq`, per-organisation bounded admission already exists for
  previews, Gate 0 blocks W4 alone, and the launcher is not a second store
  writer today.
- `npm run backup` is compiled (`node dist/cli/backup.js`) because the host
  installs with `npm ci --omit=dev`; `backup:dev` is the source path, and
  `release:check` smokes the compiled `--help`.

### Fixed

- A standing browser proof survives a pre-flight refusal. The L1 kept one bit —
  the `ok` flag of its last `validate_html` call — so a refusal after
  successful observations of an unchanged document fired the internal
  validation banner and replayed the whole phase. That bit becomes a ledger
  bound to the observed document: a refusal observes nothing and retires
  nothing, the last executed observation decides, and a write to the observed
  path after its last `ok` observation retires it as stale.
- The production Registry listed every type twice. The viz server opens every
  handle read-only, so on a deployed host the owner-partition fold never fired
  while the readers had stopped filtering by owner. The server now folds every
  configured store at startup, idempotently and loudly on failure, and
  `unfoldedRegistryPredicate` guards every read-only reader, with
  `AtomRegistry` refusing an unfolded store outright.
- A completed Codex device login is no longer lost. Every released Codex up to
  0.154 sends `account/login/completed` before `auth_manager.reload()`, so
  reading the account immediately saw no ChatGPT account and deleted the
  freshly written profile. The account is now read inside a bounded settle
  window, woken early by `account/updated`, never refreshing tokens.
- Codex tool action sequencing and argument recovery; MCP run retries are
  preserved and browser interaction targets are scrolled into view.
- Recoverable atom trust and the reuse of equivalent capabilities.
- Every registry transaction takes the write lock before the read.
- The restore drill is valid on the deployed shape: a tier that is not
  applicable is distinguished from one expected and lost, so a host running no
  benchmarks no longer reports every snapshot incomplete — without silencing
  the skipped list, which is the only signal that earned state went missing.
- Preview proxy resolution, internal artifact delivery, session identity and
  stale request handling; the cleanup assertion is scoped to its own
  generation.
- The egress proxy stays alive when denied clients disconnect.
- Delayed live traces are recovered without leaking errors across views, run
  index errors are confined to the active view, multiline timeline previews are
  contained within their cards, and mobile viz navigation and touch scrolling
  work.
- Observed browser checks are preserved in result validation, inferred port
  constraints are reviewed against the requested startup contract, and prose
  punctuation is excluded from inferred validation URLs.
- Pending run usage is distinguished from zero totals.
- Skill events are localized in the viz without misattributing withheld credit.

## v0.3.0 — 2026-09-08

One model selector for every tier, runs as MCP tasks over a replayable SSE
stream, ChatGPT subscriptions on all three tiers, and a full-stack cell for
pages served by a Node API. Everything landed since v0.2.0.

### Added

- A canonical full-stack cell and molecule: `start_node_server`, `fetch_url`
  and `validate_html` in one L1, without a static server, seeded only when the
  executor offers the combined capability. A phase that serves a page from a
  Node API and proves it in a browser now has a home in the catalog instead
  of being routed to a web-only cell (`docs/incidents/notes-app-browser-phase-2026-09-07.md`).
- ChatGPT subscriptions (`sub:openai`, `own:openai`) serve L1 too. Codex stays
  a text-only subprocess: tool-bearing calls run through a host-side JSON
  action loop where only declared tools reach the sandbox executor, results
  are observed before truncation, a finite budget allows one finalization, and
  partial usage survives errors and cancellation.
- The supervisor's new verdicts carry an evidence-cited review of every run
  stage (planning, delegation, execution, validation, recovery, learning),
  each marked reviewed, insufficient evidence or not applicable. Historical
  verdicts without coverage stay readable.
- The GPU client refreshes itself after a frontend deployment: it checks the
  content-hashed bundle URLs every minute while visible, bypassing the service
  worker, and reloads only after five idle seconds with no editable work or
  pending mutation, restoring tab-local navigation once.
- `build-app --help` (and `-h`) prints usage derived from the profile instead
  of falling through to the default goal and starting a real run.
- Settings shows the `[mcp_servers.atoma]` table for `~/.codex/config.toml`
  beside the Claude Code registration line; the bearer reaches Codex through
  `ATOMA_MCP_TOKEN` and never enters the file.

### Changed

- Project runs get 30 minutes by default instead of 15; explicit operator
  budgets still take precedence.
- L2 and L3 plan prompts list every cell and peer WITH the tools its L1s hold
  and state that a `create` seed cannot add tools; ungrantable seed tools are
  logged at plan time. L3 runs the envelope and explicit-failure result gates
  on cell results before earned trust. Fallback recovery reads first, verifies
  the actual deliverable, and reports a missing capability instead of
  rewriting the artefact. L1 workers now see the declared `dom-interaction`
  proof obligation.
- A Claude CLI query that exhausts its tool budget is finalized once in its
  own session with tools and MCP servers disabled; both usages are summed and
  finalization never recurses.
- GitHub connect discovers the viewer's existing App installations before
  opening GitHub's install page, so an already-installed App is relinked
  through the same verified setup callback instead of a dead Configure page.

### Fixed

- `validate_html` replaces an input's existing text with Chromium's
  `selectAll` command before typing; `Meta+A` did not select in headless
  Chromium on macOS, so a "type" interaction appended instead of replacing.
- A missing or retired `ATOMA_ANALYST_MODEL` switches the analyst off with a
  visible reason in the banner instead of crash-looping the viz server.
- GPU visualizer: camera zoom rasterizes at native pixels, rasterized text is
  sharp, crystal caustics stay visible with the navigation collapsed, timeline
  scroll windows are retained and idle controls settle.

### Changed

- The MCP start tools are MCP TASKS (spec 2025-11-25): `atoma_run_start` and
  `atoma_operator_run_start` answer a task-augmented call with a task id and
  are driven through `tasks/get` (the operator run's output tail as the
  status line), `tasks/result` (the status payload) and `tasks/cancel` (which
  cancels the run). Called without task augmentation they return when the run
  ends. The `waitMs` long-poll and its `notifications/progress`, added
  earlier in this release, are gone: the status tools are plain readers.
- The MCP transport answers on SSE instead of plain JSON. In JSON mode the SDK
  drops every notification related to a request (0 of 3 progress lines
  delivered, measured 2026-09-07); the stream is what carries task results,
  the run log and resource updates. The release smoke reads SSE frames.

### Added

- Every MCP session replays its stream: a bounded in-memory event store stamps
  SSE frames with ids, so a client cut mid-call reconnects with `Last-Event-ID`
  and receives what it missed, the response included.
- The MCP declares `logging`: the session that started an operator run
  receives its output as `notifications/message` under `atoma.run.<runId>`,
  marked untrusted, and one notice when it ends.

- The MCP catalogue grows from 24 to 37 tools, closing the 2026-08-21 surface
  roadmap. Readers, platform tier: `atoma_skills_show` (one recipe in full,
  body bounded and marked untrusted), `atoma_ledger_tail`, `atoma_costs` (per
  model/tier/role totals and an older-half vs newer-half median trend),
  `atoma_registry_history`, `atoma_verdicts_list`, `atoma_verdict_show`,
  `atoma_sentinel_health`. Tenant tier: `atoma_run_preview` (state for a
  viewer; open/stop for a member) and `atoma_notifications` (the viewer's
  tray, through the same builder as `/api/notifications`). Operator writes,
  platform tier and attributed to the caller: `atoma_skill_reset`,
  `atoma_skill_drop`, `atoma_skill_merge`, `atoma_registry_rollback`, with the
  CLI's own refusals (proven knowledge needs `force`) and, on a gated host, a
  journal row per action under the new kinds `skill.reset`, `skill.dropped`,
  `skill.merged`, `registry.rolled_back`.
- Every tool result now also carries `structuredContent`; the new readers
  declare an `outputSchema`.
- MCP resources: `atoma://families`, `atoma://runs/{file}`,
  `atoma://operator-runs/{runId}` (platform) and
  `atoma://projects/{projectId}/runs/{runId}` (tenant), listable, completable
  and subscribable — a subscribed session is told when the run finishes.
- Three prompts: `atoma_read_skill` (completes the skill id once the molecule
  is named), `atoma_inspect_verdict`, `atoma_cost_curve`.

### Changed

- The production activator refreshes the mender at the end of every
  deployment: its clone is moved to the deployed revision, rebuilt with its
  image and unit file, and restarted — after the application is healthy and
  outside the rollback section, so a mender failure is reported and never
  restores the previous application. Hosts without a mender skip the phase;
  `deploy.env` gains three optional `ATOMA_DEPLOY_MENDER_*` paths.
- ONE model selector, `<api|sub|own>:<vendor>:<model>`, for every tier.
  `ATOMA_MODEL_L1/L2/L3` are all REQUIRED and there is no default: a tier
  nobody configured is a launch error naming the variable. `api` bills a key
  (`anthropic`, `openai`, `zai`, or a self-hosted `ollama`), `sub` spends the
  host's own Claude Code or Codex login, `own` a member's personal login
  (Settings only). `ATOMA_LLM`, the base provider and the `provider:model`
  prefixes are gone; so are the `host-subscription:` / `chatgpt-subscription:`
  sentinels. Stored pins written under the old spellings are not migrated —
  delete `atoma.db` and reconfigure Settings (the provider-key table's CHECK
  constraint also changed).
- doctor, burn-in, the benchmark, the MCP and the viz announcement translator
  all derive their transports from the three selectors; the MCP no longer
  imposes `claude-cli` on operator runs.
- The supervisor follows the same grammar: `ATOMA_ANALYST_MODEL` and
  `ATOMA_MENDER_MODEL` hold one full selector each (`sub:anthropic:sonnet`,
  `api:zai:glm-5.3`, `sub:openai:gpt-5.6-sol`), REQUIRED once the stage is
  enabled and with no default. `ATOMA_ANALYST_TRANSPORT`, `_BASE_URL`,
  `_AUTH_TOKEN` and their mender twins are retired and refused by name; the
  key comes from `ANTHROPIC_API_KEY` or `ZAI_API_KEY`. `api:openai` is refused
  for supervisor sessions, which require a ChatGPT login.

### Added

- `api:openai:<model>`: OpenAI by API (Responses API, function tools), so
  GPT models can serve every tier, L1 included, from `OPENAI_API_KEY` or an
  organisation key.

## v0.2.0 — 2026-09-07

The first public release: the repository is open on GitHub under the AGPL.
This version gathers everything landed since v0.1.4.

### Added

- Result previews: a delivered run's deliverable is classified and served in
  its own isolated instance (static or runtime), reachable from the Runs view
  and from a project; `npm run doctor -- --preview` checks the host and
  `npm run preview:demo` makes the surface clickable on a machine that cannot
  execute a run.
- The supervisor: a resident post-mortem analyst (`npm run analyst`, opt-in
  with `ATOMA_VIZ_ANALYST=1`) grades ended runs behind the shared idle gate,
  and the mender (`npm run mender`) turns a cited high-confidence defect into
  one pull request on `main` from an isolated worktree; a person merges. Both
  stages are journaled and typed by one contract per shape.
- The sentinel: a mechanical live watch over runs in flight (rules, sources,
  hosts) hosted by the viz server, with `npm run sentinel -- --once`.
- Personal host subscriptions: a run can route a tier through the caller's own
  Claude Code or ChatGPT subscription instead of an API key, configured per
  tier from Settings.
- Settings is split into tabs: general, LLM models, personal subscriptions,
  provider API keys and the Atoma MCP panel, which mints a bearer token shown
  once, lists and revokes them, and gives the exact client registration line.
- Bearer API tokens (`/api/tokens`, `npm run auth -- token`), hashed at rest,
  organisation-bound and journaled.
- Production deployment is automated after CI, keeps state on a dedicated
  disk, and `npm run deploy:preflight` refuses to deploy over a live run.
- `npm run docs:facts` and `npm run docs:architecture` generate the README's
  derived facts and the architecture diagram; `docs:check` asserts the prose.

### Changed

- ONE MCP for everyone, over HTTP: the compiled viz server serves the
  Streamable HTTP endpoint on `/mcp`, a catalogue of 24 tools whose visibility
  follows the caller's role (viewer, member, admin, platform), sessions bound
  to one bearer token. The stdio server and `npm run mcp` are removed.
  Operator run tools are `atoma_operator_run_*`; `atoma_run_*` are project
  runs. Decision record: `docs/mcp-one-surface-2026-09-05.md`.
- The GPU visualizer isolates every per-frame animation in its own retained
  render group, so a pulsing chip no longer re-uploads the whole view each
  frame; the frame is measured by `viz:smoke`.
- Node 24 only. `.nvmrc` pins 24.20.0, the runtime production runs;
  `engines` is `>=24`; CI, the release job and the worker, preview and mender
  images use the same line. Node 22 is no longer supported: the SQLite driver
  needed 22.14+ anyway, and a second CI arm for a version nothing deploys was
  not worth keeping. The `protect-main` ruleset requires one hermetic check.
- ESLint 10.

### Added

- `atoma.run` is the public name of the product: `package.json` declares it as
  the homepage, the README links it, and the deployment, preview and MCP
  documentation use it in place of `atoma.example.com`. Previews still need a
  second registrable domain.
- The repository is public under the GNU Affero General Public License v3.0
  (`AGPL-3.0-only`): `LICENSE`, a `license` field in `package.json`, a README
  licence section, `CONTRIBUTING.md`, a contributor licence agreement
  (`CLA.md`) and `SECURITY.md`. Release archives now carry the licence and
  the security policy.
- A `CLA` workflow (CLA Assistant Lite, pinned by commit) asks the author of
  an external pull request to sign `CLA.md` and records signatures on the
  unprotected `cla-signatures` branch; the repository owner and bots are
  allowlisted.
- The GPU visualizer now includes an in-product Docs surface, a grouped left
  navigation rail, and account Settings reached only from the account menu.
  Platform admins are offered the curated platform-alert subscription at
  their first console entry after login; member notification prompts remain
  tied to their first live run.
- Platform admin: an instance-wide operator flag granted only through the
  CLI (`npm run auth -- grant-admin --principal <id-or-email>`), never from
  a login's email. Behind the gate, the instance-global registry, skill and
  burn-in APIs now answer the platform admin alone (403 for everyone else);
  the admin reads every organisation's projects and run traces and manages
  organisations and one-use invitations from the new Admin tab
  (`/api/admin/organisations`, `/api/admin/invitations`). Ordinary
  organisations keep the existing roles (owner/admin/member/viewer).
- A failed GitHub publication can be retried:
  `POST /api/projects/:id/runs/:runId/publish` re-drives the publication of
  a delivered run through the same idempotent path (one repository, ever).
- The arrival gate is the login. A gated deployment now serves the GL app
  shell (crystal, tagline) to unauthenticated visitors with one
  "Continue with …" button per configured provider, instead of a bare
  server-rendered form; login failures bounce back onto the gate as bounded
  notice codes rendered from the i18n catalogs, and the plain selector
  remains at `/auth/login` as the no-JS fallback. The compiled auth release
  smoke now drives the real product flow (founder sign-in without an
  invitation, CLI `invite --org`, invited member admission) — its previous
  incarnation minted an invitation on an empty store and could never pass.

### Fixed

- The GPU visualizer no longer lets Pixi 8.19.0's WebGPU garbage collector
  destroy uniform buffers that cached bind groups still reference, which
  crashed the canvas after about a minute with
  `used in submit while destroyed`.
- Starting a project run no longer 500s: the public run projection strips
  host filesystem paths instead of rejecting them as unrecognized keys.
- Gated `/api/runs` lists the viewer's organisation only. Each project run
  lives at `orgs/<orgId>/projects/<projectId>/runs/<runId>/` (workspace,
  traces, log) and is not copied into the operator `./runs` directory.
- The GPU shell now keeps every navigation destination, project control,
  admin journal and Settings model choice inside narrow or short viewports.
  Project selection is mirrored in the keyboard/screen-reader bridge, whose
  controls reveal a visible focus palette instead of remaining clipped.

### Changed

- Documentation premise: skills are a platform commons shared across
  organisations, and the organisation bounds trust and execution rights, not
  knowledge. Project-local partitioning is described as containment on the
  way there; Track B is named the product target. The body/trust split and
  the human gate on catalogue entry are unchanged (`docs/saas-architecture.md`
  §2, root and projects contracts, README, how-it-works).
- The hermetic CI jobs are named by Node line (`Hermetic checks (Node 22)`,
  `Hermetic checks (Node 24)`) instead of the pinned patch version, so the
  `protect-main` ruleset can require them by name. The ruleset itself is
  versioned in `.github/rulesets/protect-main.json` with import instructions.
- The visualizer opens on Projects. Its create-project and start-run forms are
  mutually exclusive, re-clicking the selected project returns to creation,
  and single-column views share one framed layout across their GL and DOM
  surfaces. Launch guidance now lives beside the project run prompt rather
  than in a separate GPU tab.
- `npm run viz`, `doctor:dev` and `auth:dev` fill unset keys from checkout
  `.env` so a local GitHub-gated visualizer does not need a shell export.
  Compiled `viz:serve` still reads only the process environment.

### Added

- The visualizer can opt into an invitation-only OAuth gate with GitHub,
  Google or an approved Sign in with ChatGPT client.
- `atoma auth` lists linked principals and mints hashed, expiring, one-use
  invitations without persisting their bearer tokens.
- An optional GitHub App connect flow (`/auth/github/connect`, setup URL and
  `/webhooks/github`) links an installation to the viewer's organisation
  separately from login.
- Organisation-scoped projects can start runs and, after a delivered and
  validated artifact manifest, publish those files into one idempotent GitHub
  repository (user-to-server token for personal repos; installation token for
  organisations).
- `atoma doctor` reports the GitHub App snapshot as disabled, configured, or
  a hard failure when the env is only half-present.
- The GPU visualizer adds a Projects tab (six views in `viz:smoke`).

### Security

- OAuth uses PKCE S256, single-use server-side state, a canonical configured
  redirect origin, bounded provider requests and opaque revocable sessions.
  The first unknown identity creates an organisation; further admission is
  invitation-only.
- The service worker excludes authentication, API and GitHub webhook traffic
  and will not cache responses marked `no-store`.
- Project mutations require a same-origin `Origin` header; webhooks verify
  `X-Hub-Signature-256` and never sit behind the session gate.

## v0.1.4 — 2026-08-20

### Added

- Built-in tools now carry stable periodic-table element identities while
  retaining their existing invocation names.
- `registry migrate-taxonomy` dry-runs or applies the backed-up, in-place
  migration of registry identities, ledger provenance and skill namespaces.
- A full-GPU visualizer is now the default client: PixiJS 8 renders the UI
  and the aurora field through one WebGPU/WebGL context, Zustand owns scene
  state, and TanStack Query owns API state.
- `npm run viz:smoke` exercises the compiled client in a real browser across
  all five views and verifies both WebGPU and forced-WebGL rendering.
- `npm run viz:mui` and `npm run viz:build:mui` retain the previous MUI client
  as an immediate development and build fallback.
- GPU filter controls provide animated neutral, hover, pressed and active
  states, staggered entrance, fragment dissolution and spring-like layout
  transitions that preserve occupied space until exit animations complete.
- The full-GL shell adds an animated GLSL aurora/grid field, GPU sweep
  transitions between views, energy-state top navigation, and event cards with
  depth rails, scanlines, hover lift, pressed compression and selected pulses.
- Event cards now run dual-backend shaders selected by function: reasoning
  waves for LLMs, packet grids for tools, shield rings for trust, plasma for
  skills, crystalline replay glints for cache and circuit traces for registry.
- Run/Burn-in statistics use holographic telemetry bars, tier agents use
  color-specific orbital particles and selection pulses, and the Burn-in
  scatter adds temporal gridlines, family colors, radar sweep, point hover
  highlighting and GPU tooltips.
- The visualizer has a Vite HMR development path and a compiled `viz:serve`
  release path; release smoke verifies its index, hashed asset and Burn-in API.
- Burn-in analytics provide family/outcome/time presets, ECharts drag/slider
  zoom, compact selection summaries, 50-row pagination and metric tooltips.
- The Runs header uses a React 19 / Headless UI searchable combobox with
  keyboard/ARIA behavior and virtualized options for large trace histories;
  opening via input or chevron clears and focuses the query immediately.
- The entire visualizer now uses typed React components and a shared MUI theme;
  component tests traverse Runs, Registry, Skills, Burn-in and Launch against
  their API contracts.

### Changed

- The public composition model is now Element (tool) → Molecule (L1) → Cell
  (L2) → botanical Tissue (L3); numeric tiers and technical API names remain
  backward-compatible, with new `Agent`, `AgentRegistry`, `MoleculeAgent`,
  `CellAgent` and `TissueAgent` aliases.
- The visualizer projects structured identities in pre-migration traces onto
  the current taxonomy while preserving raw audit text, and labels GPU run
  lanes as molecules, cells and tissues.
- Event detail panes now render arbitrary JSON recursively as localized
  sections and semantic fields. Verdict/status booleans use readable badges,
  known keys receive human labels, and deep GPU details have independent
  scrolling instead of a clipped raw JSON block.
- Registry trace events now record the mutation initiator as `actor` and the
  affected agent as `child`; legacy traces recover every mechanically provable
  target without inventing an initiator for old unattributed counter bumps.
- Runs now uses a causal top-to-bottom timeline with a main trunk, nested phase
  paths, fan-out/fan-in connectors and human branch labels. Interactive cards
  remain virtualized in Pixi with 2.5D depth, while the R3F layer renders only
  visible 3D card slabs and branch rails from the same pure layout.
- New traces persist exact branch start/end metadata (parent, subtask index,
  aggregation mode and label); archived traces use a bounded tier/interval
  inference instead of opaque UUID-only branch chips.
- The event-kind filter is again labelled `Tools` / `Outils` for
  discoverability; elemental names remain the taxonomy shown on tool details.
- Timeline cards reserve hover/shader space above and to the right, preventing
  the first card from clipping against the viewport. Depth now uses smooth
  rounded layers instead of polygonal faces that broke right-hand corners.
- Agent buttons retain their enclosed 1/2/3-particle tier animation; the
  orbit now rotates around its local nucleus instead of the canvas origin, so
  its ellipse can no longer wander outside the button.
- Agent particles now keep a 9px minimum internal margin, while filter and
  navigation controls reserve 14px/20px gaps so hover scale and glow do not
  collide with neighbouring buttons. Agent-button sizing also reserves a
  dedicated particle zone before the text.
- Atoma now uses one isometric crystal as its brand mark — three rank faces
  meeting at a bright core — so the header and favicon stay readable instead of
  collapsing into a lattice of tiny facets.
- The visualizer ships a shared favicon, Apple icon, 192/512/maskable app
  icons, web manifest and production-only service worker. API requests remain
  network-only; the PWA cache is limited to the visual shell and static assets.
- Viz builds now force `NODE_ENV=production`, preventing an exported local
  development value from producing a React dev bundle and removing the
  production-only service-worker registration.
- `npm run viz` and `viz:build` now select the full-GL client. The visible
  application UI is canvas-rendered; only text input, clipboard, IME and
  accessibility semantics remain in a minimal DOM bridge.
- Burn-in uses a time-axis scatter instead of connected batch-order lines, and
  family cards are replaced by a bounded global summary plus compact chips.
- All five visualizer views replace the legacy custom DOM renderer with
  lazy-loaded React/MUI feature components while preserving live delta polling,
  event details, cross-view links, filters and read-only server semantics.

### Fixed

- The arrival screen now displays the packaged release version, and release
  automation rejects tags that disagree with `package.json`.
- The stateful GPU renderer is once again a real lazy-loaded chunk; pure
  metrics and tuning geometry no longer pull it into the initial bundle.
- WebGL fallback shaders that use derivative intrinsics now pin GLSL ES 3.00
  on both stages, matching Pixi's fragment-selected program dialect.

- The GPU run picker no longer truncates its dataset to twelve entries. It
  virtualizes all runs behind an independent wheel scrollbar and supports
  ArrowUp/ArrowDown, Home/End, Enter and reliable canvas selection.
- GPU timeline rows are clipped to their scroll viewport and scrolling is
  clamped to filtered content, preventing cards from overlapping filter
  controls or overscrolling into blank space. Event cards again expose
  actor/child/branch, tool arguments, result facts, model, cost, duration,
  counters and timestamp.
- GPU filter and agent controls allocate width from their semibold text metrics;
  semantic labels such as `VALIDATE-RESULT` remain complete, while agent lanes
  wrap instead of truncating names or silently dropping later agents.
- GPU filter rows wrap instead of dropping overflowing options and center their
  labels geometrically. Selecting a role now switches to the LLM kind, so
  `PREFILTER` no longer leaves unrelated tool/skill/registry cards visible.
- Three is pinned before the `Clock` deprecation used internally by R3F;
  imperative renderer HMR performs a clean reload, and a GPU error boundary
  exposes recovery instead of leaving a blank canvas. Compiled browser smoke
  now fails on warnings, page errors, failed requests and HTTP errors.
- The selected top-navigation rail remains stationary while surrounding glow
  and particles animate, and the timeline mask reserves shader/hover padding
  so enlarged cards are no longer clipped on their right edge.
- The GPU renderer prefers WebGPU, retries with WebGL after initialization
  failure, and exposes a deterministic `?renderer=webgl` acceptance path.
- The Burn-in visualizer displays compiler refusals and transport errors in
  both family summaries and individual rows; legacy CSV rows still default to zero.
- Burn-in/Skills network errors, empty states and raw-JSON toggles no longer
  leak French literals into the default English visualizer locale.
- Explicit JSON object/array requirements also inspect successful stdout from
  the on-disk probe manifest when a trusted Result omits inline probes.
- MCP initialize metadata reads the package version instead of advertising the
  stale hardcoded `0.1.0`.
- Burn-in API rows normalize blank historical providers to `claude-legacy`
  when O/S/H explain every call, or `unknown` when attribution is impossible.
- The Vite client API module is named `data-api.ts`, avoiding a `/api`
  development-proxy collision that served it as `application/octet-stream`;
  a source-contract test keeps the forbidden root `api.ts` name from returning.
- Run summaries render the real per-model names from the trace array instead of
  array indices, and Burn-in chart tooltips escape CSV-derived text.
- The searchable Runs picker now shares the MUI field outline and the same
  Search/ArrowDropDown icon family as the application's other select controls.
- In development, the read-only API root redirects from port 4111 to the Vite
  UI on 5173 instead of serving an untranspiled `main.tsx` entry with a MIME
  error; the launcher now starts tsx and Vite directly without `npm exec`
  wrapper chains.

## v0.1.3 — 2026-08-13

### Added

- `npm run doctor` provides a quota-free preflight for the configured Node
  runtime, base and tier-routed providers, Docker daemon and worker image.
  Docker failures remain advisory for local runs and become blocking when
  container or egress mode is selected.
- `npm run doctor:dev` exposes the same checks from TypeScript source; release
  checks and extracted archives smoke the compiled command.
- `.nvmrc` pins the same Node 22.13.0 runtime used by CI and release jobs.

### Changed

- The final eight active `no-explicit-any` warnings in test doubles now use
  the real SDK and framework interfaces, leaving CI free of lint annotations.
- Puppeteer 25 removes the vulnerable extract-zip chain; the supported Node
  floor is now 22.13+ (or 24+) to match that patched browser runtime and CI.
- Codex-backed skill compilation uses `effort: low`; other providers retain
  `medium`. An exact-prompt ABBA replay changed 0/2 timeouts into 2/2 valid,
  scan-clean script responses; a fresh production run then compiled and
  promoted in 48.6 seconds with `compile_errors=0`.

### Fixed

- File-mutating plan phases now name their exact output paths, allowing the
  trusted-script target guard to refuse read-only verifiers instead of
  silently replacing requested implementation work.
- Skill compilation now rejects interpreter tokens and generic entry filenames
  as package/product names; a live script that had packaged `index.js` as
  `node` was corrected and had its trust counters reset.
- HTTP probe guidance now forbids recording a long-running server process as a
  shell probe; endpoint observations or a finite harness are the evidence.
- HTTP builders now distinguish JSON syntax from semantic field validation and
  probe a blank/wrong-type payload; durable docs use `<port>` placeholders
  rather than the current process's bound port, with independent read-back
  forcing review when a numeric loopback port still leaks into markdown.
- Probe-manifest validation now rejects custom `probe` scenario labels instead
  of inferring a valid web shape from the presence of `smoke`.
- The deterministic deliverable gate now compares only proven output targets
  for mutating tasks, so unchanged input files and explicitly negated files no
  longer force a correct script back through the LLM loop; read-only gates also
  ignore file paths mentioned solely under a negation.
- Skill compilation now preserves the scope of quantified requirements: a
  minimum bullet count attached to `## Steps` is not applied to prose-only
  sibling sections.
- Burn-in aborts before appending a row when logs explicitly report exhausted
  weekly/monthly quota, credit, or model subscription entitlement.
- Ollama requests pin a 32K context by default (configurable through
  `OLLAMA_CONTEXT_LENGTH`) because the server's 4K default is smaller than
  atoma's real L1 prompts.
- Task and event skill distillation now require a successful tool action
  observed by the transport; narrative-only results cannot teach recipes.
- Burn-in CSV rows now append the base provider and non-Claude-family call
  count, keeping routed Codex/Ollama calls visible without rewriting history.
- Mutation detection now covers planner vocabulary, preserves full target
  paths, treats negation clause-locally, and routes ungated mutations through
  the validated LLM path.
- Deterministic verification no longer mistakes contingent repair guidance,
  negated creation, or nominal phrases such as "document probe" for a required
  file mutation; unconditional writes remain protected by the deliverable gate.
- HTTP L1 loopback requests are machine-recorded automatically through
  `fetch_url`; `record_probe` is absent from the HTTP scope, eliminating
  dead-port server probes, curl/node-e clients and missing manifests.
- Ambiguous `edit_file` matches now return bounded line-numbered context for
  each real occurrence, so the model can choose `replace_all` or a uniquely
  scoped span instead of repeating the same rejected edit.
- Identical `edit_file` spans return an explicit unchanged no-op without a hard
  tool failure and do not count as a successful observed action.
- Web smoke stuck/oscillation history is scoped to the loaded source revision,
  so a smoke that passes after the page was fixed is not mislabeled flaky.
- Web guidance keeps exposed getters on one writable backing field, rejects
  duplicate class methods, and captures intermediate milestone state before a
  reset instead of claiming it from final-state-only evidence.
- Structured web smokes require explicit `ok:true`; objects without it fail
  validation instead of passing merely because the object itself is truthy.
- With explicit `ok:true`, expected-false raw state remains valid when the
  aggregate compares it; task-aware evidence gates enforce required styling
  dimensions without treating diagnostics as assertions.
- Interaction IDs tolerate only a unique case/kebab/snake spelling match to an
  existing DOM id, while widget guidance checks every getter name for illegal
  writes before serving.
- L1 results carrying `[INTERNAL VALIDATION FAILED]` are mechanically rejected
  before a trusted type can bypass validation.
- `validate_html` rejects repeated-change-then-reset sequences whose smoke
  cannot observe or reconstruct the erased intermediate state.
- Self-driving smoke IIFEs ignore external interactions that would corrupt
  their initial state, and styling tasks require recorded milestone/reset
  class, style or color evidence before trust.
- Web manifest health is checked alongside browser re-validation; `expected`
  must be a JSON-encoded string, matching the schema and replay contract.
- Conditional styling evidence must cover both milestone and reset/final
  classes, styles or colors and bind those checks into the aggregate `ok`.
- `validate_html` reports styling values omitted from `ok` inside the same
  tool-loop, before an expensive supervisor rejection.
- Tool-bearing L2/L3 last-resort fallbacks use the L1 model route, preventing
  text-only Codex tiers from receiving an unsupported tool loop.
- Web builders/verifiers use one source-derived state-journey template with
  empty external interactions and looped milestone transitions, avoiding
  guessed labels and unrolled validation thrash.
- Self-driving smoke detection recognizes goal/threshold and numbered
  after-transition snapshot names, dropping conflicting external interactions
  for novel widgets as well as the original habit case.
- State-journey smokes compare computed style against captured initial values
  instead of guessed RGB literals and return named `checks` to expose the exact
  failed assertion on the first browser pass.
- Styling-verdict analysis recognizes `Object.values(checks).every(Boolean)`
  when the named checks contain class/style/color comparisons.
- `validate_html` rejects direct computed-style comparisons against literal
  RGB/RGBA values before browser launch, preventing repeated CSS rewrites around
  guessed serialization values.
- Smokes that invoke state-mutating methods automatically supersede external
  interactions, and uninvoked IIFE bodies are rejected before browser launch.
- Compiled packaging recipes omit unproven package scripts instead of emitting
  `start`/`test` commands that fail when a CLI requires arguments.
- Explicit JSON object/array requirements are checked against parseable
  successful probe stdout before trusted results can skip semantic review.
- The L1 transport records whether an injected script scratch file actually
  ran; ignored script recipes cannot earn credit through type trust.
- OpenAI-compatible pseudo-final `json` calls carrying either a nested or
  top-level `{output,summary}` Result are normalized without an off-scope round-trip.
- CLI build recipes retain every fixture referenced by a recorded probe so
  later packaging and replay phases cannot inherit broken evidence.
- L2/L3 plans preserve exact structured goal clauses—HTTP routes, JSON fields,
  formats, status codes and rejection rules—in every downstream subtask.
- Burn-in rows distinguish compile transport/time-out errors from genuine
  not-promotable refusals via a trailing `compile_errors` column.
- Tasks requiring a finite `node test/probe*.js` command now require that exact
  manifest entry to exist and exit zero before trusted result approval.
- Web-manifest health rejects non-browser test files, unsupported interactions,
  non-JavaScript smoke prose, and missing replay expectations.
- Full-stack plans route real-browser and finite-harness verification through
  separate sequential web/HTTP phases instead of simulating one capability
  inside the other.
- Capability routing ignores appended global literal-contract blocks and
  classifies only the subtask's own phase scope.
- `validate_html` supports selector-based `{type:"type", text}` form entry;
  `keypress` remains a single-key action.
- Styling-evidence detection inspects result field names rather than HTML
  string values, avoiding false positives on diagnostics containing `class=`.
- `write_file` merges probe-manifest entries across phases instead of allowing
  a web writer to erase earlier shell/HTTP evidence.
- Failed direct dispatch reloads a same-call demoted skill before L1 injection,
  and scratch cleanup no longer counts as proof that the script executed.
- Task-required portable README documentation is read before trust even when a
  child omits it from result files; numeric ports trigger remediation.
- Web probe expectations avoid volatile timestamps/ids/ports and identify the
  real embedded-UI source file.
- Browser-phase detection recognizes explicit web-probe replay language, while
  split shell phases exclude browser-only sentences.
- Manifest merging preserves malformed incoming entries for health reporting,
  and form typing replaces existing field text before entry.
- Post-approval learning/compilation is capped at 120 seconds, and transport
  failures receive a generation-scoped stamp so they cannot block every later
  run; all observed successful calls remain within the new bound.
- L3 planning now chooses semantic CLI entry filenames for packaging phases,
  and the live argv-CLI recipe keeps package/module semantics coherent and
  stays inside its subtask’s output scope.
- Script-skill scaffolding is never re-probed after deletion; web recipes copy
  selectors exactly from source; source-based API documentation never boots or
  curls the server and always uses portable port placeholders.
- Unambiguous pseudo-final `return`/XML-corrupted `output` tool calls are
  normalized into assistant JSON without an error round-trip; other attempts
  receive explicit coaching, and tolerantly wrapped non-JSON L1 results are
  rejected before trust can approve them.
- Intentional empty negative-test fixtures no longer masquerade as broken
  deliverables when a recorded non-zero probe corroborates their purpose.
- Production L1 results with no successful transport-observed action are
  rejected before trust or validator shortcuts; failed structured tool results
  cannot seed task or recovery skills.
- Atom counters support negative-only, transactional compensation with ledger
  projection, allowing false experimental trust to be removed audibly.
- `record_probe` can explicitly supersede one accidental command when a
  corrected probe uses a different command.
- Burn-in quota detection ignores delivered artefact text, canonicalizes base
  and routed providers, and records event-skill learning separately.
- `run_shell` accepts an unambiguous whole line placed in `command` when
  `args` is empty, using the same parser and allowlist as the preferred `cmd`
  form.
- The fallback non-Anthropic operating profile is now live-validated:
  Codex subscription on L3/L2 with `glm-4.5-air` on Z.ai for L1; five
  independently scored runs delivered without Anthropic calls.

## v0.1.2 — 2026-08-12

Corrective release after extending acceptance to Docker, proxied egress and
MCP cancellation from the published v0.1.1 archive.

### Fixed

- `npm run build:worker` now consumes the compiled `dist/` shipped in release
  archives instead of trying to rebuild omitted TypeScript source.
- `npm run build:worker:dev` preserves the source-checkout compile-and-build
  workflow, and fresh-worker CI uses that explicit path.
- The release workflow now builds the worker from the extracted
  production-only archive and runs a quota-free container/egress smoke.

### Release acceptance

- A containerised HTTP task delivered in 387 seconds, 14 LLM calls and
  $0.2705 API-price equivalent; its server, Unicode echo contract and recorded
  harness were independently executed.
- Allowlisted egress returned HTTP 200 while the Docker control plane remained
  unreachable.
- MCP cancellation retained the serialization lease until the process group
  exited, then left no worker container, private network or release-rooted
  process.
- The broader first HTTP attempt exhausted its 600-second budget despite a
  correct final artefact; it remains recorded as a failed diagnostic, not an
  acceptance success.
- Full evidence: [`docs/release-acceptance-v0.1.1.md`](docs/release-acceptance-v0.1.1.md).

## v0.1.1 — 2026-08-12

Corrective release after installing and exercising the published v0.1.0 archive.

### Fixed

- Release checksums now contain the downloadable archive basename instead of
  the workflow-internal `release/` path; the workflow verifies the checksum
  before extracting the archive.
- The compiled MCP smoke derives its client version from `package.json`.

### Release soak

- Installed the release with production dependencies only.
- Started the compiled MCP server and completed a real zero-dependency CLI task.
- Delivered in 437 seconds, 16 LLM calls and $0.2863 API-price equivalent.
- Independently verified `reverse.js`, its missing-argument exit contract,
  README, package metadata and probe manifest.
- Confirmed two learned skills, eight persisted atom types and a clean
  seven-event lifecycle ledger with zero counter drift.

## v0.1.0 — 2026-08-12

First reproducible local release of atoma.

### Included

- Three-tier LLM orchestration with symmetric plan/result supervision.
- Persistent atom types, earned trust, learned recipes and guarded script promotion.
- Thirteen-tool MCP server over stdio, with cross-process run serialization and cancellation.
- Ten builtin execution tools, machine-written probe manifests and independent ground-truth checks.
- Local sandbox by default, plus opt-in Docker isolation and allowlisted proxied egress.
- JSON run traces, lifecycle ledger, web visualizer, burn-in harness and controlled benchmark artefacts.
- Hermetic checks, fresh-worker Linux CI, compiled MCP smoke and zero known npm advisories.

### Security and reliability

- Tool children receive a credential-stripped environment and scratch home.
- Filesystem access is symlink-contained; child process groups and browsers are reaped.
- Trusted fast paths still run deterministic ground-truth checks.
- Container runs mount only the workspace, drop capabilities and default to no network.
- MCP stdout is claimed before the application import graph and remains JSON-RPC only.

### Known limits

- Local, single-operator system only: no users, organisations, authentication or multi-tenancy.
- The attached compiled archive supports the MCP server and its build-run path; development,
  benchmark and operator CLIs remain supported from the full source checkout.
- SQLite and filesystem skill storage are not multi-process deployment primitives.
- Container execution is opt-in for local development and requires a locally built worker image.
- Compiled skills are correct and guarded, but the controlled benchmarks do not show them driving
  the measured cost advantage; savings come from tiering, earned trust and recipe reuse.
- Runtime state (`atoma.db`, `skills/`, `runs/`, workspaces and credentials) is never bundled in
  release artefacts.
