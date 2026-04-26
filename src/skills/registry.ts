import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Skill, SkillFrontmatter, SkillKind, SkillLanguage, SkillMeta } from './types.js';

/**
 * Filesystem-backed skill store. Skills live under
 *   <rootDir>/<l1-name>/<skill-id>/SKILL.md   (frontmatter + body)
 *   <rootDir>/<l1-name>/<skill-id>/_meta.json (counters)
 *
 * The serialiser is a tiny YAML frontmatter + markdown body parser —
 * we don't pull a YAML library because the frontmatter shape is fixed
 * and small (4 string-typed keys). Anything more complex than the
 * declared shape rejects with a clear error so a malformed skill
 * doesn't silently degrade to a half-loaded object.
 *
 * Counters are kept in a sidecar JSON so hand-edited SKILL.md files
 * are never rewritten by `recordSuccess` / `recordFailure` — the
 * trust signal mutates without touching the human-authored content.
 */
export class SkillRegistry {
  readonly rootDir: string;

  constructor(rootDir = './skills') {
    this.rootDir = resolve(rootDir);
  }

  /** Return the full directory holding all skills for an L1. */
  private namespaceDir(l1Name: string): string {
    return join(this.rootDir, sanitise(l1Name));
  }

  private skillDir(l1Name: string, skillId: string): string {
    return join(this.namespaceDir(l1Name), sanitise(skillId));
  }

  /**
   * Load every skill belonging to a given L1. Missing namespace returns
   * an empty list (a fresh L1 has no skills). Malformed skill folders
   * (no SKILL.md, bad frontmatter) are SKIPPED with a console.warn
   * rather than throwing — one bad file should not bring down the
   * whole atom.
   */
  loadFor(l1Name: string): Skill[] {
    const dir = this.namespaceDir(l1Name);
    if (!existsSync(dir)) return [];
    const out: Skill[] = [];
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      let st;
      try {
        st = statSync(skillDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const text = readFileSync(skillFile, 'utf8');
        const { frontmatter, body } = parseFrontmatter(text);
        const meta = readMeta(join(skillDir, '_meta.json'));
        out.push({
          id: frontmatter.id,
          description: frontmatter.description,
          whenToUse: frontmatter.whenToUse,
          kind: frontmatter.kind,
          ...(frontmatter.language !== undefined ? { language: frontmatter.language } : {}),
          body,
          successes: meta.successes,
          failures: meta.failures,
          updatedAt: meta.updatedAt,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[SkillRegistry] skipping ${skillFile}: ${(err as Error).message}`
        );
      }
    }
    // Stable sort by id so prefilter prompts are deterministic.
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * Persist a skill to disk. Creates the namespace + skill directories
   * as needed and resets counters to zero on first save (a re-save of
   * the same id refreshes content but PRESERVES counters — patches
   * shouldn't punish a skill that was earning trust).
   */
  save(
    l1Name: string,
    skill: Pick<Skill, 'id' | 'description' | 'whenToUse' | 'kind' | 'body'> &
      Partial<Pick<Skill, 'language'>>
  ): Skill {
    if (skill.kind === 'script' && !skill.language) {
      throw new Error(`save: kind:"script" requires a language (node|python|bash)`);
    }
    if (skill.kind === 'llm' && skill.language) {
      throw new Error(`save: kind:"llm" must not declare a language; got "${skill.language}"`);
    }
    const dir = this.skillDir(l1Name, skill.id);
    mkdirSync(dir, { recursive: true });
    const md = renderFrontmatter(
      {
        id: skill.id,
        description: skill.description,
        whenToUse: skill.whenToUse,
        kind: skill.kind,
        ...(skill.language ? { language: skill.language } : {}),
      },
      skill.body
    );
    writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
    // Preserve existing counters if a meta file is already there.
    const metaPath = join(dir, '_meta.json');
    const existing = existsSync(metaPath) ? readMeta(metaPath) : { successes: 0, failures: 0, updatedAt: nowIso() };
    const meta: SkillMeta = { ...existing, updatedAt: nowIso() };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return {
      id: skill.id,
      description: skill.description,
      whenToUse: skill.whenToUse,
      kind: skill.kind,
      ...(skill.language ? { language: skill.language } : {}),
      body: skill.body,
      successes: meta.successes,
      failures: meta.failures,
      updatedAt: meta.updatedAt,
    };
  }

  /** Bump the success counter for a known skill (no-op if not found). */
  recordSuccess(l1Name: string, skillId: string): void {
    this.bump(l1Name, skillId, 'success');
  }

  /** Bump the failure counter for a known skill (no-op if not found). */
  recordFailure(l1Name: string, skillId: string): void {
    this.bump(l1Name, skillId, 'failure');
  }

  private bump(l1Name: string, skillId: string, kind: 'success' | 'failure'): void {
    const dir = this.skillDir(l1Name, skillId);
    const metaPath = join(dir, '_meta.json');
    if (!existsSync(metaPath)) return;
    const cur = readMeta(metaPath);
    const next: SkillMeta = {
      successes: cur.successes + (kind === 'success' ? 1 : 0),
      failures: cur.failures + (kind === 'failure' ? 1 : 0),
      updatedAt: nowIso(),
    };
    writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }
}

/** Reject anything not [a-z0-9._-] so a skill name can't escape its namespace. */
function sanitise(s: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`unsafe skill path component: ${s}`);
  }
  return s;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readMeta(path: string): SkillMeta {
  if (!existsSync(path)) return { successes: 0, failures: 0, updatedAt: nowIso() };
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillMeta>;
    return {
      successes: typeof obj.successes === 'number' ? obj.successes : 0,
      failures: typeof obj.failures === 'number' ? obj.failures : 0,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : nowIso(),
    };
  } catch {
    return { successes: 0, failures: 0, updatedAt: nowIso() };
  }
}

/**
 * Tiny frontmatter parser. Accepts:
 *   ---
 *   id: <kebab>
 *   description: <single line>
 *   when_to_use: <single line>
 *   kind: llm | script
 *   ---
 *   <markdown body>
 *
 * Single-line values only; embedded newlines / lists / nested keys
 * not supported in phase 1. We snake_case the YAML keys to follow
 * the Claude Skills convention; runtime types stay camelCase.
 */
export function parseFrontmatter(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md missing frontmatter delimiters');
  const head = m[1] ?? '';
  const body = (m[2] ?? '').trim();
  const lines = head.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error(`malformed frontmatter line: ${line}`);
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip optional surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  const id = fields['id'];
  const description = fields['description'];
  const whenToUse = fields['when_to_use'];
  const kindRaw = fields['kind'] ?? 'llm';
  const languageRaw = fields['language'];
  if (!id) throw new Error('SKILL.md frontmatter missing required field: id');
  if (!description) throw new Error('SKILL.md frontmatter missing required field: description');
  if (!whenToUse) throw new Error('SKILL.md frontmatter missing required field: when_to_use');
  if (kindRaw !== 'llm' && kindRaw !== 'script') {
    throw new Error(`SKILL.md frontmatter "kind" must be llm | script, got: ${kindRaw}`);
  }
  // Language is required for kind:script, forbidden for kind:llm.
  let language: SkillLanguage | undefined;
  if (kindRaw === 'script') {
    if (!languageRaw) {
      throw new Error('SKILL.md frontmatter kind:"script" requires a "language" field (node|python|bash)');
    }
    if (languageRaw !== 'node' && languageRaw !== 'python' && languageRaw !== 'bash') {
      throw new Error(`SKILL.md frontmatter "language" must be node|python|bash, got: ${languageRaw}`);
    }
    language = languageRaw;
  } else if (languageRaw) {
    throw new Error(`SKILL.md frontmatter "language" only valid with kind:"script"; got language=${languageRaw} on kind:llm`);
  }
  return {
    frontmatter: {
      id,
      description,
      whenToUse,
      kind: kindRaw as SkillKind,
      ...(language ? { language } : {}),
    },
    body,
  };
}

/** Inverse of parseFrontmatter — emits a minimal canonical SKILL.md text. */
export function renderFrontmatter(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = [
    '---',
    `id: ${frontmatter.id}`,
    `description: ${frontmatter.description}`,
    `when_to_use: ${frontmatter.whenToUse}`,
    `kind: ${frontmatter.kind}`,
  ];
  if (frontmatter.language) lines.push(`language: ${frontmatter.language}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}
