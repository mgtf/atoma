---
id: single-file-http-json-server
description: Build a zero-dep Node http server exposing a JSON resource API and prove it boots
when_to_use: Task asks for one self-contained Node file (only 'http') implementing CRUD-style JSON endpoints over an in-memory store, started via env PORT
kind: llm
---

1. write_file <entry>.js implementing the described routes with only 'http'; on start, listen on Number(process.env.PORT)||0 and print LISTENING_ON_PORT=<port>.
2. Read the file back (or list dir) to confirm it exists and is non-empty before proceeding — do not start the server on an unconfirmed write.
3. start_node_server <entry>.js.
4. fetch_url the simplest read-only route (e.g. list/root GET) and check it returns the documented empty/default state.
5. Only report success once the probe's status+body match the spec.
