import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RetrievalRegistration } from '../contracts/retrievalCampaign.js';
import { loadRetrievalDataset } from './retrievalDataset.js';
import { runRetrievalCampaign } from './retrievalCampaign.js';
import { signalRunProcessGroup } from './burnin.js';

export type RetrievalCampaignStart = (
  registration: RetrievalRegistration, signal: AbortSignal, progress: (message: string) => void
) => Promise<Awaited<ReturnType<typeof runRetrievalCampaign>>>;

/** The MCP's second door onto the CLI campaign, with a host-owned archive root. */
export function retrievalCampaignHost(repo: string, root: string): RetrievalCampaignStart {
  return async (registration, signal, progress) => {
    const dataset = loadRetrievalDataset(join(repo, 'benchmark/retrieval'));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let childPid: number | null = null;
    const onExit = () => { if (childPid !== null) signalRunProcessGroup(childPid, 'SIGTERM'); };
    process.once('exit', onExit);
    try {
      return await runRetrievalCampaign(registration, dataset, {
        repo, out: join(root, registration.spec.id), signal,
        onChild: pid => { childPid = pid; },
        onAttempt: (entry, runId) => progress(
          `${registration.spec.id}: ${entry.ordinal}/${registration.schedule.length} ${entry.arm} ${entry.questionId}; trace ${runId}`
        ),
      });
    } finally {
      // A wedged child's lease AND exit hook survive until the host exits.
      if (childPid === null) process.removeListener('exit', onExit);
    }
  };
}
