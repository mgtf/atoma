# Project retrieval experiment protocol

Status: instruments, registration and A/C characterization driver implemented;
no live campaign registered or executed.

This experiment is separate from the historical
[cost-amortisation benchmark](../PROTOCOL.md). The existing benchmark CLI owns
the `retrieval` subcommand; existing `--baseline` semantics and the
shared runner are unchanged. No new supervision loop is introduced.

## Before the first live measurement

Create a reviewed campaign registration binding the instrument lock and the
exact source revision, including scorer code. Record the selected questions,
repetitions, ordered arm schedule, all three model selectors, frontier-direct
selector, sandbox and tool capabilities, deadlines, budgets, stopping rules,
threshold environment values, and provider accounting configuration. Record
the starting stores, skill/trust state, learning policy and cache treatment.
The instrument lock is insufficient for a live comparison on its own.
`retrieval register` now freezes these inputs for an A/C development
characterization, and `inspect` prints it offline. See the
[operator commands and exact supported policies](README.md#registered-characterization-campaigns).

Use three arms:

- A: Atoma using existing `list_files`, `read_file` and `run_shell` search.
- B: the identical Atoma configuration with the proposed L1 search element.
- C: the existing frontier-direct baseline on the same shared runner.

A versus B isolates retrieval availability. C provides the existing broader
reference and is not a retrieval-only ablation. Characterization may initially
run A and C. Once B exists, rerun paired arms on the same revision and day;
earlier characterization results are not the final control.

Each question/arm must receive the identical selected snapshot and goal in an
independent sandbox workspace. Keep questions, gold, reference fixes, evaluator
code and all other projects outside the candidate's readable mounts. Use the
existing machine-global lease and execute runs serially. Fix every setting
except the retrieval treatment. Do not reuse skill/trust mutations or answers
between paired runs. Balance ordering and record provider cache usage; local
reset does not establish a cold provider cache.

The held-out Orchard project is separate from the development project, but
remains public in this repository. It is held out from retriever tuning, not
secret from dataset authors. Reading it to verify scorer implementation does
not count as a model evaluation. If model or retriever selection is informed
by Orchard results, retire it as held-out and freeze a new project family
before making confirmation claims. The two isolation snapshots are fixtures
for boundary tests, never additional evidence in another project's sandbox.

## Decision rule and reporting

Before inspecting treatment results, register the primary objective, minimum
useful improvement, and cost/latency ceilings, or a correctness non-inferiority
margin for a cost-saving objective. Register repetitions and stopping rules
from coverage and budget. No numerical gain threshold or sample sufficiency
is asserted by these initial instruments.

The primary observation is the executable scorer's full task pass, including
required citations and maintenance behavior. Report retrieval-only and
maintenance tasks separately, plus source validity, fact correctness and
abstention accuracy. Include sample size, paired differences and uncertainty.
Do not treat 26 correlated questions from two small synthetic projects as 26
independent production projects.

Keep raw answers, full run outputs and traces, runner outcomes, fixed-scorer
results, failures, source/instrument hashes, environment configuration, and
starting/ending state as an auditable archive outside ignored runtime folders.
Exclude credentials and live tenant material. Runner failures remain failures
in the outcome denominator and are classified separately, never silently
discarded or counted as correct abstention.

Report calls, tokens, wall time, failed attempts, observed cache usage, actual
API spend and subscription price equivalents separately. Add index build and
rebuild time, CPU, memory and storage before adopting a backend. Declare reuse
counts for amortization; even agentic search consumes model time and tokens.
This small corpus cannot justify a vector service or a scale threshold.

## Next implementation increment

Register and measure A/C with the implemented driver to identify actual
failure classes. The initial driver uses host subscriptions, empty starting
state and development questions; treatment B, paid API campaigns and the
confirmatory statistical report remain later increments.
Then implement and test the scoped host execution
contract and SQLite FTS5 backend before the paired A/B/C comparison.
Keep production tenant authorization, worker protocol isolation, indexing and
operational lifecycle tests separate from the fixture scorer's guarantees.
