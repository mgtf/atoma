---
id: reverify-cli-readme-invocations
description: Re-execute a CLI's documented invocations and confirm outputs/exit codes match README and files exist
when_to_use: A README with a 'Verified invocations' section exists and the deliverable's files/fixtures are on disk, ready for final check
kind: llm
---

1. list_files to confirm <entry>, package.json (if any), and fixture files referenced in README all exist.
2. If package.json exists, run `node -e "require('./package.json')"` and expect exit 0.
3. Parse README's 'Verified invocations' section for each documented command; re-run each exactly as written.
4. Compare each re-run's stdout/stderr/exit code to what README claims; flag any mismatch as failure.
