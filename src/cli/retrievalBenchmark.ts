import { resolve } from 'node:path';
import { parseArgTokens } from './args.js';
import { loadRetrievalDataset, prepareRetrievalWorkspace } from './retrievalDataset.js';
import { scoreRetrievalWorkspace } from './retrievalScorer.js';

const USAGE = `atoma benchmark retrieval — offline evaluation instruments

usage:
  npm run benchmark -- retrieval validate
  npm run benchmark -- retrieval --dry-run
  npm run benchmark -- retrieval prepare --question <id> --out <new-directory>
  npm run benchmark -- retrieval score --question <id> --workspace <directory>

All commands accept --dataset <directory> (default: benchmark/retrieval).
prepare copies only the chosen snapshot and prints its task goal. Its parent
directory must exist. It refuses to overwrite an existing workspace.
score returns exit 0 for full success, 1 for a failed answer/deliverable, and
2 for invalid arguments or broken evaluation instruments.

These commands make no provider calls and do not execute a live benchmark.
The RAG element and live campaign registration are not implemented here.
Existing cost-amortisation benchmark options remain unchanged.
`;

/** Also called by the compiled benchmark CLI; no alternate agent runner. */
export function retrievalBenchmarkMain(argv: string[]): number {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    console.log(USAGE);
    return 0;
  }
  const mode = argv[0] === '--dry-run' ? 'validate' : argv[0];
  if (!['validate', 'prepare', 'score'].includes(mode ?? '')) {
    console.error(USAGE);
    return 2;
  }
  const allowed = mode === 'prepare' ? ['--dataset', '--question', '--out'] :
    mode === 'score' ? ['--dataset', '--question', '--workspace'] : ['--dataset'];
  const tail = argv.slice(1);
  const seen = new Set<string>();
  // The shared parser accepts arbitrary flags. Validate this command's closed
  // vocabulary first, so a typo cannot silently select another dataset/path.
  for (let i = 0; i < tail.length; i += 2) {
    const name = tail[i];
    const value = tail[i + 1];
    if (!name || !allowed.includes(name) || seen.has(name) || !value || value.startsWith('--')) {
      console.error('invalid or repeated retrieval argument\n' + USAGE);
      return 2;
    }
    seen.add(name);
  }
  const { flags } = parseArgTokens(tail, { valueFlags: allowed.map(flag => flag.slice(2)) });
  if ((mode === 'prepare' && (!flags['question'] || !flags['out'])) ||
      (mode === 'score' && (!flags['question'] || !flags['workspace']))) {
    console.error('missing retrieval argument\n' + USAGE);
    return 2;
  }
  try {
    const dataset = loadRetrievalDataset(resolve(flags['dataset'] ?? 'benchmark/retrieval'));
    if (mode === 'validate') {
      console.log(JSON.stringify({
        status: 'instruments-valid', liveCampaign: 'not-registered', providerCalls: 0,
        snapshots: dataset.corpus.snapshots.map(s => ({
          id: s.id, split: s.split, sha256: s.sha256,
          documents: s.documents.length,
          bytes: s.documents.reduce((sum, f) => sum + f.bytes, 0),
          questions: dataset.questions.filter(q => q.snapshotId === s.id).length,
        })),
        questions: dataset.questions.length,
        maintenanceTasks: dataset.questions.filter(q => q.maintenance).length,
      }, null, 2));
      return 0;
    }
    if (mode === 'prepare') {
      console.log(JSON.stringify(prepareRetrievalWorkspace(dataset, flags['question']!, flags['out']!), null, 2));
      return 0;
    }
    const score = scoreRetrievalWorkspace(dataset, flags['question']!, flags['workspace']!);
    console.log(JSON.stringify(score, null, 2));
    return score.full ? 0 : 1;
  } catch (error) {
    console.error('retrieval benchmark: ' + (error instanceof Error ? error.message : 'invalid input'));
    return 2;
  }
}
