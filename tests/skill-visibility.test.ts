import { asStoredNamespace, namespaceOf } from '../src/skills/namespace.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { visibleSkillNamespaces } from '../src/skills/visibility.js';
import { bucketIdForToolNames } from '../src/atoms/capability.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * SHARED-CATALOG VISIBILITY LATTICE (commit B). Skills stay stored per-L1;
 * a donor namespace becomes VISIBLE to a reader iff the donor's bucket is
 * executable by the reader (required ⊆ reader tools). Credit still lands
 * on the OWNER namespace (commit A′). The adversarial review's R1 (script
 * donors need the invocation-ABI test, not the text scan) is pinned here.
 */

const HTTP_TOOLS = ['write_file', 'read_file', 'run_shell', 'fetch_url', 'start_node_server'];
const SCRIBE_TOOLS = ['write_file', 'read_file', 'run_shell', 'list_files'];
const WEB_TOOLS = ['write_file', 'read_file', 'start_static_server', 'validate_html'];

describe('visibleSkillNamespaces — the lattice, pure', () => {
  const namespaces = ['Methane', 'Water', 'Ammonia', 'Ghost'].map(asStoredNamespace);
  const toolNamesFor = (ns: string): readonly string[] | null =>
    ns === 'Methane'
      ? HTTP_TOOLS
      : ns === 'Ammonia'
        ? SCRIBE_TOOLS
        : ns === 'Water'
          ? WEB_TOOLS
          : null;

  it('an http reader sees the file-scribe donor (required ⊆ reader), never the orphan', () => {
    const vis = visibleSkillNamespaces({
      home: asStoredNamespace('Methane'),
      readerToolNames: HTTP_TOOLS,
      namespaces,
      toolNamesFor,
    });
    // Home first; Water (web bucket requires validate_html) is NOT
    // executable by an http reader; Ghost is orphaned (no registry entry).
    expect(vis).toEqual(['Methane', 'Ammonia']);
  });

  it('a file-scribe reader does NOT see the http donor (cannot execute its class)', () => {
    const vis = visibleSkillNamespaces({
      home: asStoredNamespace('Ammonia'),
      readerToolNames: SCRIBE_TOOLS,
      namespaces,
      toolNamesFor,
    });
    expect(vis).toEqual(['Ammonia']);
  });

  it('a kitchen-sink reader sees every live bucket; home stays first', () => {
    const ALL = [...new Set([...HTTP_TOOLS, ...WEB_TOOLS, ...SCRIBE_TOOLS])];
    const vis = visibleSkillNamespaces({
      home: asStoredNamespace('Ammonia'),
      readerToolNames: ALL,
      namespaces,
      toolNamesFor,
    });
    expect(vis[0]).toBe('Ammonia');
    expect(vis).toContain('Methane');
    expect(vis).toContain('Water');
  });

  it('a null-bucket reader (no write_file) sees home only', () => {
    const vis = visibleSkillNamespaces({
      home: asStoredNamespace('Weird'),
      readerToolNames: ['read_file'],
      namespaces: [...namespaces, asStoredNamespace('Weird')],
      toolNamesFor: (ns) => (ns === 'Weird' ? ['read_file'] : toolNamesFor(ns)),
    });
    expect(vis).toEqual(['Weird']);
  });

  it('kill switch restores the exact per-L1 behaviour', () => {
    const before = process.env['ATOMA_SKILL_SHARED_CATALOG'];
    process.env['ATOMA_SKILL_SHARED_CATALOG'] = '0';
    try {
      expect(
        visibleSkillNamespaces({
          home: asStoredNamespace('Methane'),
          readerToolNames: HTTP_TOOLS,
          namespaces,
          toolNamesFor,
        })
      ).toEqual(['Methane']);
    } finally {
      if (before === undefined) delete process.env['ATOMA_SKILL_SHARED_CATALOG'];
      else process.env['ATOMA_SKILL_SHARED_CATALOG'] = before;
    }
  });

  it('bucketIdForToolNames mirrors the Tool[] variant', () => {
    expect(bucketIdForToolNames(HTTP_TOOLS)).toBe('http-server-build+probe');
    expect(bucketIdForToolNames(SCRIBE_TOOLS)).toBe('file-scribe');
    expect(bucketIdForToolNames(['read_file'])).toBeNull();
  });
});

describe('L2.runSubtask — donor match with owner-routed credit', () => {
  let dir: string;
  let skills: SkillRegistry;
  let reg: AtomRegistry;

  const mkType = (tier: 1 | 2, description: string, tools: readonly string[]): void => {
    reg.create(tier, {
      description,
      systemPrompt: `You are a tier-${tier}.`,
      tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
      params: {},
      createdBy: 'test',
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-lattice-'));
    skills = new SkillRegistry(dir);
    reg = new AtomRegistry(openDb(':memory:'));
    mkType(2, 'orchestrator', []);
    mkType(1, 'http builder', HTTP_TOOLS); // Water (first L1 name)
    mkType(1, 'file scribe', SCRIBE_TOOLS); // second L1 → taxonomy name
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches a donor's llm recipe and credits the DONOR namespace", async () => {
    // A prefilter TARGET is a display name (the model picks by name); a skill
    // NAMESPACE is the atom id. Splitting them is the whole point of T4.
    const [t1a, t1b] = reg.listByTier(1);
    const l1aName = t1a!.name;
    const l1a = namespaceOf(t1a!);
    const l1b = namespaceOf(t1b!);
    // The donor (file-scribe) owns the only skill.
    skills.save(l1b, {
      id: 'replay-recorded-probes',
      description: 'replay recorded shell probes',
      whenToUse: 'a probes manifest exists and needs re-verification',
      kind: 'llm',
      body: '1. read the manifest with read_file\n2. run_shell each recorded cmd\n3. compare exit codes',
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter → the HTTP L1 (the reader).
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: l1aName, confidence: 'high', reasoning: 't' }));
    // Skill prefilter sees the donor's recipe in the merged catalog → match.
    ctx.llm.enqueueText(
      jsonText({ kind: 'reuse', target: 'replay-recorded-probes', confidence: 'high', reasoning: 'fit' })
    );
    // L1 plan + validate + execute + validate (untrusted child, full cycle).
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'run the recorded cmds', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'verified', summary: 'replayed 3 probes, all matched' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'result ok' }));

    await neuron.handleDirect({ description: 'confirm the recorded probes still pass' }, ctx);

    const donorSkill = skills.loadFor(l1b)[0]!;
    expect(donorSkill.successes).toBe(1); // credit landed on the OWNER
    expect(donorSkill.matches).toBe(1);
    expect(skills.loadFor(l1a)).toHaveLength(0); // nothing materialised at the reader
  });

  it('commit C: a draft whose id exists at a VISIBLE donor is never re-created at home', async () => {
    const envBefore = process.env['ATOMA_SKILL_LEARN'];
    process.env['ATOMA_SKILL_LEARN'] = '1';
    try {
      // A prefilter TARGET is a display name (the model picks by name); a skill
    // NAMESPACE is the atom id. Splitting them is the whole point of T4.
    const [t1a, t1b] = reg.listByTier(1);
    const l1aName = t1a!.name;
    const l1a = namespaceOf(t1a!);
    const l1b = namespaceOf(t1b!);
      // The donor owns 'replay-recorded-probes'; the reader will try to
      // learn a draft with the SAME id after a novel run.
      skills.save(l1b, {
        id: 'replay-recorded-probes',
        description: 'replay recorded shell probes',
        whenToUse: 'manifest exists',
        kind: 'llm',
        body: '1. read_file the manifest\n2. run_shell each cmd',
      });
      // A scarecrow at home so the skill prefilter fires (and escalates).
      skills.save(l1a, {
        id: 'unrelated',
        description: 'something else',
        whenToUse: 'never',
        kind: 'llm',
        body: 'b',
      });
      for (let i = 0; i < 3; i++) reg.recordSuccess(l1aName);
      const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: l1aName, confidence: 'high', reasoning: 't' }));
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'ok' }));
      // The C3 learner emits a draft colliding with the donor's id.
      ctx.llm.enqueueText(
        JSON.stringify({
          id: 'replay-recorded-probes',
          description: 'near-duplicate of the donor recipe',
          when_to_use: 'manifest exists',
          body: '1. read_file the manifest\n2. run_shell each recorded cmd',
        })
      );

      await neuron.handleDirect({ description: 'novel-ish verification task' }, ctx);
      // Not re-created at home; the donor's copy is untouched.
      expect(skills.loadFor(l1a).map((s) => s.id)).toEqual(['unrelated']);
      expect(skills.loadFor(l1b).map((s) => s.id)).toEqual(['replay-recorded-probes']);
    } finally {
      if (envBefore === undefined) delete process.env['ATOMA_SKILL_LEARN'];
      else process.env['ATOMA_SKILL_LEARN'] = envBefore;
    }
  });

  it('R1: a donor SCRIPT is invisible to a reader lacking the invocation ABI (run_shell)', async () => {
    const [, l1b] = reg.listByTier(1).map((t) => namespaceOf(t));
    mkType(1, 'web builder', WEB_TOOLS); // third L1 — the ABI-less reader
    const webName = reg.listByTier(1).map((t) => t.name)[2]!;
    // Donor script (its body is Node source — the text filter cannot judge it).
    skills.save(l1b!, {
      id: 'compiled-replayer',
      description: 'replay probes deterministically',
      whenToUse: 'manifest exists',
      kind: 'script',
      language: 'node',
      body: "import fs from 'node:fs';\nconsole.log(JSON.stringify({output:1, summary:'ok'}));",
    });
    const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
    const ctx = makeCtx();
    // Tier prefilter → the WEB L1 (no run_shell).
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: webName, confidence: 'high', reasoning: 't' }));
    // NO skill-prefilter reply enqueued: the donor's script must be
    // filtered out and the web reader has no other skills → matchSkill
    // short-circuits without an LLM call.
    ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'built' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'result ok' }));

    await neuron.handleDirect({ description: 'build the page' }, ctx);
    // 5 calls total — none of them a skill prefilter (its catalog was empty
    // after the ABI filter dropped the donor script).
    expect(ctx.llm.calls).toHaveLength(5);
    const donor = skills.loadFor(l1b!)[0]!;
    expect(donor.matches ?? 0).toBe(0);
    expect(donor.failures).toBe(0); // the 17✓-asset protection: no cross-blame
  });
});
