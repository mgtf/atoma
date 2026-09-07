import { join, resolve } from 'node:path';

/**
 * WHERE THE SUPERVISOR WRITES, resolved once.
 *
 * The analyst's verdicts, backlog and alerts live under a git-ignored
 * `supervisor/` directory beside the store, overridable with
 * `ATOMA_SUPERVISOR_DIR`. The resident analyst (viz server), the analyst CLI
 * and the MCP verdict readers all have to agree on that directory, so the
 * resolution lives here rather than being spelled three times — the same
 * one-rule-one-home argument `runsDirPath` and `skillsDirPath` rest on.
 */
export function supervisorDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['ATOMA_SUPERVISOR_DIR'] ?? './supervisor');
}

/** One verdict per run: `<supervisorDir>/verdicts/<runId>.json`. */
export function verdictsDirPath(supervisorDir: string): string {
  return join(supervisorDir, 'verdicts');
}
