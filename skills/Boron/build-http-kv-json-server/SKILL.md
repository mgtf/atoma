---
id: build-http-kv-json-server
description: Write a zero-dependency Node HTTP server implementing a CRUD-style JSON API, then boot and probe it
when_to_use: Task asks for a single-file zero-dependency HTTP server exposing REST-like endpoints over an in-memory or simple store
kind: llm
---

1. write_file <server>.js using only 'http' module, define routes matching <resource> spec (list/get/put/delete or equivalent).
2. Listen on Number(process.env.PORT)||0; on 'listening' print literal LISTENING_ON_PORT=<port>.
3. Return correct status codes (200/204/404/405) with JSON bodies for success/error/unknown cases per spec.
4. start_node_server on <server>.js, capture bound port from stdout.
5. fetch_url a baseline read endpoint (e.g. list-all) expecting the empty/default state; confirm status+body match spec before declaring done.
