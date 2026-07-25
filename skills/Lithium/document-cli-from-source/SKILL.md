---
id: document-cli-from-source
description: Write a README for a CLI by reading back its source and pasting real run output
when_to_use: After building/verifying a CLI tool, when a README documenting install/usage with accurate examples is needed
kind: llm
---

1. read index.js and package.json to confirm actual flags, output labels, error behaviour.
2. write_file README.md with ## Install (clone, npm install no-op if no deps) and ## Usage (node index.js <file> and npm start -- <file>).
3. run_shell node index.js sample.txt to capture real stdout.
4. Paste that exact output into README example, never invent output.
5. cat README.md / list_files to confirm package.json, index.js, README.md all exist.
