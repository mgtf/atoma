# Production run under the second account — 2026-09-21

Status: account unblocked with a model selection change; original rejection
cause remains unclassified.

The production MCP connection resolved to `mgtf2`, organisation owner without
platform-admin rights. A private build project, `SaaS validation September 21`,
was created through MCP (project `828f429a-7a5f-465e-a628-1c73580e025c`).

Run `1dba127d-7412-4f0a-88ff-f9d8e99055ea` requested a dependency-free Node
bookmarks API. It started at 2026-09-20T23:16:56.115Z and failed at
23:17:57.605Z, after 61.49 seconds, without an artifact manifest or publication.

The MCP trace reports:

- One successful planning call to `own:openai:gpt-5.6-terra`.
- Three rejected calls to `own:openai:gpt-5.4-mini`: two prefilter calls and
  one molecule planning call. Each reports `codex call failed [request-rejected]`.
- Four calls total; recorded subscription API-equivalent cost $0.0162, not
  evidence of an additional invoice.
- Organisation model defaults are null for all three tiers. Effective account
  pins and the underlying provider rejection detail were not retrieved.

Do not infer an outage or a model retirement from the generic error alone.
Next: inspect the requesting account's effective model selection and provider
rejection, correct the cause, then retry before proceeding to the planned
second scenario (a standalone interactive page). No second run was started.

## Recovery

After the owner requested a correction, Settings confirmed the personal pins
were Mini / Terra / Sol. Changed only the account's L1 pin to
`own:openai:gpt-5.6-terra`; the UI confirmed `Saved`. Organisation defaults,
host settings and other accounts were not changed. This is an operational
workaround, not proof that Mini is universally unavailable; the default model
catalogue still needs separate investigation before a platform-wide change.

Retry `b5e873f8-2f04-4f57-a159-ce31fb46968d` delivered the same API goal in
270.255 seconds, with eight recorded calls, zero refusals and one learned skill.
The artifact manifest contains `server.mjs` (2,538 bytes) and `README.md`
(932 bytes). Recorded subscription API-equivalent cost: $0.3207. The live
trace showed successful prefilter, L1 planning, execution and result validation,
including HTTP requests. GitHub publication was pending at the delivery receipt.

The second scenario was then started with idempotency key
`mgf2-validation-20260921-tasks-v1-terra`: a standalone task-list page.

Both recovery scenarios completed and were published to the private repository
`https://github.com/mgtf2/atoma-saas-validation-20260921`:

- API: commit `309ed77e8f8c4565b7cf3b28f41035a08b710d11`.
- Task list: run `fd557ba9-80fa-43bb-9bf4-bedfeb6c45c6`, delivered in
  800.864 seconds, 16 recorded calls, zero refusals and $1.0007 subscription
  API-equivalent cost. Commit `291dd635c00eccce602ff68cfa3434b513d5f580`.
  Its manifest adds `index.html` (4,754 bytes) and retains the API files.

The second start call exceeded the MCP client's 300-second wait; the server
continued the same run to completion, observed through status/trace readers.
No duplicate retry was submitted. Its repeated browser checks account for a
long live verification phase worth analysing separately. These delivery and
publication results are the platform's receipts, not a separate manual audit
of every application interaction.
