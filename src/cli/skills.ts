#!/usr/bin/env tsx
/**
 * atoma skills CLI — inspect and manage the filesystem-backed skill store.
 *
 * Usage:
 *   tsx src/cli/skills.ts list [--l1 <name>] [--dir path]
 *   tsx src/cli/skills.ts show  <l1> <skill-id>  [--dir path]
 *   tsx src/cli/skills.ts reset <l1> <skill-id>  [--dir path]
 *
 * Defaults: --dir from ATOMA_SKILLS_DIR env or ./skills.
 *
 * `reset` is the operator escape hatch for the two promotion dead-ends:
 * a demoted script's `failures > 0` blocks re-promotion forever, and a
 * Sonnet compile refusal stamps `promotionRefusedAt` which parks an
 * unchanged body indefinitely. Resetting zeroes both counters and drops
 * the refusal stamp — the skill re-earns promotion from scratch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillRegistry } from '../skills/registry.js';
import { exportSkillToSpec } from '../skills/exportSpec.js';
import { parseCliArgs } from './args.js';
import { COMPILE_PROMPT_GENERATION } from '../atoms/L2Atom.js';
import { demoteAfter, promoteThreshold, trustThreshold } from '../atoms/cost.js';
import { computeStatsRows, similarityPairs } from '../skills/stats.js';
import type { Skill } from '../skills/types.js';

interface Args {
  command: 'list' | 'show' | 'reset' | 'stats' | 'drop' | 'merge' | 'export' | 'help';
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const { command, positional, flags } = parseCliArgs(argv);
  if (command === null) return { command: 'help', positional, flags };
  if (!['list', 'show', 'reset', 'stats', 'drop', 'merge', 'export', 'help'].includes(command)) {
    return { command: 'help', positional: [command, ...positional], flags };
  }
  return { command: command as Args['command'], positional, flags };
}

function dirFrom(flags: Record<string, string>): string {
  return flags['dir'] ?? process.env['ATOMA_SKILLS_DIR'] ?? './skills';
}

function padCell(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...all.map((r) => r[col]!.length)));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [
    headers.map((h, i) => padCell(h, widths[i]!)).join('  '),
    sep,
    ...rows.map((r) => r.map((c, i) => padCell(c, widths[i]!)).join('  ')),
  ];
  return lines.join('\n');
}

const tableHeaders = ['l1', 'id', 'kind', 'lang', 'succ', 'fail', 'refused', 'updated_at', 'description'];

function formatSkill(l1: string, s: Skill): string[] {
  return [
    l1,
    s.id,
    s.kind,
    s.language ?? '—',
    String(s.successes),
    String(s.failures),
    s.promotionRefusedAt ? s.promotionRefusedAt.slice(0, 10) : '—',
    s.updatedAt.slice(0, 19),
    s.description.length > 50 ? s.description.slice(0, 47) + '...' : s.description,
  ];
}

function cmdList(registry: SkillRegistry, l1Filter: string | undefined): void {
  const namespaces = l1Filter ? [l1Filter] : registry.listNamespaces();
  const rows: string[][] = [];
  for (const ns of namespaces) {
    rows.push(...registry.loadFor(ns).map((s) => formatSkill(ns, s)));
  }
  if (rows.length === 0) {
    console.log(
      l1Filter
        ? `(no skills for L1 "${l1Filter}" under ${registry.rootDir})`
        : `(no skills under ${registry.rootDir})`
    );
    return;
  }
  console.log(renderTable(tableHeaders, rows));
}

function findSkill(registry: SkillRegistry, l1: string, id: string): Skill | null {
  return registry.loadFor(l1).find((s) => s.id === id) ?? null;
}

function cmdShow(registry: SkillRegistry, l1: string, id: string): void {
  const s = findSkill(registry, l1, id);
  if (!s) {
    console.error(`no skill "${id}" for L1 "${l1}" under ${registry.rootDir}`);
    process.exit(1);
  }
  console.log(`${l1} / ${s.id}  (kind: ${s.kind}${s.language ? `, language: ${s.language}` : ''})`);
  console.log(`  description : ${s.description}`);
  console.log(`  when to use : ${s.whenToUse}`);
  console.log(`  counters    : ${s.successes} successes / ${s.failures} failures`);
  if (s.matches) {
    console.log(
      `  matched     : ${s.matches}× (last ${s.lastMatchedAt?.slice(0, 19) ?? '?'})` +
        (s.matches > s.successes + s.failures
          ? ` — ${s.matches - s.successes - s.failures} free ride(s): matched but did not drive the run`
          : '')
    );
  }
  console.log(`  updated at  : ${s.updatedAt}`);
  if (s.promotionRefusedAt) {
    console.log(`  ⚠ promotion refused at ${s.promotionRefusedAt} — \`reset\` clears the stamp`);
    if (s.promotionRefusedReason) {
      console.log(`    reason: ${s.promotionRefusedReason}`);
    }
  }
  if (s.directFailures) {
    console.log(
      `  ⚠ ${s.directFailures} consecutive deterministic-dispatch failure(s) — demotes to llm at ${demoteAfter()}`
    );
  }
  // Lifecycle position: what has to happen next, and whether anything blocks
  // it. Without this an operator sees counters but not the CONSEQUENCE.
  const next: string[] = [];
  if (s.kind === 'llm') {
    if (s.failures > 0) {
      next.push(`blocked: ${s.failures} failure(s) recorded — \`reset\` to clear`);
    } else if (s.promotionRefusedAt && s.promotionRefusedGeneration === COMPILE_PROMPT_GENERATION) {
      next.push('blocked: refused by the CURRENT compiler — revise the body or `reset`');
    } else if (s.promotionRefusedAt) {
      next.push('will RETRY compilation (stamp predates the current compiler)');
    } else if (s.successes >= promoteThreshold()) {
      next.push('eligible NOW for llm→script compilation');
    } else {
      next.push(`${promoteThreshold() - s.successes} more clean run(s) → compile attempt`);
    }
  } else {
    if (s.failures > 0) {
      next.push(`blocked: ${s.failures} failure(s) — dispatch stays off until \`reset\``);
    } else if (s.successes >= trustThreshold()) {
      next.push('TRUSTED — runs via zero-LLM deterministic dispatch');
    } else {
      next.push(`${trustThreshold() - s.successes} more clean run(s) → zero-LLM dispatch`);
    }
    if (!s.fallbackBody) next.push('no _fallback.md — cannot be auto-demoted');
  }
  console.log(`  next        : ${next.join(' · ')}`);
  if (s.fallbackBody) {
    console.log(`  has _fallback.md (original llm body preserved from promotion)`);
  }
  console.log('');
  console.log('== BODY ==');
  console.log(s.body);
}

/**
 * Default matching-surface overlap at which a pair of same-L1 skills is
 * reported as a merge candidate. AWM's healthy libraries sit under ~0.2
 * pairwise overlap; 0.5 flags only the clearly redundant.
 */
const DEFAULT_SIM_THRESHOLD = 0.5;

function cmdStats(registry: SkillRegistry, l1Filter: string | undefined, simFlag: string | undefined): void {
  const namespaces = l1Filter ? [l1Filter] : registry.listNamespaces();
  const byL1 = new Map(namespaces.map((ns) => [ns, registry.loadFor(ns)]));
  const rows = computeStatsRows(byL1, {
    trust: trustThreshold(),
    promote: promoteThreshold(),
    currentGeneration: COMPILE_PROMPT_GENERATION,
  });
  if (rows.length === 0) {
    console.log(
      l1Filter
        ? `(no skills for L1 "${l1Filter}" under ${registry.rootDir})`
        : `(no skills under ${registry.rootDir})`
    );
    return;
  }
  console.log(
    renderTable(
      ['l1', 'id', 'kind', 'match', 'succ', 'fail', 'rides', 'status'],
      rows.map((r) => [
        r.l1,
        r.id,
        r.kind,
        String(r.matches),
        String(r.successes),
        String(r.failures),
        String(r.freeRides),
        r.status,
      ])
    )
  );
  console.log('');
  console.log(
    'match = prefilter picks · rides = matched but did not drive the run (credit withheld) ·'
  );
  console.log('never-matched / matched-never-drove = drop candidates (`skills drop`)');

  const parsed = Number(simFlag);
  const threshold = Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_SIM_THRESHOLD;
  const pairs = similarityPairs(byL1, threshold);
  if (pairs.length > 0) {
    console.log('');
    console.log(`== merge candidates (matching-surface overlap ≥ ${threshold}) ==`);
    for (const p of pairs) {
      console.log(
        `  ${p.l1}: "${p.a}" ↔ "${p.b}"  (${p.score.toFixed(2)})  → skills merge ${p.l1} <keep-id> <absorb-id>`
      );
    }
  }
}

function cmdDrop(registry: SkillRegistry, l1: string, id: string, force: boolean): void {
  const s = findSkill(registry, l1, id);
  if (!s) {
    console.error(`no skill "${id}" for L1 "${l1}" under ${registry.rootDir}`);
    process.exit(1);
  }
  if (s.successes > 0 && !force) {
    console.error(
      `refusing to drop ${l1}/${id}: it has ${s.successes} recorded success(es) — proven knowledge.\n` +
        `Pass --force to drop it anyway.`
    );
    process.exit(1);
  }
  registry.drop(l1, id);
  console.log(`dropped ${l1}/${id} (was ${s.kind}, ${s.successes}✓/${s.failures}✗, ${s.matches ?? 0} matches)`);
}

function cmdMerge(registry: SkillRegistry, l1: string, keepId: string, absorbId: string, force: boolean): void {
  const keep = findSkill(registry, l1, keepId);
  const absorb = findSkill(registry, l1, absorbId);
  if (!keep || !absorb) {
    console.error(
      `merge needs two existing skills; missing: ${[!keep && keepId, !absorb && absorbId].filter(Boolean).join(', ')} (L1 "${l1}", ${registry.rootDir})`
    );
    process.exit(1);
  }
  if (absorb.successes > 0 && !force) {
    console.error(
      `refusing to absorb ${l1}/${absorbId}: its body has ${absorb.successes} recorded success(es) and would be DELETED.\n` +
        `If that body is the one worth keeping, merge in the other direction; otherwise pass --force.`
    );
    process.exit(1);
  }
  const merged = registry.merge(l1, keepId, absorbId);
  if (!merged) {
    console.error(`merge failed (identical ids, or a skill vanished mid-operation)`);
    process.exit(1);
  }
  console.log(`merged ${l1}/${absorbId} → ${l1}/${keepId}:`);
  console.log(`  keeper body/counters untouched (${merged.successes}✓/${merged.failures}✗ preserved)`);
  console.log(`  when_to_use now: ${merged.whenToUse}`);
  console.log(`  absorbed skill deleted (its ${absorb.successes}✓/${absorb.failures}✗ die with its body)`);
}

function cmdExport(registry: SkillRegistry, l1: string, id: string, outDir: string): void {
  const s = findSkill(registry, l1, id);
  if (!s) {
    console.error(`no skill "${id}" for L1 "${l1}" under ${registry.rootDir}`);
    process.exit(1);
  }
  const result = exportSkillToSpec(s);
  if ('error' in result) {
    console.error(`export refused: ${result.error}`);
    process.exit(1);
  }
  const dir = join(outDir, s.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, result.content, 'utf8');
  console.log(`exported ${l1}/${id} → ${path}`);
  console.log(
    '  base-spec frontmatter (name + description only — portable to any Agent Skills runtime,'
  );
  console.log('  including the claude.ai upload path, which rejects non-spec keys).');
  console.log(`  counters/refusal stamps stay home in _meta.json — trust is runtime-local.`);
}

function cmdReset(registry: SkillRegistry, l1: string, id: string): void {
  const before = findSkill(registry, l1, id);
  if (!before) {
    console.error(`no skill "${id}" for L1 "${l1}" under ${registry.rootDir}`);
    process.exit(1);
  }
  registry.resetCounters(l1, id);
  console.log(
    `reset ${l1}/${id}: counters ${before.successes}/${before.failures} → 0/0` +
      (before.promotionRefusedAt ? `, promotionRefusedAt cleared` : '')
  );
  console.log(
    `  the skill re-earns trust from scratch (deterministic dispatch after ${trustThreshold()} clean runs,` +
      ` promotion attempt after ${promoteThreshold()}).`
  );
}

function help(unknown?: string): void {
  if (unknown) console.error(`unknown command: ${unknown}\n`);
  console.log(
    [
      'atoma skills CLI',
      '',
      '  list [--l1 <name>]        — list skills (all namespaces, or one L1)',
      '  show <l1> <skill-id>      — full body + counters + promotion state',
      '  stats [--l1 <name>] [--sim <0..1>]',
      '                            — utility view: matches vs driven runs,',
      '                              free-ride gap, lifecycle status, and',
      '                              merge candidates by matching-surface',
      '                              overlap (default threshold 0.5)',
      '  drop <l1> <skill-id> [--force]',
      '                            — delete a skill. Refused when it has',
      '                              recorded successes unless --force.',
      '  merge <l1> <keep-id> <absorb-id> [--force]',
      '                            — keeper absorbs the other skill\'s',
      '                              when_to_use (routing surface); keeper',
      '                              body + counters untouched; absorbed',
      '                              skill deleted. --force to absorb a',
      '                              skill with recorded successes.',
      '  export <l1> <skill-id> [--out <dir>]',
      '                            — write a portable Agent Skills spec',
      '                              SKILL.md (name + description only) to',
      '                              <dir>/<skill-id>/ (default',
      '                              ./skills-export). llm task recipes',
      '                              only; script/event skills refused.',
      '  reset <l1> <skill-id>     — zero counters AND clear the promotion-',
      '                              refusal stamp. Operator escape hatch for',
      '                              the failures>0 / promotionRefusedAt',
      '                              dead-ends; the skill re-earns trust from',
      '                              scratch.',
      '',
      'Common flags:',
      '  --dir <path>   override ATOMA_SKILLS_DIR (default: ./skills)',
    ].join('\n')
  );
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.command === 'help') {
    help(args.positional[0]);
    // Unknown command → error exit; bare `skills` or `skills help` → 0.
    if (args.positional.length > 0) process.exit(1);
    return;
  }
  const registry = new SkillRegistry(dirFrom(args.flags));

  switch (args.command) {
    case 'list':
      return cmdList(registry, args.flags['l1']);
    case 'stats':
      return cmdStats(registry, args.flags['l1'], args.flags['sim']);
    case 'show': {
      const [l1, id] = args.positional;
      if (!l1 || !id) {
        console.error('usage: show <l1> <skill-id>');
        process.exit(2);
      }
      return cmdShow(registry, l1, id);
    }
    case 'drop': {
      const [l1, id] = args.positional;
      if (!l1 || !id) {
        console.error('usage: drop <l1> <skill-id> [--force]');
        process.exit(2);
      }
      return cmdDrop(registry, l1, id, 'force' in args.flags);
    }
    case 'merge': {
      const [l1, keepId, absorbId] = args.positional;
      if (!l1 || !keepId || !absorbId) {
        console.error('usage: merge <l1> <keep-id> <absorb-id> [--force]');
        process.exit(2);
      }
      return cmdMerge(registry, l1, keepId, absorbId, 'force' in args.flags);
    }
    case 'export': {
      const [l1, id] = args.positional;
      if (!l1 || !id) {
        console.error('usage: export <l1> <skill-id> [--out <dir>]');
        process.exit(2);
      }
      return cmdExport(registry, l1, id, args.flags['out'] ?? './skills-export');
    }
    case 'reset': {
      const [l1, id] = args.positional;
      if (!l1 || !id) {
        console.error('usage: reset <l1> <skill-id>');
        process.exit(2);
      }
      return cmdReset(registry, l1, id);
    }
  }
}

main();
