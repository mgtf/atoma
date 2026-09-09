import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { retrievalAttemptStartSchema, retrievalRegistrationSchema } from '../contracts/retrievalCampaign.js';
import { readRetrievalFile } from '../cli/retrievalDataset.js';
import { summarizeTraceFile } from './runIndex.js';
import type { VizRunIndexEntry } from './trace.js';

/** Derived only from host campaign receipts. No new product store or trace copies. */
export class BenchmarkRuns {
  constructor(readonly root: string) {}

  private *directories(path: string, limit: number): Generator<string> {
    try {
      const dir = opendirSync(path);
      try {
        let entry;
        let scanned = 0;
        while (scanned++ < limit && (entry = dir.readSync())) {
          if (entry.isDirectory()) yield entry.name;
        }
      } finally { dir.closeSync(); }
    } catch { /* Missing archive root is an empty corpus. */ }
  }

  private *receipts() {
    // Bound both scans and receipt bytes. Only host-generated archive names
    // enter this reader; a tenant's project store is never searched.
    for (const campaign of this.directories(this.root, 1000)) {
      try {
        const registration = retrievalRegistrationSchema.parse(JSON.parse(
          readRetrievalFile(this.root, `${campaign}/registration.json`, 2_000_000).toString('utf8')
        ));
        if (registration.spec.id !== campaign) continue;
        for (const attempt of this.directories(join(this.root, campaign, 'attempts'), 200)) {
          try {
            const receipt = retrievalAttemptStartSchema.parse(JSON.parse(
              readRetrievalFile(this.root, `${campaign}/attempts/${attempt}/start.json`, 2_000_000).toString('utf8')
            ));
            if (!registration.schedule.some(entry => entry.ordinal === receipt.entry.ordinal &&
              entry.arm === receipt.entry.arm && entry.questionId === receipt.entry.questionId &&
              entry.repetition === receipt.entry.repetition)) continue;
            const runs = receipt.executionEnv['ATOMA_RUNS_DIR'];
            if (!runs) continue;
            const file = resolve(runs, `${receipt.runId}.json`);
            const logicalRoot = resolve(this.root, campaign, 'attempts', attempt);
            const attemptRoot = realpathSync(logicalRoot);
            // macOS /var and /tmp alias their /private counterparts. Permit
            // the host root alias, while rejecting symlinks BELOW the receipt.
            const rel = relative(logicalRoot, file);
            if (!rel || isAbsolute(rel) || rel.split(sep).some(part => part === '..')) continue;
            let checked = attemptRoot;
            for (const part of rel.split(sep)) {
              checked = join(checked, part);
              if (lstatSync(checked).isSymbolicLink()) throw new Error('symlink trace refused');
            }
            yield { campaign, receipt, file };
          } catch { /* Incomplete or invalid attempts are not readable traces. */ }
        }
      } catch { /* Invalid campaign metadata never grants file access. */ }
    }
  }

  list(platformAccess: boolean): VizRunIndexEntry[] {
    if (!platformAccess) return [];
    const entries: VizRunIndexEntry[] = [];
    for (const { campaign, receipt, file } of this.receipts()) {
      const summary = summarizeTraceFile(file);
      if (!summary || summary.id !== receipt.runId) continue;
      entries.push({ ...summary,
        label: `[Benchmark ${receipt.entry.arm} · ${receipt.entry.questionId} · ${campaign}] ${summary.label}`,
      });
    }
    return entries;
  }

  resolve(id: string, platformAccess: boolean): string | null {
    if (!platformAccess) return null;
    for (const { receipt, file } of this.receipts()) {
      if (receipt.runId === id) return file;
    }
    return null;
  }
}
