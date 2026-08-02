---
id: probe-documented-json-endpoints
description: Mechanically exercise each documented endpoint of a running JSON API and check status/body
when_to_use: An entry file's route table (from source or README) lists methods+paths with expected status codes and JSON shapes, and a server is already running
kind: llm
---

1. Enumerate routes from the entry file/README (method, path pattern, expected status, expected body shape).
2. For each route, fetch_url with the derived method/path (substitute a sample key where needed).
3. Compare returned status code and JSON body against the documented expectation.
4. Include one mutating call (PUT/POST/DELETE) followed by a read-back to confirm state changed as documented.
