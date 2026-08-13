import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAUNCHABLE_PROFILES, findLaunchable } from '../src/run/profiles/index.js';
import { BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';

/**
 * Guards for the viz Launch tab.
 *
 * The tab is the SECOND consumer of `TaskProfile` — the first being the
 * runner — and that is most of its architectural value: an interface with a
 * single consumer has nothing keeping it honest. These tests are what make
 * the second consumer bite.
 */

describe('launchable profiles are all describable', () => {
  it('every family carries a label, real help and examples', () => {
    expect(LAUNCHABLE_PROFILES.length).toBeGreaterThan(0);
    for (const { profile } of LAUNCHABLE_PROFILES) {
      const g = profile.guidance;
      expect(g.label.trim(), `${profile.id}: empty label`).not.toBe('');
      // A stub sentence is worse than nothing: it looks like guidance and
      // teaches nothing. The real one is ~700 chars.
      expect(g.help.length, `${profile.id}: help too short to be guidance`).toBeGreaterThan(200);
      expect(g.examples.length, `${profile.id}: needs concrete examples`).toBeGreaterThanOrEqual(2);
      for (const ex of g.examples) expect(ex.trim()).not.toBe('');
    }
  });

  it('every family names an npm script that actually exists', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    for (const { profile, npmScript } of LAUNCHABLE_PROFILES) {
      expect(scripts[npmScript], `${profile.id} points at missing script "${npmScript}"`).toBeTruthy();
    }
  });

  it('the guidance never tells a user to name a tool in their goal', () => {
    // ae63e06 forbids naming tools in subtask descriptions — 194/237 archived
    // subtasks did it, and the clock-cli run burned half its calls on a
    // serve+validate phase the wording had implied. Help text that taught the
    // habit at the source would reintroduce the defect one level up, in the
    // human's own words. The example goals are held to the same rule.
    for (const { profile } of LAUNCHABLE_PROFILES) {
      const corpus = [profile.guidance.help, ...profile.guidance.examples].join(' \n ');
      for (const tool of BUILTIN_TOOL_VOCABULARY) {
        expect(corpus, `${profile.id}: guidance names the tool "${tool}"`).not.toContain(tool);
      }
    }
  });

  it('findLaunchable resolves a known id and rejects an unknown one', () => {
    expect(findLaunchable('build')?.npmScript).toBe('run:build');
    expect(findLaunchable('nope')).toBeUndefined();
    expect(findLaunchable('../etc/passwd')).toBeUndefined();
  });
});

/**
 * The viz i18n parity rule was purely disciplinary until now: AGENTS.md
 * states en/fr must stay in strict parity, and nothing enforced it. A missing
 * key renders as the key itself — loud, but only if someone happens to open
 * that pane in that locale.
 */
describe('viz i18n catalogs stay in parity', () => {
  const html = readFileSync('src/viz/ui.html', 'utf8');
  const lines = html.split('\n');
  const enStart = lines.findIndex((l) => /^ {2}en: \{/.test(l));
  const frStart = lines.findIndex((l) => /^ {2}fr: \{/.test(l));

  function keysBetween(from: number, to: number): Set<string> {
    const out = new Set<string>();
    for (const line of lines.slice(from, to)) {
      const m = /^\s*'([^']+)':/.exec(line);
      if (m) out.add(m[1]!);
    }
    return out;
  }

  it('finds both catalogs', () => {
    expect(enStart).toBeGreaterThan(-1);
    expect(frStart).toBeGreaterThan(enStart);
  });

  it('every English key has a French counterpart', () => {
    const en = keysBetween(enStart, frStart);
    const fr = keysBetween(frStart, frStart + 400);
    expect(en.size).toBeGreaterThan(150);
    const missing = [...en].filter((k) => !fr.has(k));
    expect(missing, `keys missing from the fr catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('the Launch tab keys are present in both', () => {
    const en = keysBetween(enStart, frStart);
    const fr = keysBetween(frStart, frStart + 400);
    for (const k of ['nav.launch', 'launch.family', 'launch.goal', 'launch.command', 'pane.selectLaunch']) {
      expect(en.has(k), `en missing ${k}`).toBe(true);
      expect(fr.has(k), `fr missing ${k}`).toBe(true);
    }
  });
});

describe('viz burn-in lifecycle visibility', () => {
  const html = readFileSync('src/viz/ui.html', 'utf8');
  const server = readFileSync('src/viz/server.ts', 'utf8');

  it('renders compiler refusals and transport errors already present in the API', () => {
    expect(server).toMatch(/refusals:\s*num\(c\[14\]\)\s*\?\?\s*0/);
    expect(server).toMatch(/compileErrors:\s*num\(c\[21\]\)\s*\?\?\s*0/);
    expect(html).toMatch(/r\.refusals[\s\S]{0,120}burnin\.refusals/);
    expect(html).toMatch(/r\.compileErrors[\s\S]{0,120}burnin\.compileErrors/);
    expect(html).toMatch(/f\.refusals[\s\S]{0,120}burnin\.refusals/);
    expect(html).toMatch(/f\.compileErrors[\s\S]{0,120}burnin\.compileErrors/);
  });
});

/**
 * The tab renders a command to COPY, never an argv it builds. A goal
 * containing a double quote must still paste as one shell argument.
 */
describe('the generated command quotes the goal', () => {
  it('escapes embedded double quotes', () => {
    // Mirror of launchCommand() in ui.html — the UI is served verbatim and
    // cannot be imported, so the rule is pinned here and in the source.
    const cmd = (script: string, goal: string): string =>
      'npm run ' + script + ' -- "' + goal.trim().replace(/"/g, '\\"') + '"';
    expect(cmd('run:build', 'Build a CLI that prints "hello"')).toBe(
      'npm run run:build -- "Build a CLI that prints \\"hello\\""'
    );
  });
});

/**
 * No FRENCH string outside the French catalog.
 *
 * The parity test above proves both catalogs hold the same KEYS. It cannot
 * see a call site that skips `t()` entirely, and that is not hypothetical:
 * `'Compteurs'` and `'(vide)'` sat hardcoded in the English source long
 * enough to ship, so the English UI showed French. A sweep then found 15 such
 * literals — `Lien`, `Atome — …`, `(vide)` ×7, `Chargement…` ×5.
 *
 * Detecting "any unlocalised string" needs judgment and would be noisy. This
 * detects the DEMONSTRATED bug class instead, with no judgment required: a
 * recognisably French word in a literal outside the `fr:` block is always
 * wrong, whatever the surrounding code does.
 */
describe('no French leaks into the English source', () => {
  const raw = readFileSync('src/viz/ui.html', 'utf8');
  const lines = raw.split('\n');

  it('finds no French literal outside the fr catalog', () => {
    const frStart = lines.findIndex((l) => /^ {2}fr: \{/.test(l));
    const frEnd = lines.findIndex((l, i) => i > frStart && /^ {2}\},?\s*$/.test(l));
    expect(frStart, 'fr catalog not found').toBeGreaterThan(-1);
    expect(frEnd).toBeGreaterThan(frStart);

    const FRENCH =
      /\b(Atome|Lien|Compteurs|vide|Aucune?|D\u00e9tails|R\u00e9sultat|Co\u00fbt|Dur\u00e9e|Appels|Mod\u00e8le|R\u00e9ponse|Requ\u00eate|Erreur|R\u00e9sum\u00e9|\u00c9tape|Cr\u00e9\u00e9|Raison|Chargement|Recherche|Filtrer|Afficher|Masquer|Fermer)\b/;
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (i >= frStart && i <= frEnd) return; // the fr catalog is meant to be French
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may discuss it
      for (const m of line.matchAll(/['`]([^'`\n]{2,80})['`]/g)) {
        if (FRENCH.test(m[1]!)) offenders.push(`ui.html:${i + 1}  ${JSON.stringify(m[1])}`);
      }
    });
    expect(offenders, `French outside the fr catalog:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * No bare user-facing string handed to `h()` as a child.
 *
 * STRUCTURAL, and that is why it replaced a word-list heuristic. The French
 * detector above was written first and immediately proved its own limit: a
 * follow-up sweep found `Appel LLM`, `dernier run`, `Version actuelle` and
 * `afficher / masquer` — all French, all missed, because a word list is only
 * as good as the words someone thought of. Position in the call tells the
 * truth instead: a quoted literal sitting where `h()` expects a CHILD is
 * rendered text, whatever language it happens to be in.
 *
 * Scoped to literals of two or more words so separators (`' — '`, `'·'`) and
 * single technical tokens (`'args'`, `'error'`) stay out. That leaves a
 * residue this does NOT catch — one-word labels, template strings, innerHTML
 * — so it is a floor, not proof of full coverage.
 */
describe('no bare user-facing string in the viz', () => {
  const lines = readFileSync('src/viz/ui.html', 'utf8').split('\n');

  it('every multi-word h() child goes through t()', () => {
    const enStart = lines.findIndex((l) => /^ {2}en: \{/.test(l));
    const frStart = lines.findIndex((l) => /^ {2}fr: \{/.test(l));
    const frEnd = lines.findIndex((l, i) => i > frStart && /^ {2}\},?\s*$/.test(l));
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (i >= enStart && i <= frEnd) return; // the catalogs ARE the strings
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(
        /h\(\s*'[a-z0-9]+'\s*,\s*(?:\{[^}]*\}|\[[^\]]*\])\s*,\s*'([^']{3,90})'/g
      )) {
        const txt = m[1]!;
        if (/t\(/.test(txt)) continue;
        const words = txt.match(/[A-Za-z][A-Za-z'-]{1,}/g) ?? [];
        if (words.length >= 2) offenders.push(`ui.html:${i + 1}  ${JSON.stringify(txt)}`);
      }
    });
    expect(offenders, `bare strings:\n${offenders.join('\n')}`).toEqual([]);
  });
});
