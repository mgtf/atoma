import Anthropic from '@anthropic-ai/sdk';
import { RunnerConfigError } from '../core/errors.js';

/**
 * Build the Anthropic client from the SDK's native credential chain
 * instead of hard-requiring ANTHROPIC_API_KEY. The chain resolves, in
 * order (first match wins):
 *
 *   1. ANTHROPIC_API_KEY          (classic API key)
 *   2. ANTHROPIC_AUTH_TOKEN       (bearer token, e.g. from
 *                                  `ant auth print-credentials --access-token`)
 *   3. the active `ant auth login` OAuth profile on disk
 *      (~/.config/anthropic/ — the "CLI auth" path; short-lived tokens,
 *      auto-refreshed by the SDK, billed to the same org as an API key)
 *
 * ATOMA_AUTH=cli explicitly IGNORES a set ANTHROPIC_API_KEY. Rationale: the
 * chain puts the env key first, so a stale or revoked exported key silently
 * SHADOWS a perfectly good CLI profile and every call 401s — the #1 auth
 * trap. The knob makes "use my CLI login, not whatever key is lying around
 * in this shell" a one-flag decision instead of an `env -u` incantation.
 *
 * `env` is the credential SNAPSHOT, not ambient process state. Passing one
 * is what lets a single process serve more than one credential (invariant
 * T10 in docs/saas-architecture.md); it defaults to `process.env` so every
 * existing single-tenant call site is unchanged. LIMIT, stated because it
 * is not obvious: only the API key and bearer token are snapshot inputs.
 * When both are absent the SDK falls through to profile / workload-identity
 * resolution, which reads the real `process.env` and the config directory
 * itself — a per-run snapshot cannot redirect that half without
 * re-implementing the SDK's chain, which is the drift this repo has been
 * bitten by twice.
 *
 * TWO BEHAVIOURS OF THE INSTALLED SDK, MEASURED 2026-08-17 — do not
 * re-add a guard that assumes otherwise:
 *
 *   - **Construction never throws.** `new Anthropic()` with no API key, no
 *     bearer token, no ANTHROPIC_PROFILE and a nonexistent config dir
 *     returns a client with `apiKey === null`. Credentials resolve on the
 *     FIRST REQUEST ("If omitted … the client automatically resolves
 *     credentials from config files or environment variables on the first
 *     request" — ClientOptions.credentials docs). A missing credential is
 *     therefore a first-call failure, not a construction failure, and this
 *     function cannot detect it. Proving a credential exists is `atoma
 *     doctor`'s job, and it must not be done by re-deriving the chain here.
 *   - **`apiKey: null` ignores a set ANTHROPIC_API_KEY.** That is why
 *     ATOMA_AUTH=cli no longer needs `delete process.env[...]`: mutating
 *     the parent process to influence a constructor made this function
 *     unusable in any process serving a second credential.
 *
 * Throws `RunnerConfigError` — never calls `process.exit`. A library entry
 * that kills the process cannot be hosted: one tenant's bad credential
 * would take down every other tenant's run.
 */
export function makeAnthropicClient(env: NodeJS.ProcessEnv = process.env): Anthropic {
  const forceCli = (env['ATOMA_AUTH'] ?? '').toLowerCase() === 'cli';
  const envApiKey = env['ANTHROPIC_API_KEY'];
  const envAuthToken = env['ANTHROPIC_AUTH_TOKEN'];

  if (forceCli && envApiKey) {
    console.log(
      'ATOMA_AUTH=cli — ignoring the exported ANTHROPIC_API_KEY so the CLI profile / ANTHROPIC_AUTH_TOKEN wins'
    );
  }

  // `null` is the SDK's "no credential supplied" value and suppresses its
  // own env read for that slot, so the snapshot — not process.env — decides.
  const apiKey = forceCli ? null : (envApiKey ?? null);
  const authToken = envAuthToken ?? null;
  const source = apiKey
    ? 'ANTHROPIC_API_KEY'
    : authToken
      ? 'ANTHROPIC_AUTH_TOKEN (bearer)'
      : 'CLI OAuth profile (ant auth login)';

  try {
    const client = new Anthropic({ apiKey, authToken });
    console.log(`anthropic auth: ${source}`);
    return client;
  } catch (err) {
    // Unreachable with the SDK behaviour measured above, kept because a
    // future SDK could restore construction-time validation. It must
    // surface as a config error, not as a dead process.
    throw new RunnerConfigError(
      [
        `no Anthropic credential source found (${(err as Error).message}).`,
        'Provide one of:',
        '  - a valid ANTHROPIC_API_KEY env var',
        '  - ANTHROPIC_AUTH_TOKEN (bearer)',
        '  - a CLI OAuth profile: `brew install anthropics/tap/ant && ant auth login`',
        '  - or pin the tiers to api:ollama:<model> to run against a local model instead.',
      ].join('\n')
    );
  }
}
