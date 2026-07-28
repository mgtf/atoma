---
id: validate-html-zero-console-errors
description: Serve a static HTML file and confirm it loads cleanly with expected initial state
when_to_use: An HTML/JS artefact exists and needs a pass/fail load check against console errors, failed requests, and documented initial DOM/state values
kind: llm
---

1. Read the entry HTML file to list required element ids and any window-exposed state object.
2. start_static_server pointing at the file's directory.
3. validate_html <entry>.html once.
4. Assert console.error count == 0 and failed request count == 0.
5. Assert each required DOM id's text/value matches the initial value stated in the task/README.
