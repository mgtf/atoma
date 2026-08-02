---
id: serve-validate-stateful-ui
description: Serve a single-file HTML app and validate stateful UI interactions until clean
when_to_use: An HTML artefact has interactive controls whose state (text/class/style) must be exercised across multiple steps and validated with zero errors
kind: llm
---

1. Identify the entry file and start a static server on the workspace root.
2. Inspect the file for interactive elements (buttons, ids, classes) to derive their selectors/handlers.
3. Build an interaction sequence covering normal, boundary, and reset states of the widget.
4. Write a smoke snippet asserting displayed text, relevant class/computed style, and underlying state variable match expectations at each step.
5. Run validate_html against the served URL with the interactions+smoke.
6. If console.error/pageerror/failedRequests >0 or smoke fails, read file, fix, rewrite, re-serve, re-validate. Repeat until ok:true and all error counts are 0.
7. Report served URL and exact probe result.
