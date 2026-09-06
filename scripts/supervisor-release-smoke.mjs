import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
for (const file of ['AGENTS.md', 'docs/supervisor-design.md', 'src/supervisor/AGENTS.md',
  'src/supervisor/analyst.ts', 'dist/supervisor/codexSession.js', 'dist/supervisor/codexReader.js']) {
  accessSync(join(root, file), constants.R_OK);
}
const contract = readFileSync(join(root, 'AGENTS.md'), 'utf8');
for (const match of contract.matchAll(/\]\((src\/[^)]+\/AGENTS\.md)\)/g)) accessSync(join(root, match[1]), constants.R_OK);
if (readdirSync(join(root, 'src')).length === 0) throw new Error('Missing analyst source evidence');
const { createEvidenceReader } = await import(pathToFileURL(join(root, 'dist/supervisor/codexReader.js')).href);
const reader = createEvidenceReader(root, {});
const evidence = JSON.parse(reader({ path: 'src/supervisor/AGENTS.md', query: '', offset: 0, limit: 10 }));
if (!evidence.lines?.length) throw new Error('Compiled analyst cannot read the packaged subsystem contract');
console.log('Supervisor release evidence and compiled transport are present');
