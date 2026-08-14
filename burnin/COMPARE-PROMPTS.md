# Frontier comparison prompts (Opus / Fable)

Same three goals the harness runs. Paste one goal as the user message.
The in-harness control arm (`--baseline`) uses this text plus the nine
sandbox tools; a chat-only Opus/Fable paste has no sandbox.

## unique-emails-cli

Write a no-dependency Node CLI that reads a file path from argv, treats each non-empty line as an email, prints the unique emails sorted case-insensitively one per line, and exits 1 with a stderr usage message when the path is missing or the file cannot be read.

## shift-handoff-docs

Create handoff.md with an H1 and exactly two ## sections named Handoff and Checks, each containing at least four bullet items, and a settings.json whose contents are exactly {"desk":"north","shiftHours":8}.

## lost-found-json-api

Build a tiny HTTP JSON service for a lost-and-found desk with POST /items {label:string,location:string}, GET /items, and GET /items/:id. Reject a blank label or missing location with 400. Document the routes in README.md using <port> placeholders. Then as a FINAL SEPARATE PHASE probe the documented routes and confirm the status codes and response fields.
