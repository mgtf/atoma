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

import { SkillRegistry } from '../skills/registry.js';
import { COMPILE_PROMPT_GENERATION } from '../atoms/L2Atom.js';
import { demoteAfter, promoteThreshold, trustThreshold } from '../atoms/cost.js';
import type { Skill } from '../skills/types.js';

interface Args {
  command: 'list' | 'show' | 'reset' | 'help';
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  if (rest.length === 0) return { command: 'help', positional: [], flags: {} };
  const cmd = rest[0] as Args['command'];
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  if (!['list', 'show', 'reset', 'help'].includes(cmd)) {
    return { command: 'help', positional: [cmd, ...positional], flags };
  }
  return { command: cmd, positional, flags };
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
    return;
  }
  const registry = new SkillRegistry(dirFrom(args.flags));

  switch (args.command) {
    case 'list':
      return cmdList(registry, args.flags['l1']);
    case 'show': {
      const [l1, id] = args.positional;
      if (!l1 || !id) {
        console.error('usage: show <l1> <skill-id>');
        process.exit(2);
      }
      return cmdShow(registry, l1, id);
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
