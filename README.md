<div align="center">

# ⚛️ atoma

### Turn business ideas into working software.

Describe the tool your team needs. atoma coordinates AI agents to build it,
check the result, and let you inspect the work along the way.

**[Open atoma.run →](https://atoma.run)**

[Demo](#watch-the-demo) · [Use cases](#what-could-your-team-build) · [How it works](#how-it-works) · [Self-host](#install-and-evaluate-it-locally) · [Documentation](#documentation)

[![CI](https://github.com/mgtf/atoma/actions/workflows/ci.yml/badge.svg)](https://github.com/mgtf/atoma/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

</div>

## Watch the demo

https://github.com/user-attachments/assets/481c59de-2f29-423e-a55c-80cc5b448b92

## From a business need to a tool you can use

An operations team needs a dashboard. An agency needs a client demo. A product
team needs an API prototype. atoma helps turn those requests into software:
web applications, HTTP APIs, command-line tools and their technical documentation.

Start at **[atoma.run](https://atoma.run)**. The web console brings projects,
AI execution, result previews and run history into one place. This repository
contains the open-source engine and console for teams that want to inspect,
extend or self-host them.

- **Make an idea tangible.** Describe a goal and review the application it produces.
- **Keep the work visible.** Follow progress, verification results and model cost
  estimates as the agents work.
- **Build on the result.** Review the generated files and publish delivered
  artifacts to a connected GitHub repository.
- **Learn as a platform.** Agent types, skills and the trust they earn are shared
  by every run on an instance. What one run works out is offered to the next,
  whoever started it.

## What could your team build?

These are example project briefs for the kinds of software atoma builds, not
prebuilt industry integrations or customer deployment claims.

| Team or industry | Example project | What it helps you do |
| --- | --- | --- |
| Agencies & consulting | An interactive client demo or project estimator | Turn a proposal into something a client can try |
| Retail & e-commerce | A sales dashboard from exported CSV files | Explore product performance and share a clear view with the team |
| Logistics & operations | An inventory viewer or shipment-status prototype using sample data | Test a workflow before connecting operational systems |
| SaaS & product teams | A web app prototype or HTTP JSON API | Explore a feature and hand working code to engineering |
| Data & engineering teams | A CSV-to-JSON CLI, validation utility or technical documentation | Package a repetitive task into a reusable tool |

For example:

> Build a sales dashboard that lets me upload a CSV with date, product, region
> and revenue columns. Add filters, monthly totals and a chart by region.
> Include sample data and instructions to run it locally.

## From brief to review

1. **Create a project** in the web console and describe the outcome you want.
2. **Follow the run** as agents plan, write files and check their work.
3. **Preview supported web results**, including a timestamped snapshot while work
   is still in progress.
4. **Review and keep the deliverable**, with its verification record and optional
   GitHub publication.

Previews are temporary review environments. Deploying the generated application
is a separate step. Project runs use the configured model accounts and consume
model quota or incur API charges.

<p align="center">
  <img src="docs/atoma-run-audit.png" alt="atoma console showing a build run, its timeline, validation results and model cost estimates">
</p>

<p align="center"><em>See what ran, what was checked, and where model usage went.</em></p>

<p align="center">
  <img src="docs/atoma-run-llm-filter.png" width="640" alt="The same run timeline narrowed to LLM calls, each step showing its agent, model, tokens, cache use, duration and cost">
</p>

<p align="center"><em>Filter the timeline to LLM calls: the model, tokens and cost behind each step.</em></p>

## How it works

atoma assigns planning, supervision and execution to different AI agents and
model tiers. Ordinary build runs start with a supervisor and workers; a deeper
planning tier can take over if supervision exhausts its retries.

- **Workers build.** They read and write files, run commands and use tools.
- **Supervisors check.** They review results and use artifact evidence and fixed
  probes where applicable. A run also receives independent final acceptance.
- **Trust is earned.** Successful components can skip some model reviews while
  retaining mechanical checks. A failure revokes that trust.
- **Skills carry forward.** Verified work can become reusable recipes. Eligible
  recipes can be compiled into scripts, though historical benchmarks have not
  established a cost benefit from compilation.

The composition model is **Element → Molecule → Cell → Tissue**: tools, workers,
supervisors and planners. Model selection is configurable per tier.

Read **[How atoma works](docs/how-it-works.md)** for the architecture, execution
boundaries and verification design.

### One catalogue, shared by every run

A run is a run. One instance keeps one agent registry and one skill catalogue,
and every run reads and writes them — the operator's own runs and every
organisation's alike. A recipe distilled during one team's run is offered to the
next team's run, and the trust a component earns is the trust the next supervisor
reads. Projects, workspaces, run traces and the documents a run may search stay
scoped to their organisation.

This is the design, not a pending isolation gap. Read
**[One registry, one trust](docs/platform-trust-2026-09-15.md)** for what is
shared, what is not, and why.

### Connect an existing agent through MCP

The console also serves an HTTP MCP endpoint at `https://<your-instance>/mcp`.
Compatible clients can submit tasks and inspect their results through the same
organisation permissions as the web console.

**Thirty-eight tools.** The visible subset depends on the caller's role.
See the [MCP connection and authorization guide](docs/mcp-oauth.md) for setup.

## Install and evaluate it locally

For the web experience, start at **[atoma.run](https://atoma.run)**.
For a source checkout, use the pinned Node version and follow the
[platform setup guide](docs/development-setup.md), including system prerequisites.
Runs and the full test suite require macOS or Linux; on Windows, use WSL2 with
its own checkout on ext4.

```bash
git clone https://github.com/mgtf/atoma.git
cd atoma
nvm install && nvm use
npm ci
npm run release:check
npm run doctor
```

Configure your model providers using [`.env.example`](.env.example) and the
[development guide](docs/development-setup.md), then run a task:

```bash
npm run run:build -- "a Node CLI that converts CSV to JSON"
npm run viz:serve
```

The compiled commands read the process environment; they do not load `.env`.
The local console is open on loopback by default. Organisation-scoped project
runs additionally require Docker and a configured
[Haystack search runtime](docs/project-retrieval-haystack-only-2026-09-09.md#activation).
A fresh checkout contains no learned state.

For a hosted instance, follow the [deployment guide](docs/automatic-deployment.md),
[GitHub App setup](docs/github-app-setup.md) and
[preview deployment guide](docs/preview-deployment.md).

## Status

atoma is an evolving open-source system with a working web console, project
runs, GitHub publication, result previews and inspectable execution.

**Shared learning is the design, and it has a price.** One instance means one
agent registry, one skill catalogue and one lifecycle ledger, shared by every
organisation on it. Prompts, recipes and trust counters that a run writes are
readable by every other organisation's runs — including wording a supervisor
derived from a document that run was given to search. Projects, workspaces and
traces stay organisation-scoped, and a platform admin can read across
organisations. An instance therefore suits teams that accept pooling what their
runs learn; mutually untrusted tenants are not a supported deployment shape.
See [One registry, one trust](docs/platform-trust-2026-09-15.md) and the
[architecture and roadmap](docs/saas-architecture.md).

Local file-tool containment is not shell isolation; use the container backend
for isolated execution. Verification provides evidence for review, not a guarantee
that every generated application is ready for production.

<details>
<summary>Repository facts</summary>

<!-- atoma:facts:begin -->
<!-- Generated from this checkout by `npm run docs:facts -- --apply`. Do not edit by hand. -->

| Read out of this checkout | |
| --- | --- |
| Version | `0.4.0` |
| Node | 24.20+ (`.nvmrc` 24.20.0, `engines` >=24) |
| Subsystems under their own contract | 18 |
| MCP tools | 38 |
| Curated agent names | 118 molecules · 40 cells · 20 tissues |
| Controlled benchmark rounds | 12 (`benchmark/RESULT.md` + `ROUND<n>.md`) |
| Interface locales | 13 catalogs — 1 source, 12 translated |

<!-- atoma:facts:end -->

</details>

## Documentation

| I want to… | Read |
| --- | --- |
| Understand the architecture | [How it works](docs/how-it-works.md) |
| Know what runs share with each other | [One registry, one trust](docs/platform-trust-2026-09-15.md) |
| Develop locally or contribute | [Development setup](docs/development-setup.md) · [Contributing](CONTRIBUTING.md) |
| Operate a hosted instance | [Deployment](docs/automatic-deployment.md) · [Configuration](.env.example) |
| Publish results or enable previews | [GitHub App](docs/github-app-setup.md) · [Preview deployment](docs/preview-deployment.md) |
| Connect an MCP client | [MCP authorization](docs/mcp-oauth.md) |
| Review changes and limitations | [Changelog](CHANGELOG.md) · [SaaS architecture](docs/saas-architecture.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |

## Historical measurements

**Twelve controlled rounds** explored build and maintenance tasks. Results were
mixed: some comparisons favoured atoma over a frontier agent; cheaper direct
models matched or outperformed it on the tested maintenance tasks. These findings
do not establish savings or correctness for the current release.

The measurements predate the 2026-08-18 state reset. Raw CSVs and workspaces were
archived outside this repository; the committed reports retain findings and
failures. Read the [protocol](benchmark/PROTOCOL.md),
[initial results](benchmark/RESULT.md),
[model comparisons](benchmark/ROUND11.md) and
[harder maintenance task](benchmark/ROUND12.md) for context.

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

**[Explore atoma.run →](https://atoma.run)**
