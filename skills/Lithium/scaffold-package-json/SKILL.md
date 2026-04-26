---
id: scaffold-package-json
description: scaffold a Node package.json with a name, version, optional description, and ESM type
when_to_use: when the subtask asks to create a package.json for a Node project (provide name, optionally version + description)
kind: script
language: node
---
const fs = require('fs');
const args = process.argv.slice(2);
const name = args[0];
const version = args[1] || '0.1.0';
const description = args.slice(2).join(' ') || '';
if (!name) {
  console.error('usage: node <script> <name> [version] [description...]');
  process.exit(1);
}
const pkg = {
  name,
  version,
  ...(description ? { description } : {}),
  private: true,
  type: 'module',
  scripts: { test: 'echo "no tests yet"' }
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`wrote package.json: ${name}@${version}${description ? ' — ' + description : ''}`);
