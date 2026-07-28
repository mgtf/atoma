---
id: node-file-analyzer-cli
description: Build a dependency-free Node CLI that reads a file arg and prints a computed summary
when_to_use: Task asks for a minimal Node CLI (package.json+index.js) that reads process.argv input and prints derived stats, verified by running it
kind: llm
---

1. write_file package.json: name, version, type commonjs, bin->index.js, scripts.start='node index.js', no deps.
2. write_file index.js: read process.argv[2] with fs.readFileSync, parse/process, compute stats via small recursive/pure helper functions, console.log summary line.
3. write_file a fixture input file.
4. run_shell `node index.js fixture` — verify exit code 0 and correct summary values.
5. run_shell `npm start -- fixture` — verify same output.
6. Iterate read_file/write_file until both probes match expected values exactly.
