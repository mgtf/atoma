---
id: sqlite-ingest-stats-endpoint
description: Add idempotent data ingestion + aggregated stats endpoint to an Express/SQLite server.
when_to_use: Task requires ingesting records into SQLite and exposing aggregated stats via a REST endpoint, with optional live API + bundled seed data fallback.
kind: llm
---

1. Create `data/seed_<entity>.json` with ~40-80 synthetic records covering varied cases.
2. Add `ingest.js` module: upsert seed JSON into SQLite; if env API key present, also fetch live data and upsert.
3. Add `GET /api/ingest` route calling ingest module (idempotent via INSERT OR IGNORE / ON CONFLICT).
4. Add `GET /api/stats/:key` route: JOIN relevant tables, compute counts/rates, return JSON.
5. Smoke-test: call `/api/ingest` then `/api/stats/<key>` and assert non-empty aggregates.
