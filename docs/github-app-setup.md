# GitHub App setup

The optional GitHub App lets an organisation connect a GitHub installation, so
a delivered project run publishes its artifacts into a real repository. It is a
**separate install from GitHub login**, and this document is the procedure — the
permissions below are derived from the endpoints the code actually calls, not
from a guess at what might be needed.

Registration is a one-time operator task. Nothing here is required to run atoma
locally or to use the visualizer.

## Prerequisites, in this order

1. **The visualizer auth gate must be on.** Without it there is no projects
   runtime at all, and every GitHub route answers 404
   ([`server.ts:558`](../src/viz/server.ts#L558)).
2. **A GitHub login provider must exist** (`ATOMA_AUTH_GITHUB_CLIENT_ID` /
   `ATOMA_AUTH_GITHUB_CLIENT_SECRET`).
3. **That login provider should be the App itself.** atoma passes the auth
   provider's client credentials into the App snapshot
   ([`server.ts:576-580`](../src/viz/server.ts#L576-L580)), so the App's own
   *Client ID* and *Client secret* are what belong in those two variables. A
   separate OAuth App for login and a GitHub App for publication is not a
   supported pairing.

A plain **OAuth App** cannot be used: it has no App ID, no slug, no private key
and no webhook secret. If your client ID is 20 hex characters you have an OAuth
App; a GitHub App's client ID begins with `Iv1.` or `Iv23`.

## 1. Register the App

`https://github.com/settings/apps` for a personal App, or
`https://github.com/organizations/<org>/settings/apps` for an org-owned one →
**New GitHub App**.

### URLs

Substitute your `ATOMA_VIZ_PUBLIC_ORIGIN`.

| Field | Value |
|---|---|
| Homepage URL | anything |
| **Callback URL** | `<origin>/auth/callback` |
| **Setup URL** | `<origin>/auth/github/setup` |
| **Webhook URL** | `<origin>/webhooks/github` |

### Two settings that are hard requirements

**Request user authorization (OAuth) during installation → OFF.** Enabling it
removes the Setup URL field, and the Setup URL is the only place an installation
is bound to an organisation ([`http.ts:178-188`](../src/github/http.ts#L178)).
The post-install arrival would land on the Callback URL instead, where the
connect branch requires a transaction cookie that `startGitHubConnect` never
mints ([`server.ts:1660-1663`](../src/viz/server.ts#L1660)) — every connect
would fail as expired.

**Expire user authorization tokens → ENABLED** (GitHub's default; leave it
alone). With it off, GitHub returns no `expires_in` and no refresh token, and
`persistGitHubUserTokens` throws `GitHub user access token has no expiry`
([`tokens.ts:19-23`](../src/github/tokens.ts#L19)) on every connect callback.
That breaks the personal-account branch permanently, with a 502 and nothing
useful in the UI.

### Webhook

Set **Active**, give it the URL above, and set a secret — see step 2.

**Subscribe to no events.** The only two events the code handles are
`installation` and `installation_repositories`
([`webhook.ts:95`](../src/github/webhook.ts#L95)), and GitHub sends both to
every App by default; neither appears in the subscribe list. Every other event
is signature-checked, journaled and discarded, and a large `push` payload would
be refused at the 1 MiB ceiling and journaled as noise.

### Permissions

Three rows, all under **Repository permissions**. Nothing at organisation or
account level.

| Permission | Level | Why |
|---|---|---|
| **Administration** | Read and write | `POST /user/repos` and `POST /orgs/{org}/repos` — repository creation |
| **Contents** | Read and write | the blob/tree/commit/ref writes and the first-commit `PUT /contents/{path}` |
| **Metadata** | Read-only | `GET /repos/{owner}/{repo}`, the adoption read after a 422 |

Those first two are also requested in the installation-token body
(`GITHUB_PUBLISH_PERMISSIONS`,
[`client.ts:40-43`](../src/github/client.ts#L40)) and the token is refused
unless both were granted, so the checkbox set is fully determined.

**Leave Workflows at No access.** It looks conditionally needed — GitHub
requires it to write under `.github/workflows/` — but
`assertPublishableArtifactPath`
([`artifacts.ts:133-144`](../src/projects/artifacts.ts#L133)) rejects any such
path during manifest collection, before a single GitHub call, and its error
message names this permission. Granting it changes nothing until that policy
changes.

**Organization permissions: none.** Repository creation under an organisation is
governed by the *repository* Administration row, not an organisation one. If
creation is refused while Administration write is granted, the cause is an org
*setting* (Member privileges → Repository creation, or an App-installation
restriction) and the symptom is a **422** carrying
`repository creation was refused (HTTP 422)…`, not a 403.

**Account permissions: none.** One consequence to accept rather than a row to
grant: GitHub-logged-in principals will usually store `email = null`, so
`auth grant-admin --principal <email>` and `projects run --as <email>` will not
resolve them. Use principal ids.

Know what you are granting: **Administration write is the broadest permission in
the App** — on every repository the installation covers it also permits rename,
transfer, visibility change, deletion and ruleset edits. atoma uses it for
exactly one call per project. There is no narrower level that permits creation,
and a 403 on creation never reaches the adoption path, so it cannot be worked
around by pre-creating repositories.

### Where can this GitHub App be installed?

- **Any account** for a multi-tenant deployment: the store links one
  installation per organisation and guards against cross-org reuse, which only
  matters if unrelated accounts can install.
- **Only on this account** for a single-tenant or self-hosted one. Tighter and
  sufficient.

## 2. Collect the five values

Two of them GitHub never shows twice. Generate what you cannot read.

| Variable | Where it comes from |
|---|---|
| `ATOMA_GITHUB_APP_ID` | the App's General page, field **App ID** — always visible |
| `ATOMA_GITHUB_APP_SLUG` | the URL: `/settings/apps/<slug>` — always visible, lowercase |
| `ATOMA_GITHUB_APP_PRIVATE_KEY_PATH` | General → **Private keys** → *Generate a private key*, which downloads a `.pem` **once** |
| `ATOMA_GITHUB_WEBHOOK_SECRET` | you choose it; the field is write-only and GitHub never redisplays it |
| `ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY` | you generate it; it never reaches GitHub |

```bash
# webhook secret — paste the SAME value into GitHub's Webhook secret field
openssl rand -hex 32

# token encryption key — local only, never leaves the machine
openssl rand -hex 32

mkdir -p ~/.atoma
mv ~/Downloads/*.private-key.pem ~/.atoma/github-app.pem
chmod 600 ~/.atoma/github-app.pem
```

Then, in the checkout `.env`:

```bash
ATOMA_GITHUB_APP_ID=123456
ATOMA_GITHUB_APP_SLUG=your-app-slug
ATOMA_GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.atoma/github-app.pem
ATOMA_GITHUB_WEBHOOK_SECRET=<64 hex chars>
ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY=<64 hex chars>
```

Format rules the code enforces
([`config.ts`](../src/github/config.ts), [`secretCrypto.ts`](../src/core/secretCrypto.ts)):

- The private key must be **RSA, at least 2048 bits**. GitHub's is. Configure
  **exactly one** of `ATOMA_GITHUB_APP_PRIVATE_KEY` (inline PEM, `\n` escapes
  accepted) and `..._PATH` — both set, or neither, is refused.
- The webhook secret must be **at least 32 bytes**.
- The token encryption key must be **exactly 32 bytes**, written as 64 hex
  characters or 43 canonical base64url characters (an optional `base64url:`
  prefix is allowed). A passphrase is **not** accepted here — that form belongs
  to `ATOMA_SECRET_ENCRYPTION_KEY` alone.
- Optional: `ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY_ID` (otherwise derived from a
  hash of the key) and `ATOMA_GITHUB_API_URL` (HTTPS only, except loopback).

The config is **all or nothing**: any one of these variables being present
triggers the full snapshot, which throws on the rest, and that throw happens at
module scope — a half-configured App means the viz server does not start. Set
them together.

`.env` is read only by the source launchers (`npm run viz:dev`, `doctor:dev`,
`auth:dev`, `projects:dev`). Compiled `viz:serve` and `projects` take the
process environment.

## 3. Verify before connecting

```bash
npm run doctor:dev
```

The `GitHub App` check reports `configured · <slug> · <apiBaseUrl>` on success,
or the exact parse error. Note that `disabled` is reported as a **pass** — the
App is optional, so its absence is not a failure. It is quota-free and contacts
GitHub not at all.

## 4. Install it, and connect an organisation

1. Restart the visualizer and sign in.
2. Projects → **Connect GitHub**, which is `GET /auth/github/connect`. It
   requires `org:admin` or above on your active organisation, mints a
   short-lived state, and redirects you to the App's install page.
3. Install the App on the account or organisation that will own the
   repositories.
4. GitHub returns your browser to the Setup URL, which reads the installation
   with an App JWT and links it to your organisation.

**If the installation targets a personal account, choose "All repositories".**
The repository is created with a user-to-server token, and a repository outside
the installation's scope is unreachable by the installation token that drives
every write afterwards — so publication would fail immediately after a
successful creation. (GitHub documents the auto-add behaviour for App-created
repositories poorly; "All repositories" is correct either way, which is why it
is the recommendation.)

A reachable webhook URL is **not** required for any of this. Installations link,
projects are created, and artifacts publish with deliveries never arriving —
verified across the connect and publish paths, neither of which consults a
webhook fact. What you lose without one is status upkeep: an installation the
tenant later suspends or uninstalls stays `active` in the store, and the
staleness surfaces as a GitHub error mid-publish instead of a status the UI
could show. On a loopback origin GitHub cannot deliver anyway; the secret is
still mandatory *configuration*, it is simply never exercised.

## Recovery and rotation

- **Lost the `.pem`.** Generate a second private key. Both stay valid until you
  delete one, so this does not disturb another machine using the first.
- **Lost the webhook secret.** Overwrite it with a new one. Nothing else knows
  the old value — unless deliveries are actually flowing, in which case GitHub's
  field and `ATOMA_GITHUB_WEBHOOK_SECRET` must match.
- **Changing `ATOMA_GITHUB_TOKEN_ENCRYPTION_KEY` is not free.** The key id is
  derived from the key's own hash, so every stored envelope fails its binding
  check (`envelope does not match the requested binding`). Nothing is corrupted
  — it fails closed — but installations must be reconnected. Generate it once
  and keep it. If `ATOMA_SECRET_ENCRYPTION_KEY` is unset, this same key also
  wraps per-organisation provider keys.
- **Widening permissions on an App that already has installations.** Each
  installation must accept the new permissions at GitHub. Until it does, minting
  a publish token fails with an opaque HTTP 422 rather than a readable message.

## Symptoms

| What you see | Cause |
|---|---|
| `{"error":"GitHub App is not configured on this deployment."}` | none of the `ATOMA_GITHUB_*` variables are set, so the App runtime is null. The Projects screen offers the connect link regardless |
| the viz server will not start, GitHub error at boot | half-present config — set all five |
| `404 not found` on `/webhooks/github` | the auth gate is off, or the App is not configured |
| `401` on a webhook delivery | GitHub's secret and `ATOMA_GITHUB_WEBHOOK_SECRET` disagree |
| `GitHub webhook installation belongs to another App` | `ATOMA_GITHUB_APP_ID` names a different App than the one delivering |
| `GitHub user access token has no expiry` | *Expire user authorization tokens* is disabled on the App |
| `GitHub installation token lacks required publish permissions`, or an opaque 422 when minting a token | Administration and/or Contents write is not granted, or not yet accepted by the installation |
| `repository creation was refused (HTTP 422)` | an org setting forbids creation or that visibility, or the name is taken outside the installation's scope |
| publication fails on the first write after a successful creation | a personal-account installation scoped to selected repositories |

## A note for maintainers

`GITHUB_PUBLISH_PERMISSIONS` requests `administration: 'write'` on **every**
publish token, including incremental publications that only touch Contents, and
including the personal-account branch where the installation token creates
nothing. Narrowing that request to `contents` outside organisation repository
creation would cost nothing and remove deletion and transfer authority from the
common path. Not done; recorded here.
