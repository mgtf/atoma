import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';
import { launchCommand } from '../src/viz/client/launch-utils.js';
import { I18N_CATALOGS } from '../src/viz/client/i18n.js';
import { LAUNCHABLE_PROFILES, findLaunchable } from '../src/run/profiles/index.js';

describe('launchable profiles are all describable', () => {
  it('every family carries a label, real help and examples', () => {
    expect(LAUNCHABLE_PROFILES.length).toBeGreaterThan(0);
    for (const { profile } of LAUNCHABLE_PROFILES) {
      const guidance = profile.guidance;
      expect(guidance.label.trim(), `${profile.id}: empty label`).not.toBe('');
      expect(guidance.help.length, `${profile.id}: help too short`).toBeGreaterThan(200);
      expect(guidance.examples.length, `${profile.id}: needs examples`).toBeGreaterThanOrEqual(2);
      for (const example of guidance.examples) expect(example.trim()).not.toBe('');
    }
  });

  it('every family names an npm script that actually exists', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    for (const { profile, npmScript } of LAUNCHABLE_PROFILES) {
      expect(scripts[npmScript], `${profile.id} points at missing script "${npmScript}"`).toBeTruthy();
    }
  });

  it('the guidance never tells a user to name a tool in their goal', () => {
    for (const { profile } of LAUNCHABLE_PROFILES) {
      const corpus = [profile.guidance.help, ...profile.guidance.examples].join(' \n ');
      for (const tool of BUILTIN_TOOL_VOCABULARY) {
        expect(corpus, `${profile.id}: guidance names "${tool}"`).not.toContain(tool);
      }
    }
  });

  it('resolves known ids and rejects unknown or traversal-shaped ids', () => {
    expect(findLaunchable('build')?.npmScript).toBe('run:build');
    expect(findLaunchable('nope')).toBeUndefined();
    expect(findLaunchable('../etc/passwd')).toBeUndefined();
  });
});

describe('viz React/MUI build contract', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const server = readFileSync('src/viz/server.ts', 'utf8');
  const app = readFileSync('src/viz/client/App.tsx', 'utf8');
  const burnin = readFileSync('src/viz/client/features/BurninView.tsx', 'utf8');
  const chart = readFileSync('src/viz/client/burnin-chart.ts', 'utf8');
  const picker = readFileSync('src/viz/client/run-picker.tsx', 'utf8');
  const devLauncher = readFileSync('scripts/viz-dev.mjs', 'utf8');
  const vite = readFileSync('vite.config.ts', 'utf8');

  it('has HMR development and compiled static deployment paths', () => {
    expect(existsSync('src/viz/client/index.html')).toBe(true);
    expect(existsSync('src/viz/client/main.tsx')).toBe(true);
    expect(existsSync('src/viz/client/main.js')).toBe(false);
    // Vite proxies the `/api` prefix. A root-level `api.ts` module is also
    // caught by that proxy and arrives as application/octet-stream.
    expect(existsSync('src/viz/client/api.ts')).toBe(false);
    expect(existsSync('src/viz/client/data-api.ts')).toBe(true);
    expect(pkg.scripts['viz']).toMatch(/viz-dev/);
    expect(pkg.scripts['viz:build']).toMatch(/vite build/);
    expect(pkg.scripts['viz:serve']).toBe('node dist/viz/server.js');
    expect(pkg.scripts['build']).toMatch(/viz:build/);
    expect(server).toMatch(/dist\/viz\/client|CLIENT_DIR/);
    expect(pkg.devDependencies['react']).toBeTruthy();
    expect(pkg.devDependencies['@mui/material']).toBeTruthy();
    expect(pkg.devDependencies['@headlessui/react']).toBeTruthy();
    expect(vite).toMatch(/plugin-react/);
    expect(app).toMatch(/ThemeProvider|lazy\(/);
    expect(devLauncher).toContain('ATOMA_VIZ_DEV_URL');
    expect(devLauncher).toContain('process.execPath');
    expect(devLauncher).not.toMatch(/npm['"],\s*\['exec'|npm exec/);
    expect(server).toContain('res.writeHead(307');
  });

  it('uses component-based scalable charting, pagination and tooltips', () => {
    expect(burnin).toMatch(/import\('\.\.\/burnin-chart\.js'\)/);
    expect(chart).toMatch(/from 'echarts\/core'/);
    expect(burnin).toMatch(/type:\s*'slider'/);
    expect(burnin).toMatch(/PAGE_SIZE\s*=\s*50/);
    expect(burnin).toMatch(/<HelpChip/);
    expect(burnin).toMatch(/burnin\.metric\.fallbacks/);
    expect(picker).toMatch(/virtual=\{\{ options: filtered \}\}/);
    expect(picker).toMatch(/ComboboxInput/);
    expect(picker).toMatch(/ArrowDropDownIcon/);
    expect(picker).toMatch(/SearchIcon/);
    expect(picker).not.toContain('>⌄<');
    expect(picker).toMatch(/requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/);
  });
});

describe('viz i18n catalogs stay in parity', () => {
  it('every English key has a French counterpart', () => {
    const en = Object.keys(I18N_CATALOGS.en);
    const fr = new Set(Object.keys(I18N_CATALOGS.fr));
    expect(en.length).toBeGreaterThan(150);
    expect(en.filter((key) => !fr.has(key))).toEqual([]);
    expect(Object.keys(I18N_CATALOGS.fr).filter((key) => !(key in I18N_CATALOGS.en))).toEqual([]);
  });

  it('the Launch tab keys are present in both', () => {
    for (const key of ['nav.launch', 'launch.family', 'launch.goal', 'launch.command', 'pane.selectLaunch']) {
      expect(I18N_CATALOGS.en[key], `en missing ${key}`).toBeTruthy();
      expect(I18N_CATALOGS.fr[key], `fr missing ${key}`).toBeTruthy();
    }
  });
});

describe('viz burn-in lifecycle visibility', () => {
  const burnin = readFileSync('src/viz/client/features/BurninView.tsx', 'utf8');
  const server = readFileSync('src/viz/server.ts', 'utf8');

  it('renders compiler refusals and transport errors already present in the API', () => {
    expect(server).toMatch(/refusals:\s*num\(c\[14\]\)\s*\?\?\s*0/);
    expect(server).toMatch(/compileErrors:\s*num\(c\[21\]\)\s*\?\?\s*0/);
    expect(burnin).toContain("[row.refusals, '⛔', 'burnin.metric.refusals']");
    expect(burnin).toContain("[row.compileErrors, '⚠', 'burnin.metric.compileErrors']");
  });
});

describe('the generated command quotes the goal', () => {
  it('escapes embedded double quotes', () => {
    expect(
      launchCommand(
        { id: 'build', npmScript: 'run:build', label: 'Build', help: '', examples: [] },
        'Build a CLI that prints "hello"'
      )
    ).toBe('npm run run:build -- "Build a CLI that prints \\"hello\\""');
  });
});

describe('the component client contains no legacy DOM renderer', () => {
  it('uses React roots and MUI components rather than the custom h() helper', () => {
    const sources = [
      'src/viz/client/App.tsx',
      'src/viz/client/features/RunsView.tsx',
      'src/viz/client/features/RegistryView.tsx',
      'src/viz/client/features/SkillsView.tsx',
      'src/viz/client/features/BurninView.tsx',
      'src/viz/client/features/LaunchView.tsx',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(sources).not.toMatch(/\bfunction h\(|\bh\(\s*['"]/);
    expect(sources).toMatch(/<Paper|<Stack|<Box/);
  });
});
