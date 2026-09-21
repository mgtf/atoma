# Personal ChatGPT model discovery

Personal ChatGPT selectors use the connected account's Codex app-server
[`model/list`](https://learn.chatgpt.com/docs/app-server#models) inventory.
Atoma reads all pages and omits hidden entries. Discovery makes no inference
calls. This is the provider's reported availability, not a guarantee of quota
or of success for every subsequent request.

The service opens the exact private profile generation, through the existing
process budget and CODEX_HOME lease. It verifies ChatGPT authentication, limits
discovery to 30 seconds, and reaps the process before releasing its lease.
Only model metadata reaches the browser; account identity and credentials do not.

The in-memory cache lasts five minutes and separates principals and profile
generations. Concurrent reads share discovery. Settings offers manual refresh;
while a run is active it reads the cache without competing for the profile.
Failed refreshes retain explicitly stale models for display, not admission.

Storage accepts future personal model slugs so removed selections remain
readable. Settings validates changed personal selections against discovery;
unchanged removed selections can remain while other tiers are edited. Every
personal project run, including MCP runs, refreshes and validates its resolved
models before spawning. Failure does not fall through to another payer or model.

The launch passes discovered capabilities into the transport. The requested
slug is preserved exactly, and unsupported reasoning efforts use the model's
reported default (or omit the setting when none is supported).

Connecting an otherwise unconfigured account selects the provider's advertised
default for all tiers. Existing account, organisation and host choices are not
overwritten. If discovery fails or reports no default, the user chooses later
in Settings. Host subscriptions and API-key catalogues remain separate and
are outside this first implementation.

Verification covers pagination, malformed responses, account/generation cache
isolation, stale data, future slugs, launch refusal, exact transport model and
effort, and the Settings picker. Private-profile integration tests run on POSIX;
Windows remains a development host without personal-profile ACL support.
