# Haystack in the shared agent runner

Date: 2026-09-09. Experimental development comparison; no rollout decision.

**Subsequent simplification:** [Haystack is now the only product retrieval backend](project-retrieval-haystack-only-2026-09-09.md).
Source preparation no longer builds FTS5, and normal retrieval-enabled
coordinators require and forward explicit Haystack configuration. The pilot
description below records the exact earlier implementation that was measured.

## Change

A `haystack-development` campaign now compares ordinary Atoma (A), Atoma
with local Haystack retrieval (B), and the existing frontier-direct reference
(C). It reuses the registered campaign driver, synthetic tenant authority,
`spawnRun`, `startTask`, isolated worker, global run lease, source archiving,
accounting and unchanged executable scorers. Existing BM25 registrations keep
their original arm names, settings and policy.

The host-only `ATOMA_PROJECT_RETRIEVAL_HAYSTACK` JSON configuration contains
an absolute Python executable, Haystack settings and the SHA-256 of installed
Python runtime/package metadata. It is only admitted with the existing tenant
retrieval receipt and isolation/lifecycle checks. The benchmark injects it into
B after constructing the project environment; ordinary coordinator launches
still select FTS5. Model arguments, user goals and workers cannot set it.

Preflight resolves the same read-only source receipt and authority. Python
starts after `startTask` owns its teardown, trace and watchdog, before the first
model call. Preparation therefore consumes the same attempt budget, and a
preparation failure leaves a stopped trace with an `error` accounting epilogue
and zero model calls. The benchmark classifies it as infrastructure failure.
The source receipt currently also builds its small FTS cache; that cost is
included rather than hidden. A future receipt/cache split is not part of this
experiment.

The framework uses the already archived immutable source, never the live worker
workspace. Query authorization is still checked before and after delivery.
Shutdown cancels initialization and queries, then reaps Python. A dedicated
stdin reader exits Python on host EOF even when model computation is busy, so
an abruptly killed host does not leave a detached runtime working indefinitely.
Runtime identity is checked in preflight and on actual Python startup; model
content pins are checked before loading. No telemetry or paid retrieval API
is enabled, and model downloads remain an explicit setup action.

## Registered pilot design

Use `northstar-05` and `northstar-13`, one repetition in A/B/C then C/B/A order.
The first is a French refund-window question selected because the earlier
component screen recovered its evidence only with hybrid retrieval at five
passages. The second requires the maintenance artifact plus cited answers and
was a failure case in the prior agent pilot. This is a disclosed development
selection, not a held-out sample. Do not run the Orchard family.

Use the previous tier selectors: Haiku L1, Sonnet L2, Opus L3 and frontier,
all `sub:anthropic`. Each attempt has 180 seconds including preparation; the
six-attempt campaign has a 1,200-second cap. Learning, promotion, direct
execution, event skills and prefilter caching stay disabled. The worker uses
no egress. No model change, citation shortcut, new detector, larger tool budget
or scorer relaxation is included.

The shared screen requires a paired full-pass gain of at least 0.5 and total
B/A elapsed-time and subscription-price-equivalent ratios at most 1.25.
Incomplete accounting or any infrastructure failure makes it inconclusive.
Success would justify a new confirmation experiment only. The host subscription
permission continues the owner's existing choice; no API-funded transport is
selected. Subscription price equivalents are not an incremental API invoice.

## Prior failures and interpretation

The prior pilot's real harness persistence defects are already corrected and
covered by regression tests. Its remaining wrong citations and unfinished
maintenance artifacts are measured task failures. There is no runtime exception
to repair by weakening their requirements. This comparison asks whether the
retrieval treatment changes those outcomes under the existing budgets; it does
not presume that retrieval fixes downstream assembly.

Current framework weights remain the compact BGE-small and MiniLM references
from the component experiment. The full registration must include their actual
content hashes, the Python/package identity, source revision, instrument lock
and worker image digest before execution. The original failed tasks and the
component observations remain preserved independently.

## Verification and operation

Unit/integration tests exercise receipt admission, balanced arm selection,
controls without Haystack settings, the real runner's successful/failed warmup,
zero model calls on warmup failure, cancellation/reaping and original citations.
Optional tests exercise real Python and offline models. The existing compiled
`scripts/retrieval-project-smoke.mjs --container --haystack` also tests live
revocation and proves that neither source paths, store paths nor Haystack
configuration enter the real worker. Its explicit test environment provides
`ATOMA_PROJECT_RETRIEVAL_HAYSTACK` and optionally a pinned
`ATOMA_RETRIEVAL_SMOKE_IMAGE`.

Register and execute with the existing CLI:

```bash
npm run benchmark -- retrieval register --spec /absolute/pilot-spec.json --out /absolute/new-registration.json
npm run benchmark -- retrieval inspect --registration /absolute/new-registration.json
npm run benchmark -- retrieval run --registration /absolute/new-registration.json --out /absolute/new-evidence-directory
```

Only `run` consumes model quota. Save every attempt, stopped trace, initial and
final store, executable score and accounting before interpreting the screen.

## Completed development pilot

The [six-attempt report and replayable archive](../benchmark/retrieval-haystack-agent-pilot-2026-09-09/README.md)
record A 0/2, B 0/2 and C 1/2 full tasks, with no infrastructure failure.
The pre-registered benefit screen was not met. Haystack's one search returned
the required evidence, but its final citation used the wrong line number.
The maintenance treatment did not invoke retrieval; all three maintenance
attempts made the correct change without delivering the required cited answer.
The framework remains experimental pending downstream completion work and
new evidence. All scores and the paired decision reproduced offline from a
fresh extraction; no additional model calls or scorer changes were needed.
