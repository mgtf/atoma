---
id: scaffold-node-ssr-sqlite-api
description: Bootstrap a single-file Node SSR server with SQLite DB and external API cache.
when_to_use: Task asks for a Node HTTP server that fetches+caches an external API on boot, persists data in SQLite, and serves server-rendered HTML.
kind: llm
---

1. write_file package.json with dependencies (better-sqlite3, node-fetch if needed).
2. write_file server.js: on boot fetch external API, cache in memory; init better-sqlite3 DB + schema; define GET / rendering cached+DB stats as HTML with all interactive form elements; define POST /recommend (or GET with query params) computing top-5 recommendations from SQLite winrate data, excluding picked champions on both sides, enforcing a minimum games threshold, and SSR-rendering each result with champion name, winrate percentage, and sample size; define POST /api/match to persist completed match records; emit LISTENING_ON_PORT=<port> to stdout via console.log — this line MUST appear before any other output and MUST use exactly that format.
3. install_dependencies (npm install).
4. start_node_server server.js — capture and log the console output; confirm the output contains the literal string `LISTENING_ON_PORT=` followed by a port number; record that port for subsequent steps.
5. fetch_url GET / — assert HTTP 200; capture the full raw response body; log at minimum the first 2000 characters of the HTML; explicitly count and log the number of champion `<option>` elements found in the ally selector and the enemy selector; FAIL this step if either count is zero or if the body is empty.
6. fetch_url POST /recommend (or GET /?ally=X,Y&enemy=Z) with 2 ally picks and 1 enemy pick — assert HTTP 200; parse the response HTML and verify it contains exactly 5 recommendation entries; confirm none of the 3 picked champions appear in the results; confirm each entry visibly contains a winrate value (e.g. `%`) and a sample-size value (e.g. `games`); log the raw recommendation block (at least 500 characters) as evidence.
7. fetch_url POST /api/match with a complete match payload — assert HTTP 200 or 201; then fetch_url GET /api/stats and confirm the returned data reflects the newly inserted record (row count or updated winrate); log the full stats response body as evidence.
8. Return the server URL and paste ALL of the following as a GROUND-TRUTH EVIDENCE block in the RESULT: (a) the console line showing LISTENING_ON_PORT=<port>, (b) the raw HTML snippet from step 5 showing champion options with an explicit count, (c) the raw recommendation block from step 6, (d) the stats response from step 7. A result that omits any of these four items MUST be treated as a failure.
