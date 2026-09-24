# MCP browser authorization

Atoma acts as both the OAuth authorization server and the resource server for
its canonical `/mcp` URL. The existing GitHub/Google/ChatGPT web login proves
identity; its upstream credentials are never passed through to an MCP client.
OAuth is available only on an authenticated deployment, using its configured
public origin. The local ungated MCP remains unchanged.

## Client connection

Register the URL in Codex, then use `codex mcp login atoma` or the client's
OAuth authentication control. Remove any configured bearer environment variable
or static Authorization header when migrating: explicit credentials take precedence.
The browser signs into Atoma if needed, then displays the requesting client,
account, active organisation, return address and permission implications. The user
must explicitly approve. Denial returns `access_denied` with the client's state.

Use **Use another account** on that page to sign this browser out of Atoma,
choose a provider account, and return to a new consent page. The original
request is invalidated; switching neither grants access nor revokes existing
MCP connections. The new consent shows the account's provider identity,
organisation and role. The original expiry and client callback are preserved.
The provider receives `prompt=select_account` to request its account picker
([GitHub documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).

The client name is self-declared, not a verified brand. Consent includes the
caller's current MCP rights, including platform administration when applicable.
Changing active organisation does not move an already-issued grant. Revocation
is available in the existing MCP token list as `OAuth: <client>` and through the
OAuth revocation endpoint. Membership and platform flags are resolved on every
MCP request, exactly as for manually minted API tokens.

## Diagnosing a run through MCP

`atoma_run_trace` accepts the project `runId` (or an operator `file` at the
platform tier). Its default summary pages events with `offset`, `limit` and
`nextOffset`, including recorded durations, acceptance decisions and excerpts.
For the evidence behind those summaries, use the same tool:

- `section: "metadata"`: all persisted top-level trace fields except events,
  including the task, final error/result, attestations and execution provenance.
- `section: "event", eventId: "<id from summary>"`: the complete event,
  including prompts, responses, validation reasons, tool arguments/results,
  usage and durations when recorded.
- `section: "log"`: the project runner log, even before a trace exists.
  This section requires `runId`, not an operator filename.

Detail replies contain JSON-encoded `text`, a `snapshot` hash and
`nextTextOffset`. Concatenate successive text pages, passing the returned
`nextTextOffset` as `textOffset` and the same `snapshot`, then parse the joined
JSON. Offsets count UTF-16 code units. Pages default to 12,000 characters and
cap at 24,000; nothing is silently truncated. If `changed: true` is returned,
restart at offset zero because the selected evidence changed during the read.
Missing/expired files and files beyond the shared trace read ceiling are
reported explicitly. The normal organisation and platform read permissions
apply to every section; all model-authored content remains untrusted data.

New traces record the executable release's `REVISION` receipt, or the exact
checkout's Git HEAD and dirty state during development, plus the Node runtime
and platform. A missing receipt/checkout is unknown. Old traces are never
backfilled with the revision of the server reading them today. Provenance
identifies the runner, not the generated application's publication commit.

## Wire contract

- `/.well-known/oauth-protected-resource/mcp` (also root fallback): resource,
  authorization server and the `mcp` scope. Unauthenticated `/mcp` responses
  include this URL in `WWW-Authenticate`.
- `/.well-known/oauth-authorization-server`: endpoints, public-client
  authentication (`none`), authorization code/refresh grants, S256 and issuer
  identification in the authorization response.
- `/oauth/register`: bounded RFC 7591 public-client registration, HTTPS or HTTP
  loopback redirects, no wildcard matching. Registration lasts 90 days.
  Client metadata URL fetching is not advertised; Codex can use DCR.
- `/oauth/authorize`: code flow only, exact registered redirect, S256 PKCE,
  canonical resource, optional `mcp` scope. Five-minute pending requests; a
  same-origin consent POST is bound to the displayed browser session and org.
- `/oauth/token`: form-encoded exchange or refresh, bound to client and resource.
  Codes last five minutes; access tokens one hour; refresh authorization 30 days
  absolutely. A refresh rotates both credentials. Reuse of a correctly bound
  redeemed code or refresh token revokes the grant.
- `/oauth/revoke`: RFC 7009, client-bound access or refresh token, generic success
  for unknown credentials. Existing Settings/CLI revocation also blocks refresh.

Redirect targets are never fetched by the server. Metadata uses the configured
origin, never forwarded request headers. Browser consent sends no cross-origin referrer and
cannot be framed. Its form policy permits the registered callback origin so a
desktop client's separate loopback port can receive the consent redirect.
Protocol bodies, registrations, pending requests and public
request rates are bounded. Stateful authorization GETs observe deployment drain.

## Persistence and verification

`auth_mcp_clients`, `auth_mcp_codes`, `auth_mcp_grants` and `auth_mcp_refresh`
are additive tables in the primary SQLite store. The existing `auth_api_tokens`
row owns each grant and its revocation. Only hashes of codes/access/refresh
credentials persist. Consumed refresh hashes remain until grant expiry or
revocation so replay can revoke the current generation. The existing auth sweep
prunes expired protocol state. No new secret-encryption key or product store is
required. Existing API tokens retain their current behavior.

Wire tests exercise consent, client/resource/PKCE binding, replay, rotation,
expiry, live roles and revocation. The process-level auth test follows upstream
login back to consent; the auth release smoke exchanges OAuth credentials and
calls a real MCP reader on the compiled server. `npm run viz:smoke` also submits
the real consent form in Chrome and exchanges its code, verifying browser Origin
behavior. No test starts a paid run.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591),
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009),
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
