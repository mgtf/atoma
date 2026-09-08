/** Operator repair: preview by default; archive evidence before versioned patches. */
import { parseArgs } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AtomRegistry } from '../src/registry/atomRegistry.ts';
import { buildNarrowL1Prompt } from '../src/atoms/L2Atom.ts';
import { buildNarrowL2Prompt } from '../src/atoms/L3Atom.ts';
import {
  CANONICAL_L1_SYSTEM_PROMPT_LINES, CANONICAL_L2_SYSTEM_PROMPT_LINES,
  CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES, CANONICAL_HTTP_L2_SYSTEM_PROMPT_LINES,
  CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES, canonicalFullStackPrompt,
} from '../src/atoms/capability.ts';
import { SMOKE_DESIGN_GUIDANCE } from '../src/atoms/prompts.ts';
import { defaultBuiltinTools } from '../src/tools/builtin.ts';
import { ToolSandbox } from '../src/tools/sandbox.ts';

const { values } = parseArgs({ options: {
  db: { type: 'string', default: 'atoma.db' },
  apply: { type: 'boolean', default: false },
} });
const path = resolve(values.db);
const db = new Database(path, { readonly: !values.apply, fileMustExist: true });
try {
  const registry = new AtomRegistry(db);
  const declarations = new Map(defaultBuiltinTools({ sandbox: new ToolSandbox(dirname(path)) })
    .map(tool => [tool.declaration.name, tool.declaration]));
  // Keep every identity and capability. Refresh descriptions/schemas of existing tools only.
  const repairs = [1, 2].flatMap(tier => registry.listByTier(tier).map(type => {
    const tools = type.tools.map(tool => declarations.get(tool.name) ?? tool);
    const marker = type.createdBy;
    let prompt;
    if (marker === 'bootstrap-canonical-full-stack') prompt = canonicalFullStackPrompt(tier);
    else if (marker === 'bootstrap-canonical-http') prompt = (tier === 1
      ? CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES : CANONICAL_HTTP_L2_SYSTEM_PROMPT_LINES).join('\n');
    else if (marker === 'bootstrap-canonical-filescribe') prompt = CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n');
    else if (marker === 'bootstrap-canonical') prompt = tier === 1
      ? [...CANONICAL_L1_SYSTEM_PROMPT_LINES, '', SMOKE_DESIGN_GUIDANCE].join('\n')
      : CANONICAL_L2_SYSTEM_PROMPT_LINES.join('\n');
    else prompt = tier === 1 ? buildNarrowL1Prompt('', tools) : buildNarrowL2Prompt('', tools);
    return { type, tools, prompt };
  })).filter(({ type, tools, prompt }) => type.systemPrompt !== prompt || JSON.stringify(type.tools) !== JSON.stringify(tools));
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'preview', changes: repairs.map(({ type }) => ({ name: type.name, version: type.version, nextVersion: type.version + 1 })) }, null, 2));
  if (values.apply && repairs.length) {
    const archive = join(dirname(path), '.registry-archive', `prompt-repair-${Date.now()}`);
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    await db.backup(join(archive, 'atoma.db'));
    for (const name of ['skills', 'runs']) {
      const source = join(dirname(path), name);
      if (existsSync(source)) cpSync(source, join(archive, name), { recursive: true, errorOnExist: true, force: false });
    }
    writeFileSync(join(archive, 'repair.json'), JSON.stringify(repairs.map(({ type, prompt }) => ({ name: type.name, atomId: type.atomId, previousVersion: type.version, previousPrompt: type.systemPrompt, nextPrompt: prompt })), null, 2));
    db.transaction(() => {
      for (const { type, tools, prompt } of repairs) registry.patch(type.name, {
        systemPromptReplace: prompt, removeTools: type.tools.map(tool => tool.name), addTools: tools,
      }, 'operator:prompt-review', 'Repair contradictory prompts and remove task-specific recovery context; preserve identity and tool scope.');
    })();
    console.log(JSON.stringify({ archive, patched: repairs.length }));
  }
} finally { db.close(); }
