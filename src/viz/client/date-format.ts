/**
 * Human-readable metadata timestamps. Operational clocks and exact diagnostic
 * tooltips keep their seconds; catalogue metadata normally does not need them.
 * Invalid values remain visible verbatim instead of becoming "Invalid Date".
 */
export function formatDateTime(
  at: string | number,
  locale: string,
  options: { seconds?: boolean; dateStyle?: 'long' | 'full' } = {}
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  return date.toLocaleString(locale, {
    dateStyle: options.dateStyle ?? 'long',
    timeStyle: options.seconds ? 'medium' : 'short',
  });
}
