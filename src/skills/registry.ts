import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendLedger } from '../core/ledger.js';
import { join, resolve } from 'node:path';
import type { Skill, SkillFrontmatter, SkillKind, SkillLanguage, SkillMeta, SkillProvenance } from './types.js';

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
 * Upper bound on the persisted `promotionRefusedReason`. Sonnet's refusal
 * explanations are one or two sentences; the cap only exists so a runaway
 * response can't balloon a `_meta.json` that every `loadFor` reads.
 */
export const REFUSAL_REASON_MAX_CHARS = 500;

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
          ...(frontmatter.trigger !== undefined ? { trigger: frontmatter.trigger } : {}),
          body,
          ...(fallbackBody ? { fallbackBody } : {}),
          successes: meta.successes,
          failures: meta.failures,
          updatedAt: meta.updatedAt,
          ...(meta.promotionRefusedAt ? { promotionRefusedAt: meta.promotionRefusedAt } : {}),
          ...(meta.promotionRefusedReason
            ? { promotionRefusedReason: meta.promotionRefusedReason }
            : {}),
          ...(meta.promotionRefusedGeneration
            ? { promotionRefusedGeneration: meta.promotionRefusedGeneration }
            : {}),
          ...(meta.compiledGeneration ? { compiledGeneration: meta.compiledGeneration } : {}),
          ...(meta.provenance ? { provenance: meta.provenance } : {}),
          ...(meta.directFailures ? { directFailures: meta.directFailures } : {}),
          ...(meta.matches ? { matches: meta.matches } : {}),
          ...(meta.lastMatchedAt ? { lastMatchedAt: meta.lastMatchedAt } : {}),
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
      Partial<Pick<Skill, 'language' | 'trigger'>>,
    provenance?: SkillProvenance
  ): Skill {
    if (skill.kind === 'script' && !skill.language) {
      throw new Error(`save: kind:"script" requires a language (node|python|bash)`);
    }
    if (skill.kind === 'llm' && skill.language) {
      throw new Error(`save: kind:"llm" must not declare a language; got "${skill.language}"`);
    }
    if (skill.kind === 'script' && skill.trigger) {
      throw new Error(`save: kind:"script" must not declare a trigger — event skills are guidance, not scripts`);
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
        ...(skill.trigger ? { trigger: skill.trigger } : {}),
      },
      skill.body
    );
    writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
    appendLedger({
      kind: 'skill-save',
      entity: `${l1Name}/${skill.id}`,
      detail: { kind: skill.kind, ...(provenance ? { mechanism: provenance.mechanism } : {}) },
    });
    // Preserve existing counters if a meta file is already there.
    // INTENTIONALLY DROP `promotionRefusedAt`: a save() means the body
    // changed (or the kind flipped). Sonnet's prior refusal was a
    // judgment about the OLD body; the new body deserves a fresh
    // compile attempt next time the trust gate is crossed. Without
    // this clear, an `improveSkillBody`-revised recipe could never
    // earn promotion even if the rewrite makes it script-shaped.
    const metaPath = join(dir, '_meta.json');
    const existing = existsSync(metaPath) ? readMeta(metaPath) : { successes: 0, failures: 0, updatedAt: nowIso() };
    const nextProvenance: SkillProvenance | undefined = provenance
      ? { ...provenance, at: provenance.at ?? nowIso() }
      : existing.provenance;
    const meta: SkillMeta = {
      successes: existing.successes,
      failures: existing.failures,
      updatedAt: nowIso(),
      ...(nextProvenance ? { provenance: nextProvenance } : {}),
      // Match history survives a body rewrite for the same reason the
      // counters do: the stats gap (matches vs driven) compares against
      // counters that save() preserves.
      ...(existing.matches ? { matches: existing.matches } : {}),
      ...(existing.lastMatchedAt ? { lastMatchedAt: existing.lastMatchedAt } : {}),
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
  markPromotionRefused(
    l1Name: string,
    skillId: string,
    reason?: string,
    generation?: string
  ): SkillMeta | null {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    const metaPath = join(dir, '_meta.json');
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    const trimmed = reason?.trim().slice(0, REFUSAL_REASON_MAX_CHARS);
    const next: SkillMeta = {
      ...cur,
      promotionRefusedAt: nowIso(),
      ...(trimmed ? { promotionRefusedReason: trimmed } : {}),
      ...(generation ? { promotionRefusedGeneration: generation } : {}),
      updatedAt: nowIso(),
    };
    writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
    appendLedger({
      kind: 'promotion-refused',
      entity: `${l1Name}/${skillId}`,
      detail: { ...(generation ? { generation } : {}), ...(trimmed ? { reason: trimmed.slice(0, 160) } : {}) },
    });
    return next;
  }

  /**
   * Bump the consecutive deterministic-dispatch failure count and return
   * the new value. See `SkillMeta.directFailures` for semantics — this is
   * NOT the trust failure counter. No-op (returns 0) for a missing skill.
   */
  markDirectFailure(l1Name: string, skillId: string): number {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return 0;
    const metaPath = join(dir, '_meta.json');
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    const next: SkillMeta = {
      ...cur,
      directFailures: (cur.directFailures ?? 0) + 1,
      updatedAt: nowIso(),
    };
    writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
    appendLedger({
      kind: 'direct-failure',
      entity: `${l1Name}/${skillId}`,
      detail: { streak: next.directFailures ?? 0 },
    });
    return next.directFailures ?? 0;
  }

  /**
   * Drop the refusal/demotion stamp (timestamp, reason, generation) while
   * KEEPING counters. Used when the stamp is stale because the compile
   * prompt generation moved on — the stamp's premise no longer holds, so
   * the evolved compiler deserves a shot without an operator reset.
   */
  clearPromotionRefusal(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    const metaPath = join(dir, '_meta.json');
    if (!existsSync(join(dir, 'SKILL.md')) || !existsSync(metaPath)) return;
    const cur = readMeta(metaPath);
    if (!cur.promotionRefusedAt) return;
    const {
      promotionRefusedAt: _a,
      promotionRefusedReason: _r,
      promotionRefusedGeneration: _g,
      ...rest
    } = cur;
    writeFileSync(metaPath, JSON.stringify({ ...rest, updatedAt: nowIso() }, null, 2), 'utf8');
  }

  /**
   * Record a skill-prefilter match — see `SkillMeta.matches`. Called at
   * match time (before the run outcome is known) so the stats gap between
   * matches and driven runs surfaces free-riding and never-picked skills.
   * NOT a ledger event: a match is neither a trust nor a lifecycle
   * mutation, and it fires on every skill-driven subtask. No-op for a
   * missing skill.
   */
  markMatched(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    const metaPath = join(dir, '_meta.json');
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    const next: SkillMeta = {
      ...cur,
      matches: (cur.matches ?? 0) + 1,
      lastMatchedAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }

  /**
   * Delete a skill folder outright (CLI `skills drop`). The operator's
   * catalog-hygiene verb: retire never-matched debris and free-riding
   * recipes that `skills stats` surfaced. Destructive — the CLI guards
   * proven skills (successes > 0) behind --force; the registry method
   * itself only refuses a missing skill (returns false).
   */
  drop(l1Name: string, skillId: string): boolean {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return false;
    appendLedger({ kind: 'skill-drop', entity: `${l1Name}/${skillId}` });
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Consolidate two skills of one L1 (CLI `skills merge`): the KEEPER's
   * matching surface absorbs the other skill's `when_to_use`, and the
   * absorbed skill is deleted. Deliberately MECHANICAL, no LLM:
   *   - the keeper's BODY, description, kind and counters are untouched —
   *     trust is body-bound, and an unchanged body keeps its earned trust
   *     (this is also why we do NOT route through save(), which would
   *     clear the promotion-refusal stamp on the premise of a body change);
   *   - the absorbed body is deleted, and its counters die with it —
   *     summing counters earned by a DIFFERENT body would inflate trust,
   *     the exact corruption "patch resets trust" exists to prevent.
   * The point of a merge is routing: future subtasks that would have
   * matched the absorbed skill now reach the keeper. If the absorbed body
   * is the one worth keeping, merge in the other direction.
   * Returns the merged keeper, or null when either skill is missing.
   */
  merge(l1Name: string, keepId: string, absorbId: string): Skill | null {
    if (keepId === absorbId) return null;
    const keepDir = this.skillDir(l1Name, keepId);
    const absorbDir = this.skillDir(l1Name, absorbId);
    const keepFile = join(keepDir, 'SKILL.md');
    if (!existsSync(keepFile) || !existsSync(join(absorbDir, 'SKILL.md'))) return null;
    const keep = parseFrontmatter(readFileSync(keepFile, 'utf8'));
    const absorb = parseFrontmatter(readFileSync(join(absorbDir, 'SKILL.md'), 'utf8'));
    const mergedWhenToUse = keep.frontmatter.whenToUse.includes(absorb.frontmatter.whenToUse)
      ? keep.frontmatter.whenToUse
      : `${keep.frontmatter.whenToUse}; also: ${absorb.frontmatter.whenToUse}`;
    writeFileSync(
      keepFile,
      renderFrontmatter({ ...keep.frontmatter, whenToUse: mergedWhenToUse }, keep.body),
      'utf8'
    );
    // Touch updatedAt only — everything else in the keeper's meta
    // (counters, stamps, provenance, match history) is preserved verbatim.
    const metaPath = join(keepDir, '_meta.json');
    const cur = existsSync(metaPath)
      ? readMeta(metaPath)
      : { successes: 0, failures: 0, updatedAt: nowIso() };
    writeFileSync(metaPath, JSON.stringify({ ...cur, updatedAt: nowIso() }, null, 2), 'utf8');
    appendLedger({
      kind: 'skill-merge',
      entity: `${l1Name}/${keepId}`,
      detail: { absorbed: absorbId },
    });
    rmSync(absorbDir, { recursive: true, force: true });
    const merged = this.loadFor(l1Name).find((s) => s.id === keepId);
    return merged ?? null;
  }

  /**
   * Reset the deterministic-failure streak — called on a deterministic
   * SUCCESS only. An LLM-loop success is deliberately not a reset: it
   * proves the recipe, not the script.
   */
  clearDirectFailures(l1Name: string, skillId: string): void {
    const dir = this.skillDir(l1Name, skillId);
    const metaPath = join(dir, '_meta.json');
    if (!existsSync(join(dir, 'SKILL.md')) || !existsSync(metaPath)) return;
    const cur = readMeta(metaPath);
    if (!cur.directFailures) return;
    const { directFailures: _dropped, ...rest } = cur;
    writeFileSync(
      metaPath,
      JSON.stringify({ ...rest, updatedAt: nowIso() }, null, 2),
      'utf8'
    );
  }

  /**
   * Promote an existing `kind: 'llm'` skill to `kind: 'script'`. Writes
   * the current llm body to the `_fallback.md` sidecar so demotion can
   * restore it verbatim, then rewrites SKILL.md with the new script
   * body + language.
   *
   * Counters are RESET to 0/0. They were preserved in the original
   * implementation ("a body reformulation of an already-trusted skill"),
   * and that reasoning is wrong in a way that turned out to be dangerous:
   * the successes were all earned by the MARKDOWN recipe driving a
   * validated LLM tool-loop, while the compiled script is a brand-new
   * artefact that has never executed even once. Inheriting 5/0 armed the
   * deterministic dispatch (`shouldTrustSkill` needs 3/0) on its very
   * first match — and that path returns before the supervise loop, so
   * nothing would have validated its output, and `onFailed`/`demoteToLlm`
   * are unreachable from it. Observed on `document-cli-from-source` after
   * the 2026-07-25 run. Resetting makes the script form earn its 3 clean
   * runs THROUGH the validated loop before it is trusted to run unwatched.
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
    /** COMPILE_PROMPT_GENERATION that produced scriptBody. */
    compiledGeneration?: string;
    /** Model id that ran the compile — provenance {mechanism:'compiled'}. */
    compiledBy?: string;
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
    // CRASH-ORDERED writes (audit finding): the old sequence wrote
    // SKILL.md kind:script FIRST (via save, counters preserved at 5/0)
    // and zeroed the counters after — a crash in that window left a
    // NEVER-EXECUTED script armed for the no-validator deterministic
    // dispatch (shouldTrustSkill needs only 3/0). New order: fallback
    // sidecar, then ONE zeroed meta write (compiledGeneration and
    // provenance included), then SKILL.md LAST as the commit point. A
    // crash anywhere leaves the llm form — worst case with zeroed
    // counters, which merely re-earns trust.
    writeFileSync(join(dir, FALLBACK_FILENAME), currentBody.trim() + '\n', 'utf8');
    const meta: SkillMeta = {
      successes: 0,
      failures: 0,
      updatedAt: nowIso(),
      ...(args.compiledGeneration ? { compiledGeneration: args.compiledGeneration } : {}),
      provenance: {
        mechanism: 'compiled',
        ...(args.compiledBy ? { model: args.compiledBy } : {}),
        at: nowIso(),
      },
    };
    writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    const md = renderFrontmatter(
      {
        id: frontmatter.id,
        description: frontmatter.description,
        whenToUse: frontmatter.whenToUse,
        kind: 'script',
        language: args.language,
      },
      args.scriptBody
    );
    writeFileSync(skillFile, md, 'utf8');
    appendLedger({
      kind: 'promote',
      entity: `${args.l1Name}/${args.skillId}`,
      detail: { language: args.language, ...(args.compiledGeneration ? { compiledGeneration: args.compiledGeneration } : {}) },
    });
    return {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'script',
      language: args.language,
      body: args.scriptBody,
      successes: meta.successes,
      failures: meta.failures,
      updatedAt: meta.updatedAt,
      ...(meta.compiledGeneration ? { compiledGeneration: meta.compiledGeneration } : {}),
      ...(meta.provenance ? { provenance: meta.provenance } : {}),
    };
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
    appendLedger({ kind: 'demote', entity: `${l1Name}/${skillId}` });
    return this.save(l1Name, {
      id: frontmatter.id,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      kind: 'llm',
      body: fallbackBody,
    });
  }

  /**
   * Operator-facing counter reset (CLI `skills reset`). Zeroes both
   * counters AND drops `promotionRefusedAt` — the reset expresses an
   * explicit operator judgment that the skill deserves a fresh start,
   * which includes a fresh Sonnet compile attempt once it re-earns the
   * promotion threshold. This is the only sanctioned way out of the
   * two dead-ends the automatic gates create: `failures > 0` blocks
   * re-promotion forever after a demotion, and a compile-refusal stamp
   * parks an unchanged body indefinitely.
   *
   * Returns the fresh meta, or null when the skill doesn't exist (we
   * never create a meta file for a non-existent skill).
   */
  resetCounters(l1Name: string, skillId: string): SkillMeta | null {
    const dir = this.skillDir(l1Name, skillId);
    if (!existsSync(join(dir, 'SKILL.md'))) return null;
    appendLedger({ kind: 'counters-reset', entity: `${l1Name}/${skillId}`, detail: { reason: 'reset' } });
    // A reset zeroes COUNTERS and drops the refusal stamp — it does not
    // rewrite history about the body itself: compiledGeneration (which
    // compiler produced the current script) and provenance (who wrote the
    // body) describe the artefact, not its trust, and survive the reset.
    const metaPath = join(dir, '_meta.json');
    const cur = existsSync(metaPath) ? readMeta(metaPath) : null;
    const meta: SkillMeta = {
      successes: 0,
      failures: 0,
      updatedAt: nowIso(),
      ...(cur?.compiledGeneration ? { compiledGeneration: cur.compiledGeneration } : {}),
      ...(cur?.provenance ? { provenance: cur.provenance } : {}),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  /**
   * Enumerate the L1 namespaces that have at least one skill folder.
   * Used by the skills CLI to sweep the whole store.
   */
  listNamespaces(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir)
      .filter((entry) => {
        try {
          return statSync(join(this.rootDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  }

  /** Bump the success counter for a known skill (no-op if not found). */
  recordSuccess(l1Name: string, skillId: string): void {
    appendLedger({ kind: 'skill-success', entity: `${l1Name}/${skillId}` });
    this.bump(l1Name, skillId, 'success');
  }

  /** Bump the failure counter for a known skill (no-op if not found). */
  recordFailure(l1Name: string, skillId: string): void {
    appendLedger({ kind: 'skill-failure', entity: `${l1Name}/${skillId}` });
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
      // Preserve `promotionRefusedAt` (+ its reason) and `directFailures`
      // across counter bumps — only `save()` (i.e. a body rewrite), manual
      // edits and their dedicated clear paths reset them.
      ...(cur.promotionRefusedAt ? { promotionRefusedAt: cur.promotionRefusedAt } : {}),
      ...(cur.promotionRefusedReason
        ? { promotionRefusedReason: cur.promotionRefusedReason }
        : {}),
      ...(cur.promotionRefusedGeneration
        ? { promotionRefusedGeneration: cur.promotionRefusedGeneration }
        : {}),
      // AUDIT FIX (verified live-adjacent): omitting compiledGeneration here
      // meant the FIRST success after a promotion erased it, so a later
      // demotion stamped the CURRENT compiler generation — re-parking the
      // skill against the very compiler that would have fixed it. The whole
      // point of recording the COMPILING generation dies without this line.
      ...(cur.compiledGeneration ? { compiledGeneration: cur.compiledGeneration } : {}),
      ...(cur.provenance ? { provenance: cur.provenance } : {}),
      ...(cur.directFailures ? { directFailures: cur.directFailures } : {}),
      ...(cur.matches ? { matches: cur.matches } : {}),
      ...(cur.lastMatchedAt ? { lastMatchedAt: cur.lastMatchedAt } : {}),
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
    // The reason is meaningless without its stamp — a hand-edited meta that
    // deleted the stamp but left the reason reads as unstamped.
    const promotionRefusedReason =
      promotionRefusedAt &&
      typeof obj.promotionRefusedReason === 'string' &&
      obj.promotionRefusedReason.length > 0
        ? obj.promotionRefusedReason.slice(0, REFUSAL_REASON_MAX_CHARS)
        : undefined;
    const directFailures =
      typeof obj.directFailures === 'number' && obj.directFailures > 0
        ? Math.floor(obj.directFailures)
        : undefined;
    return {
      successes: typeof obj.successes === 'number' ? obj.successes : 0,
      failures: typeof obj.failures === 'number' ? obj.failures : 0,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : nowIso(),
      ...(promotionRefusedAt ? { promotionRefusedAt } : {}),
      ...(promotionRefusedReason ? { promotionRefusedReason } : {}),
      ...(promotionRefusedAt && typeof obj.promotionRefusedGeneration === 'string' && obj.promotionRefusedGeneration.length > 0
        ? { promotionRefusedGeneration: obj.promotionRefusedGeneration }
        : {}),
      ...(typeof obj.compiledGeneration === 'string' && obj.compiledGeneration.length > 0
        ? { compiledGeneration: obj.compiledGeneration }
        : {}),
      ...(obj.provenance &&
      typeof obj.provenance === 'object' &&
      !Array.isArray(obj.provenance) &&
      typeof (obj.provenance as unknown as Record<string, unknown>)['mechanism'] === 'string'
        ? { provenance: obj.provenance as SkillProvenance }
        : {}),
      ...(directFailures ? { directFailures } : {}),
      ...(typeof obj.matches === 'number' && obj.matches > 0
        ? { matches: Math.floor(obj.matches) }
        : {}),
      ...(typeof obj.lastMatchedAt === 'string' && obj.lastMatchedAt.length > 0
        ? { lastMatchedAt: obj.lastMatchedAt }
        : {}),
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
  // Agent Skills spec compliance: the canonical key is `name`
  // (agentskills.io base spec — 1-64 chars, kebab, must match the parent
  // directory, all of which atoma's id rules already guarantee). `id` is
  // the legacy atoma key, still READ so pre-migration stores keep
  // loading; the writer emits `name`. Runtime identity stays `Skill.id`.
  const id = fields['name'] ?? fields['id'];
  const description = fields['description'];
  const whenToUse = fields['when_to_use'];
  const kindRaw = fields['kind'] ?? 'llm';
  const languageRaw = fields['language'];
  if (!id) throw new Error('SKILL.md frontmatter missing required field: name (or legacy id)');
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
  // Trigger marks an EVENT-DRIVEN skill (recovery guidance matched against
  // mid-run events) — guidance cannot be a script, so the combination is a
  // structural error, not a tolerated variant.
  const trigger = fields['trigger'];
  if (trigger && kindRaw === 'script') {
    throw new Error('SKILL.md frontmatter "trigger" only valid with kind:"llm" — event skills are guidance, not scripts');
  }
  return {
    frontmatter: {
      id,
      description,
      whenToUse,
      kind: kindRaw as SkillKind,
      ...(language ? { language } : {}),
      ...(trigger ? { trigger } : {}),
    },
    body,
  };
}

/**
 * Inverse of parseFrontmatter — emits a minimal canonical SKILL.md text.
 * Writes the spec-canonical `name` key (parseFrontmatter reads both
 * `name` and legacy `id`); on-disk stores migrate opportunistically on
 * the next body save, and readers never care which era wrote the file.
 */
export function renderFrontmatter(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = [
    '---',
    `name: ${frontmatter.id}`,
    `description: ${frontmatter.description}`,
    `when_to_use: ${frontmatter.whenToUse}`,
    `kind: ${frontmatter.kind}`,
  ];
  if (frontmatter.language) lines.push(`language: ${frontmatter.language}`);
  if (frontmatter.trigger) lines.push(`trigger: ${frontmatter.trigger}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}
