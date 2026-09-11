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
  `/webhooks/github`. New empty repositories are created only after a delivered,
  validated artifact manifest, and a retry never creates a second repo. The
  operator procedure — the three repository permissions, the settings that are
  hard requirements, and what is recoverable — is
  [`docs/github-app-setup.md`](../../docs/github-app-setup.md); keep it in step
  with `GITHUB_PUBLISH_PERMISSIONS` and `snapshotGitHubAppConfig`.
- `bindInstallation` IS THE ONE PLACE AN INSTALLATION BECOMES AN
  ORGANISATION'S, and both doors — the setup callback and the authorize
  callback — route through it. They did not, and they disagreed: setup checked
  the role and wrote no audit row, authorize wrote no audit row and checked NO
  role, and neither refused a suspended installation though the client has
  always parsed `suspended`. Its caller must pass a view obtained from
  `verifyInstallation`, never from `getAppInstallation` alone.
- THE VIEW MUST BE CORROBORATED AGAINST THE CONNECTING USER, and that is a
  security property, not tidiness. `installation_id` reaches
  `/auth/github/setup` from a URL the viewer can type, and the connect state
  binds a principal and an org — the table has no installation column. Linking
  from the App-JWT view alone therefore proved only "some installation of this
  App", so an authenticated admin could put a stranger's id on their own state
  and capture it: the cross-org guard fires only once a row exists, first
  binder wins, and nothing in the product can unbind. Installation ids are not
  secret and open signup makes `org:admin` free.
  `startGitHubConnect` therefore REFUSES TO START a flow whose callback could
  not verify: no stored user authorization means a redirect to the authorize
  path first. Almost nobody sees that hop — an ordinary GitHub login already
  stores one. The authorized viewer then reaches installation discovery.
- Connect discovers the current user's existing installations before opening
  GitHub's install page. An already-installed App only opens Configure there,
  which does not repeat the setup callback. Discovery offers an explicit account
  choice and writes no installation; the selected link carries the existing
  principal/org-bound one-use state into the SAME verified setup callback.
  No matching installation keeps the ordinary install redirect. Discovery errors
  are visible failures, never interpreted as an empty list. Authorization without
  an installation id resumes connect so this choice remains reachable.
- TWO GITHUB SETTINGS ARE LOAD-BEARING AND NEITHER IS OBVIOUS. *Request user
  authorization (OAuth) during installation* must stay OFF: it removes the
  Setup URL field, which is where GitHub returns the browser after a real
  install, and the post-install arrival on `/auth/callback` is refused because
  `startGitHubConnect` mints no tx cookie.
  *Expire user authorization tokens* must stay ENABLED: `persistGitHubUserTokens`
  throws on a null `expires_in`, so the personal-account branch dies at every
  connect. A REACHABLE webhook URL, by contrast, is optional — nothing on the
  connect or publish path reads a delivery; without one an installation row
  simply never leaves `active`, since status mutation lives only in
  `recordWebhookDelivery` and there is no reconciliation poll.
- THE GIT DATA API CANNOT START A REPOSITORY, and every publication path here
  used to begin with it. Measured against real GitHub on 2026-08-23, in a
  repository created moments earlier: `POST /git/blobs` answers
  `409 {"message":"Git Repository is empty."}`, and so does `POST /git/trees`
  with inline content. `PUT /contents/{path}` answered 201 on the same
  repository. So a FIRST publication SEEDS the branch through the contents API
  with a real manifest file — never a placeholder, so no commit needs
  explaining later — and completes the tree with git data only when there is
  more than one file or an executable mode needs preserving. A single regular
  file needs only the seed commit.
- That defect survived because every publisher test mocks this client: the
  suite pinned a sequence GitHub refuses. The tests now encode the real one,
  and the shape was verified end to end against a throwaway private repository
  that was deleted afterwards.
- `publishManifestCommit` is the ONE composed flow, and it decides
  first-versus-incremental FROM GITHUB: `readBranchHead` is the fact and
  `expectedHead` is the authority. Never from `repository_status = 'ready'`,
  which says the repository EXISTS — reading it as "the branch is ours" is what
  made publication single-shot, so exactly one commit could ever reach a
  project's repository.
- `expectedHead` is this project's own last published commit, or null. It is
  the AUTHORITY to write onto a branch that already has commits, and it is
  load-bearing beyond ordering: `ensureRepository` adopts a pre-existing
  repository on a 422 name collision, and nothing in the projects DDL forbids
  two projects of one organisation naming the same repository. A null
  `expectedHead` against a populated branch is therefore still a refusal with
  zero writes unless this same publication holds a durable root-seed receipt.
  That receipt is persisted before uploading the remaining tree: retry may
  finish the exact seed or recognize its direct child with the exact desired
  tree. Unrecorded seeds and unrelated heads remain refused. A crash between
  the remote seed and persisting its receipt still requires operator recovery.
  The unowned-branch refusal used to be a side effect of the empty-branch
  precondition, and it is now the stated guard.
- `readBranchHead` DISCRIMINATES 404 from 409, which the old `getReference`
  collapsed into one `null` a line from the decision. 409 is "this repository
  has no commits", the state the contents API exists to seed. 404 is "it has
  commits but not this branch", which for a project that already published
  means the branch was deleted or renamed — `GitHubBranchGoneError`, refused
  rather than re-seeded, because a second root history in a repository a tenant
  has already cloned is worse than a stopped publication.
- An incremental commit MERGES onto the parent's tree (`base_tree`) and never
  replaces it, so publication can add and overwrite but never remove. Legacy
  manifests are model plan-time lists, while new manifests inventory the
  finished workspace. This API remains additive for both: absence is never
  translated into deletion implicitly. Replacing would let "run 2 only touched
  index.html" delete `app.js` from the tip while `app.js` still sits on disk in
  that very run. Deletion is therefore not expressible by publication at all —
  that is registered, not built.
- `T1 === T0` IS THE NO-OP AND THE CRASH REPAIR, and it is why the tree is
  built before any commit object exists. Git trees are content-addressed, so an
  identical result sha means the branch already holds every byte the manifest
  declares: no commit, no reference move, and the row records the commit that
  really holds them. It is also what makes a crash between the reference move
  and the store write converge — merging a manifest onto its own result is
  idempotent, where replacing would not be.
- `updateReference` sends `force: false` as a body LITERAL and takes no force
  parameter. It is a FAST-FORWARD test, not a compare-and-swap: a human who
  resets the branch to an ancestor inside the window gets rolled forward,
  because the new commit is still a descendant. GitHub's ref API has no
  expected-old-sha, so there is no cheap close; the next publication observes
  it, since `baseSha` then differs from the previous publication's commit.
- 422 is ALSO how a ruleset declines, and `GitHubApiError` carries no body — so
  `moveBranch` re-reads the head once and `GitHubRefRefusedError` says which it
  was (`moved`, `blocked`, `unknown`). NO WORD is shared with the divergence
  sentence: reporting a protected branch as "somebody pushed" sends an operator
  hunting a push that never happened. Anything that is not 422 or 409
  propagates untouched.
- The pre-flight head read is not the whole race. A contents write
  to a branch created inside the window SUCCEEDS silently, so the seed commit's
  PARENT COUNT is the evidence: a root commit means the branch was ours,
  anything else is `GitHubDivergenceError` — one file written, and said out
  loud, rather than the rest of the manifest piled onto content this product
  never saw.
- HTTP 422 from repository creation is not proof a name is taken: an account
  can also refuse to create a repository of that visibility, and
  `GitHubApiError` carries no body. See [`src/projects`](../projects/AGENTS.md).


## Existing repositories

- `publishRepositoryRun` consumes the captured run base: PR mode creates an
  immutable `atoma/run-<id>` branch and one PR; fork mode advances the fork's
  default branch directly. Neither mode force-pushes. Changed fork heads and
  unrelated run branches are refused; matching tree+parent receipts converge
  after a remote-write crash. An unchanged tree creates no empty PR.
- Imported PR runs request `pull_requests: write` in addition to the ordinary
  publish permissions. Forks and new repositories keep the ordinary token.
- Repository snapshots read bounded immutable trees/blobs; truncated trees,
  unsafe paths, symlinks and submodules fail before model work. No GitHub
  credential enters the worker. Fork adoption requires the exact parent id.
