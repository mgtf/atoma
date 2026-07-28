---
id: verify-cli-output-against-fixtures
description: Re-run a CLI entry against its fixtures and check stdout against the rules it claims to implement
when_to_use: Workspace has an entry script, fixture files, and documented transform rules that need mechanical confirmation
kind: llm
---

1. Locate entry script via package.json bin field or task description.
2. Locate fixture files on disk (e.g. fixtures/*.json).
3. run_shell `node <entry> <fixture args>` and capture stdout + exit code.
4. Parse stdout; for each rule documented (README/task/comments), verify the corresponding field/value in output matches deriving expected value from the fixtures themselves.
5. Assert exit code 0 and zero stderr; report pass/fail per rule.
