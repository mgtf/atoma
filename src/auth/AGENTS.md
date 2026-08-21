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

- Visualizer authentication is an opt-in deployment gate, not multi-tenancy
  of the run corpus. `ATOMA_VIZ_AUTH=1` requires the operator-owned
  `ATOMA_VIZ_PUBLIC_ORIGIN`, at least one complete provider configuration
  (GitHub/Google require client ID + secret; an approved ChatGPT client may
  use PKCE without a secret). The first login without an invitation creates
  an organisation owned by that principal; a one-use invitation joins an
  existing organisation.
  OAuth identities join only on `(provider, subject)`, never email; provider
  login conveys no model-inference entitlement. Auth rows live in the primary
  product store selected by viz, and browser redirects always use
  `${ATOMA_VIZ_PUBLIC_ORIGIN}/auth/callback`, never request Host headers.

## Platform admin

- PLATFORM ADMIN is one instance-wide operator flag on a principal
  (`auth_platform_admins`), granted and revoked ONLY by the operator CLI
  (`npm run auth -- grant-admin --principal <id-or-email>`), never derived
  from OAuth claims — provider emails are display attributes and GitHub's is
  not even a verified-email assertion.
  What the flag unlocks is a routing question, answered in
  [`src/viz`](../viz/AGENTS.md).
