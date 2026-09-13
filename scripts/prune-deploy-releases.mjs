#!/usr/bin/env node
// Called by the root-owned activator while its deployment lock and run drain
// are still held. Install this helper root-owned alongside the activator.
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const revisionPattern = /^[0-9a-f]{40}$/;
const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH';

export function pruneReleases(root, { previous = '', apply = false, procRoot = '/proc' } = {}) {
  root = fs.realpathSync(root);
  const releases = path.join(root, 'releases');
  if (fs.realpathSync(releases) !== releases) throw new Error('Release directory must not be symlinked');
  const current = fs.realpathSync(path.join(root, 'current'));
  if (path.dirname(current) !== releases || !revisionPattern.test(path.basename(current))) {
    throw new Error('Current release is outside the release directory');
  }
  const entries = fs.readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && revisionPattern.test(entry.name))
    .map((entry) => {
      const directory = path.join(releases, entry.name);
      const stat = fs.lstatSync(directory);
      return { directory, name: entry.name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
  const keep = new Set([current, ...entries.slice(0, 5).map((entry) => entry.directory)]);
  if (previous) {
    const resolved = fs.realpathSync(previous);
    if (path.dirname(resolved) !== releases) throw new Error('Previous release is outside the release directory');
    keep.add(resolved);
  }
  // Only match a complete release identity, never an arbitrary path prefix.
  const prefix = `${releases}/`;
  function remember(text) {
    let offset = text.indexOf(prefix);
    while (offset !== -1) {
      const start = offset + prefix.length;
      const name = text.slice(start, start + 40);
      const boundary = text[start + 40];
      if (revisionPattern.test(name) && (!boundary || /[\s/\0]/.test(boundary))) {
        keep.add(path.join(releases, name));
      }
      offset = text.indexOf(prefix, start);
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      try { remember(fs.realpathSync(path.join(root, entry.name))); }
      catch (error) { if (!gone(error)) throw error; }
    }
  }
  // Never descend into a nested mount. mountinfo encodes spaces and other
  // special characters as octal escapes; decode before comparing paths.
  const mountinfo = fs.readFileSync(path.join(procRoot, 'self', 'mountinfo'), 'utf8');
  for (const line of mountinfo.trim().split('\n')) {
    const mount = line.split(' ')[4];
    if (!mount) throw new Error('Cannot read mount inventory');
    remember(mount.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
  }
  // Read the whole process inventory before deleting anything. A process
  // exiting is normal; denied access or any other error aborts the cleanup.
  for (const pid of fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name))) {
    const proc = path.join(procRoot, pid);
    try {
      for (const name of ['cwd', 'exe']) {
        try { remember(fs.readlinkSync(path.join(proc, name))); }
        catch (error) { if (!gone(error)) throw error; }
      }
      remember(fs.readFileSync(path.join(proc, 'cmdline'), 'utf8'));
      remember(fs.readFileSync(path.join(proc, 'maps'), 'utf8'));
      for (const fd of fs.readdirSync(path.join(proc, 'fd'))) {
        try { remember(fs.readlinkSync(path.join(proc, 'fd', fd))); }
        catch (error) { if (!gone(error)) throw error; }
      }
    } catch (error) { if (!gone(error)) throw error; }
  }
  const candidates = entries.filter((entry) => !keep.has(entry.directory));
  // Validate every candidate's receipt before the first destructive action.
  for (const entry of candidates) {
    if (fs.readFileSync(path.join(entry.directory, 'REVISION'), 'utf8').trim() !== entry.name) {
      throw new Error(`Release receipt mismatch: ${entry.name}`);
    }
  }
  for (const entry of candidates) {
    if (fs.realpathSync(path.join(root, 'current')) !== current) throw new Error('Current release changed');
    const now = fs.lstatSync(entry.directory);
    if (!now.isDirectory() || now.ino !== entry.stat.ino || now.dev !== entry.stat.dev) {
      throw new Error(`Release directory changed: ${entry.name}`);
    }
    console.log(`release retention: ${apply ? 'removing' : 'would remove'} ${entry.name}`);
    if (apply) fs.rmSync(entry.directory, { recursive: true });
  }
  console.log(`release retention: ${candidates.length} ${apply ? 'removed' : 'eligible'}, ${entries.length - candidates.length} retained`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, previous = '', mode = '--dry-run'] = process.argv.slice(2);
  if (!root || !['--apply', '--dry-run'].includes(mode)) {
    console.error('Usage: atoma-prune-releases.mjs ROOT PREVIOUS [--apply|--dry-run]');
    process.exitCode = 1;
  } else {
    try { pruneReleases(root, { previous, apply: mode === '--apply' }); }
    catch (error) { console.error(`release retention: ${error.message}`); process.exitCode = 1; }
  }
}
