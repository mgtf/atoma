import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ClaudeProjectSettings {
  permissions?: {
    allow?: string[];
  };
}

describe('Claude Code project permissions', () => {
  it('never pre-authorizes shell execution for every collaborator', () => {
    const settings = JSON.parse(
      readFileSync(resolve('.claude/settings.json'), 'utf8')
    ) as ClaudeProjectSettings;
    const shellGrants = (settings.permissions?.allow ?? []).filter((rule) =>
      rule.startsWith('Bash(')
    );

    expect(
      shellGrants,
      'move shell approvals to ignored .claude/settings.local.json; project settings cross the trust boundary'
    ).toEqual([]);
  });

  it('keeps local permission preferences out of version control', () => {
    const ignore = readFileSync(resolve('.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.claude\/settings\.local\.json$/m);
  });

  it('keeps local Codex MCP commands out of version control', () => {
    const ignore = readFileSync(resolve('.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.codex\/config\.toml$/m);
  });
});
