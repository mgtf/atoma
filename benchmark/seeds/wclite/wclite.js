#!/usr/bin/env node
// wclite — count lines, words and characters in a text file.
import fs from 'node:fs';

function usage() {
  console.log('Usage: node wclite.js [--lines|--words|--chars] <file>');
  console.log('  --lines   count lines only');
  console.log('  --words   count words only');
  console.log('  --chars   count characters only');
  console.log('  (no flag) print all three');
}

const argv = process.argv.slice(2);
if (argv.includes('--help')) { usage(); process.exit(0); }
const flags = argv.filter((a) => a.startsWith('--'));
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length !== 1) { console.error('wclite: exactly one file argument is required'); process.exit(2); }
let text;
try { text = fs.readFileSync(files[0], 'utf8'); }
catch { console.error('wclite: cannot read file: ' + files[0]); process.exit(2); }

const lines = text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length;
const words = text.split(/\s+/).filter(Boolean).length;
const chars = text.length;
if (flags.includes('--lines')) console.log(String(lines));
else if (flags.includes('--words')) console.log(String(words));
else if (flags.includes('--chars')) console.log(String(chars));
else console.log(`lines ${lines}`), console.log(`words ${words}`), console.log(`chars ${chars}`);
