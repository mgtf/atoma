---
id: verify-cli-error-exit-codes
description: Re-run a CLI's documented invocations to confirm exit codes and stdout/stderr match spec
when_to_use: After error-handling changes exist and fixtures/invocations are already defined on disk or in README, to confirm behavior deterministically
kind: llm
---

1. List fixtures/ present in workspace to find valid + broken/missing inputs.
2. Read <entry>'s usage/help output or README to get exact invocation forms.
3. For each documented invocation, run_shell: node <entry> <args>; echo EXIT=$?.
4. Confirm error cases: stderr non-empty, stdout empty, EXIT=1.
5. Confirm happy-path case: expected stdout content, empty stderr, EXIT=0.
6. Report each command with captured stdout/stderr/exit code verbatim.
