import { describe, it, expect } from 'vitest';
import { assessShareability } from '../src/skills/shareability.js';
import type { Skill } from '../src/skills/types.js';

/**
 * The mechanical half of the cross-organisation review gate
 * (docs/saas-architecture.md §4.2).
 *
 * Run against the real catalog it reports 0 blocked, which is the RIGHT
 * answer and also the reason these tests exist: a detector that never fires
 * proves nothing. Every blocker below is a case this repo actually met.
 */

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'a-skill',
    description: 'does a thing',
    whenToUse: 'when a thing must be done',
    kind: 'llm',
    body: 'Step 1. Do the thing. Step 2. Verify it.',
    successes: 3,
    failures: 0,
    matches: 3,
    ...over,
  } as Skill;
}

const FILE_TOOLS = ['write_file', 'read_file', 'list_files', 'run_shell', 'edit_file'];

describe('leakage — content that came from the run the recipe was distilled from', () => {
  it('catches the documented document-cli-from-source literal', () => {
    // The real incident: a README recipe learned on a file-analyzer task kept
    // `node index.js sample.txt` and shipped it into a Caesar-cipher README.
    const a = assessShareability({
      skill: skill({ body: 'Document the CLI. Run `node index.js sample.txt` and paste the output.' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('blocked');
    expect(a.blockers.map((b) => b.code)).toContain('leak:concrete-file-arg');
  });

  it('catches an absolute path from the machine it was learned on', () => {
    const a = assessShareability({
      skill: skill({ body: 'Read /Users/mgtf/dev/atoma/build/app/notes.md first.' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.blockers.map((b) => b.code)).toContain('leak:absolute-path');
  });

  it('catches a port pinned by one run', () => {
    const a = assessShareability({
      skill: skill({ body: 'Probe http://localhost:59375/health to confirm.' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.blockers.map((b) => b.code)).toContain('leak:pinned-port');
  });

  it('catches an external host dragged in from the originating task', () => {
    const a = assessShareability({
      skill: skill({ body: 'Fetch https://api.acme-corp.com/v1/items and map the fields.' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.blockers.map((b) => b.code)).toContain('leak:external-host');
  });

  it('does NOT flag loopback without a port, or example.com', () => {
    // Generic recipes legitimately say "your local server" and use the
    // reserved example domain; flagging those would make the check noise.
    const a = assessShareability({
      skill: skill({ body: 'Start the server on localhost, then GET https://example.com/spec.' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('review-required');
  });
});

describe('scope — a body must stay inside its host toolset', () => {
  it('blocks a recipe naming a tool the owning L1 cannot declare', () => {
    // The app-task-tracker incident: two skills distilled onto an HTTP host
    // taught validate_html, which that host can never declare.
    const a = assessShareability({
      skill: skill({ body: 'Load the page and call validate_html with a smoke expression. Then validate_html again.' }),
      ownerToolNames: ['write_file', 'read_file', 'run_shell', 'fetch_url', 'start_node_server'],
    });
    expect(a.verdict).toBe('blocked');
    expect(a.blockers.some((b) => b.code === 'scope:undeclared-tool')).toBe(true);
  });
});

describe('script bodies get the scan, and the scan is not the gate', () => {
  it('surfaces a scan flag as a blocker', () => {
    const a = assessShareability({
      skill: skill({ kind: 'script', body: 'const k = require("os").homedir() + "/.ssh/id_rsa";' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('blocked');
    expect(a.blockers.some((b) => b.code.startsWith('scan:'))).toBe(true);
  });

  it('a CLEAN script is still review-required, and says why in the loudest terms', () => {
    const a = assessShareability({
      skill: skill({ kind: 'script', body: 'import { readFileSync } from "node:fs"; console.log("{}");' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('review-required');
    expect(a.humanMustCheck).toMatch(/READ THE NODE SOURCE/);
  });

  it('does not refuse an HTTP host for probing its own loopback server', () => {
    // The measured near-miss: probe-crud reached 5✓, compiled correctly, and
    // the scan refused it for `network:fetch` on a body whose every request
    // went to the server it had just booted.
    const a = assessShareability({
      skill: skill({ kind: 'script', body: 'const r = await fetch("http://127.0.0.1:" + port + "/notes");' }),
      ownerToolNames: ['write_file', 'read_file', 'run_shell', 'fetch_url', 'start_node_server'],
    });
    expect(a.blockers.filter((b) => b.code.startsWith('scan:network'))).toEqual([]);
  });
});

describe('event skills are local by construction', () => {
  it('is not-shareable regardless of content', () => {
    const a = assessShareability({
      skill: skill({ trigger: 'validator rejects for missing ground-truth evidence' }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('not-shareable');
    expect(a.blockers).toEqual([]);
  });
});

describe('free-ride warning', () => {
  it('warns when matches outran the runs the skill actually drove', () => {
    const a = assessShareability({
      skill: skill({ successes: 5, failures: 0, matches: 9 }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.verdict).toBe('review-required'); // a warning must not block
    expect(a.warnings.map((w) => w.code)).toContain('trust:free-ride');
  });

  it('stays quiet when every match drove a run', () => {
    const a = assessShareability({
      skill: skill({ successes: 4, failures: 1, matches: 5 }),
      ownerToolNames: FILE_TOOLS,
    });
    expect(a.warnings).toEqual([]);
  });
});
