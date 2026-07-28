---
id: probe-documented-http-endpoints
description: Mechanically exercise each documented HTTP endpoint and diff status/body against spec.
when_to_use: An HTTP server's routes, methods, status codes and response bodies are already documented and need runtime confirmation.
kind: llm
---

1. Read entry file/README/subtask to enumerate each <method> <path> [+body] -> <status>/<body> rule.
2. start_node_server <entry>, capture bound port.
3. For each rule, send the derived request and record actual status+body.
4. Diff actual vs documented per rule; flag mismatches.
5. Stop the server.
