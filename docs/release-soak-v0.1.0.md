# v0.1.0 release soak

Run 2026-08-12 against the archive downloaded from the private GitHub Release,
not against the source checkout.

## Installation path

1. Download `atoma-v0.1.0.tar.gz` and its SHA-256 file.
2. Verify the checksum.
3. Extract into an empty directory.
4. Run `npm ci --omit=dev`.
5. Start `node dist/mcp/stdio.js`.

All runtime paths were redirected into an isolated temporary state root:
database, skills, traces, workspace and MCP run lease.

## Finding

The published checksum named `release/atoma-v0.1.0.tar.gz`, a path that exists
inside the workflow but not after downloading both assets into one directory.
The archive bytes were correct. The v0.1.0 checksum asset was replaced with a
basename-only record, and v0.1.1 fixes plus tests checksum generation in the
workflow.

## Live task

The compiled MCP launched a real default-lifecycle run from an empty store:

> Build a zero-dependency Node CLI with the exact entry file `reverse.js`.
> Accept exactly one string argument, print it reversed, reject a missing
> argument, and document verified success/error examples.

| Result | Value |
|---|---:|
| MCP status | finished / delivered |
| Wall clock | 437 s |
| LLM calls | 16 |
| API-price equivalent | $0.2863 |
| Trace | `2026-08-12T09-07-34-898-2efa3487.json` |

Independent checks outside atoma passed:

- `node reverse.js "Hello World"` printed `dlroW olleH`;
- missing argument exited non-zero and printed usage;
- `reverse.js`, `package.json`, `README.md` and `.atoma-probes.json` existed;
- the manifest carried both success and error evidence;
- the registry persisted 8 atom types;
- the skill store learned 2 recipes;
- `ledger check` projected 7 events with zero impossible or expected drift.

## Conclusion

The compiled release path and real MCP run path work from a production-only
installation. v0.1.1 is a packaging correction, not an orchestration change.
