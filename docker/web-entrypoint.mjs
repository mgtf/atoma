import { mkdirSync } from 'node:fs';
import { validateWebEnvironment } from './stack-contract.mjs';
import { generateHaystackConfig } from '../dist/cli/haystackConfig.js';

validateWebEnvironment(process.env);
mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
// Fingerprint the installed interpreter and packages; no model download or inference.
process.env.ATOMA_HAYSTACK_CONFIG ??= await generateHaystackConfig(['--python', '/opt/atoma-python/bin/python']);
process.argv = [process.execPath, '/app/dist/viz/server.js', '--host', '127.0.0.1', '--port', '4111'];
await import('../dist/viz/server.js');
