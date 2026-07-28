---
id: document-cli-from-source
description: Write a README for a CLI by reading back its source and pasting real run output
when_to_use: After building/verifying a CLI tool, when a README documenting install/usage with accurate examples is needed
kind: script
language: node
---

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safeRun(cmd) {
  try {
    const stdout = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { cmd, stdout, code: 0 };
  } catch (e) {
    return { cmd, stdout: (e.stdout || '').toString(), code: (typeof e.status === 'number' ? e.status : 1), err: (e.stderr || '').toString() };
  }
}

function main() {
  const rawArg = process.argv[2] || '""';
  let subtask = '';
  try { subtask = JSON.parse(rawArg); } catch (_) { subtask = String(rawArg); }

  const cwd = process.cwd();
  const indexPath = path.join(cwd, 'index.js');
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(indexPath) || !fs.existsSync(pkgPath)) {
    const out = { output: null, summary: 'FAILED: index.js and/or package.json not found in workspace; cannot document a CLI that has not been built.\n== GROUND TRUTH ==\nindex.js present: ' + fs.existsSync(indexPath) + '; package.json present: ' + fs.existsSync(pkgPath) };
    console.log(JSON.stringify(out));
    return;
  }

  const indexSrc = fs.readFileSync(indexPath, 'utf8');
  const pkgSrc = fs.readFileSync(pkgPath, 'utf8');
  let pkg = {};
  try { pkg = JSON.parse(pkgSrc); } catch (_) { pkg = {}; }

  const name = pkg.name || 'cli-tool';
  const description = pkg.description || ('A lightweight Node.js CLI tool: ' + name + '.');
  const engineNode = (pkg.engines && pkg.engines.node) ? pkg.engines.node : '>=12.0.0';
  const hasStartScript = !!(pkg.scripts && pkg.scripts.start);

  // Extract candidate invocation commands from backticked snippets in the subtask description.
  const backtickRe = /`([^`]+)`/g;
  let m;
  const candidates = [];
  while ((m = backtickRe.exec(subtask)) !== null) {
    const snippet = m[1].trim();
    if (/^node index\.js\b/.test(snippet) || /^npm start\b/.test(snippet)) {
      candidates.push(snippet);
    }
  }

  // Dedupe while preserving order.
  const seen = new Set();
  let invocations = [];
  for (const c of candidates) {
    if (!seen.has(c)) { seen.add(c); invocations.push(c); }
  }

  // Fallback defaults if nothing usable was found in the description.
  if (invocations.length === 0) {
    invocations = ['node index.js sample.txt'];
    if (hasStartScript) invocations.push('npm start -- sample.txt');
  }

  // Always also probe the no-argument case for documenting error/default behaviour,
  // unless it's already covered.
  if (!invocations.some((c) => /^node index\.js\s*$/.test(c))) {
    invocations.push('node index.js');
  }

  const results = invocations.map(safeRun);

  // Build README content.
  const usageBlocks = results.map((r) => {
    const lines = [];
    lines.push('```');
    lines.push('$ ' + r.cmd);
    const out = (r.stdout || '').replace(/\s+$/, '');
    if (out) lines.push(out);
    if (r.code !== 0) {
      const errTxt = (r.err || '').replace(/\s+$/, '');
      if (errTxt) lines.push(errTxt);
      lines.push('(exit code ' + r.code + ')');
    }
    lines.push('```');
    return lines.join('\n');
  }).join('\n\n');

  const readme = [
    '# ' + name,
    '',
    description,
    '',
    '## Install',
    '',
    '```',
    'git clone <this-repo>',
    'cd ' + name,
    'npm install   # no-op: no external dependencies',
    '```',
    '',
    'Requires Node.js ' + engineNode + '.',
    '',
    '## Usage',
    '',
    usageBlocks,
    ''
  ].join('\n');

  fs.writeFileSync(path.join(cwd, 'README.md'), readme, 'utf8');

  // Re-verification pass: list files, re-run the first (and second, if present) invocation,
  // and diff against what was just written into README.md.
  const files = fs.readdirSync(cwd).filter((f) => !f.startsWith('.') && f !== 'node_modules');
  const rewrittenReadme = fs.readFileSync(path.join(cwd, 'README.md'), 'utf8');

  const recheckCount = Math.min(2, results.length);
  const rechecks = [];
  let allMatch = true;
  for (let i = 0; i < recheckCount; i++) {
    const original = results[i];
    const again = safeRun(original.cmd);
    const matches = (again.stdout === original.stdout) && (again.code === original.code);
    if (!matches) allMatch = false;
    rechecks.push({ cmd: original.cmd, stdout: again.stdout, code: again.code, matches });
  }

  const readmeHasInstall = /##\s*Install/.test(rewrittenReadme);
  const readmeHasUsage = /##\s*Usage/.test(rewrittenReadme);

  const groundTruthLines = [];
  groundTruthLines.push('File listing: ' + files.join(', ') + '.');
  groundTruthLines.push('');
  rechecks.forEach((r, i) => {
    groundTruthLines.push('Re-run test ' + (i + 1) + ' - `' + r.cmd + '`:');
    groundTruthLines.push('Exit code ' + r.code + ', stdout matches README: ' + r.matches + ', stdout:');
    groundTruthLines.push((r.stdout || '').replace(/\s+$/, '') || '(empty)');
    groundTruthLines.push('');
  });
  groundTruthLines.push('README.md sections confirmed: Install=' + readmeHasInstall + ', Usage=' + readmeHasUsage + '.');
  groundTruthLines.push('All rechecked outputs match README verbatim: ' + allMatch + '.');

  const groundTruth = groundTruthLines.join('\n');

  const summary = 'README.md written for "' + name + '" documenting install/usage with ' + invocations.length + ' real captured invocation(s); re-verified ' + recheckCount + ' of them against a fresh run (all match: ' + allMatch + ').\n== GROUND TRUTH ==\n' + groundTruth;

  const output = {
    files,
    readme_path: 'README.md',
    invocations: results.map((r) => ({ cmd: r.cmd, exit_code: r.code, stdout: r.stdout })),
    rechecks
  };

  console.log(JSON.stringify({ output, summary }));
}

main();
