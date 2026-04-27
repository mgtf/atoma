---
id: smoke-test-node-server-endpoints
description: End-to-end smoke test a running Node server: UI, POST API, and GET API.
when_to_use: Task requires verifying a freshly built HTTP server has a working HTML UI and one or more JSON API endpoints before declaring done.
kind: llm
---

1. start_node_server to (re)start the server.
2. fetch_url GET / — assert status 200 and key HTML landmarks present.
3. fetch_url POST /api/<resource> with realistic payload — assert status 200, JSON body, expected fields.
4. fetch_url GET /api/<collection> — assert status 200 and non-empty array.
5. On any failure: read_file the relevant route, write_file the fix, restart, retest.
6. Return server URL + one-sentence usage note when all checks pass.
