# ChatGPT subscriptions on all three tiers

The owner requested L1, L2 and L3 on ChatGPT, without a separately billed API
tier. The previous refusal was in Atoma's transport: Codex completed text but
had no bridge into the scoped executor. Platform-admin status could not remove
that structural limitation.

## Implementation boundary

`codexToolLoop` exchanges schema-constrained JSON actions with the existing
isolated Codex text transport. Each action either names one declared Atoma
tool with JSON arguments or contains the final response as text. The host
checks scope and dispatches through the original executor, retaining its
sandbox, attestation and trace wrappers. Native Codex tools, user configuration,
MCP servers and direct workspace access stay disabled. The Codex working
directory remains the empty read-only jail, not the deliverable directory.

The CLI receives `--output-schema` with a temporary schema alongside its
instruction file. Both files are cleaned up. A finite action budget permits
one finalization; a tool request on that finalization is refused without
execution. The observer receives raw results, while the model transcript uses
the shared result truncation. Usage accumulates across action rounds and is
attached to failures. Existing profile leases and payer checks remain in force.

Both host and personal ChatGPT families now admit L1 in the catalogue, stored
account pins and launcher. Subscriptions remain account-only on hosted runs:
platform-admin plus the declared organisation for the host login, or the exact
requesting principal's private profile for a personal login. No API fallback
is introduced. An old failed run keeps its original error message.

## Evidence and limits

- An initial unconstrained JSON smoke failed to conform to the action protocol.
  The strict CLI output schema closed that failure; the parser still refuses
  malformed actions and arguments rather than executing guessed commands.
- A real ChatGPT/Codex smoke wrote an unpredictable UUID through `write_file`,
  read it through `read_file`, and returned the observed contents. Independent
  disk inspection matched the UUID. Model: `gpt-5.4-mini`.
- The first full compiled run, `2026-09-07T21-49-25-688-502b2f34`, used Mini
  on L1, Terra on L2 and Sol on L3. It wrote the correct artifact but exhausted
  its 360-second budget during a validation repair. It is retained as failed,
  not counted as a delivery.
- The second full compiled run, `2026-09-07T21-56-14-175-a31f47e7`, used Terra
  on L1/L2 and Sol on L3 with a fresh registry and skills directory. It delivered
  in nine recorded LLM calls, with no escalation. All recorded model calls used
  `sub:openai`. API keys were removed from the run environment. A separate JSON
  parser verified the exact delivered object on disk.
- `release:check` passed: 3,509 tests, 12 skipped, audit, compiled build, MCP and
  authentication smokes. Tests retain scope rejection, cancellation, budget
  finalization, usage, profile isolation and account-versus-host payer checks.

Local evidence is in `/private/tmp/atoma-codex-all-*.log` and the isolated
`/private/tmp/atoma-codex-all-run-*` directories. These are feature acceptance
exercises, not a controlled performance benchmark. Each action starts a new
isolated completion and sends the accumulated bounded-result transcript;
latency and subscription consumption can exceed a native function-tool loop.
The full trial is a small JSON artifact, not proof of broad app-building
reliability.
