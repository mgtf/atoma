<div align="center">

# ⚛️ atoma

### Three-tier AI orchestration with earned trust and inspectable execution.

*atoma separates goal decomposition, routing and execution across model tiers. It
builds software in a workspace, records the evidence behind each result, and retains
reusable agent types and skills between runs.*

[![CI](https://github.com/mgtf/atoma/actions/workflows/ci.yml/badge.svg)](https://github.com/mgtf/atoma/actions/workflows/ci.yml)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![providers](https://img.shields.io/badge/LLM_routes-Anthropic_·_Claude_·_Ollama_·_Z.ai_·_Codex-8A2BE2)

**[→ How it works, in detail](docs/how-it-works.md)** · **[Install](#install-and-evaluate-it-locally)** · **[Documentation](#documentation)** · **[atoma.run](https://atoma.run)**

</div>

<p align="center">
  <img src="docs/atoma-run-audit.png" alt="atoma run visualizer showing cost, cache usage, three-tier routing, validation verdicts, ground-truth evidence and the full execution timeline">
</p>

<p align="center"><em>One run, fully inspectable: every model call, routing decision, tool action, cache hit, trust shortcut, validation verdict and cost estimate remains attributable.</em></p>

---

## What you can use today

Run a goal from the CLI or the role-scoped HTTP MCP, or configure the authenticated
web console to create projects, start runs, inspect traces and publish delivered
artifacts to GitHub. Supported web results have ephemeral previews, including
snapshots while a run is in flight. The console includes a member guide, model
settings and optional notifications.

The default local runner has file-tool containment and process cleanup; shell
isolation requires the container backend. The authenticated control plane scopes
projects and runs to organisations, but agent trust remains instance-global.
See [Status](#status) before deploying for unrelated organisations.

## The approach

Three mechanisms. The first two carry the result; the third is real but has not yet paid.

**1. The cheapest model that can answer, answers.**
An L3 **tissue** decomposes the goal into phases, an L2 **cell** routes each phase, and an L1
**molecule** does the work by invoking atomic tool **elements** such as file-writing and
command-running. This is structural, not a guideline — only molecules receive elements on the
supervised path. Validation uses the cheap route by default; explicit tier pins determine the
models actually served.

**2. Components earn trust, and can lose it.**
Every reusable component carries a success/failure record. Once one has a clean track record the
system stops paying a model to review its output — but it still runs a zero-token ground-truth
probe against the artefact first, because the component nobody watches is exactly the one that
needs watching. One failure revokes trust automatically.

**3. Reusable recipes can become deterministic scripts.**
After verified, observed work, the system can learn a reusable recipe. With promotion
enabled, a repeatedly successful recipe can be compiled into a script; that new script
must earn its own trust before it can run with zero model calls. Promotion is disabled
by default for from-scratch runs and enabled for seeded maintenance work. The compiler *refuses*
patterns needing judgment, and records why — verbatim, from a benchmark run:

> *"designing a hand-written state-machine parser and type-inference/stats engine tailored to
> whatever edge cases a given spec names … is an irreducible per-task design/reasoning act that
> cannot be replaced by a fixed deterministic script without hardcoding one particular grammar."*

**Twelve controlled rounds have not shown this mechanism paying.** These are historical
measurements, not a benchmark of the current release. Across the recorded atoma
rows it fired once in 54 build runs, then 11 / 1 / 1 / 0 times across four maintenance rounds
(10 / 1 / 1 / 0 on the primary tasks alone) — and **zero times in rounds 9, 10, 11 and 12**,
despite four promotions, making seven consecutive rounds contributing nothing. Round 5 shipped
seven wrong deliverables out of nine. Each fix since made the path more correct and none made it cheaper; the best remaining
idea was designed, measured at a **$0.03/run ceiling** and
[refused](docs/hybrid-skills-design.md). It is kept because it is sound and cheap to carry, not
because it is load-bearing. Mechanisms 1 and 2 are the product.

## What it builds today

The historical 156-run corpus covered: **single-page web applications**, **zero-dependency HTTP JSON APIs**,
**command-line tools**, and **technical documentation** — each delivered into an isolated
workspace with a machine-readable record of every command that was run to verify it.

It is a **framework for building such systems**, not a finished product. The repository supports self-hosted deployment; full tenant isolation remains
incomplete — see [Status](#status) below. The opt-in authenticated
control plane permits multiple organisations and scopes projects, runs, workspaces, traces and
project learning to them. The atom catalogue, atom trust and lifecycle ledger remain
instance-global, while the operator skill store and burn-in surfaces answer only the
**platform admin** — an operator flag granted exclusively through the CLI
(`npm run auth -- grant-admin --principal <id-or-email>`), never from a login's email. The
platform admin also reads every organisation's projects and traces and manages organisations
and invitations from the Admin tab.

Supported web results can be opened from Runs as an ephemeral **Preview**. A delivered run opens
the result that was classified at delivery; a run still in progress opens a timestamped snapshot,
clearly labelled as non-final. Preview is a review surface, not a deployment: it never mutates the
run workspace, stops when nobody is watching, and gives generated code no network access unless an
organisation admin explicitly approves hosts requested by the delivered project.

## Why a technical buyer should look closer

- **Every claim is auditable.** Each run leaves a full JSON trace: every model call with its
  prompt, response and token count, every file written, every trust decision. A built-in web
  console replays any run end to end.
- **Verification does not trust the worker.** Before accepting a result the supervisor re-reads
  the files from disk, checks quoted content against what the file actually contains, loads the
  page in a real browser, and cross-checks the machine-readable record of the commands the worker
  ran. It never re-runs those commands itself — that was considered and rejected, and the reason
  is written down. This costs no tokens and it runs *even on the most-trusted path*.
- **Generated applications stay outside the control plane.** Preview origins live on a separate
  registrable domain and use short-lived, one-time claims. Node previews run in an ephemeral
  container with a read-only root filesystem; static previews need no application container. The
  gateway strips credentials and application-supplied security headers, then imposes its own
  frame, cookie and cross-origin policy.
- **The engineering record is unusually explicit.** `AGENTS.md` keeps the
  cross-cutting contracts and routes to a per-subsystem `AGENTS.md` beside the
  code it governs, and to an archived record documenting not only what the
  system does but which observed failure motivated each mechanism, and a "considered and
  rejected" section records optimisations that were designed, measured, and refused. Reversals
  are recorded rather than quietly deleted — including several in the benchmark above.
- **Vendor-flexible.** The same code runs against the Anthropic API, a Claude subscription, local
  models via Ollama, Z.ai, or a ChatGPT subscription through Codex for supervisor tiers — and can
  mix vendors per tier, e.g. a cheap third-party model for execution while planning stays on a
  frontier model.

## Install and evaluate it locally

Runs execute on **macOS or Linux**: a run is a detached process group reaped
through SIGTERM → SIGKILL, which Windows has no equivalent for. Windows is a
development host — `typecheck`, `lint` and `build` all work there — while runs
and the full test suite belong in WSL2, with the checkout on ext4.
`npm run doctor` names which side you are on before you spend anything.
[`docs/development-setup.md`](docs/development-setup.md) is the step-by-step
setup for each platform, including the system packages Linux needs.

```bash
git clone https://github.com/mgtf/atoma.git
cd atoma
nvm install && nvm use            # or provide an equivalent supported Node version
npm ci
npm run release:check             # checks + audit + build + compiled MCP/auth/doctor smokes
npm run doctor                    # quota-free Node, provider and optional Docker preflight

# one real task. Every tier names its model as <api|sub>:<vendor>:<model>;
# `api` bills a key, `sub` spends this machine's Claude Code or Codex login.
ANTHROPIC_API_KEY=... \
  ATOMA_MODEL_L1=api:anthropic:claude-haiku-4-5-20251001 \
  ATOMA_MODEL_L2=api:anthropic:claude-sonnet-5 ATOMA_MODEL_L3=api:anthropic:claude-opus-5 \
  npm run run:build -- "a Node CLI that converts CSV to JSON"
ATOMA_MODEL_L1=sub:anthropic:haiku ATOMA_MODEL_L2=sub:anthropic:sonnet \
  ATOMA_MODEL_L3=sub:anthropic:opus \
  npm run run:build -- "…"                      # Claude subscription, no API key
ZAI_API_KEY=... ATOMA_MODEL_L1=api:zai:glm-4.5-air \
  ATOMA_MODEL_L2=sub:openai:gpt-5.4-mini ATOMA_MODEL_L3=sub:openai:gpt-5.6-sol \
  npm run run:build -- "…"                      # ChatGPT supervisors + Z.ai executor

npm run viz                       # HMR UI :5173; API :4111 redirects its root there
                                  # (gated: also hosts the sentinel watch in-process)
npm run viz:mui                   # frozen DOM/MUI fallback (bugfixes only)
npm run viz:serve                 # compiled visualizer after npm run build
npm run viz:smoke                 # real-browser proof of the compiled GPU client
npm run skills -- list            # what it learned, and what it refused to compile
npm run burnin                    # optional: measure a NEW corpus; consumes model quota
```

### Optional organisation login

The visualizer remains open on loopback by default. The keys to set are
`ATOMA_VIZ_AUTH=1`, an exact `ATOMA_VIZ_PUBLIC_ORIGIN`, and at least one
provider's canonical `ATOMA_AUTH_<PROVIDER>_CLIENT_ID` (plus its client
secret for GitHub and Google; an approved ChatGPT client may use PKCE
without one) — `.env.example` documents them all. On a source checkout, copy
it to `.env`: `npm run viz`, `npm run doctor:dev`, `npm run auth:dev` and `npm run projects:dev`
apply unset keys from that file. The compiled `npm run viz:serve` reads only
the process environment (systemd, Docker, the platform), matching
production — a `.env` file does nothing there. For the Vite HMR path the origin is
`http://127.0.0.1:5173` (not the API port). Register `${origin}/auth/callback`
at GitHub, Google or ChatGPT. ChatGPT login requires an approved client; login
proves identity only and never grants model inference on the person's
subscription. The legacy unprefixed provider credential names remain
compatibility inputs, not the preferred configuration. Behind a reverse proxy,
set `ATOMA_VIZ_TRUSTED_PROXIES` to its exact socket IP (or comma-separated
chain); `X-Forwarded-For` is ignored by default.

An optional GitHub App (`ATOMA_GITHUB_APP_ID`, slug, private key, webhook
secret and token encryption key) lets an org:admin connect an installation
separately from login. Register setup at `${origin}/auth/github/setup` and
webhooks at `${origin}/webhooks/github` —
[`docs/github-app-setup.md`](docs/github-app-setup.md) is the full procedure,
including the three repository permissions to grant and the two App settings
that are hard requirements. Admitted members can then create
organisation-scoped projects and start runs; a delivered, validated artifact
manifest is published into one idempotent GitHub repository. Gated `/api/runs`
lists that organisation's project traces from
`orgs/<orgId>/projects/<projectId>/runs/<runId>/`.

A first login without an invitation creates a personal organisation and makes
that principal its owner. Joining an existing organisation requires an explicit
one-use invitation. In a source checkout, mint an invitation
for an existing org, then send the printed token only to its intended
recipient:

```bash
npm run auth:dev -- invite --org <org-id> --role org:member --ttl-hours 24 --db ./atoma.db
# open the clean invitation URL printed by the command, then choose a provider
npm run auth:dev -- list --db ./atoma.db
```

The compiled equivalents are `npm run auth -- invite …` and
`npm run auth -- list …` after `npm run build`. A principal may belong to more
than one organisation; projects and GitHub installations follow the active
org. Gated run traces follow the active org too. Ungated viz still reads the
operator `./runs` directory.
`npm run doctor` validates the auth switch, canonical origin, provider
registry and optional GitHub App snapshot without contacting GitHub.

Settings separates provider API keys, per-tier models, personal subscriptions and
MCP access. Personal Codex login binds a private inference profile to the requesting
principal; it is distinct from signing into the console. Personal Claude connection
is currently unavailable pending provider approval. Every choice is one selector,
`<api|sub|own>:<vendor>:<model>`: `api` bills a key, `sub` the host's own login,
`own` the member's.

The default visualizer is a full-GPU React 19 client: one PixiJS context
renders the component system and ambient field through WebGPU with a
deterministic WebGL fallback. A left rail opens on Projects, where an
authenticated member creates a project and starts work; Runs replays that
work live and can open the application it produced, including a snapshot while
the run is still in flight. The in-product Docs view explains the member
workflow and its boundaries. Zustand owns scene/UI state and TanStack Query
owns API state. Pixi draws the scene; a small DOM bridge owns browser-native
controls and accessibility, including inputs, selects, links, forms,
login/navigation fallbacks, the preview iframe and the push-permission dialog.
The previous MUI client remains available through `npm run viz:mui` but is
frozen: it receives bugfixes, not features.
The compiled visualizer is installable as an **Atoma** PWA; its service worker
will cache only cacheable application-shell and static responses. It always
excludes live `/api/*`, authentication `/auth/*`, GitHub `/webhooks/*`, and
every response marked `Cache-Control: no-store`.

### Optional result previews

`npm run preview:demo` is the development-only way to inspect the complete
authenticated UI on a laptop without executing a paid run: it starts a
loopback OAuth provider and seeds a project with a delivered static app through
the production store path. It deliberately does not stand in for container
isolation or for a real run.

A production preview host is Linux with Docker Engine 28+ and gVisor registered
as the `runsc` runtime. It also needs a separate wildcard preview domain and a
runtime-only image built with `npm run build:preview`, pushed and configured by
immutable digest. `npm run doctor -- --preview` exercises the selected engine
and proves the container's read-only filesystem and closed network without any
model call. The complete proxy, DNS, image and environment contract is in
[`docs/preview-deployment.md`](docs/preview-deployment.md).

Deploying the compiled control plane after a successful GitHub CI run is
documented in [`docs/automatic-deployment.md`](docs/automatic-deployment.md).
The workflow is inert until the production environment and the explicit
repository-level enable switch are configured.

A local release keeps its learned state beside the checkout: `atoma.db`,
`skills/` and `runs/`. Build artefacts live under `~/.atoma/workspaces/build`;
the MCP run lease is `~/.atoma/mcp-run-lock.db`. Back up the database and
skills directory together: `npm run backup -- --dest <off-machine mount>`
snapshots the store (SQLite online backup, WAL-safe), the skill tree, the run
traces and the local archives into one dated directory and prunes old
snapshots (`--keep`, default 14). None of that state is regenerable from the
repository. Docker is optional for the core runner: `npm run build:worker` enables
the isolated backend and proxied egress paths from compiled `dist/`. Proxied
egress requires Docker Engine 28+ so its private bridge can remove both host
gateway addresses; plain container isolation (`--network none`) works on older
engines. Confirm the selected path with `npm run doctor -- --container` or
`npm run doctor -- --egress`. Contributors changing
source use `npm run build:worker:dev` and `npm run doctor:dev`.

Stores created before the Element→Molecule→Cell→Tissue taxonomy use
`npm run registry -- migrate-taxonomy` for a dry-run, then
`npm run registry -- migrate-taxonomy --apply`. The apply path creates its own
DB+skills backup before renaming identities.

The full source checkout supports every operator, benchmark and development
command. The compiled archive attached to each GitHub Release includes MCP,
its build-run path, doctor, the identity/invitation CLI (`npm run auth`), and
the compiled visualizer (`npm run viz:serve`), including authenticated
organisation-scoped project creation and launch when the optional gate is
configured. The compiled project, sentinel, analyst, mender and deployment-preflight CLIs are
also included. Benchmark and registry/skill mutation-oriented operator CLIs remain source-only.
See [`CHANGELOG.md`](CHANGELOG.md) and the
[`v0.1.0 release soak`](docs/release-soak-v0.1.0.md), followed by the
[`v0.1.1 container/egress acceptance matrix`](docs/release-acceptance-v0.1.1.md)
and [`v0.1.3 release acceptance`](docs/release-acceptance-v0.1.3.md).

A fresh clone starts with **no learned state at all** — the catalogue, the recipes and the
traces are runtime data, deliberately not committed. What you clone is the framework; the
experience is earned on your own machine, which lets you measure learning on your own tasks. Historical costs are not a
prediction for a fresh checkout or different models.

## Drive it from the agent you already use (MCP)

atoma exposes itself as an [MCP](https://modelcontextprotocol.io) server on the same origin as
the console, so an existing agent can hand it a task and read back what the system has learned. One
line registers it — a URL and a bearer:

```bash
claude mcp add atoma --transport http https://<your-instance>/mcp \
  --header "Authorization: Bearer <token from Settings, or npm run auth -- token>"
# locally, ungated: npm run viz, then http://127.0.0.1:4111/mcp with no token
```

Codex CLI (OpenAI) reads the same URL from `~/.codex/config.toml` and the bearer from an
environment variable, so the secret never enters the file:

```toml
[mcp_servers.atoma]
url = "https://<your-instance>/mcp"
bearer_token_env_var = "ATOMA_MCP_TOKEN"   # omit on the local ungated instance
```

```bash
export ATOMA_MCP_TOKEN='<token>'   # in the shell profile Codex starts from
# or, in one line: codex mcp add atoma --url https://<your-instance>/mcp --bearer-token-env-var ATOMA_MCP_TOKEN
```

Settings shows both snippets, filled in, when a token is created. Either client then lists the
`atoma_*` tools your role admits under `/mcp`.

**Thirty-seven tools.** ONE MCP for everyone, and what you see depends on who you are. An organisation member
sees its projects and runs — start one as an MCP task and drive it through `tasks/get`, `tasks/result`
and `tasks/cancel`, cancel, retry a
publication, read a trace's shape, open the live preview of a deliverable, read their own notification
tray. An organisation admin also sees its members and model defaults. The platform admin
(or the operator on a local ungated server) sees everything above plus operator runs, the agent
catalogue with its earned trust and version history, the recipe library with its lifecycle and every
recipe body, the audit ledger's integrity projection and its newest entries, the cost curve over
recent runs, the operator run corpus, the tool-friction report, the sentinel's health, the analyst's
post-mortem verdicts and the audit journal — plus four attributed, journaled catalogue actions:
reset, drop or merge a recipe, roll an agent type back. The same state is addressable as MCP
resources (`atoma://runs/…`, `atoma://projects/…/runs/…`) that a host can subscribe to and be told
when a run finishes.
Starting a run initiates multiple internal model calls on the configured provider
accounts; polling and readers do not themselves launch inference.

**Identity is the security argument.** A token is minted by a signed-in principal for one
organisation, stored hashed, revocable, journaled; every call is bound to that organisation and
re-checks the role, and a run itself holds no token. The earlier stdio-only rule described a
framework on the operator's machine; the deployed product answered that question with its
authentication gate ([decision record](docs/mcp-one-surface-2026-09-05.md)).

Two properties are declared to the host rather than left to be discovered: starting an
operator run is **destructive** — it archives the shared workspace unless told otherwise,
and it mutates the catalogue, the recipe store and the ledger. Runs are
**serialised** by a machine-global admission lease. Project runs have
separate workspaces but share that slot with operator runs and background maintenance. The
slot is a cross-process lease, not just server memory; cancellation keeps it until the detached
process group is confirmed gone and the trace has closed.

## Status

**Working research system, honestly labelled.** Strict TypeScript on Node
24.20+, with hermetic and fresh-worker CI.

What exists: the full three-tier loop, the learning and compilation lifecycle, sandboxed
execution with opt-in container isolation and proxied egress, an append-only audit ledger with
integrity checking, a web console with optional multi-organisation login, project launch and
GitHub publication, ephemeral previews of delivered or in-flight web results, a mechanical live
watch, an optional post-mortem analyst, an isolated mender that proposes correction
pull requests for human merge, platform notifications, and a measurement harness.
A first login creates a personal
organisation unless it redeems an invitation to an existing one.

What does not: full tenant isolation. Authenticated projects, their run
workspaces, traces and project skills are scoped to the viewer's active organisation for now;
skills are meant to become a commons shared across organisations, with trust earned per
organisation. The platform admin can read across organisations. The atom catalogue, atom
trust and lifecycle ledger remain instance-global, however, so the control plane is not yet
safe for mutually untrusted organisations. The repository is public and open source so that the sandbox, the
egress path and the cost accounting can be audited and built upon; the supported deployment procedure is
[`docs/automatic-deployment.md`](docs/automatic-deployment.md).
The dated current state, invariants and Track A/Track B roadmap are reconciled in
[`docs/saas-architecture.md`](docs/saas-architecture.md).

![atoma's subsystems and the paths between them, drawn from the AGENTS.md subsystem map](docs/architecture.svg)
<sub>Regenerated from the repository by <code>npm run docs:architecture -- --apply --render --svg</code>; a subsystem
that is absent from the diagram IR fails <code>npm run docs:check</code>. The check
validates the IR, not the rendered SVG; rendering requires a separate Archify checkout.</sub>

<!-- atoma:facts:begin -->
<!-- Generated from this checkout by `npm run docs:facts -- --apply`. Do not edit by hand. -->

| Read out of this checkout | |
| --- | --- |
| Version | `0.2.0` |
| Node | 24.20+ (`.nvmrc` 24.20.0, `engines` >=24) |
| Subsystems under their own contract | 18 |
| MCP tools | 37 |
| Curated agent names | 118 molecules · 40 cells · 20 tissues |
| Controlled benchmark rounds | 12 (`benchmark/RESULT.md` + `ROUND<n>.md`) |
| Interface locales | 13 catalogs — 1 source, 12 translated |

<!-- atoma:facts:end -->

**[→ How it works: components, flows and diagrams](docs/how-it-works.md)**

## Documentation

- [How it works](docs/how-it-works.md): architecture, supervision, evidence, state and limits.
- [Development setup](docs/development-setup.md) and [contributing](CONTRIBUTING.md): install and verify a source checkout.
- [Automatic deployment](docs/automatic-deployment.md), [GitHub App setup](docs/github-app-setup.md) and [preview deployment](docs/preview-deployment.md): operator procedures.
- [Supervisor on Debian](docs/supervisor-codex-production.md): optional analyst and mender services.
- [Changelog](CHANGELOG.md) and [security policy](SECURITY.md): release history and reporting.
- [SaaS architecture](docs/saas-architecture.md): implemented boundaries and the remaining design roadmap.

Dated designs, incident reports and release acceptance notes describe the revision
or experiment they record; they are not substitutes for the current setup guides.

## Historical measurements

The following results predate the 2026-08-18 state reset and the current release.
Raw CSVs and run workspaces were archived outside this repository. The committed
round write-ups and scorer summaries preserve the findings, including failures;
new runs measure a new corpus rather than regenerate those rows.

<details>
<summary>Read the controlled benchmark and 156-run corpus findings</summary>

### Where the money went in round 8

One measured run of the same maintenance task, both arms, [round 8](benchmark/ROUND8.md):

| | frontier calls | **frontier cost** | cheap-model cost | total |
|---|---|---|---|---|
| single frontier agent | 1 | **$0.820** | — | $0.820 |
| atoma, warm | 1 | **$0.027** | $0.192 | $0.219 |

> **This comparison is against a frontier agent, and that choice does most of the
> work.** [Rounds 9–11](#rounds-911--how-much-of-this-is-tiering-and-how-much-is-the-control-model)
> re-ran the same task against Sonnet-direct and Haiku-direct: the advantage falls
> to 1.05× and then reverses to a 2.8× loss. Read them before quoting the table
> above.

The baseline does the whole job inside one frontier call: read the files, edit, run five
verification commands, rewrite the docs. Every tool result stays in the conversation and is
re-billed at frontier rates on every subsequent turn.

In this observation, atoma paid the frontier model **to decompose the goal** — one call, $0.027 — and hands the
execution to a cheap model. **A ~30× reduction on the expensive line item** is where the saving
comes from. Everything below is that fact, measured repeatedly.


### The controlled experiment

The same task, from an **empty registry and empty skill store**, given to atoma and to a single
frontier agent — same sandbox, same tools, same budget and token accounting,
[registered before each run](benchmark/PROTOCOL.md).

> **Raw measurement CSVs are no longer in the repository.** The project was reset to a from-scratch state on 2026-08-18 — store, skills, traces and measurement CSVs were archived out of the tree so that no code has to accommodate a previous era. The round write-ups keep the reasoning and the numbers as recorded at the time; the rows behind them are in the archive, not reproducible from this checkout.

Twelve rounds: four on a from-scratch build,
four on a maintenance task, three that vary the control arm’s model instead of the code, and one on a
harder maintenance family built after the eighth could no longer discriminate.

![cost curve, round 1](docs/benchmark-cost-curve.svg)
<sub>Round 1 only. Later rounds are written up in `benchmark/ROUND{2..12}.md`.</sub>

Mean cost per run on each round's main task, each against **its own same-day control**:

| | R1 | R2 | R3 | R4 | | R5 | R6 | R7 | R8 |
|---|---|---|---|---|---|---|---|---|---|
| | *build task* | | | | | *maintenance task* | | | |
| frontier direct | $0.82 | $1.01 | $1.68 | $1.10 | | $0.71 | $0.58 | $0.58 | $0.82 |
| **atoma** | **$0.53** | **$0.54** | **$0.51** | **$0.47** | | **$0.20** | **$0.28** | **$0.59** | **$0.31** |
| ratio | 1.54× | 1.89× | 3.33× | 2.35× | | 3.57× | 2.05× | **1.00×** | 2.62× |
| control arm *n* | 5 | 3 | 3 | 2 | | 2 | 2 | 2 | **1** |

**Read the two weak rounds, not just the strong ones.** Round 7 shows **no saving at all** — an
earlier sequential phase had already applied the edit, then validators repeatedly rejected a
later phase for honestly reporting the work already satisfied. That rare semantics gap cost
$0.33/run in escalation churn until it was [diagnosed and fixed](benchmark/ROUND7.md). Round 8's
control arm is a **single observation**: its
second run lost its LLM connection, so its cost is unrecoverable (the deliverable was correct).
Round 5's 3.57× is the round whose deliverables were later found wrong — see below.

### Rounds 9–11 — how much of this is tiering, and how much is the control model?

Rounds 1–8 all compared atoma against **one Opus agent**. A sceptic's obvious reply is
that they would simply run a cheaper model directly and pay less than either arm. Rounds
9–11 ran exactly that experiment: the control arm's model was pinned independently
(`ATOMA_BASELINE_MODEL`) while atoma kept its default `L1=haiku / L2=sonnet / L3=opus`
gradient. Same task, same seed, same code path, **all measured on 2026-08-15**.

| control arm | n | mean | correct | mean ÷ atoma |
|---|---|---|---|---|
| [Opus direct](benchmark/ROUND11.md) | 3 | $0.5104 | 3/3 | **1.78×** |
| [Sonnet direct](benchmark/ROUND9.md) | 3 | $0.3012 | 3/3 | **1.05×** |
| [Haiku direct](benchmark/ROUND10.md) | 6 | $0.1032 | 6/6 | **0.36×** — atoma loses |
| atoma (12 runs, two series from empty state) | 12 | $0.2865 | 13/14 | — |

**Both registered hypotheses were refuted, and they are published here as required by the
protocol.** Against Sonnet, atoma never reached break-even inside six runs (H9, cost).
Against Haiku, atoma was 2.5× more expensive *and* scored lower — one deliverable in seven
left two probe-manifest entries pointing at a fixture it had deleted (H10, correctness).

**What survives:** the structural claim. the measured normal path spent one top-tier decomposition call per task.
That is not a hard call limit: replanning and synthesis can add calls. On this task that is worth about $0.22 a
run against Opus-direct.

**What does not:** the assumption underneath the architecture — that a cheap model needs
supervision to be *correct*. Twelve of twelve unsupervised control deliverables were right,
first try, at all three price points.

### Round 12 — the harder task, and what it found

Rounds 9–11 ran on a one-file, five-invocation maintenance edit that turned out not to
discriminate: every deliverable of every arm scored full marks. [Round 12](benchmark/ROUND12.md)
was built to be able to fail — `tabstat`, three source files, eleven documented invocations,
three clauses one of which forbids a change, and **only three of ten documented statistics
actually move**, so a deliverable can fail by leaving the record stale *or* by whitewashing
values that never changed. The scorer was validated in four directions before the round.

| | control (Haiku direct) | atoma |
|---|---|---|
| deliverables at full marks | **6 of 6** | **5 of 7** |
| mean cost | **$0.2495** | $0.4881 |

**The task discriminated, and it discriminated against atoma.** Both failures are the same
class — the README contradicting the artefact — and the code was correct in 6 of 6 atoma runs.
One run updated the README's prose and left all seven recorded output blocks stale; another
updated every block and left the prose verbatim from the seed. **atoma updated each half of
the file and never both.**

Run 3's trace shows why, and it is a real architectural defect rather than bad luck. The plan
was three sequential phases — implement, re-verify, document. Phase 2 re-recorded the probes
*after* the edit, compared them against themselves and reported *"zero changed entries"*; phase
3 was then told to update *"only the invocations whose output legitimately changed per the
previous phase's change list"* — an empty list — and correctly did nothing. **The change list
must be computed before the edit, not after it.** A single agent holding the whole job in one
context never has that failure available.

**So the correctness case for supervision is now refuted twice, in the same direction, on an
easy task and a harder one.** It is not merely unmeasured — on this family of work, at this
scale, it is absent. What round 12 did produce is the first finding in four rounds that is
about supervision itself, and it is actionable.

**The historical frontier baseline varied more across these rounds.** Across the four build rounds the control
swung **2.1×** ($0.82 → $1.68) while atoma stayed inside **$0.47–0.54**. atoma exposes one
frontier call in roughly fifteen, so frontier variance is diluted; a single-agent baseline is
exposed end to end and passes it straight through. That was never the hypothesis — it fell out of
a confounder the protocol registered in advance, within these historical observations. It does not establish current model economics.

| | frontier direct | atoma |
|---|---|---|
| A *novel* task in the same family | $1.18 <sub>(n=2, spanning 2.5×)</sub> | **$0.18–0.55, zero new recipes learned** |
| Deliverable correctness, executing scorer <sub>(R1 · R2 · R3 · R8 · R9 · R10 · R11 · R12)</sub> | 7/7 · 3/3 · 3/3 · 2/2 · 3/3 · 6/6 · 3/3 · **6/6** | **12/12 · 16/16 · 16/16 · 7/7 · 7/7 · 6/7 · — · 5/7** |

Generalisation is the claim that has held most consistently: **eleven held-out runs across eight
rounds, all in the same family as the trained task, all needing zero new recipes.** The frontier
comparison for it rests on two observations from round 1 and should be read as indicative.

Correctness is scored by [an executing scorer run outside both arms](benchmark/verify-maint.mjs)
— it runs the artefact rather than reading claims about it. **Rounds 4–7 have no committed
scorer output**, so their correctness figures are not reproducible from this repo; rounds 1–3 and
8–11 retain scorer summaries, but their original workspaces are archived and cannot
be re-executed from this checkout alone. That gap is recorded rather than papered over. From round 9 the run→workspace mapping
is [computed from an anchor recorded before the round](benchmark/score-round.mjs) rather than
reconstructed afterwards, which is how round 8 came to publish a false 83.3% before correcting it.

**One headline in this table used to be wrong, and how it was caught matters more than the
number.** Round 5 measured 4.7× — and the independent scorer found **7 of 9 deliverables shipping
a README that contradicted the artefact it documented**. A compiled verifier had been handed an
*"update README.md"* subtask, replayed its manifest, reported success and written nothing; the
guard meant to catch that only checked whether named files *exist*, which is inert when every
file was seeded. With the guard fixed, correctness went to 5 of 6 and the ratio fell to 2.05×.
Half the original headline was work that had not happened. The pipeline's own "delivered" banner
never noticed.

### The longer-run picture

Beyond the controlled experiment, a burn-in corpus of 156 runs across 8 task families was
measured with `npm run burnin`. Its CSV is archived rather than committed — see the note above.

| | |
|---|---|
| Runs recorded | **156** across 8 task families |
| Delivered successfully | **150 — 96.2%** |
| Cost per delivered run | median **$0.33**, mean $0.37 |
| Cheapest *delivered* run | **$0.126 · 132s** |
| Runs containing at least one zero-model-call phase | **45 of 156** — median $0.26 · 227s |
| Expensive-model calls per run | **1** on the normal path (148 of 150 delivered runs) |

### Three honest readings

**The batch average across those 156 runs does not fall, and that is expected.** It is not the
same measurement as the experiment above. Cost falls on a *repeated* task; the batch curve is
flat-to-rising because the task generator deliberately proposes harder, novel work each round.
Read the controlled experiment for the amortisation claim and this corpus for breadth — not the
other way round.

**The zero-cost mechanism applies to *phases*, and it is not what makes atoma cheaper.** No
complete run has ever cost $0.00, and none can today: every run still pays for one top-level
planning call. 45 of 156 corpus runs contain a phase that executed with no model call — but those
runs' mean cost is $0.37, identical to the corpus mean, and in the controlled rounds the compiled
path fired 14 times in 8 rounds, 11 of them in the single round whose deliverables were wrong.
The saving comes from tiering and earned trust.

**Failure handling improved measurably.** Runs with at least one escalation fell from **27 of
the first 52** to **zero in the last thirty**. That is a learning curve being paid down.


</details>

## License

atoma is **free and open-source software** under the
[GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).
You may use, study, modify and redistribute it, and build products and services
on it. If you distribute a modified version, or run one that users interact with
over a network, you must offer those users its source under the same licence.
Unmodified use, including internal production use and hosting, carries no
obligation beyond keeping the notices. The licence is approved by the OSI and
the FSF; its terms are the ones Grafana, MinIO, Mattermost and Nextcloud publish
under.

Organisations that cannot accept the AGPL, for example to embed atoma in a
closed product, can obtain a commercial licence from the author; contributors
grant the rights that make this possible through the [CLA](CLA.md), which
also commits the project to remaining under an OSI-approved licence.

Contributions start with [`CONTRIBUTING.md`](CONTRIBUTING.md). Vulnerabilities
go through [`SECURITY.md`](SECURITY.md), not the issue tracker.

The model transports are your own accounts under each provider's terms: the
Anthropic API and Claude Code, OpenAI Codex, Z.ai and Ollama are called with the
credentials you supply, and the `@anthropic-ai/claude-agent-sdk` dependency is
distributed by Anthropic under its own licence, not under this one. The 3D assets
under `src/viz/public/` carry their CC0 and CC-BY-4.0 notices beside the files.

Copyright 2026 Matthieu Foillard.

---

<div align="center">
<sub>TypeScript · SQLite · Node 24.20+ · new corpora can be measured with <code>npm run burnin</code>;
the controlled rounds are in <code>benchmark/</code></sub>
</div>
