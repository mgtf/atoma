---
id: scaffold-package-json
description: scaffold a Node package.json with a name, version, optional description, and ESM type
when_to_use: when the subtask asks to create a package.json for a Node project
kind: llm
---

1. DERIVE the fields from the subtask and the workspace — never from this recipe:
   - `name`: a short kebab-case identifier for the project (from the tool/entry
     name, e.g. the entry script's basename without extension). NEVER the task
     sentence itself.
   - `version`: `0.1.0` unless the subtask states one.
   - `description`: one clause, only if the subtask gives one.
   - `bin` / `main`: point at the real entry file if one exists in the
     workspace (`list_files` to check); omit both if it does not exist yet.
2. write_file package.json with this shape (omit empty optional fields):
   `{ name, version, description?, private: true, type: "module",
      bin?, main?, scripts: { test: "echo \"no tests yet\"" } }`
3. read_file package.json and paste it into a `== GROUND TRUTH ==` block.
4. If the project has dependencies, run_shell `npm install` and report the
   real exit code; otherwise state explicitly that there are none.
5. If you cannot derive a sensible `name`, say so and stop — do NOT invent one
   from the task description.
