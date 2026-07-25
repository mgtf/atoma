---
id: ssr-html-db-smoke-test
description: Build an SSR HTML page with DB-populated selects, stats block, and POST API endpoint.
when_to_use: Task requires a server-rendered HTML UI with dropdowns from a DB, aggregate stats, and a recommendation/action POST endpoint, verified by live probes.
kind: llm
---

1. Add GET / route: query DB for all items, render full HTML with <select> options and stats block injected server-side.
2. Add POST /api/action route: accept JSON body, query DB, return ranked results with score+reasoning.
3. Add minimal CSS (grid layout, readable contrast).
4. start_node_server.
5. fetch_url GET / — confirm <option> tags and stats values present in body.
6. fetch_url POST /api/action with sample payload — confirm JSON array with score fields.
7. On failure: read_file, patch, restart, re-probe.
