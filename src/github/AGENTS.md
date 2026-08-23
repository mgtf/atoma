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
- THE GIT DATA API CANNOT START A REPOSITORY, and every publication path here
  used to begin with it. Measured against real GitHub on 2026-08-23, in a
  repository created moments earlier: `POST /git/blobs` answers
  `409 {"message":"Git Repository is empty."}`, and so does `POST /git/trees`
  with inline content. `PUT /contents/{path}` answered 201 on the same
  repository. So `publishInitialCommit` SEEDS the branch through the contents
  API with a real manifest file — never a placeholder, so no commit needs
  explaining later — and completes the tree with git data only when there is
  more than one file. One file is one commit and the git data API is never
  touched.
- That defect survived because every publisher test mocks this client: the
  suite pinned a sequence GitHub refuses. The tests now encode the real one,
  and the shape was verified end to end against a throwaway private repository
  that was deleted afterwards.
- The pre-flight `getReference` refusal is not the whole race. A contents write
  to a branch created inside the window SUCCEEDS silently, so the seed commit's
  PARENT COUNT is the evidence: a root commit means the branch was ours,
  anything else is `GitHubDivergenceError` — one file written, and said out
  loud, rather than the rest of the manifest piled onto content this product
  never saw.
- HTTP 422 from repository creation is not proof a name is taken: an account
  can also refuse to create a repository of that visibility, and
  `GitHubApiError` carries no body. See [`src/projects`](../projects/AGENTS.md).

