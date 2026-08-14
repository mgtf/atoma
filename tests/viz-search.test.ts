import { describe, expect, it } from 'vitest';
import {
  atomSearchText,
  matchesSearchQuery,
  runSearchText,
  searchTokens,
  skillSearchText,
} from '../src/viz/client/search.js';

describe('viz list search', () => {
  it('trims and requires every token', () => {
    expect(searchTokens('  replay  probes ')).toEqual(['replay', 'probes']);
    expect(matchesSearchQuery('replay-recorded-shell-probes', '  replay  ')).toBe(true);
    expect(matchesSearchQuery('replay-recorded-shell-probes', 'shell probes')).toBe(true);
    expect(matchesSearchQuery('replay-recorded-shell-probes', 'shell http')).toBe(false);
    expect(matchesSearchQuery('anything', '   ')).toBe(true);
  });

  it('does not match a skill whose visible identity lacks the query', () => {
    const recover = skillSearchText(
      { id: 'recover-manifest-run-varying-stdout', kind: 'llm' },
      'Methane'
    );
    const replay = skillSearchText(
      { id: 'replay-recorded-shell-probes', kind: 'script' },
      'Ammonia'
    );
    expect(matchesSearchQuery(recover, 'replay')).toBe(false);
    expect(matchesSearchQuery(replay, 'replay')).toBe(true);
    expect(skillSearchText({
      id: 'recover-manifest-run-varying-stdout',
      kind: 'llm',
    }, 'Methane')).not.toMatch(/replay the recorded|when_to_use|description/i);
  });

  it('keeps registry search off the system prompt', () => {
    const haystack = atomSearchText({
      name: 'Methane',
      description: 'Node HTTP server orchestrator',
      tools: ['fetch_url'],
    });
    expect(matchesSearchQuery(haystack, 'http')).toBe(true);
    expect(matchesSearchQuery(haystack, 'fetch_url')).toBe(true);
    expect(haystack).not.toMatch(/LISTENING_ON_PORT|You are/);
  });

  it('matches runs on id and label only', () => {
    const haystack = runSearchText({
      id: '2026-08-14T00-21-19-742-3521e44f',
      label: 'build-app: rpg docs and config',
    });
    expect(matchesSearchQuery(haystack, 'rpg docs')).toBe(true);
    expect(matchesSearchQuery(haystack, 'calls')).toBe(false);
  });
});
