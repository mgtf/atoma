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

describe('viz full-GL build contract with MUI fallback', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const server = readFileSync('src/viz/server.ts', 'utf8');
  const app = readFileSync('src/viz/client/App.tsx', 'utf8');
  const burnin = readFileSync('src/viz/client/features/BurninView.tsx', 'utf8');
  const chart = readFileSync('src/viz/client/burnin-chart.ts', 'utf8');
  const picker = readFileSync('src/viz/client/run-picker.tsx', 'utf8');
  const gpuApp = readFileSync('src/viz/client-gl/GpuApp.tsx', 'utf8');
  const gpuMain = readFileSync('src/viz/client-gl/main.tsx', 'utf8');
  const gpuRenderer = readFileSync('src/viz/client-gl/gpu-renderer.ts', 'utf8');
  const rendererRuns = readFileSync('src/viz/client-gl/renderer/views/runs.ts', 'utf8');
  const rendererShaders = readFileSync('src/viz/client-gl/renderer/shaders.ts', 'utf8');
  const rendererChipLayout = readFileSync('src/viz/client-gl/renderer/chip-layout.ts', 'utf8');
  const threeBackdrop = readFileSync('src/viz/client-gl/ThreeBackdrop.tsx', 'utf8');
  const gpuCursor = readFileSync('src/viz/client-gl/AtomaCursor.tsx', 'utf8');
  const pointerLight = readFileSync('src/viz/client-gl/pointer-light.ts', 'utf8');
  const timelineLayout = readFileSync('src/viz/client/timeline-layout.ts', 'utf8');
  const timelineRails = readFileSync('src/viz/client-gl/RunsTimelineRails.tsx', 'utf8');
  const gpuStore = readFileSync('src/viz/client-gl/store.ts', 'utf8');
  const gpuStyles = readFileSync('src/viz/client-gl/styles.css', 'utf8');
  const devLauncher = readFileSync('scripts/viz-dev.mjs', 'utf8');
  const buildLauncher = readFileSync('scripts/viz-build.mjs', 'utf8');
  const vite = readFileSync('vite.config.ts', 'utf8');

  it('has HMR development and compiled static deployment paths', () => {
    expect(existsSync('src/viz/client/index.html')).toBe(true);
    expect(existsSync('src/viz/client/main.tsx')).toBe(true);
    expect(existsSync('src/viz/client/main.js')).toBe(false);
    // Vite proxies the `/api` prefix. A root-level `api.ts` module is also
    // caught by that proxy and arrives as application/octet-stream.
    expect(existsSync('src/viz/client/api.ts')).toBe(false);
    expect(existsSync('src/viz/client/data-api.ts')).toBe(true);
    expect(existsSync('src/viz/client-gl/index.html')).toBe(true);
    expect(existsSync('src/viz/client-gl/main.tsx')).toBe(true);
    expect(pkg.scripts['viz']).toMatch(/viz-dev/);
    expect(pkg.scripts['viz:build']).toMatch(/viz-build/);
    expect(pkg.scripts['viz:build:mui']).toMatch(/viz-build.*mui/);
    expect(pkg.scripts['viz:mui']).toMatch(/--ui mui/);
    expect(pkg.scripts['viz:smoke']).toMatch(/viz-gpu-smoke/);
    expect(pkg.scripts['viz:serve']).toBe('node dist/viz/server.js');
    expect(pkg.scripts['build']).toMatch(/viz:build/);
    expect(server).toMatch(/dist\/viz\/client|CLIENT_DIR/);
    expect(pkg.devDependencies['react']).toBeTruthy();
    expect(pkg.devDependencies['@mui/material']).toBeTruthy();
    expect(pkg.devDependencies['@headlessui/react']).toBeTruthy();
    expect(pkg.devDependencies['pixi.js']).toBeTruthy();
    expect(pkg.devDependencies['zustand']).toBeTruthy();
    expect(pkg.devDependencies['@tanstack/react-query']).toBeTruthy();
    expect(pkg.devDependencies['three']).toBeTruthy();
    expect(pkg.devDependencies['three']).toMatch(/0\.182/);
    expect(pkg.devDependencies['@react-three/fiber']).toBeTruthy();
    expect(pkg.devDependencies['@pixi/react']).toBeUndefined();
    expect(vite).toMatch(/plugin-react/);
    expect(vite).toMatch(/client-gl/);
    expect(app).toMatch(/ThemeProvider|lazy\(/);
    expect(devLauncher).toContain('ATOMA_VIZ_DEV_URL');
    expect(devLauncher).toContain('process.execPath');
    expect(devLauncher).not.toMatch(/npm['"],\s*\['exec'|npm exec/);
    expect(buildLauncher).toMatch(/NODE_ENV:\s*'production'/);
    expect(server).toContain('res.writeHead(307');
    expect(gpuApp).toMatch(/ThreeBackdrop|GpuSurface|DomBridge/);
    expect(gpuApp).toMatch(/AtomaCursor/);
    expect(gpuMain).toMatch(/GpuErrorBoundary/);
    expect(gpuRenderer).toMatch(
      /preference:\s*forceWebGl\s*\?\s*\['webgl'\]\s*:\s*\['webgpu', 'webgl'\]/
    );
    expect(gpuStore).toMatch(/create<GpuUiState>/);
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

  // Drawing behavior (labels, cards, pagination, scroll bounds, masks, filter
  // layout) is asserted behaviorally in tests/viz-gpu-views.test.ts against
  // the exported view functions; layout/copy math in tests/viz-gpu-state.test.ts.
  // Only architectural presence/absence that cannot be observed behaviorally
  // stays greppable here, targeted at the file where the code actually lives.
  it('bounds full-GL rendering and keeps data-heavy widgets on the GPU', () => {
    // Run picker overlay windows its matches instead of truncating the list.
    expect(gpuRenderer).toMatch(/runPickerScrollMax/);
    expect(gpuRenderer).toMatch(/matching\.slice\(start, start \+ visibleCount\)/);
    expect(gpuRenderer).not.toMatch(/\.slice\(0, 12\)/);
    expect(rendererRuns).not.toMatch(/\.slice\(0, 12\)/);
    // The GPU runs view and the MUI RunsView share ONE heading/detail source.
    expect(rendererRuns).toMatch(/timelineBranchHeading\(/);
    expect(rendererRuns).toMatch(/filePathFromArgs/);
    expect(rendererRuns).toMatch(/buildSkillEventDetail\(event, skill, snapshot\.t\)/);
    expect(timelineLayout).toMatch(/export function timelineBranchHeading\(/);
    expect(readFileSync('src/viz/client/features/RunsView.tsx', 'utf8')).toMatch(
      /timelineBranchHeading\(/
    );
    expect(timelineLayout).toMatch(/inferParents|assignLanes/);
    // Widget interactivity and the filter exit/enter animation protocol stay
    // on the renderer class.
    expect(gpuRenderer).toMatch(/pointerover|pointerdown/);
    expect(gpuRenderer).toMatch(/drawRemovedFilterEffects/);
    expect(gpuRenderer).toMatch(/drawExitingFilterButtons/);
    expect(gpuRenderer).toMatch(/animateEnteringFilterSpace/);
    expect(gpuRenderer).toMatch(/roleRowTransition/);
    expect(gpuRenderer).toMatch(/startedAt/);
    expect(gpuRenderer).toMatch(/app\.ticker\.add/);
    expect(gpuRenderer).toMatch(/private navButton\(/);
    // The brand mark is one Pixi crystal in the header; no parallel R3F logo.
    expect(gpuRenderer).toMatch(/private drawAtomaMark\(/);
    expect(gpuRenderer).toMatch(/this\.drawAtomaMark\(10, 12\)/);
    expect(gpuRenderer).toMatch(/crystal\.scale\.set\(frame\.scale \* 1\.12\)/);
    expect(gpuRenderer).toMatch(/buildAtomaMarkFrame\(/);
    expect(gpuApp).not.toMatch(/AtomaCrystal/);
    expect(gpuStyles).not.toMatch(/\.gpu-brand-mark/);
    expect(gpuRenderer).toMatch(/this\.text\(this\.root, 'Atoma'/);
    expect(gpuRenderer).toMatch(/let x = 160/);
    // Atom buttons draw local geometry at local origin (no double offsets).
    expect(gpuRenderer).toMatch(/ellipse\(0, 0, 7, 4\)/);
    expect(gpuRenderer).toMatch(/const particleCenterX = 16/);
    expect(gpuRenderer).toMatch(/orbit\.position\.set\(particleCenterX, height \/ 2\)/);
    expect(gpuRenderer).toMatch(/Array\.from\(\{ length: tier \}/);
    expect(gpuRenderer).not.toMatch(/ellipse\(10, height \/ 2, 7, 4\)/);
    // Hover-scale gaps are pinned so scaled chips never overlap neighbours.
    expect(rendererChipLayout).toMatch(/const CONTROL_HOVER_GAP = 14/);
    expect(gpuRenderer).toMatch(/const NAV_HOVER_GAP = 20/);
    expect(gpuRenderer).toMatch(/label\.length \* 7 \+ 22\) \+ NAV_HOVER_GAP/);
    expect(gpuRenderer).toMatch(/underline\.scale\.x = active \? 1/);
    // Card shaders and the pointer light ship BOTH GLSL and WGSL variants so
    // the WebGL fallback renders what WebGPU renders.
    expect(gpuRenderer).toMatch(/CARD_FILTER_GLSL|CARD_FILTER_WGSL/);
    expect(rendererShaders).toMatch(/CARD_FILTER_GLSL/);
    expect(rendererShaders).toMatch(/CARD_FILTER_WGSL/);
    expect(gpuRenderer).toMatch(/padding: 12/);
    expect(gpuRenderer).toMatch(/drawViewTransition/);
    expect(threeBackdrop).toMatch(/BACKDROP_FRAGMENT_SHADER/);
    expect(threeBackdrop).toMatch(/float fbm|<shaderMaterial/);
    expect(threeBackdrop).toMatch(/PointerPointLight|readPointerLight/);
    expect(threeBackdrop).toMatch(/uPointerUv|uPointerStrength/);
    expect(gpuRenderer).toMatch(/POINTER_LIGHT_GLSL|POINTER_LIGHT_WGSL/);
    expect(gpuRenderer).toMatch(/installPointerLightFilter/);
    expect(rendererShaders).toMatch(/POINTER_LIGHT_GLSL/);
    expect(rendererShaders).toMatch(/POINTER_LIGHT_WGSL/);
    expect(rendererShaders).toMatch(/uInputPixel\.z|dpdx\(sampleLuminance\)/);
    expect(gpuCursor).toMatch(/atoma-pointer-(halo|face)|atoma-pointer-tip-light/);
    expect(gpuCursor).toMatch(/pointerType === 'touch'|REDUCED_MOTION_QUERY/);
    expect(pointerLight).toMatch(/pointerClientToUv|pointerClientToRenderer/);
    expect(threeBackdrop).toMatch(/view === 'runs'[\s\S]*RunsTimelineRails/);
    expect(threeBackdrop).toMatch(/buildAtomMap\(run\)/);
    expect(threeBackdrop).toMatch(/events=\{\(\) => \(\{ enabled: false, priority: 1 \}\)\}/);
    expect(gpuStyles).toMatch(/\.three-backdrop \* \{/);
    expect(gpuStyles).toMatch(/pointer-events: none !important;/);
    expect(gpuStyles).not.toMatch(/contain:\s*layout paint/);
    expect(gpuRenderer).toMatch(/mask\.eventMode = 'none'/);
    expect(timelineRails).toMatch(/visibleItems\.map|visibleBranches\.map/);
    expect(timelineRails).not.toMatch(/run\.events\.map/);
    // Pixi survives Fast Refresh via one clean reload, never stateful HMR.
    expect(gpuRenderer).toMatch(/import\.meta\.hot\.accept/);
    expect(gpuApp).toMatch(/useRunTrace|useBurnin|useSkillLists/);
    expect(gpuApp).toMatch(/runSkillSelection/);
    expect(readFileSync('src/viz/client/features/RegistryView.tsx', 'utf8'))
      .not.toMatch(/systemPrompt.*filter|filter.*systemPrompt/);
    expect(readFileSync('src/viz/client/features/SkillsView.tsx', 'utf8'))
      .toMatch(/matchesSearchQuery\(skillSearchText\(skill, namespace\.l1Name\)/);
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

  // The GPU client's rendering of these columns is asserted behaviorally in
  // tests/viz-gpu-views.test.ts ('renders compiler refusals and transport
  // errors present in the rows').
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
