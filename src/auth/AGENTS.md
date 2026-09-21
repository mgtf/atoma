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

## Host-subscription delegation

- ONE ROW, ONE ORGANISATION (`auth_subscription_delegates`,
  `subscriptionDelegates.ts`): a member of the DECLARED organisation
  (`ATOMA_HOST_SUBSCRIPTION_ORG`) may name the machine's own login session
  (`sub:` selectors) on a tier WITHOUT holding the platform-admin flag. It
  separates "may spend the operator's subscription" from "holds every
  operator power", which were the same fact until 2026-09-22 — handing a
  colleague the first meant handing them burn-in, the operator corpus,
  cross-organisation reads and the four writes.
- It changes exactly ONE of the three facts the coordinator re-asks per run:
  the requester's authority. The pin is still the delegate's OWN account pin
  (never an org default, never the host env), and the run must still belong
  to the declared organisation. See [src/projects](../projects/AGENTS.md).
- MEMBERSHIP-SCOPED, not principal-scoped, and the store checks it: a
  delegation for someone who cannot launch a run there is an authority nobody
  could exercise and nobody would think to withdraw. The same person in
  another organisation is not a delegate.
- MINTED BY AN OPERATOR ACT ONLY — the CLI by possession of the machine
  (`grant-subscription` / `revoke-subscription`), or a platform admin's own
  authenticated session. A delegate can never delegate further. The rule
  lives in ONE body that all three doors call (CLI, `/api/org/
  subscription-delegates/:principalId`, `atoma_subscription_delegates`);
  never re-check it in a door.
- Granting and withdrawing are `admin.subscription_delegated` /
  `admin.subscription_revoked` (severity `security`, pushed to platform
  admins), journaled at the moment of the decision, from whichever process
  decided. A no-op journals nothing.
- WITHDRAWAL LEAVES THE PINS: they are data, refused by name at the next
  launch, exactly as for a revoked flag. Erasing them would lose "who chose
  this payer".
- The table post-dates the first stores and is deliberately absent from
  `AUTH_TABLE_NAMES`: a read-only open of an older product DB answers "no
  delegates" instead of refusing the whole schema.
- Design and the owner's decision:
  [docs/subscription-delegation-2026-09-22.md](../../docs/subscription-delegation-2026-09-22.md).

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
  A completed login is verified with a bounded settle window: released Codex
  (≤0.154) notifies `account/login/completed` BEFORE reloading its auth cache,
  so the first `account/read` may report no account. Retry until `account/updated`
  or the window closes; never fail on the first empty read (2026-09-15).
  A run resolves the exact current generation from its requesting principal;
  disconnection deletes the receipt first and never falls back to the host.
  App-server access shares the same per-`CODEX_HOME` lease as run calls. The
  lease combines an in-process FIFO with a sibling SQLite transaction, so it
  also excludes a surviving run child or overlapping server process and is
  released by the OS after a crash. Never release it before the provider child
  is reaped. Status verification shares the bounded app-server process budget.
  Startup removes only safe UUID generations absent from the receipt set, so a
  crash cannot leave an unbounded credential-bearing staging corpus.
- Connecting a personal subscription ARMS the three tier pins when, and only
  when, no level of the chain (account pin > org default > host env) resolves
  any tier: that member could not launch a run at all, and the account choice
  is itself the authorization to spend. `armStarterChatGptPins` owns the rule
  and journals it under the manual kind with `automatic: true`. Never let it
  overwrite a value, and never arm the HOST's login from it.
- Personal ChatGPT models come from app-server `model/list` in that exact
  private generation. The bounded five-minute cache is keyed by principal and
  generation; refresh failure exposes stale data without authorizing new pins.
  Launch refreshes the inventory before spend. No static fallback or model
  substitution. Empty accounts start with the provider-reported default only.
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
