/**
 * Every tier selector is REQUIRED and there is no default (2026-09-07), so a
 * test that reaches `modelForTier` without pinning its own would fail on
 * configuration rather than on what it tests. This setup gives the suite the
 * three `api:anthropic:` selectors the built-in Anthropic pins used to imply,
 * and only where the test environment set none. A test about the missing-pin
 * rule deletes the variables itself.
 */
process.env['ATOMA_MODEL_L1'] ??= 'api:anthropic:claude-haiku-4-5-20251001';
process.env['ATOMA_MODEL_L2'] ??= 'api:anthropic:claude-sonnet-5';
process.env['ATOMA_MODEL_L3'] ??= 'api:anthropic:claude-opus-5';
