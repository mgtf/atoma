---
id: seed-synthetic-data-recommendation-api
description: Seed synthetic historical records and expose a scored recommendation endpoint.
when_to_use: Task requires generating fake but realistic relational data, computing multi-factor scores from it, and serving results via a POST API route.
kind: llm
---

1. Insert N synthetic rows into existing DB table using randomised foreign-key references and outcome fields.
2. Write recommend.js: score candidates by (a) co-occurrence win rate, (b) counter win rate, (c) overall win rate with Laplace smoothing; return top-K with scores + reasoning.
3. Register POST route, parse JSON body, call recommend(), return JSON array.
4. start_node_server.
5. fetch_url POST with sample payload; assert 200 and non-empty array.
