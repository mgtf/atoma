---
id: single-file-stateful-widget-html
description: Build a single-file HTML app with timed/stateful UI logic, validated via static server
when_to_use: Task asks for one self-contained HTML file with interactive state (timer, counter, game) exposing internal state for testing
kind: llm
---

1. Identify required DOM ids/labels and state fields from the task description.
2. write_file <entry>.html with inline CSS+JS only, no external assets/network calls.
3. Implement state machine driving the DOM ids; expose internal state via window.<ns> object matching described fields.
4. start_static_server on workspace root, with retry: if startup fails, retry up to 3 times with a short backoff, and on repeated failure try an alternate/free port (e.g. port=0 for auto-assign, or explicitly release/select another port) before giving up; never treat a transient server failure as a reason to skip the remaining steps.
5. Once the server is confirmed up (received a valid base URL/port), run validate_html <entry>.html; confirm zero console.error, zero failed requests, and initial DOM values match spec.
6. The task is only complete when validate_html has actually executed and reported clean results. If the server cannot be started after retries, treat this as a blocking failure to surface explicitly (not a silent partial success) rather than stopping after step 2 with only the file written.
