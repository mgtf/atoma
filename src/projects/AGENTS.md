# Projects — AGENTS.md

`src/projects/` owns organisation-scoped projects: the run corpus they hold,
their artifact manifests, and publication.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — the identities projects belong to
- [`src/github`](../github/AGENTS.md) — where publication lands
- [`src/platform`](../platform/AGENTS.md) — the journal this domain emits into

## Scoping and storage

- Projects, GitHub App installations and publications are organisation-scoped;
  a run belongs to exactly one project and a project to exactly one
  organisation. Gated `/api/runs` lists that org's project traces from
  `orgs/<orgId>/projects/<projectId>/runs/<runId>/` (override the host root
  with `ATOMA_PROJECTS_ROOT`, default `~/.atoma`). It does not mix the
  operator `./runs` corpus used by CLI, MCP and ungated viz.
