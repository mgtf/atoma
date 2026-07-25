import Anthropic from '@anthropic-ai/sdk';

/**
 * Build the Anthropic client from the SDK's native credential chain
 * instead of hard-requiring ANTHROPIC_API_KEY. The zero-arg constructor
 * resolves, in order (first match wins):
 *
 *   1. ANTHROPIC_API_KEY          (classic API key)
 *   2. ANTHROPIC_AUTH_TOKEN       (bearer token, e.g. from
 *                                  `ant auth print-credentials --access-token`)
 *   3. the active `ant auth login` OAuth profile on disk
 *      (~/.config/anthropic/ — the "CLI auth" path; short-lived tokens,
 *      auto-refreshed by the SDK, billed to the same org as an API key)
 *
 * ATOMA_AUTH=cli explicitly DROPS a set ANTHROPIC_API_KEY before
 * construction. Rationale: the chain puts the env key first, so a stale
 * or revoked exported key silently SHADOWS a perfectly good CLI profile
 * and every call 401s — the #1 auth trap. The knob makes "use my CLI
 * login, not whatever key is lying around in this shell" a one-flag
 * decision instead of an `env -u` incantation.
 *
 * Exits the process with actionable guidance when no credential source
 * resolves at all.
 */
export function makeAnthropicClient(): Anthropic {
  if ((process.env['ATOMA_AUTH'] ?? '').toLowerCase() === 'cli') {
    if (process.env['ANTHROPIC_API_KEY']) {
      console.log(
        'ATOMA_AUTH=cli — ignoring the exported ANTHROPIC_API_KEY so the CLI profile / ANTHROPIC_AUTH_TOKEN wins'
      );
      delete process.env['ANTHROPIC_API_KEY'];
    }
  }
  const source = process.env['ANTHROPIC_API_KEY']
    ? 'ANTHROPIC_API_KEY'
    : process.env['ANTHROPIC_AUTH_TOKEN']
      ? 'ANTHROPIC_AUTH_TOKEN (bearer)'
      : 'CLI OAuth profile (ant auth login)';
  try {
    const client = new Anthropic();
    console.log(`anthropic auth: ${source}`);
    return client;
  } catch (err) {
    console.error(
      [
        `no Anthropic credential source found (${(err as Error).message}).`,
        'Provide one of:',
        '  - a valid ANTHROPIC_API_KEY env var',
        '  - ANTHROPIC_AUTH_TOKEN (bearer)',
        '  - a CLI OAuth profile: `brew install anthropics/tap/ant && ant auth login`',
        '  - or set ATOMA_LLM=ollama to run against a local model instead.',
      ].join('\n')
    );
    process.exit(1);
  }
}
