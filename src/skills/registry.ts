import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Skill, SkillFrontmatter, SkillKind, SkillLanguage, SkillMeta } from './types.js';

/**
 * Sidecar filename holding the original `kind: 'llm'` body of a skill
 * that has since been PROMOTED to `kind: 'script'`. Lives next to
 * SKILL.md inside the skill folder. Read on `loadFor`, written on
 * `promoteToScript`, consulted (and copied back) on `demoteToLlm`.
 * Plain text — no frontmatter — because its only purpose is to be
 * dropped back into SKILL.md verbatim during demotion.
 */
export const FALLBACK_FILENAME = '_fallback.md';

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
        const fallbackPath = join(skillDir, FALLBACK_FILENAME);
        const fallbackBody = existsSync(fallbackPath)
          ? readFileSync(fallbackPath, 'utf8').trim()
          : undefined;
        out.push({
          id: frontmatter.id,
          description: frontmatter.description,
          whenToUse: frontmatter.whenToUse,
          kind: frontmatter.kind,
          ...(frontmatter.language !== undefined ? { language: frontmatter.language } : {}),
          body,
          ...(fallbackBody ? { fallbackBody } : {}),
          successes: meta.successes,
          failures: meta.failures,
          updatedAt: meta.updatedAt,
          ...(meta.promotionRefusedAt ? { promotionRefusedAt: meta.promotionRefusedAt } : {}),
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
    // INTENTIONALLY DROP `promotionRefusedAt`: a save() means the body
    // changed (or the kind flipped). Sonnet's prior refusal was a
    // judgment about the OLD body; the new body deserves a fresh
    // compile attempt next time the trust gate is crossed. Without
    // this clear, an `improveSkillBody`-revised recipe could never
    // earn promotion even if the rewrite makes it script-shaped.
    const metaPath = join(dir, '_meta.json');
    const existing = existsSync(metaPath) ? readMeta(metaPath) : { successes: 0, failures: 0, updatedAt: nowIso() };
    const meta: SkillMeta = {
      successes: existing.successes,
      failures: existing.failures,
      updatedAt: nowIso(),
    };
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

  /**
   * Mark a skill as having recently failed Sonnet compile (the model
   * answered `{"promotable": false, ...}`). The supervisor's
   * promotion gate skips any skill whose meta carries this stamp,
   * preventing a fresh Sonnet compile call on every future success
   * for a skill whose recipe is structurally non-promotable (e.g.
   * recipes containing irreducible LLM reasoning steps like SQL
   * schema design or external-API shape choice). The stamp is
   * cleared automatically by `save()` whenever the skill body is
   * rewritten — a revised body is a new compile candidate.
   *
   * No-op (returns null) when the skill folder doesn't exist; we
   * never auto-create a meta file for a non-existent skill.
   */
  markPromotionRefused(l1Name: string, skillId: string): SkillMeta | null {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    const metaPath = join(dir, '_meta.json');
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    const next: SkillMeta = {
      ...cur,
      promotionRefusedAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /**
   * Promote an existing `kind: 'llm'` skill to `kind: 'script'`. Writes
   * the current llm body to the `_fallback.md` sidecar so demotion can
   * restore it verbatim, then rewrites SKILL.md with the new script
   * body + language. Counters are PRESERVED — promotion is a body
   * reformulation of an already-trusted skill, not a fresh record.
   *
   * Refuses (throws) if the skill on disk is already `kind: 'script'`.
   * That guard keeps double-promotion from clobbering an existing
   * fallback (the original llm body would be lost).
   */
  promoteToScript(args: {
    l1Name: string;
    skillId: string;
    language: SkillLanguage;
    scriptBody: string;
  }): Skill {
    const dir = this.skillDir(args.l1Name, args.skillId);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      throw new Error(`promoteToScript: no skill at ${skillFile}`);
    }
    const text = readFileSync(skillFile, 'utf8');
    const { frontmatter, body: currentBody } = parseFrontmatter(text);
    if (frontmatter.kind !== 'llm') {
      throw new Error(
        `promoteToScript: skill ${args.skillId} is already kind:"${frontmatter.kind}"; refusing to overwrite`
      );
    }
    writeFileSync(join(dir, FALLBACK_FILENAME), currentBody.trim() + '\n', 'utf8');
    return this.save(args.l1Name, {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'script',
      language: args.language,
      body: args.scriptBody,
    });
  }

  /**
   * Demote a `kind: 'script'` skill back to `kind: 'llm'` by restoring
   * the fallback body that was preserved at promotion time. Counters
   * are PRESERVED (the failure counter has already been bumped via
   * `recordFailure` upstream — that's what triggers demotion in the
   * first place). The `_fallback.md` sidecar is INTENTIONALLY left in
   * place: keeping it lets a future re-promotion compare against the
   * historical body, and a `failures > 0` gate at promote-attempt
   * time blocks accidental re-promotion until counters are reset.
   *
   * No-op (returns null) when the skill doesn't exist, isn't currently
   * kind:script, or has no fallback body — the caller should treat
   * those as "nothing to demote" rather than as errors.
   */
  demoteToLlm(l1Name: string, skillId: string): Skill | null {
    const dir = this.skillDir(l1Name, skillId);
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) return null;
    const text = readFileSync(skillFile, 'utf8');
    const { frontmatter } = parseFrontmatter(text);
    if (frontmatter.kind !== 'script') return null;
    const fallbackPath = join(dir, FALLBACK_FILENAME);
    if (!existsSync(fallbackPath)) return null;
    const fallbackBody = readFileSync(fallbackPath, 'utf8').trim();
    if (!fallbackBody) return null;
    return this.save(l1Name, {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'llm',
      body: fallbackBody,
    });
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
    // No skill on disk at all — no SKILL.md, no skill folder. The
    // bump silently no-ops; the supervise loop must not create a
    // counter for a skill that doesn't exist.
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    const metaPath = join(dir, '_meta.json');
    // Hand-written skills come WITHOUT a sidecar meta file. The
    // first counter bump initialises one at zero so future loads
    // see persistent counters. Without this, hand-authored skills
    // never accumulate trust — observed when seeding a kind:script
    // skill via cat heredoc and watching its counter stay empty.
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    const next: SkillMeta = {
      successes: cur.successes + (kind === 'success' ? 1 : 0),
      failures: cur.failures + (kind === 'failure' ? 1 : 0),
      updatedAt: nowIso(),
      // Preserve `promotionRefusedAt` across counter bumps — only
      // `save()` (i.e. a body rewrite) and manual edits clear it.
      ...(cur.promotionRefusedAt ? { promotionRefusedAt: cur.promotionRefusedAt } : {}),
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
    const promotionRefusedAt =
      typeof obj.promotionRefusedAt === 'string' && obj.promotionRefusedAt.length > 0
        ? obj.promotionRefusedAt
        : undefined;
    return {
      successes: typeof obj.successes === 'number' ? obj.successes : 0,
      failures: typeof obj.failures === 'number' ? obj.failures : 0,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : nowIso(),
      ...(promotionRefusedAt ? { promotionRefusedAt } : {}),
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
