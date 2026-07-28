---
id: build-http-json-crud-api
description: Implement a zero-dep Node http server for a JSON resource API and verify it boots.
when_to_use: Task asks for a self-contained Node file exposing CRUD-style JSON endpoints via the built-in http module.
kind: llm
---

1. Parse subtask spec to list <method> <path> -> <status>/<body> rules and required env var (e.g. PORT).
2. write_file <entry>.js using only 'http'/core modules; keep state in-memory per spec.
3. Bind to process.env.<PORT_VAR>, print required startup line once listening.
4. start_node_server <entry>.js.
5. Probe a few representative routes (happy path + one error path) to confirm shapes match spec before declaring done.
