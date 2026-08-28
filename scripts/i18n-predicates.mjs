/**
 * i18n-predicates.mjs — the two predicates the locale pipeline GATES on, in ONE
 * place because they are read by mechanisms that cannot import each other.
 * Named apart from the `scripts/i18n-rules/` directory beside it, which holds
 * something else entirely: the per-language style rules handed to the model.
 *
 * `scripts/i18n.mjs` dispatches at module scope (`await runners[command]()`),
 * so importing it from a test would RUN it; the checks in
 * `tests/locales-contract.test.ts` therefore kept their own copies, and the
 * 2026-08-27 review measured what that costs: `translate` accepted
 * `value.length > 0` where `check` demanded `value.trim()`, so a
 * whitespace-only translation was written, committed, and then invisible to
 * every repair path — a permanently red i18n job needing a hand edit.
 *
 * Both consumers import from here now. A blank is a blank once, a placeholder
 * signature is computed once.
 */

/**
 * Every interpolation i18next will act on:
 *   {{name}} · {{ name }} · {{- raw}} · {{count, number}} · $t(other.key)
 *
 * Widened 2026-08-27 (finding 3.12) from `/\{\{\s*\w+\s*\}\}/g`, which saw only
 * the bare form: a value formatted `{{count, number}}` or nesting `$t(...)` had
 * signature "" on BOTH sides, so a translation that dropped it compared equal
 * and passed every gate. No EN value used either form when this was widened,
 * which is exactly when a blind spot is cheap to close.
 */
export const PLACEHOLDER_PATTERN = /\{\{[^{}]*\}\}|\$t\([^()]*\)/g;

/**
 * The sorted set of interpolations in a value. Inner whitespace is normalised
 * away: i18next trims, so `{{ name }}` and `{{name}}` are the SAME
 * interpolation, and reporting drift between them was a false positive.
 */
export function placeholderSignature(value) {
  if (typeof value !== 'string') return '';
  const matches = value.match(PLACEHOLDER_PATTERN);
  if (!matches) return '';
  return matches
    .map((token) => token.replace(/\s+/g, ''))
    .sort()
    .join('|');
}

export function placeholdersMatch(en, target) {
  return placeholderSignature(en) === placeholderSignature(target);
}

/**
 * "Awaiting translation" — the ONE definition. A missing key, an empty string
 * and a whitespace-only string are the same state: nothing a reader can use.
 * Every gate that decides whether a value counts must ask HERE, or the
 * pipeline grows a value that one half writes and the other half refuses.
 */
export function isBlankValue(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}
