---
id: probe-http-json-endpoints
description: Exercise each documented endpoint of a running HTTP server and compare status/body to spec
when_to_use: A server is already running and its endpoints/expected responses are enumerable from its own route definitions or README
kind: llm
---

1. Read <server> source or README to enumerate each METHOD path and its documented status/body.
2. For each, fetch_url METHOD path (with derived test payload/key if needed) and record status + body[0:200].
3. Compare each result to the documented expectation; flag mismatches.
4. Include an unknown path/method to confirm 404/405 fallback.
5. Report raw probe outputs, not a summary claim.
