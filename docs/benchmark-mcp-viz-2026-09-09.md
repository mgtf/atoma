# Registered benchmarks in the current visualizer

Platform administrators can run a pre-registered retrieval campaign through
`atoma_benchmark_start` on the existing `/mcp` endpoint. Its attempts appear
in **Runs**, alongside the project runs the administrator can already read.
Ordinary organisation members cannot list or open benchmark traces.

## Local workflow

1. Finish source changes and checks, commit the runtime, and build a dedicated
   worker image. Keep the analyst disabled during a campaign and ensure the
   machine-global run lease is free. Do not rebuild or edit source mid-campaign.
2. Prepare a development specification using the existing retrieval protocol:
   fixed questions, balanced schedule, model selectors, image digest, time
   budgets, thresholds, treatment and executable scorers.
3. Register it before executing models:
   `npm run benchmark -- retrieval register --spec <spec.json> --out <registration.json>`.
4. Restart the local viz backend after installing this integration. Connect
   the MCP client to its usual `/mcp` URL using its existing authentication.
5. Call `atoma_benchmark_start` with `{ "registration": <registration object> }`
   using MCP task augmentation. `tasks/get` reports the current attempt, arm
   and trace id; `tasks/result` returns the campaign report. `tasks/cancel`
   aborts the campaign through the shared runner's termination path. A client
   without task support receives the terminal report over the same SSE call.
6. Open **Runs** in the existing viz. The list labels each attempt with its
   campaign, question and arm. `frontier-direct` is the real single frontier
   reference agent in the shared runner, with the registered sandbox, tools,
   budgets and accounting. It is not an Atoma hierarchy instructed to act alone.
7. Preserve the complete archive, replay the executable scorers and record
   the results. A runner's success label is not an evaluation score.

## Boundaries

The MCP delegates to `runRetrievalCampaign`; it does not implement another
agent loop or change the registered experiment. The dataset is fixed to
`benchmark/retrieval` in the host checkout. Output goes to
`<runs-dir>/benchmarks/<campaign-id>` and an existing output directory is
refused. Starting requires the committed matching source checkout and local
benchmark dependencies; this is development tooling, not a packaged
production benchmark execution contract.

Each attempt retains its synthetic authority, database, skills, workspace,
logs and trace. No product project is created, published or altered, and
mandatory retrieval for ordinary project runs is unchanged. The host-owned
start receipt locates the original trace inside that attempt. The derived
reader rejects escaping paths and symlinks, bounds receipt bytes and scans
at most 1,000 campaign directories and 200 attempts per campaign. Move older
archives out of the live corpus after preserving them before reaching that
operational limit.

Index labels are projections; raw traces are served unchanged through the
existing bounded detail/delta route. The existing Runs polling follows live
traces. A restart forgets MCP task ids but preserves all archive files and
trace access. Disconnecting a client leaves the campaign running. A generic
server exit signals its active child group and retains the global lease for
safe stale recovery; it never releases the slot while a child may survive.

Campaign reports and individual scorer results live in the archive; this
integration adds live trace access, not a benchmark results dashboard. Small
development campaigns remain screening evidence, not proof of production
benefit.
