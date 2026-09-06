# One MCP for everyone — decision record, 2026-09-05

Status: **decided and built.** The normative rules live in
[src/mcp/AGENTS.md](../src/mcp/AGENTS.md); this file is the reasoning and the
break with the earlier contract, so a later session does not re-derive either.

## What was decided

1. **One MCP, one transport.** atoma's MCP is served over Streamable HTTP on
   the viz server's `/mcp` route. The stdio server (`dist/mcp/stdio.js`,
   `npm run mcp`) is removed, not kept beside it.
2. **One catalogue, tiered by role.** The same tool names for every caller; a
   caller sees the tools its tier admits — `viewer`, `member`, `admin` for an
   organisation's roles, `platform` for the platform-admin flag and for the
   operator on the ungated loopback server. Visibility and execution read the
   same table.
3. **Identity is a bearer API token**, minted by a signed-in principal for one
   organisation (`/api/tokens`, or `npm run auth -- token`), stored hashed,
   listed secret-free, revocable, journaled at both ends. OAuth 2.1 is
   deferred, and the token path is shaped so an OAuth access token can later
   resolve the same way.

## Why the earlier contract is broken on purpose

The stdio-only rule was written when atoma was a framework run on the
operator's machine: the viz listened on a port the run itself could reach,
and a stdio server "had no socket the run was ever handed", which dissolved
the threat rather than mitigating it. That was the right argument for that
product.

The product moved. It is a deployed server with an authentication gate,
organisations, principals, a platform-admin flag, an audit journal, and a
project launcher that already starts runs over HTTP — behind identity,
org-scoped, journaled. The identity layer is what neutralises a reachable
port there, and it exists. Meanwhile the customers of that product plug agents
into it from their own machines, which a stdio process on the server cannot
serve at all. Keeping the rule would have meant a second, tenant-facing MCP
beside the operator's, two catalogues drifting, and a rule protecting a
threat model the product no longer has.

Checked before dropping stdio: its only consumers were the release smoke, the
README registration line, a test reading the entrypoint for its stdout guard,
and the docs. No product path launched it. The "run could reach the port"
concern on the ungated loopback path is real and unchanged — and a local run
can already shell out to the runner, so a loopback MCP adds no capability.
Host pinning (DNS-rebinding protection) is kept for the browser case.

## What it cost

- `release:check`: the compiled MCP is now proven THROUGH the compiled viz
  server (`scripts/release-smoke.mjs`), operator tier on loopback: tool list,
  a reader call, a refused traversal, prompts and a completion.
- The tool count in the README and the root `AGENTS.md` is derived from the
  catalogue (`scripts/repo-facts.mjs`) and is the WHOLE table across tiers.
- `tests/mcp-server.test.ts` keeps the run half (argv, lease, readers);
  `tests/mcp-http.test.ts` proves the transport, the tiers and the tokens
  through the real SDK client.
- Registered clients change one line: a URL and a header instead of a
  command. README and `docs/how-it-works.md` carry the new line.

## Not built, deliberately

- OAuth 2.1 for MCP clients (above).
- Org-admin invitations through the MCP: the web console has no org-admin
  invitation route either; the platform admin invites. Adding it is a product
  decision about who may grow an organisation, not an MCP one.
- Provider keys through the MCP: secrets do not travel through a tool call.
- ~~A Settings screen to mint tokens.~~ Built the same day: the "Connect your
  AI agent (MCP)" panel in Settings (`src/viz/client-gl/McpAccessPanel.tsx`)
  shows the address, the procedure, mints a token shown once with the exact
  Claude Code line, and lists and revokes the viewer's tokens.

## Settings connection and deployment troubleshooting

Settings registers a **Streamable HTTP client with a Bearer token**. It does
not perform OAuth for the MCP and a web session cookie cannot authenticate
that client. A client offering only an OAuth sign-in flow cannot use this
procedure. Select the organisation first, create one token per client, copy
it while shown, and configure the public `/mcp` URL in the client.

The Claude Code command is for a bash/zsh/WSL terminal on the user's machine,
uses private user scope, and quotes the URL and Authorization header as shell
arguments. Verify with `/mcp`, then ask for a read action such as listing
projects. Other clients need Streamable HTTP plus either an Authorization
header (`Bearer <token>`) or a dedicated Bearer field (token only). Never
commit the secret to shared client configuration. The command and verification
steps follow the [Claude Code MCP reference](https://code.claude.com/docs/en/mcp).

Failure cases have different remedies:

- **GET `/api/tokens` returns 404:** this route is present in the current API.
  Check that the web client and API are the same release and that the reverse
  proxy forwards `/api/tokens` to that API. Settings offers Retry and disables
  creation until discovery succeeds; an error is never presented as an empty
  token list. Token routes are independent of project-route registration.
- **Local mode without authentication:** GET returns `mode: operator`, an
  empty list and the API's loopback MCP URL. No token is required; POST/DELETE
  return 409. The client must run on the same machine. Gated discovery returns
  `mode: bearer` and the configured public origin, never the request's Host.
- **Initial `/mcp` returns 404:** check the complete URL and proxy routing.
  Vite forwards `/mcp`, preserving the public Host when authentication is on
  and using the API Host on loopback so MCP's Host check remains effective.
- **An established MCP session returns 404:** reconnect and initialize again;
  sessions are in memory and a restart or idle expiry forgets their IDs.
- **401/403:** check the token or current organisation role respectively.
  Revocation takes effect on the next MCP request. OAuth discovery errors
  require a client configured for Bearer authentication, not a website login.

A successful token mutation followed by a failed list refresh is reported as
such. The new token and URL remain copyable; a revoked entry stays removed.
Switching the active identity or organisation remounts MCP access and clears
the one-time secret. Last-used is evidence of valid token presentation, not
proof of a successful tool call.

Regression coverage includes the real Settings fetch lifecycle, the actual
HTTP token-create → MCP initialize/tool-list → revoke flow, and the compiled
operator discovery smoke. No external model request is needed for these checks.
