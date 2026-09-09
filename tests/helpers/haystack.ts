import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HaystackLaunch } from '../../src/contracts/retrievalHaystack.js';

/** Real process, fake ranking: CI exercises ownership/protocol without Python dependencies. */
export function haystackTestRuntime(root: string, behavior = 'valid'): HaystackLaunch {
  const python = join(root, 'haystack-test-runtime');
  writeFileSync(python, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'haystack.pid'))}, String(process.pid));
const reply = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
let documents;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 if (${JSON.stringify(behavior)} === 'hang') return;
 if (r.op === 'init') { documents = r.documents;
  reply({kind:'ready',id:0,version:'3.1.1',documents:documents.length,runtimeSha256:'f'.repeat(64)});
 } else reply({kind:'result',id:r.id,hits:documents.slice(0,r.limit).map(d => ({id:d.id,score:1}))});
});
`, { mode: 0o700 });
  return { python, runtimeSha256: 'f'.repeat(64), settings: { mode: 'bm25' } };
}
