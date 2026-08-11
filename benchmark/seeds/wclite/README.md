# wclite

Counts lines, words and characters in a text file. No dependencies.

## Usage

```
node wclite.js [--lines|--words|--chars] <file>
```

## Verified invocations

- `node wclite.js sample.txt` — exit 0, prints `lines 3`, `words 6`, `chars 36`
- `node wclite.js --lines sample.txt` — exit 0, prints `3`
- `node wclite.js --words sample.txt` — exit 0, prints `6`
- `node wclite.js --help` — exit 0, prints the usage block
- `node wclite.js missing.txt` — exit 2, `wclite: cannot read file: missing.txt`
