---
id: scaffold-node-cli-tool
description: Scaffold a minimal dependency-free Node.js CLI package with package.json, entry script, and README.
when_to_use: Task asks to create a small standalone CLI/utility with package.json + entry file + docs, no external deps.
kind: llm
---

1. write_file package.json with name/version/main-or-bin/scripts.start, deps empty.
2. write_file index.js with dependency-free logic producing required stdout output.
3. write_file README.md with '## Install' (npm install) and '## Usage' (npm start / node index.js) sections.
4. run_shell: node index.js — confirm expected stdout.
5. run_shell: npm start — confirm same behavior.
6. Report file list + captured stdout, no package installs performed.
