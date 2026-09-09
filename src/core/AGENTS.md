# Core — AGENTS.md

`src/core/` owns the LLM client and its transports, model and tier resolution,
the cost formula, the product store, the ledger, metrics and limits.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — the call sites
- [`src/run`](../run/AGENTS.md) — provider construction and tier pins
- [`src/viz`](../viz/AGENTS.md) — the consumer of what metrics record

## LLM interaction conventions

- Every call goes through `LlmClient`; never call a provider SDK from atoms.
- A model is always a full selector `<api|sub|own>:<vendor>:<model>`
  (`src/contracts/modelSelector.ts`, the ONLY parser; the third segment keeps
  its colons for Ollama tags). `modelForTier` in `src/core/models.ts` reads the
  three REQUIRED `ATOMA_MODEL_L*` pins — there is no default and no base
  provider since 2026-09-07 — accepts an optional env, and throws
  `ModelSelectorError` naming the variable. `applyTierPins` is how a snapshot
  reaches the default (`process.env`) call sites; a missing pin is deleted on
  the target, not left as leftover ambient state.
- `RoutingLlmClient` maps a selector's TRANSPORT (`transportOf`) to the one
  client built for it and hands the transport the bare model id; it has no
  default client. Record both requested and served model so cost attribution
  follows the actual transport.
- `OpenAiLlmClient` (`api:openai`) is the Responses API with function tools:
  the same loop contract as the Anthropic client, admissible on every tier.
  `sub:openai`/`own:openai` stay on the Codex CLI on all three tiers.
  Tool-bearing requests use `codexToolLoop`: a strict JSON action protocol
  over isolated text completions. Only declared names reach `req.executor`;
  results are observed before model-facing truncation. A finite tool budget
  permits one finalization, which cannot execute tools. Abort and partial
  usage propagate across the complete loop. No Codex-native tools are enabled.
  Acceptance evidence: [codex-all-tiers-2026-09-08](../../docs/incidents/codex-all-tiers-2026-09-08.md).
- Effort settings belong on strategy calls only. Validators and prefilters are
  deterministic and cheap.
- A transport cannot outlive its deadline. Keep both per-call abort and outer
  watchdog guards, clean abort listeners in `finally`, and account partial usage
  when a provider exposes it. Tool-loop iteration caps shrink against
  remaining wall clock via `capToolIterations` / `ctx.deadlineAt` (26 s
  floor from the 2026-08-16 fan-in measurement) so one phase cannot
  *plan* more iterations than the run can still pay.
- A Claude CLI tool-budget exhaustion gets one finalization in that query's
  own session, with tools and MCP servers disabled. Both queries' usage is
  retained, including when finalization fails; finalization never recurses.
- Claude CLI and Codex CLI transports run with user tools/config isolated.
  Project `.claude/settings.json` never grants shell permission; personal grants
  belong in ignored local settings. Codex MCP registration is local too. A
  principal Codex transport receives an allowlisted environment snapshot and a
  strict root-deny/workspace-read-only permission profile; provider keys and
  every other principal's profile stay outside the child. Both login and run
  force file-backed auth in that exact `CODEX_HOME`; never allow `auto` to move
  a refresh into the service account's shared keyring. The text-only transport
  explicitly disables Apps, plugins, browser/computer, image, skill and
  delegated-agent capabilities in addition to shell and network access;
  `--strict-config` must fail closed when a Codex upgrade renames one. Every
  Codex child lifetime is serialized by its canonical `CODEX_HOME`; the CLI
  may rotate `auth.json` even when calls are otherwise independent. The shared
  lease is both FIFO in-process and SQLite-backed across processes, and remains
  held through actual child reap after timeout or cancellation.
- Do not confuse interactive Codex with the Codex transport. The transport uses
  explicit safe flags and never inherits the interactive agent's tools.
- Auth checks must match the selected transport without leaking credentials.

## Cost accounting

- Anthropic tool loops keep one rolling cache breakpoint: clear the prior
  marker before marking the latest tool result. Never exceed four breakpoints.
- `estimateCostUsd` is the only cost formula. Anthropic input, cache-read, and
  cache-creation counters are disjoint; never subtract one from another.
- Accounting follows the SERVED model, not the tier pin: transports that
  rewrite the model (codex slug mapping, ollama collapse, claude-cli aliases)
  report `servedModel` on the response, and metrics/recording price
  `servedModel ?? req.model`. The pin stays the routing identity in events.
- Errors keep their paid tokens on EVERY transport: a throw from a tool loop
  carries `partialUsage`, and both observability layers read it — the trace
  and the CSV must never disagree about one call's cost.

## Ledger

- Ledger writes are fail-open for run execution but attributable and ordered.
  A ledger failure cannot take down the product; impossible counter directions
  must be surfaced by `ledger check`.

## Metrics and traces

- `InMemoryMetrics` and `MetricsLlmClient` wrap calls; traces record requested
  model, served model, usage, cost, cache, decisions, and tool actions.
- `RecordingLlmClient` preserves partial and failed attempts. A failure after
  usage is still billable evidence.
- The lifecycle ledger is attributable; registry events distinguish initiator
  from target. Cache hits have their own event kind.

## Proof attestation

- `forkBranch` wraps `ctx.tools` per branch (mirroring how it wraps `ctx.llm`)
  and appends transport-observed observations to ONE run-scoped log shared by
  reference across every fork. Branch identity comes from the wrapper the fork
  created; never from an ambient "current actor", which races the moment two
  lanes run at once.
- `attestingExecutor` UNWRAPS before wrapping (`baseExecutorOf`). A nested fork
  that stacked wrappers would append one call under every ancestor branch, and
  coverage would then find an observation in a branch that never made it.
- The attestation is a CORRECTNESS path and the trace is an OBSERVABILITY one,
  on the same seam: a failed attestation degrades the observation to unattested
  and says so, a failed recording is swallowed. Neither ever fails a tool call.
- The log is memory only. It is not a store, and cross-run proof reuse is out
  of scope by construction.

## Intentional choices and rejected shortcuts

- `DEFAULT_LIMITS.maxExecIterations` and its comparison are pinned by tests;
  change semantics only with an explicit migration of the effective budget.
