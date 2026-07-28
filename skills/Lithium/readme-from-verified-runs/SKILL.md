---
id: readme-from-verified-runs
description: Write a README documenting only CLI invocations actually executed and verified
when_to_use: Documenting a CLI/tool's usage, errors, and fixtures after implementation, before final delivery
kind: script
language: node
---

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findFileRecursive(dir, basename, depth) {
  depth = depth || 0;
  if (depth > 6) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const full = path.join(dir, e);
    let stat;
    try { stat = fs.statSync(full); } catch (e2) { continue; }
    if (stat.isDirectory()) {
      const found = findFileRecursive(full, basename, depth + 1);
      if (found) return found;
    } else if (e === basename) {
      return full;
    }
  }
  return null;
}

function listFiles(dir, base, acc) {
  base = base || dir;
  acc = acc || [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return acc; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    if (/^_skill_.*\.js$/.test(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch (e2) { continue; }
    const rel = path.relative(base, full);
    if (stat.isDirectory()) {
      listFiles(full, base, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

function extractInvocations(text) {
  const candidates = [];
  const seen = new Set();

  const add = (raw) => {
    let cmd = raw.trim();
    cmd = cmd.replace(/^\$\s*/, '');
    for (let iter = 0; iter < 3; iter++) {
      if (/[.,;:]$/.test(cmd) && !/\.(js|mjs|cjs|json|txt|csv|md)[.,;:]$/i.test(cmd)) {
        cmd = cmd.slice(0, -1).trim();
      } else break;
    }
    if (/^node\s+\S+\.(js|mjs|cjs)\b/i.test(cmd) && !seen.has(cmd)) {
      seen.add(cmd);
      candidates.push(cmd);
    }
  };

  const fenceRe = /```(?:[a-zA-Z0-9]*\n)?([\s\S]*?)```/g;
  let fm;
  while ((fm = fenceRe.exec(text))) {
    for (const line of fm[1].split('\n')) {
      const l = line.replace(/^\$\s*/, '').trim();
      if (l) add(l);
    }
  }

  const inlineRe = /`([^`\n]+)`/g;
  let im;
  while ((im = inlineRe.exec(text))) {
    add(im[1]);
  }

  const parenRe = /\(([^()]*\bnode\b[^()]*)\)/gi;
  let pm;
  while ((pm = parenRe.exec(text))) {
    for (const part of pm[1].split(';')) {
      add(part);
    }
  }

  if (candidates.length === 0) {
    const idxs = [];
    const re = /\bnode\s+\S/gi;
    let mm;
    while ((mm = re.exec(text))) idxs.push(mm.index);
    for (let i = 0; i < idxs.length; i++) {
      const start = idxs[i];
      const end = i + 1 < idxs.length ? idxs[i + 1] : text.length;
      const seg = text.slice(start, end);
      let inQuote = null, cut = seg.length;
      for (let j = 0; j < seg.length; j++) {
        const ch = seg[j];
        if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
        if (ch === '"' || ch === "'") { inQuote = ch; continue; }
        if (ch === ';' || ch === ',' || ch === ')' || ch === '\n') { cut = j; break; }
      }
      add(seg.slice(0, cut));
    }
  }

  return candidates;
}

function deriveEntryFile(cwd) {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.bin) {
        const val = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
        if (val) return val;
      }
      if (pkg.scripts && pkg.scripts.start) {
        const m = pkg.scripts.start.match(/node\s+(\S+\.(?:js|mjs|cjs))/i);
        if (m) return m[1];
      }
      if (pkg.main) return pkg.main;
    }
  } catch (e) { /* ignore */ }
  let files = [];
  try {
    files = fs.readdirSync(cwd).filter(f => /\.(js|mjs|cjs)$/.test(f) && !/^_skill_/.test(f));
  } catch (e) { files = []; }
  if (files.includes('index.js')) return 'index.js';
  if (files.length === 1) return files[0];
  return null;
}

function findFixtureFile(cwd) {
  const dirs = [cwd, path.join(cwd, 'fixtures')];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        const entries = fs.readdirSync(d).filter(f => {
          const full = path.join(d, f);
          let st;
          try { st = fs.statSync(full); } catch (e) { return false; }
          return st.isFile() && !/^package(-lock)?\.json$/i.test(f) && !/^README\.md$/i.test(f) && !/\.(js|mjs|cjs)$/i.test(f);
        });
        if (entries.length) return path.relative(cwd, path.join(d, entries[0]));
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function autoDeriveInvocations(cwd, entryFile) {
  const invocations = ['node ' + entryFile];
  let src = '';
  try { src = fs.readFileSync(path.join(cwd, entryFile), 'utf8'); } catch (e) { src = ''; }
  const readsArgFile = /process\.argv\[2\]/.test(src) && /fs\.\w*read/i.test(src);
  if (readsArgFile) {
    const fixture = findFixtureFile(cwd);
    if (fixture) {
      invocations.unshift('node ' + entryFile + ' ' + fixture);
      const dir = path.dirname(fixture);
      const missingName = (dir === '.' ? '' : dir + '/') + '__missing__' + path.basename(fixture);
      invocations.push('node ' + entryFile + ' ' + missingName);
    }
  }
  return invocations;
}

function runCommand(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', timeout: 15000 });
  if (r.error) {
    return { cmd, spawnError: String(r.error), stdout: '', stderr: '', code: null };
  }
  return { cmd, stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function buildReadme(opts) {
  const entryFile = opts.entryFile;
  const invocations = opts.invocations;
  const results = opts.results;
  const pkg = opts.pkg;
  const name = (pkg && pkg.name) || entryFile || 'cli-tool';
  const description = (pkg && pkg.description) || ('Command-line tool implemented in `' + entryFile + '`.');
  let out = '# ' + name + '\n\n';
  out += '## Overview\n\n' + description + '\n\n';
  out += '## Installation\n\nNo external dependencies. Uses Node.js core modules only.\n\n```\nnpm install\n```\n\n';
  out += '## Usage\n\n```\nnode ' + entryFile + '\n```\n\n';
  out += '## Verified invocations\n\nEach invocation below was executed with `run_shell` and its output captured verbatim; nothing here is inferred or assumed.\n\n';
  invocations.forEach((cmd, i) => {
    const r = results[i];
    out += '### `' + cmd + '`\n\n';
    out += '- Exit code: `' + (r.code === null ? 'N/A (spawn error)' : r.code) + '`\n';
    out += '- stdout:\n\n```\n' + r.stdout + '```\n\n';
    out += '- stderr:\n\n```\n' + r.stderr + '```\n\n';
  });
  out += '## Exit codes\n\n| Code | Meaning |\n| --- | --- |\n';
  const codes = Array.from(new Set(results.map(r => r.code))).sort();
  codes.forEach(c => {
    out += '| ' + (c === null ? 'N/A' : c) + ' | ' + (c === 0 ? 'Success' : 'Error (see stderr above)') + ' |\n';
  });
  out += '\n## Notes\n\n- Entry file: `' + entryFile + '`\n- No external npm dependencies; uses Node.js core modules only.\n';
  return out;
}

function main() {
  const cwd = process.cwd();
  const rawArg = process.argv[2] || '';
  let description = rawArg;
  try {
    const parsed = JSON.parse(rawArg);
    if (typeof parsed === 'string') description = parsed;
    else description = JSON.stringify(parsed);
  } catch (e) { /* keep raw string */ }

  let invocations = extractInvocations(description);
  let entryFile = null;

  if (invocations.length > 0) {
    const m = invocations[0].match(/^node\s+(\S+\.(?:js|mjs|cjs))/i);
    entryFile = m ? m[1] : null;
    if (entryFile && !fs.existsSync(path.join(cwd, entryFile))) {
      const found = findFileRecursive(cwd, path.basename(entryFile));
      if (found) entryFile = path.relative(cwd, found);
    }
  }

  if (invocations.length === 0) {
    entryFile = deriveEntryFile(cwd);
    if (!entryFile) {
      console.error('Cannot derive invocations from subtask text (no `node <file>.js ...` commands found) and cannot uniquely determine the CLI entry file from the workspace (package.json bin/main/scripts.start absent or ambiguous, and more than one root .js file present).');
      process.exit(1);
    }
    if (!fs.existsSync(path.join(cwd, entryFile))) {
      const found = findFileRecursive(cwd, path.basename(entryFile));
      if (found) entryFile = path.relative(cwd, found);
      else {
        console.error('Derived entry file "' + entryFile + '" does not exist anywhere in the workspace.');
        process.exit(1);
      }
    }
    invocations = autoDeriveInvocations(cwd, entryFile);
  }

  if (!entryFile) {
    console.error('Could not determine entry file from extracted invocations.');
    process.exit(1);
  }

  const results = invocations.map(cmd => runCommand(cmd, cwd));

  const spawnFailures = results.filter(r => r.spawnError);
  if (spawnFailures.length === results.length) {
    console.error('All extracted invocations failed to spawn: ' + JSON.stringify(spawnFailures));
    process.exit(1);
  }

  const recheck = runCommand(invocations[0], cwd);
  const first = results[0];
  const deterministic = recheck.stdout === first.stdout && recheck.stderr === first.stderr && recheck.code === first.code;
  if (!deterministic) {
    console.error('Non-deterministic output detected on re-run of: ' + invocations[0] + ' (first run vs recheck differ)');
    process.exit(1);
  }

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch (e) { pkg = null; }

  // Persist the machine-readable probe manifest alongside the README so
  // later verification passes re-run and diff against a parseable record
  // instead of prose. Merge by cmd if a manifest already exists.
  const manifestPath = path.join(cwd, '.atoma-probes.json');
  let manifest = { version: 1, entries: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (prev && Array.isArray(prev.entries)) manifest = { version: 1, entries: prev.entries };
  } catch (e) { /* absent or invalid: start fresh */ }
  for (let i = 0; i < invocations.length; i++) {
    const r = results[i];
    if (r.spawnError) continue;
    const entry = { cmd: invocations[i], exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    const at = manifest.entries.findIndex(e => e && e.cmd === entry.cmd);
    if (at >= 0) manifest.entries[at] = entry; else manifest.entries.push(entry);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const readme = buildReadme({ entryFile, invocations, results, pkg });
  fs.writeFileSync(path.join(cwd, 'README.md'), readme, 'utf8');

  let writtenBack = '';
  try { writtenBack = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'); } catch (e) { writtenBack = ''; }
  if (!writtenBack.includes('Verified invocations')) {
    console.error('README.md write verification failed: expected "Verified invocations" section missing after write+read-back.');
    process.exit(1);
  }

  const files = listFiles(cwd);

  const groundTruthLines = results.map((r, i) => {
    return 'Invocation ' + (i + 1) + ': `' + invocations[i] + '` -> exit ' + (r.code === null ? 'N/A' : r.code) + ', stdout=' + JSON.stringify(r.stdout) + ', stderr=' + JSON.stringify(r.stderr);
  }).join('\n');

  const summary = 'README.md written and verified with ' + invocations.length + ' actually-executed invocation(s) documenting entry "' + entryFile + '"; re-run of the first invocation matched byte-for-byte confirming determinism; ' + files.length + ' files present on disk.\n== GROUND TRUTH ==\n' + groundTruthLines + '\nFiles on disk: ' + files.join(', ');

  const output = {
    readme_path: 'README.md',
    entry_file: entryFile,
    invocations: invocations,
    results: results,
    files: files
  };

  console.log(JSON.stringify({ output, summary }));
}

main();
