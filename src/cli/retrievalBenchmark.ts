import { resolve } from 'node:path';
import { parseArgTokens } from './args.js';
import { loadRetrievalDataset, prepareRetrievalWorkspace } from './retrievalDataset.js';
import { scoreRetrievalWorkspace } from './retrievalScorer.js';
import {
  createRetrievalRegistration, readRetrievalJson, validateRetrievalRegistration,
  writeRetrievalRegistration,
} from './retrievalRegistration.js';

const USAGE = `atoma benchmark retrieval — offline evaluation instruments

usage:
  npm run benchmark -- retrieval validate
  npm run benchmark -- retrieval --dry-run
  npm run benchmark -- retrieval prepare --question <id> --out <new-directory>
  npm run benchmark -- retrieval score --question <id> --workspace <directory>
  npm run benchmark -- retrieval register --spec <json> --out <new-json-file>
  npm run benchmark -- retrieval inspect --registration <json>
  npm run benchmark -- retrieval run --registration <json> --out <new-directory>

All commands accept --dataset <directory> (default: benchmark/retrieval).
prepare copies only the chosen snapshot and prints its task goal. Its parent
directory must exist. It refuses to overwrite an existing workspace.
score returns exit 0 for full success, 1 for a failed answer/deliverable, and
2 for invalid arguments or broken evaluation instruments.

Only run executes models, using host subscriptions and the existing runner.
It requires committed source, the pinned worker image and the global run slot.
register, inspect and all other commands are offline and make no provider calls.
The RAG element and paid API campaigns are not implemented here.
Existing cost-amortisation benchmark options remain unchanged.
`;

/** Also called by the compiled benchmark CLI; no alternate agent runner. */
export async function retrievalBenchmarkMain(argv: string[]): Promise<number> {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    console.log(USAGE);
    return 0;
  }
  const mode = argv[0] === '--dry-run' ? 'validate' : argv[0];
  if (!['validate', 'prepare', 'score', 'register', 'inspect', 'run'].includes(mode ?? '')) {
    console.error(USAGE);
    return 2;
  }
  const allowed = mode === 'prepare' ? ['--dataset', '--question', '--out'] :
    mode === 'score' ? ['--dataset', '--question', '--workspace'] :
    mode === 'register' ? ['--dataset', '--spec', '--out'] :
    mode === 'inspect' ? ['--dataset', '--registration'] :
    mode === 'run' ? ['--dataset', '--registration', '--out'] : ['--dataset'];
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
      (mode === 'score' && (!flags['question'] || !flags['workspace'])) ||
      (mode === 'register' && (!flags['spec'] || !flags['out'])) ||
      (mode === 'inspect' && !flags['registration']) ||
      (mode === 'run' && (!flags['registration'] || !flags['out']))) {
    console.error('missing retrieval argument\n' + USAGE);
    return 2;
  }
  let executing = false;
  try {
    const dataset = loadRetrievalDataset(resolve(flags['dataset'] ?? 'benchmark/retrieval'));
    if (mode === 'register') {
      const registration = createRetrievalRegistration(readRetrievalJson(flags['spec']!), dataset, process.cwd());
      writeRetrievalRegistration(flags['out']!, registration);
      console.log(JSON.stringify({ registration: resolve(flags['out']!), runs: registration.schedule.length, providerCalls: 0 }, null, 2));
      return 0;
    }
    if (mode === 'inspect' || mode === 'run') {
      const registration = validateRetrievalRegistration(readRetrievalJson(flags['registration']!), dataset);
      if (mode === 'inspect') {
        console.log(JSON.stringify({ registration, providerCalls: 0 }, null, 2));
        return 0;
      }
      const { runRetrievalCampaign } = await import('./retrievalCampaign.js');
      const abort = new AbortController();
      const onSignal = () => abort.abort();
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        executing = true;
        const report = await runRetrievalCampaign(registration, dataset, {
          repo: process.cwd(), out: flags['out']!, signal: abort.signal,
        });
        console.log(JSON.stringify(report, null, 2));
        return report.reason === 'completed' ? 0 : 1;
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    }
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
    // The entrypoint's fatal handler exits the process. Merely setting its exit
    // code could leave a wedged spawn's open pipes alive after the backstop.
    // The campaign retains the lease/PGID when that child has not settled.
    if (executing) throw error;
    console.error('retrieval benchmark: ' + (error instanceof Error ? error.message : 'invalid input'));
    return 2;
  }
}
