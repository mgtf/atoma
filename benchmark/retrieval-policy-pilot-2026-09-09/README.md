# Retrieval invocation policy pilot, 2026-09-09

The completed comparison consists of two pre-registered campaigns on committed
source `8ec0d4e`, each with one repetition of development question
`northstar-13`, a 600-second attempt budget, fresh state, the same models and
the same worker digest. Five of six attempts passed all unchanged scorers.
Every attempt passed the pricing maintenance checks; one control failed an
exact source citation. No attempt timed out.

## Results

`available` campaign, in execution order:

- Agentic Atoma: **453.693 s; USD 0.3470; 16 LLM completions; failed**.
  The refund value and quote were correct, but its citation named line 12
  instead of line 13. Run `6d36422d-a596-471f-86f5-0a7d132918f5`.
- Atoma with Haystack available: **438.798 s; USD 0.2956; 14 completions;
  passed**. Run `1b200c59-167a-46ab-a70a-135f2668437a`.
- Single frontier reference: **129.796 s; USD 0.7520; one completion;
  passed**. Run `3e07867b-1e46-43bd-b48b-2e79fa5ecb71`.

`search-first` campaign, in execution order:

- Single frontier reference: **128.717 s; USD 0.4463; one completion;
  passed**. Run `a486c90b-fbb5-42de-b32e-b2621cb7e023`.
- Atoma instructed to search first: **303.300 s; USD 0.3666; 22 completions;
  passed**. Run `242227ef-a696-4ae3-8c5c-5bfa813f082b`.
- Agentic Atoma: **207.903 s; USD 0.2914; 14 completions; passed**.
  Run `bc0d3596-c4b1-43f3-969d-1161589b1f48`.

Amounts are subscription price equivalents computed by the existing accounting
authority, including cache usage, rounded here to four decimals. They are not
additional API charges and exclude subscription fees, local computation and
amortized index costs. The six trace totals sum to USD 2.49883855; paid API
spend is zero. Full-precision receipts are in the replay outputs. Cache state
is uncontrolled, so different trajectories can have substantially different
prices even at similar elapsed times.

## What Haystack actually did

Both Haystack arms made **two successful searches**, returned ten passages
in total, and covered all three expected facts. No returned source passage
failed the byte/digest checks. Both searches in both arms were executed by an
L1 molecule, `CarbonDioxide`.

With availability alone, the first tool read `CORPUS.json`, then the agent
searched before reading the source documents or modifying files. With the
search-first instruction, the very first tool was `search_project_docs`.
Thus both trajectories searched before source reads; the instruction changed
the first-tool ordering in this sample, not an absence of retrieval into use.
The earlier maintenance run that omitted retrieval remains separate evidence.

The search-first arm encountered one direct `git` allowlist refusal and
recovered. The refusal is preserved in the trace. `git` was not added to the
allowlist. The user-requested `sha256sum` addition was tested through the
compiled worker using the known digest of `abc`, alongside allowed external
egress and blocked control-plane access. The worker smoke log is included.

The search-first Haystack trajectory was faster but more expensive than the
available Haystack trajectory. Its own agentic control was faster and cheaper
while also passing. One selected question, one repetition per policy,
sequential campaign ordering and uncontrolled cache state do not establish a
causal efficiency benefit or production reliability. This is an instruction
experiment, not automatic runtime retrieval: future instruction adherence is
not guaranteed. The held-out corpus remains unused. A machine screening
decision from one paired question is not an adoption recommendation.

## Interrupted campaign and source isolation

An initial `available` campaign completed two attempts before the source
identity guard detected unrelated GPU source edits and refused to start the
frontier reference. Those two attempts both passed: Atoma took 225.409 s for
USD 0.4210 and Haystack took 284.641 s for USD 0.4477. They are archived under
`interrupted/`, **excluded from the completed comparison**, and the matching
initial search-first registration was never executed. Original protocols are
preserved under `original-protocols/`. Do not silently pool these attempts.

The completed campaigns used a detached worktree at
`/private/tmp/atoma-policy-frozen-20260909`, pinned to `8ec0d4e`. A temporary,
authenticated MCP server on port 4112 used that source and wrote into the
existing viz's run corpus. The regular viz on port 5173 remained available;
unrelated working-tree changes were preserved. A first connection was refused
because the temporary server still declared the regular viz origin; its local
origin was corrected before any isolated attempt started. Permission review
timeouts delayed startup/cleanup but did not change any run budget or result.

Completed MCP tasks:

- Available: `b122a4ba5af2599f011ed0d4a309087a`.
- Search-first: `b598213509aa5a081f0116d97e351853`.

The temporary MCP was stopped after completion and the global run lease was
empty. Original traces remain visible in Runs under campaign names
`haystack-mcp-policy-available-isolated-20260909` and
`haystack-mcp-policy-search-first-isolated-20260909`.

## Verification and replay

Before model execution, `release:check` passed: 3,845 tests, 16 skipped,
typechecking, lint, documentation checks, dependency audit, build and compiled
smokes. The dedicated worker was rebuilt and its real container smoke passed.
Logs are included. Worker digest:
`sha256:81632bc7a3b74509e911c9169bbb0a104867acd30ecc6db74bcaa526a8d28ea8`.

Each `evidence.tar.gz` contains the source snapshot, frozen instruments,
workspaces, logs, raw traces and starting/ending databases. Fresh extractions
reproduced all scores, runner receipts and retrieval observations, including
the interrupted campaign. `replay.mjs` additionally reports the first search,
first source read/write, search actors and recovered tool errors. macOS
AppleDouble metadata is ignored when enumerating attempt directories; actual
attempt counts and receipts are still checked. No bearer token is archived.

From the repository with its pinned Node and installed dependencies:

```bash
cd benchmark/retrieval-policy-pilot-2026-09-09
shasum -a 256 -c SHA256SUMS
mkdir /tmp/atoma-policy-replay
tar -xzf search-first/evidence.tar.gz -C /tmp/atoma-policy-replay
cd ../..
node --import tsx benchmark/retrieval-policy-pilot-2026-09-09/replay.mjs /tmp/atoma-policy-replay
```
