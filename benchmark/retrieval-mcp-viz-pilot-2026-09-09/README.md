# Retrieval diagnostic through MCP and the existing viz

Six pre-registered development attempts ran on 2026-09-09 through
`atoma_benchmark_start` on the existing authenticated local visualizer.
The campaign completed; full task success was **A 0/2, B 0/2, C 1/2**.
The unchanged executable scorers reproduced every recorded result from a
fresh extraction of the archive. This does not establish a Haystack benefit.

## Protocol and visibility

- Source: `84ecdade4f8ea4e76442cf473ace9b9253c03595`.
- Campaign: `haystack-mcp-diagnostic-20260909`.
- MCP task: `5e951fd62e5e88501a384a53479fd47e`, completed.
- Two correlated Northstar development questions, `northstar-05` and
  `northstar-13`, one repetition each; Orchard remained held out.
- Schedule: A/B/C on the first question, C/B/A on the maintenance question.
  A is agentic Atoma; B is Atoma with local hybrid Haystack; C is the real
  single frontier agent in the same runner and sandbox.
- Registered selectors: L1 `sub:anthropic:haiku`, L2 `sub:anthropic:sonnet`,
  L3 and reference `sub:anthropic:opus`. Existing inexpensive prefilter and
  validator routing remains unchanged; observed served models are recorded
  per attempt in `replay-results.json`.
- Per-attempt limit 180,000 ms; campaign limit 1,200,000 ms; trust/promotion/
  demotion thresholds 3/3/2. Fresh synthetic tenant authorities, registry and
  skills per attempt; no learning, promotion, direct skills, event skills or
  prefilter cache; container execution without egress.
- The dedicated worker digest and the runtime/model content pins are in
  `registration.json`. Its build log is included.
- MCP task window: 12:28:57–12:41:57 UTC. Original traces remain under
  `runs/benchmarks/haystack-mcp-diagnostic-20260909` for the platform admin's
  Runs view. No product project rows or publications were created.

The integration adds a platform-only MCP task and a derived trace index. It
does not modify the experiment, the scorers, the agent loop or the reference
agent. It also repairs the live projection for indexes rebuilt from traces
and the client poll that previously retained the last live row at completion.

## Observations, in execution order

1. **A / northstar-05**, `50568847-769e-439b-8ef3-5d1f446fae38`:
   runner failed at the deadline, 183.268 s. The answer file passed every
   scorer, including exact citations. The trace shows an additional planned
   verification script, tool-budget exhaustion before its execution, a
   rejected result and a retry. Correct artifact production did not imply
   successful finalization.
2. **B / northstar-05**, `4711d301-e8f1-47d8-adb8-972427328ff9`:
   runner failed at the deadline, 183.744 s. The required answer file was
   absent. The single retrieval call succeeded, returned five source-valid
   passages, and covered the expected refund fact.
3. **C / northstar-05**, `01a96bbb-5aac-44bb-8022-a5794d12220c`:
   delivered and passed all scorers, 58.654 s.
4. **C / northstar-13**, `dd1142d3-cb5b-43ce-95dc-67e66a5d4dba`:
   delivered, 46.650 s. The maintenance behavior passed, but the required
   answer file was absent, so full success was false.
5. **B / northstar-13**, `5afa4a73-a20f-4793-bc04-8446fcc21525`:
   delivered, 121.636 s. All fact values and maintenance behavior passed;
   all three citations failed. Their hashes and quoted source text were
   correct, but the model wrote line numbers one too low: annual price 5
   instead of 6, monthly price 4 instead of 5, refund 12 instead of 13.
   The retrieval call itself returned five source-valid passages covering all
   three facts. Retrieval validity and final citation validity are separate.
6. **A / northstar-13**, `05b089ed-000a-4893-bc8d-96f090cf1531`:
   runner failed at the deadline, 181.496 s. Maintenance behavior passed,
   but the answer schema check failed.

The harness reported zero infrastructure failures. Both B retrieval calls
succeeded with zero invalid source passages. That is evidence that retrieval
ran, not evidence of full task success. Delivery banners did not override
failed scorers, including for the reference agent.

The runner recorded 80 LLM completions and USD 1.5363 subscription price
equivalent; recorded paid API spend is zero. Timed-out CLI calls can lack
complete usage, so this is recorded accounting, not a complete spend estimate.
The machine report's lower B/A time and price ratios must not be presented as
an efficiency gain: neither arm passed a full task, three attempts reached
their deadline, and the sample has only two correlated questions. The
pre-registered screen was not met. No cross-round ratio or causal claim about
the visibility change is made.

## Evidence and reproduction

`evidence.tar.gz` contains the source archive, dataset, registrations,
per-attempt starting/ending state, workspaces, traces, logs and score results.
The top-level JSON files make the protocol and report readable without
extraction. `mcp-client.log`, `mcp-task.json` and `mcp-result.json` preserve
the task lifecycle without a bearer token.

From the repository with its pinned Node and dependencies:

```bash
cd benchmark/retrieval-mcp-viz-pilot-2026-09-09
shasum -a 256 -c SHA256SUMS
mkdir /tmp/atoma-mcp-replay
tar -xzf evidence.tar.gz -C /tmp/atoma-mcp-replay
cd ../..
node --import tsx benchmark/retrieval-haystack-agent-pilot-2026-09-09/replay.mjs /tmp/atoma-mcp-replay
```

The replay helper is unchanged. It checks the schedule, score results,
runner epilogues, retrieval observations and paired decision against the
archive; it does not call a model. The recorded replay was produced from
a fresh extraction, not the live workspaces.

Before the campaign, `npm run release:check` passed: 3,841 tests passed,
16 skipped, audit found zero vulnerabilities, build and compiled MCP/auth
smokes passed. The real Chrome OAuth and GPU smokes also passed against that
build, including live polling and WebGL fallback. Compressed logs are included.
After completion, the global run lease was empty and no container from the
campaign's dedicated worker image remained running.

## Next work

Review finalization, required answer-file completion and exact citation
assembly against the collected incidents before another live batch. Do not
weaken the scorers, infer a retrieval regression from a missing output file,
or add a new mechanical gate during the live session that surfaced these
failures. A new protocol must be pre-registered after any runtime correction.
