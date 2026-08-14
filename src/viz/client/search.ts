/**
 * One list-filter definition for every viz pane.
 *
 * Haystacks are the labels a human can see (or a one-line identity), never
 * recipe bodies, when_to_use prose, or system prompts. Those used to make
 * "replay" match a recover-* skill whose id does not contain the word.
 * Tokens are AND: every whitespace-separated term must appear.
 */

export function searchTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesSearchQuery(haystack: string, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const text = haystack.toLocaleLowerCase();
  return tokens.every((token) => text.includes(token));
}

export function runSearchText(run: { id: string; label: string }): string {
  return `${run.id} ${run.label}`;
}

export function atomSearchText(atom: {
  name: string;
  description?: string;
  tools?: readonly string[];
}): string {
  return [atom.name, atom.description ?? '', ...(atom.tools ?? [])].join(' ');
}

export function skillSearchText(
  skill: { id: string; kind?: string; language?: string },
  namespace?: string
): string {
  return [namespace, skill.id, skill.kind, skill.language].filter(Boolean).join(' ');
}
