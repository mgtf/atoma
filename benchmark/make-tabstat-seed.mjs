#!/usr/bin/env node
/**
 * Regenerate the tabstat seed's README invocation list and probe manifest by
 * EXECUTING the CLI, never by transcription.
 *
 *   node benchmark/make-tabstat-seed.mjs [--check]
 *
 * WHY IT IS A SCRIPT. A hand-written manifest is the exact defect class this
 * repository has paid for twice: round 3's compiled verifier could never match
 * because a recorded stdout had been truncated by hand, and `record_probe`
 * exists so that machines, not models, write what was observed. A benchmark
 * seed whose README and manifest disagreed with its own artefact would hand
 * both arms a task that is impossible to pass, and the failure would look like
 * a model failure.
 *
 * `--check` re-runs every invocation and exits non-zero if the committed seed
 * has drifted from what the code actually does — cheap enough to run before
 * every round.
 *
 * It lives OUTSIDE `seeds/tabstat/` on purpose: everything inside that
 * directory is copied into the run's workspace, and a generator in there would
 * let an arm regenerate the very record it is being asked to maintain.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// `--dir` retargets the generator at a copy of the seed. Its one use is
// validating `verify-tabstat.mjs` against a REFERENCE FIX before any round
// runs: proving the scorer passes correct work needs a correctly regenerated
// record, and hand-writing that record would reintroduce the transcription
// defect this script exists to prevent.
const dirIdx = process.argv.indexOf('--dir');
const SEED = dirIdx >= 0 ? process.argv[dirIdx + 1] : join(import.meta.dirname, 'seeds', 'tabstat');
const check = process.argv.includes('--check');

/** Every invocation the seed documents, with the note that goes in the manifest. */
const INVOCATIONS = [
  [['data.csv'], 'invocation 1 of 11: summary of every numeric column'],
  [['--column', 'units', 'data.csv'], 'invocation 2 of 11: one column, all statistics'],
  [['--column', 'delta', 'data.csv'], 'invocation 3 of 11: a column containing negative values'],
  [['--column', 'reserve', 'data.csv'], 'invocation 4 of 11: a column with no values at all'],
  [['--column', 'region', 'data.csv'], 'invocation 5 of 11: a non-numeric column'],
  [['--stat', 'mean', '--column', 'units', 'data.csv'], 'invocation 6 of 11: a single statistic'],
  [['--stat', 'count', '--column', 'units', 'data.csv'], 'invocation 7 of 11: count of non-empty cells'],
  [['--format', 'json', '--column', 'units', 'data.csv'], 'invocation 8 of 11: json output'],
  [['--format', 'json', '--column', 'reserve', 'data.csv'], 'invocation 9 of 11: json for a column with no values'],
  [['--help'], 'invocation 10 of 11: usage text'],
  [['missing.csv'], 'invocation 11 of 11: unreadable file'],
];

function run(args) {
  try {
    const stdout = execFileSync('node', ['tabstat.js', ...args], {
      cwd: SEED, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    return { exitCode: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

const entries = INVOCATIONS.map(([args, note]) => {
  const r = run(args);
  const entry = { cmd: `node tabstat.js ${args.join(' ')}`.trim(), exitCode: r.exitCode, stdout: r.stdout, note };
  if (r.stderr) entry.stderr = r.stderr;
  return entry;
});

const manifest = JSON.stringify({ version: 1, entries }, null, 2) + '\n';

const readme = `# tabstat

Per-column statistics for a simple CSV file. No dependencies.

## Usage

\`\`\`
node tabstat.js [--column <name>] [--stat <name>] [--format text|json] <file.csv>
\`\`\`

- \`--column <name>\` — report one column only; the default reports every numeric column.
- \`--stat <name>\` — report one of \`count\`, \`sum\`, \`mean\`, \`min\`, \`max\`.
- \`--format text|json\` — text is the default.

\`count\` is the number of non-empty cells. \`sum\`, \`mean\`, \`min\` and \`max\` read
every row, an empty cell counting as zero.

## Verified invocations

Each block below was produced by running the command and recording its real
output; \`.atoma-probes.json\` holds the same eleven records in machine form.

${entries
  .map((e) => {
    const body = (e.stdout + (e.stderr ?? '')).replace(/\n$/, '');
    return `### \`${e.cmd}\`\n\nexit ${e.exitCode}\n\n\`\`\`\n${body}\n\`\`\``;
  })
  .join('\n\n')}
`;

if (check) {
  const drift = [];
  const onDisk = (p) => readFileSync(join(SEED, p), 'utf8');
  if (onDisk('.atoma-probes.json') !== manifest) drift.push('.atoma-probes.json');
  if (onDisk('README.md') !== readme) drift.push('README.md');
  if (drift.length > 0) {
    console.error(`✖ seed has drifted from the live CLI: ${drift.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ tabstat seed is self-consistent (${entries.length} invocations replay as recorded)`);
} else {
  writeFileSync(join(SEED, '.atoma-probes.json'), manifest);
  writeFileSync(join(SEED, 'README.md'), readme);
  console.log(`✓ wrote README.md and .atoma-probes.json from ${entries.length} executed invocations`);
}
