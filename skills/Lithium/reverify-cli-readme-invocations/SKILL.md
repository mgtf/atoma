---
id: reverify-cli-readme-invocations
description: Re-run a CLI's verified invocations from the probe manifest (README as fallback) and diff outputs
when_to_use: A README with a 'Verified invocations' section exists and the deliverable's files/fixtures are on disk, ready for final check
kind: script
language: node
---

#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(msg) {
  process.stderr.write('DIAGNOSIS: ' + msg + '\n');
  process.exit(1);
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function runCmd(cmd) {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: process.cwd() });
  return {
    exitCode: res.status === null ? (res.signal ? -1 : 1) : res.status,
    stdout: res.stdout === undefined || res.stdout === null ? '' : res.stdout,
    stderr: res.stderr === undefined || res.stderr === null ? '' : res.stderr,
  };
}

// ---- Extraction of commands from README 'Verified invocations' section (fallback path) ----
function extractSection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /^#{1,6}.*verified invocations/i.test(lines[i])) { start = i + 1; continue; }
    if (start >= 0 && i > start && /^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return null;
  return lines.slice(start, end).join('\n');
}

// Returns array of {cmd, expectedStdout (string|null), expectedExit (number|null)}
function extractInvocationsFromSection(section) {
  const out = [];
  const seen = new Set();

  // 1) Fenced code blocks: first non-empty line = command (strip leading '$ '), remaining lines = expected stdout if block has >1 non-empty line.
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(section)) !== null) {
    const blockLines = m[1].split(/\r?\n/);
    const nonEmptyIdx = blockLines.findIndex(l => l.trim().length > 0);
    if (nonEmptyIdx === -1) continue;
    let cmdLine = blockLines[nonEmptyIdx].replace(/^\s*\$\s?/, '').trim();
    if (!cmdLine) continue;
    const rest = blockLines.slice(nonEmptyIdx + 1);
    // trim trailing empty lines from rest
    while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
    let expectedStdout = null;
    let expectedExit = null;
    if (rest.length > 0) {
      // look for an explicit exit-code annotation among rest lines
      const exitLineIdx = rest.findIndex(l => /exit\s*(code)?\s*[:=]?\s*-?\d+/i.test(l));
      let stdoutLines = rest;
      if (exitLineIdx !== -1) {
        const em = rest[exitLineIdx].match(/exit\s*(code)?\s*[:=]?\s*(-?\d+)/i);
        if (em) expectedExit = parseInt(em[2], 10);
        stdoutLines = rest.slice(0, exitLineIdx).concat(rest.slice(exitLineIdx + 1));
      }
      if (stdoutLines.length > 0) expectedStdout = stdoutLines.join('\n') + '\n';
    }
    if (!seen.has(cmdLine)) { seen.add(cmdLine); out.push({ cmd: cmdLine, expectedStdout, expectedExit }); }
  }

  // 2) Inline-code spans on list/prose lines not already captured, e.g. '- `node index.js foo "bar baz"`'
  const lines = section.split(/\r?\n/);
  for (const line of lines) {
    if (/^```/.test(line.trim())) continue;
    const inlineRe = /`([^`]+)`/g;
    let im;
    while ((im = inlineRe.exec(line)) !== null) {
      let cand = im[1].replace(/^\s*\$\s?/, '').trim();
      if (!cand) continue;
      // heuristics: looks like a shell invocation (contains a runnable token)
      if (!/^(node|npm|npx|bash|sh|\.\/|python3?)\b/.test(cand)) continue;
      // exit-code annotation possibly in same line, outside backticks
      let expectedExit = null;
      const em = line.match(/exit\s*(code)?\s*[:=]?\s*(-?\d+)/i);
      if (em) expectedExit = parseInt(em[2], 10);
      if (!seen.has(cand)) { seen.add(cand); out.push({ cmd: cand, expectedStdout: null, expectedExit }); }
    }
  }

  return out;
}

function extractReferencedFiles(cmd) {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const files = [];
  for (const t of tokens) {
    const bare = t.replace(/^['"]|['"]$/g, '');
    if (/^[\w.\-\/]+\.[A-Za-z0-9]+$/.test(bare) && !bare.startsWith('-')) files.push(bare);
  }
  return files;
}

function main() {
  const cwd = process.cwd();
  const manifestPath = path.join(cwd, '.atoma-probes.json');
  const manifestRaw = readIfExists(manifestPath);
  const results = []; // {cmd, mode: 'manifest'|'derived', pass, detail}
  let anyMismatch = false;
  let manifest = null;

  if (manifestRaw) {
    try { manifest = JSON.parse(manifestRaw); } catch (e) { fail('Failed to parse .atoma-probes.json as JSON: ' + e.message); }
    if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      fail('.atoma-probes.json present but contains no entries array to verify.');
    }
    for (const entry of manifest.entries) {
      if (!entry.cmd) continue;
      const actual = runCmd(entry.cmd);
      const recExit = entry.exitCode;
      const recStdout = entry.stdout === undefined ? '' : entry.stdout;
      const recStderr = entry.stderr === undefined ? '' : entry.stderr;
      const exitOk = recExit === undefined || recExit === null || actual.exitCode === recExit;
      const stdoutOk = actual.stdout === recStdout;
      const stderrOk = actual.stderr === recStderr;
      const pass = exitOk && stdoutOk && stderrOk;
      if (!pass) anyMismatch = true;
      results.push({
        cmd: entry.cmd,
        mode: 'manifest',
        pass,
        expectedExit: recExit,
        expectedStdout: recStdout,
        expectedStderr: recStderr,
        actualExit: actual.exitCode,
        actualStdout: actual.stdout,
        actualStderr: actual.stderr,
      });
    }
  } else {
    const readmeRaw = readIfExists(path.join(cwd, 'README.md'));
    if (!readmeRaw) fail('No .atoma-probes.json and no README.md found; nothing to re-verify.');
    const section = extractSection(readmeRaw);
    if (!section) fail("No .atoma-probes.json and README.md has no 'Verified invocations' section; nothing to re-verify.");
    const invocations = extractInvocationsFromSection(section);
    if (invocations.length === 0) fail("'Verified invocations' section found but no extractable commands within it.");

    const newEntries = [];
    for (const inv of invocations) {
      const actual = runCmd(inv.cmd);
      let pass = true;
      const notes = [];
      if (inv.expectedExit !== null) {
        if (actual.exitCode !== inv.expectedExit) { pass = false; notes.push('exit code mismatch'); }
      }
      if (inv.expectedStdout !== null) {
        if (actual.stdout !== inv.expectedStdout) { pass = false; notes.push('stdout mismatch'); }
      }
      if (inv.expectedExit === null && inv.expectedStdout === null) {
        notes.push('no explicit claim in README; executed and recorded as baseline');
      }
      if (!pass) anyMismatch = true;
      results.push({
        cmd: inv.cmd,
        mode: 'derived',
        pass,
        expectedExit: inv.expectedExit,
        expectedStdout: inv.expectedStdout,
        expectedStderr: null,
        actualExit: actual.exitCode,
        actualStdout: actual.stdout,
        actualStderr: actual.stderr,
        notes: notes.join('; '),
      });
      newEntries.push({ cmd: inv.cmd, exitCode: actual.exitCode, stdout: actual.stdout, stderr: actual.stderr });

      for (const f of extractReferencedFiles(inv.cmd)) {
        // referenced files are informational only; a missing one may be an intentional negative-path fixture.
        if (!fs.existsSync(path.join(cwd, f))) {
          results[results.length - 1].notes = (results[results.length - 1].notes ? results[results.length - 1].notes + '; ' : '') + ('referenced file not found on disk: ' + f);
        }
      }
    }

    // merge/write manifest so later passes inherit a machine-readable record
    const merged = { version: 1, entries: newEntries };
    fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  }

  // Confirm deliverable files exist: entry point derived from package.json (main/start) or index.js fallback.
  const pkgRaw = readIfExists(path.join(cwd, 'package.json'));
  let entryPoint = null;
  let pkgValid = false;
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      pkgValid = true;
      if (pkg.main) entryPoint = pkg.main;
      else if (pkg.scripts && pkg.scripts.start) {
        const sm = pkg.scripts.start.match(/node\s+([^\s]+)/);
        if (sm) entryPoint = sm[1];
      }
    } catch (e) { pkgValid = false; }
  }
  if (!entryPoint) {
    if (fs.existsSync(path.join(cwd, 'index.js'))) entryPoint = 'index.js';
  }
  if (!entryPoint || !fs.existsSync(path.join(cwd, entryPoint))) {
    fail('Could not locate an entry point file on disk (checked package.json main/start and index.js).');
  }

  const filesPresent = ['README.md', 'package.json', entryPoint].filter(f => fs.existsSync(path.join(cwd, f)));

  // Build ground truth block
  const lines = [];
  for (const r of results) {
    const mark = r.pass ? '\u2713' : '\u2717';
    let line = mark + ' Command (' + r.cmd + '): exit ' + r.actualExit + ', stdout ' + JSON.stringify(r.actualStdout) + ', stderr ' + JSON.stringify(r.actualStderr);
    if (!r.pass) {
      line += ' -- MISMATCH vs expected exit=' + JSON.stringify(r.expectedExit) + ' stdout=' + JSON.stringify(r.expectedStdout) + (r.expectedStderr !== undefined ? (' stderr=' + JSON.stringify(r.expectedStderr)) : '');
    }
    if (r.notes) line += ' [' + r.notes + ']';
    lines.push(line);
  }
  lines.push((pkgValid ? '\u2713' : '\u2717') + ' package.json valid: ' + (pkgRaw ? pkgValid : 'not present'));
  lines.push('\u2713 Files present: ' + filesPresent.join(', '));
  lines.push('\u2713 Entry point: ' + entryPoint);

  const groundTruth = lines.join('\n');

  if (anyMismatch) {
    process.stderr.write('DIAGNOSIS: one or more invocations did not match recorded/claimed results.\n' + groundTruth + '\n');
    process.exit(1);
  }

  const summary = 'All ' + results.length + ' invocation(s) re-verified ' + (manifest ? 'against .atoma-probes.json' : 'against README claims') + ' with matching exit codes and stdout; entry point ' + entryPoint + '.\n== GROUND TRUTH ==\n' + groundTruth;

  const output = { entryPoint, files: filesPresent, results };
  process.stdout.write(JSON.stringify({ output, summary }) + '\n');
}

main();
