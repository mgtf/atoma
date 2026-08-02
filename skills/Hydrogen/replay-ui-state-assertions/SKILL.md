---
id: replay-ui-state-assertions
description: Mechanically replay a documented UI interaction sequence and assert resulting DOM/state matches
when_to_use: An entry file exposes named elements/ids and a documented sequence of user actions whose expected end-state can be read from the file or prior spec
kind: llm
---

1. Read entry file to find element ids/classes and state variable exposed on window (if any).
2. Serve the file statically.
3. Replay the documented action sequence (clicks/inputs) in order.
4. After each action, assert textContent, classList membership, and any exposed state var equal the documented expected values.
5. Assert console.error=0, pageerror=0, failedRequests=0.
6. Report pass/fail per assertion, no design changes made.
