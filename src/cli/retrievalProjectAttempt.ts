import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStore } from '../auth/store.js';
import { ProjectStore } from '../projects/store.js';
import { projectRunEnvironment, projectRunHostLayout } from '../projects/coordinator.js';
import { ProjectRetrievalLaunchStore } from '../projects/retrievalLaunch.js';
import { buildArtifactManifest } from '../projects/artifacts.js';
import { openDb } from '../registry/db.js';
import type { RetrievalRegistration, RetrievalScheduleEntry } from '../contracts/retrievalCampaign.js';
import type { RunStats } from '../contracts/runStats.js';
import { questionFor, snapshotFor, type RetrievalDataset } from './retrievalDataset.js';
import { HAYSTACK_LAUNCH_ENV } from '../contracts/retrievalHaystack.js';
import { assertRetrievalCampaignExecutable } from './retrievalRegistration.js';
import { parseRunLog } from './burnin.js';

/** Synthetic host-owned project authorities; all three arms take the same tenant runner path. */
export async function prepareRetrievalProjectAttempt(input: {
  registration: RetrievalRegistration; entry: RetrievalScheduleEntry; dataset: RetrievalDataset;
  attempt: string; seed: string; runId: string; env: NodeJS.ProcessEnv; signal: AbortSignal; deadlineAt: number;
}) {
  const { registration, entry, dataset, attempt, seed, runId, signal, deadlineAt } = input;
  assertRetrievalCampaignExecutable(registration.spec);
  const dbPath = input.env['ATOMA_DB_PATH']!;
  const db = openDb(dbPath);
  let handedOff = false;
  try {
    const auth = new AuthStore(db);
    const { viewer } = auth.completeLogin({ provider: 'github', subject: 'benchmark-host', displayName: 'Synthetic benchmark owner',
      email: null, emailVerified: false }, null)!;
    const projects = new ProjectStore(db);
    const project = projects.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: 'Retrieval benchmark', slug: 'retrieval', repositoryTarget: {
        installationId: '123', owner: 'benchmark', name: 'retrieval', visibility: 'private',
      } } });
    const layout = projectRunHostLayout(attempt, viewer.orgId, project.projectId, runId);
    const sourceId = randomUUID();
    const sourceLayout = projectRunHostLayout(attempt, viewer.orgId, project.projectId, sourceId);
    const snapshot = snapshotFor(dataset, questionFor(dataset, entry.questionId).snapshotId);
    const source = buildArtifactManifest({ workspaceRoot: seed, declaredPaths: snapshot.documents.map(d => d.path) }).manifest;
    const create = (id: string, workspacePath: string, runsPath: string, logPath: string) => {
      projects.createProjectRun({ orgId: viewer.orgId, projectId: project.projectId, principalId: viewer.principalId,
        request: { idempotencyKey: id, goal: 'Synthetic retrieval benchmark' }, projectRunId: id,
        hostPaths: { workspacePath, runsPath, logPath } });
      projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
    };
    create(sourceId, seed, sourceLayout.runsPath, sourceLayout.logPath);
    projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: sourceId, from: 'running', to: 'delivered',
      traceId: sourceId, stats: parseRunLog('✓ build finished') });
    projects.saveArtifactManifest(viewer.orgId, sourceId, source);
    create(runId, layout.workspacePath, layout.runsPath, layout.logPath);
    for (const path of [layout.runsPath, layout.skillsPath]) mkdirSync(path, { recursive: true });
    const s = registration.spec;
    // This operator campaign explicitly selects host subscriptions. Exercise the
    // same account-pin/payer construction as project runs, against synthetic state.
    const built = projectRunEnvironment({ hostEnv: { ...input.env, ATOMA_HOST_SUBSCRIPTION_ORG: viewer.orgId },
      dbPath, runId, orgId: viewer.orgId, tierModels: { l1: s.models.l1, l2: s.models.l2, l3: s.models.l3 },
      subscriptionTransport: { principalId: viewer.principalId }, workspacePath: layout.workspacePath,
      runsPath: layout.runsPath, skillsPath: layout.skillsPath, artifactManifestPath: layout.artifactManifestPath });
    const treatment = entry.arm === 'atoma-haystack';
    const env: NodeJS.ProcessEnv = { ...input.env, ...built.environment, ATOMA_SKILL_LEARN: '0', ATOMA_EVENT_SKILLS: '0',
      ATOMA_PROJECT_RETRIEVAL_RECEIPT: treatment ? '1' : undefined };
    // Scientific controls bypass the product coordinator deliberately. Never
    // inherit the host's mandatory project runtime into a registered control.
    delete env[HAYSTACK_LAUNCH_ENV];
    if (entry.arm === 'atoma-haystack') {
      if (s.treatment?.backend !== 'haystack') throw new Error('missing Haystack treatment');
      env[HAYSTACK_LAUNCH_ENV] = JSON.stringify(s.treatment.launch);
    }
    const before = process.cpuUsage(); const started = performance.now();
    let receipt = null;
    if (treatment) {
      receipt = await new ProjectRetrievalLaunchStore(db).prepare(runId, sourceId, { signal, deadlineAt });
    }
    const cpu = process.cpuUsage(before);
    const preparation = { backend: treatment ? s.treatment!.backend : null, receipt,
      phase: 'source-receipt; Haystack indexing and warmup occur inside the timed child run',
      elapsedMs: performance.now() - started, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
      processRssBytes: process.memoryUsage().rss,
      storeBytes: (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number),
      documents: snapshot.documents.length, sourceBytes: snapshot.documents.reduce((n, d) => n + d.bytes, 0),
      passages: null, // Counted during run-owned Haystack initialization, not source capture.
      payers: built.payers };
    writeFileSync(join(attempt, 'preparation.json'), JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await db.backup(join(attempt, 'start.db'));
    handedOff = true;
    return { env, preparation, close: () => { if (db.open) db.close(); }, finish: async (runner: RunStats | null) => {
      try {
        const status = runner?.outcome === 'delivered' ? 'delivered' : runner?.outcome === 'cancelled' ? 'cancelled' : 'failed';
        projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: runId, from: 'running',
          to: status, ...(status === 'failed' ? { error: 'Benchmark runner did not deliver; see archived run log.' } : {}),
          ...(runner ? { stats: runner } : {}), ...(runner?.outcome === 'delivered' ? { traceId: runId } : {}) });
        await db.backup(join(attempt, 'end.db'));
      } finally { db.close(); }
    } };
  } finally { if (!handedOff) db.close(); }
}
