---
id: single-file-stateful-widget-html
description: Build a single-file HTML app with timed/stateful UI logic, validated via static server
when_to_use: Task asks for one self-contained HTML file with interactive state (timer, counter, game) exposing internal state for testing
kind: llm
---

1. Identify required DOM ids/labels and state fields from the task description.
2. write_file <entry>.html with inline CSS+JS only, no external assets/network calls.
3. Implement state machine driving the DOM ids; expose internal state via window.<ns> object matching described fields.
4. start_static_server on workspace root.
5. validate_html <entry>.html; confirm zero console.error, zero failed requests, and initial DOM values match spec.
