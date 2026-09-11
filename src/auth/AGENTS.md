# Auth — AGENTS.md

`src/auth/` owns the opt-in deployment gate: OAuth identities, sessions,
organisations, invitations, rate limiting and the platform-admin flag.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/viz`](../viz/AGENTS.md) — which surfaces the gate exposes, and to whom
- [`src/projects`](../projects/AGENTS.md) — what an organisation owns
- [`src/cli`](../cli/AGENTS.md) — the CLI that grants and revokes the admin flag

## Gate and identity

- Visualizer authentication is an opt-in deployment gate, not full
  multi-tenancy. Authenticated projects, their run workspaces and trace reads
  are scoped to the active organisation, but registry, skill and trust state
  remain instance-global. `ATOMA_VIZ_AUTH=1` requires the operator-owned
  `ATOMA_VIZ_PUBLIC_ORIGIN`, at least one complete provider configuration
  (GitHub/Google require client ID + secret; an approved ChatGPT client may
  use PKCE without a secret). The first login without an invitation creates
  an organisation owned by that principal; a one-use invitation joins an
  existing organisation.
  OAuth identities join only on `(provider, subject)`, never email; provider
  login conveys no model-inference entitlement. Auth rows live in the primary
  product store selected by viz, and browser redirects always use
  `${ATOMA_VIZ_PUBLIC_ORIGIN}/auth/callback`, never request Host headers.

HTTPS session and OAuth cookies use the `__Host-` prefix, Secure, Path=/ and
no Domain. Readers select those names from the configured public origin and
never accept legacy unprefixed cookies on HTTPS. This requires re-login after
the upgrade and prevents a preview subdomain from planting an auth bearer.
Loopback HTTP keeps its development cookie names and paths.

## Platform admin

- PLATFORM ADMIN is one instance-wide operator flag on a principal
  (`auth_platform_admins`), granted and revoked ONLY by the operator CLI
  (`npm run auth -- grant-admin --principal <id-or-email>`), never derived
  from OAuth claims — provider emails are display attributes and GitHub's is
  not even a verified-email assertion.
  What the flag unlocks is a routing question, answered in
  [`src/viz`](../viz/AGENTS.md).

## Personal provider subscriptions

- A provider subscription belongs to one principal, never an organisation.
  SQLite stores only an opaque profile-generation receipt and timestamps;
  provider credentials remain below the private `ATOMA_ACCOUNT_PROFILES_ROOT`
  (`0700`, credential files `0600`). Never put tokens, device codes, account
  email, plan or profile paths in the store, API or audit journal.
- Personal profiles fail closed on hosts where private ownership cannot be
  proven. POSIX mode checks are implemented; Windows requires an explicit ACL
  implementation before this capability may be enabled there.
- Codex login uses the official app-server device-code account methods. Pending
  attempts are bounded, memory-only and self-scoped from the resolved session.
  A run resolves the exact current generation from its requesting principal;
  disconnection deletes the receipt first and never falls back to the host.
  App-server access shares the same per-`CODEX_HOME` lease as run calls. The
  lease combines an in-process FIFO with a sibling SQLite transaction, so it
  also excludes a surviving run child or overlapping server process and is
  released by the OS after a crash. Never release it before the provider child
  is reaped. Status verification shares the bounded app-server process budget.
  Startup removes only safe UUID generations absent from the receipt set, so a
  crash cannot leave an unbounded credential-bearing staging corpus.
- Personal Claude/claude.ai login is unavailable until Anthropic grants the
  third-party approval its SDK terms require. Keep that a server-owned disabled
  capability, not a client flag or an emulated OAuth flow.

## MCP OAuth authorization server

- `mcpOAuth.ts` owns OAuth discovery, public-client registration, consent and
  token endpoints, mounted only behind the deployment gate. The existing web
  login returns through an opaque, expiring request id; consent binds the
  displayed principal and active organisation to the exact browser session,
  and only a same-origin POST grants access. No arbitrary login return URL.
- S256 PKCE, exact registered redirects (HTTPS or HTTP loopback), resource
  binding to the canonical `/mcp`, one-use codes and rotating refresh tokens
  are mandatory. DCR is supported; client metadata URL fetching is not
  advertised. Names supplied by a client are not verified identities.
- `mcpOAuthStore.ts` extends the PRIMARY store with clients, hashed codes,
  grants and hashed refresh history. API-token rows remain the authority for
  principal/org identity, live roles, listing and revocation. Access expires
  after one hour; renewal has an absolute 30-day lifetime. Valid code/refresh
  replay revokes the grant; every issuance/revocation uses the existing token
  journal events. Temporary consent state is bounded and dies on restart;
  issued grants survive. Details: [OAuth contract](../../docs/mcp-oauth.md).
