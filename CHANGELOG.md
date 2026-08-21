# Changelog

## Unreleased

### Added

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

### Changed

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
