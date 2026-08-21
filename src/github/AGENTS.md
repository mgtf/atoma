# GitHub App — AGENTS.md

`src/github/` owns the optional GitHub App: installation, webhook deliveries,
token handling and repository creation.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/auth`](../auth/AGENTS.md) — GitHub login, a different thing entirely
- [`src/projects`](../projects/AGENTS.md) — what gets published
- [`src/viz`](../viz/AGENTS.md) — why deliveries bypass the offline cache

## Installation and publication

- The optional GitHub App (`ATOMA_GITHUB_APP_*`) is a separate install from
  GitHub login: register setup at `/auth/github/setup` and webhooks at
  `/webhooks/github`. Repositories are created only after a delivered,
  validated artifact manifest, and a retry never creates a second repo.
