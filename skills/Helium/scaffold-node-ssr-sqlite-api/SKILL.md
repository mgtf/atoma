---
id: scaffold-node-ssr-sqlite-api
description: Bootstrap a single-file Node SSR server with SQLite DB and external API cache.
when_to_use: Task asks for a Node HTTP server that fetches+caches an external API on boot, persists data in SQLite, and serves server-rendered HTML.
kind: llm
---

1. write_file package.json with dependencies (better-sqlite3, node-fetch if needed).
2. write_file server.js: on boot fetch external API, cache in memory; init better-sqlite3 DB + schema; define GET / rendering cached+DB stats as HTML with all interactive form elements; define POST /recommend (or GET with query params) computing top-5 recommendations from SQLite winrate data, excluding picked champions on both sides, enforcing a minimum games threshold, and SSR-rendering each result with champion name, winrate percentage, and sample size; define POST /api/match to persist completed match records; emit LISTENING_ON_PORT=<port>.
3. install_dependencies (npm install).
4. start_node_server server.js.
5. fetch_url GET / — assert HTTP 200; inspect raw HTML to confirm champion `<option>` elements are present in both the ally and enemy draft selectors (log a count of options found).
6. fetch_url POST /recommend (or GET /?ally=X,Y&enemy=Z) with 2 ally picks and 1 enemy pick — assert HTTP 200; parse the response HTML and verify it contains exactly 5 recommendation entries; confirm none of the 3 picked champions appear in the results; confirm each entry visibly contains a winrate value (e.g. `%`) and a sample-size value (e.g. `games`); log the raw recommendation block as evidence.
7. fetch_url POST /api/match with a complete match payload — assert HTTP 200 or 201; then fetch_url GET /api/stats and confirm the returned data reflects the newly inserted record (row count or updated winrate); log the stats response as evidence.
8. Return the server URL and paste the logged HTML snippets from steps 5–7 as ground-truth artefacts in the RESULT.
