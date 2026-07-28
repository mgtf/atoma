---
id: harden-cli-error-handling-readme
description: Add error handling to a CLI, verify with a probe matrix, then document in README with real output
when_to_use: Task asks to harden an existing script's error paths and write docs/README backed by actual run output, no server/URL needed
kind: llm
---

1. Use edit_file (not full rewrite) to add try/catch per failure mode: missing arg, missing file, malformed input -> stderr message + exit 1; success -> stdout + exit 0.
2. run_shell each case (no-arg, bad path, malformed fixture, happy-path object, happy-path array, npm start) and capture exact stdout/stderr/exit code.
3. Write README.md: Install, Usage, one example block per case copied verbatim from probe output, exit-code table.
4. read_file package.json/index.js/README.md to confirm consistency.
