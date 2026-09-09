import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_PROJECT_RETRIEVAL_LIMITS } from '../contracts/projectRetrieval.js';
import { PROJECT_RETRIEVAL_BM25 } from '../contracts/projectRetrievalCorpus.js';
import { retrievalIndexConfig } from '../projects/retrievalCorpus.js';
import { execFileSync } from 'node:child_process';
import { dirname, basename, join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  retrievalCampaignSpecSchema, retrievalRegistrationSchema,
  type RetrievalCampaignSpec, type RetrievalRegistration, type RetrievalScheduleEntry,
} from '../contracts/retrievalCampaign.js';
import { readRetrievalFile, retrievalSha256, questionFor, snapshotFor, type RetrievalDataset } from './retrievalDataset.js';
import { runHostSupported, unsupportedRunHostMessage } from '../run/platform.js';

export const RETRIEVAL_CAMPAIGN_POLICY =
  'container-no-egress; fresh-prebootstrap-state; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled' as const;

export function retrievalCampaignPolicy(spec: RetrievalCampaignSpec): RetrievalRegistration['policy'] {
  return spec.kind === 'agentic-characterization' ? RETRIEVAL_CAMPAIGN_POLICY : spec.kind === 'haystack-development' ?
    'project-container-no-egress; fresh-authority-and-registry-per-attempt; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled; local-haystack-treatment' :
    'project-container-no-egress; fresh-authority-and-registry-per-attempt; learning-promotion-direct-event-skills-off; prefilter-cache-off; provider-cache-uncontrolled; bm25-only-treatment';
}

/** Historical SQLite settings retained solely to validate archived registrations. */
export function retrievalTreatmentSettings(): Extract<NonNullable<RetrievalCampaignSpec['treatment']>, { backend: 'sqlite-fts5' }> {
  return { backend: 'sqlite-fts5', index: retrievalIndexConfig(), queryLimits: DEFAULT_PROJECT_RETRIEVAL_LIMITS, ranking: PROJECT_RETRIEVAL_BM25 };
}

/** Inputs executed by the source runner, its scorer, build and image recipe. */
export const RETRIEVAL_SOURCE_PATHS = [
  'src', 'scripts', 'docker', 'package.json', 'package-lock.json', '.nvmrc',
  'tsconfig.json', '.dockerignore',
] as const;

export function readRetrievalJson(path: string): unknown {
  const file = resolve(path);
  return JSON.parse(readRetrievalFile(dirname(file), basename(file), 2_000_000).toString('utf8'));
}

/** Source must be tracked and committed; unrelated documentation may be dirty. */
export function retrievalSourceIdentity(repo: string): RetrievalRegistration['source'] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 4_000_000 });
  const dirty = git(['diff', '--name-only', 'HEAD', '--', ...RETRIEVAL_SOURCE_PATHS]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...RETRIEVAL_SOURCE_PATHS]);
  if (dirty.trim() || untracked.trim()) throw new Error('commit runtime/scorer source before registering or executing a retrieval campaign');
  const names = git(['ls-files', '-z', '--', ...RETRIEVAL_SOURCE_PATHS]).split('\0').filter(Boolean).sort();
  if (!names.includes('src/cli/retrievalCampaign.ts')) throw new Error('retrieval campaign source is not tracked');
  const hashes = names.map(path => [path, retrievalSha256(readRetrievalFile(repo, path, 8_000_000))]);
  return { revision: git(['rev-parse', 'HEAD']).trim(), sha256: retrievalSha256(JSON.stringify(hashes)) };
}

export function retrievalRuntime(): RetrievalRegistration['runtime'] {
  if (!runHostSupported(process.platform)) throw new Error(unsupportedRunHostMessage(process.platform));
  return { node: process.version, platform: process.platform as 'darwin' | 'linux', arch: process.arch };
}

/** Alternate which arm goes first for adjacent question/repetition pairs. */
export function retrievalSchedule(spec: RetrievalCampaignSpec): RetrievalScheduleEntry[] {
  const entries: RetrievalScheduleEntry[] = [];
  let pair = 0;
  for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
    for (const questionId of spec.questionIds) {
      if (spec.kind !== 'agentic-characterization') {
        const treatmentArm = spec.kind === 'haystack-development' ? 'atoma-haystack' : 'atoma-bm25';
        // Six permutations balance every position and both A/B orders over six tasks.
        const cycles = [['atoma', 'atoma-bm25', 'frontier-direct'], ['frontier-direct', 'atoma-bm25', 'atoma'],
          ['atoma-bm25', 'frontier-direct', 'atoma'], ['atoma', 'frontier-direct', 'atoma-bm25'],
          ['frontier-direct', 'atoma', 'atoma-bm25'], ['atoma-bm25', 'atoma', 'frontier-direct']] as const;
        const offset = spec.firstArm === 'atoma' ? 0 : spec.firstArm === 'frontier-direct' ? 1 : 2;
        for (const arm of cycles[(pair++ + offset) % cycles.length]!) entries.push({ ordinal: entries.length + 1, questionId, repetition, arm: arm === 'atoma-bm25' ? treatmentArm : arm });
        continue;
      }
      const other = spec.firstArm === 'atoma' ? 'frontier-direct' : 'atoma';
      const arms = pair++ % 2 === 0 ? [spec.firstArm, other] as const : [other, spec.firstArm] as const;
      for (const arm of arms) entries.push({ ordinal: entries.length + 1, questionId, repetition, arm });
    }
  }
  return entries;
}

export function validateRetrievalRegistration(
  input: unknown, dataset: RetrievalDataset
): RetrievalRegistration {
  const registration = retrievalRegistrationSchema.parse(input);
  if (registration.policy !== retrievalCampaignPolicy(registration.spec) ||
      JSON.stringify(registration.schedule) !== JSON.stringify(retrievalSchedule(registration.spec))) {
    throw new Error('registered arm schedule or execution policy is inconsistent');
  }
  if (registration.spec.kind === 'bm25-development' &&
      !isDeepStrictEqual(registration.spec.treatment, retrievalTreatmentSettings())) {
    throw new Error('registered retrieval backend settings differ from the historical SQLite defaults');
  }
  const treatment = registration.spec.treatment;
  if (treatment?.backend === 'haystack' && (!isDeepStrictEqual(treatment.index, retrievalIndexConfig()) ||
      !isDeepStrictEqual(treatment.queryLimits, DEFAULT_PROJECT_RETRIEVAL_LIMITS))) {
    throw new Error('registered Haystack settings differ from the shared corpus/query defaults');
  }
  for (const id of registration.spec.questionIds) {
    const q = questionFor(dataset, id);
    if (snapshotFor(dataset, q.snapshotId).split !== 'development') {
      throw new Error('retrieval campaigns use development questions only; reserve held-out projects for confirmation');
    }
  }
  if (retrievalSha256(readRetrievalFile(dataset.root, 'instruments.lock.json')) !== registration.instrumentsSha256) {
    throw new Error('registered retrieval instruments have changed');
  }
  return registration;
}

/** Historical protocols stay readable, but only current backends may execute. */
export function assertRetrievalCampaignExecutable(spec: RetrievalCampaignSpec): void {
  if (spec.kind === 'bm25-development') throw new Error('SQLite retrieval campaigns are historical; use haystack-development');
}

export function createRetrievalRegistration(
  input: unknown, dataset: RetrievalDataset, repo: string
): RetrievalRegistration {
  const spec = retrievalCampaignSpecSchema.parse(input);
  assertRetrievalCampaignExecutable(spec);
  const runtime = retrievalRuntime();
  if (runtime.node !== `v${readRetrievalFile(repo, '.nvmrc').toString('utf8').trim()}`) {
    throw new Error('use the repository pinned Node version to register a campaign');
  }
  return validateRetrievalRegistration({
    version: 1, registeredAt: new Date().toISOString(), spec,
    source: retrievalSourceIdentity(repo), runtime,
    instrumentsSha256: retrievalSha256(readRetrievalFile(dataset.root, 'instruments.lock.json')),
    policy: retrievalCampaignPolicy(spec), schedule: retrievalSchedule(spec),
  }, dataset);
}

export function writeRetrievalRegistration(path: string, registration: RetrievalRegistration): void {
  writeFileSync(resolve(path), JSON.stringify(registration, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function assertRetrievalExecutionIdentity(registration: RetrievalRegistration, repo: string): void {
  if (retrievalSourceIdentity(repo).sha256 !== registration.source.sha256 ||
      JSON.stringify(retrievalRuntime()) !== JSON.stringify(registration.runtime)) {
    throw new Error('registered source or Node/platform identity changed; register a new campaign');
  }
  try {
    execFileSync('git', ['diff', '--quiet', registration.source.revision, '--', ...RETRIEVAL_SOURCE_PATHS], { cwd: repo });
  } catch { throw new Error('registered revision does not contain the executable source being measured'); }
}

/** Archive committed code, with no ignored stores, credentials or tenant data. */
export function archiveRetrievalSource(repo: string, registration: RetrievalRegistration, out: string): void {
  // Some watched inputs are optional. Unlike diff/ls-files, archive rejects
  // unmatched pathspecs; resolve them against the registered tree first.
  const paths = execFileSync('git', ['ls-tree', '--name-only', '-z', registration.source.revision, '--', ...RETRIEVAL_SOURCE_PATHS], {
    cwd: repo, encoding: 'utf8', maxBuffer: 4_000_000,
  }).split('\0').filter(Boolean);
  if (!paths.length) throw new Error('registered revision has no retrieval source to archive');
  const bytes = execFileSync('git', ['archive', '--format=tar', registration.source.revision, '--', ...paths], {
    cwd: repo, maxBuffer: 32_000_000,
  });
  writeFileSync(join(out, 'source.tar'), bytes, { flag: 'wx', mode: 0o600 });
}
