import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gpuEventCardCopy,
  gpuAtomButtonWidth,
  gpuFilterButtonWidth,
  gpuFilterButtonWidthCompact,
  FILTER_BUTTON_HEIGHT,
  FILTER_BUTTON_HEIGHT_COMPACT,
  layoutAtomLaneBlocks,
  layoutFilterChipBlock,
  layoutRunFilterBlocks,
} from '../src/viz/client-gl/gpu-renderer.js';
import { I18N_CATALOGS } from '../src/viz/client/i18n-catalog.js';
import {
  advanceNavIconSpin,
  GITHUB_MESH_ASSET_PATH,
  NAV_ICON_ASSET_PATHS,
  NAV_FOLDER_PAPER_MATERIAL,
  NAV_ICON_MATERIAL,
  NAV_ICON_RENDER_SIZE,
  NAV_ICON_SOURCE_SIZE,
  NAV_ICON_SPIN_RADIANS_PER_MS,
  navIconLighting,
  navIconKind,
  navIconOpticalScale,
  navIconRestPose,
  queueNavIconSpin,
} from '../src/viz/client-gl/renderer/nav-icons.js';
import {
  githubRepositoryHref,
  openGitHubRepository,
} from '../src/viz/client-gl/repository-link.js';

describe('GitHub repository links', () => {
  it('opens only a concrete github.com repository in an isolated new tab', () => {
    const calls: string[][] = [];
    const openWindow = (...args: string[]) => {
      calls.push(args);
      return null;
    };
    expect(openGitHubRepository(
      'https://github.com/atoma-org/weather-lab',
      openWindow
    )).toBe(true);
    expect(calls).toEqual([[
      'https://github.com/atoma-org/weather-lab',
      '_blank',
      'noopener,noreferrer',
    ]]);
    expect(githubRepositoryHref('https://example.com/atoma-org/weather-lab')).toBeNull();
    expect(githubRepositoryHref('https://github.com/atoma-org')).toBeNull();
  });
});

// Decisions are catalog-backed (outcome.* keys); resolving through the real
// EN catalog proves the copy path never falls back to hardcoded English.
const t = (key: string): string => I18N_CATALOGS.en[key] ?? key;

describe('catalog copy is drawable', () => {
  it('carries no HTML tags: the GL client draws plain text', () => {
    // The GL client is the product UI and `ctx.text()` rasterises whatever it
    // is handed, so a tag meant for the frozen MUI fallback renders as
    // literal `<code>` on screen — which is exactly how the burn-in empty
    // state shipped. The MUI client strips tags defensively; the catalog is
    // the place to not have them.
    //
    // Named tags only, deliberately: copy legitimately carries shell
    // placeholders like `<goal>`, and a catch-all for anything in angle
    // brackets would fail on those instead of on markup.
    const markup = /<\/?(?:code|pre|kbd|b|i|em|strong|span|div|p|br|a|ul|ol|li)\b[^>]*>/i;
    for (const [locale, catalog] of Object.entries(I18N_CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, `${locale}/${key} carries markup`).not.toMatch(markup);
      }
    }
  });

  it('brightens nearby icons without defining a second shadow model', () => {
    const near = navIconLighting(30, 0, 1);
    const far = navIconLighting(300, 0, 1);
    expect(near.keyX).toBeLessThan(0);
    expect(near.light).toBeGreaterThan(far.light);
    expect(near).not.toHaveProperty('shadowX');
    expect(near).not.toHaveProperty('shadowAlpha');
  });

  it('queues one slow turn per click and respects reduced motion', () => {
    let spin = queueNavIconSpin({ rotation: 0, target: 0 }, false);
    spin = advanceNavIconSpin(spin, 16, false);
    expect(spin.rotation).toBeGreaterThan(0);
    expect(spin.target).toBeCloseTo(Math.PI * 2);
    expect((Math.PI * 2) / NAV_ICON_SPIN_RADIANS_PER_MS).toBeGreaterThan(3_500);

    for (let frame = 0; frame < 260; frame += 1) {
      spin = advanceNavIconSpin(spin, 16, false);
    }
    expect(spin.rotation % (Math.PI * 2)).toBeCloseTo(0);
    expect(queueNavIconSpin(spin, true)).toEqual({ rotation: 0, target: 0 });
  });

  it('normalises optical weight and keeps one app-wide material palette', () => {
    const dense = navIconOpticalScale(9_000, 100, 100);
    const sparse = navIconOpticalScale(3_500, 90, 90);
    expect(dense).toBeLessThan(0.75);
    expect(sparse).toBeGreaterThan(1);
    expect(NAV_ICON_MATERIAL).toEqual({
      color: 0xd3a126,
      roughness: 0.3,
      metalness: 0.38,
    });
    expect(NAV_FOLDER_PAPER_MATERIAL).toEqual({
      color: 0xdbe7f5,
      roughness: 0.46,
      metalness: 0.08,
    });
  });

  it('presents the folder from the front while preserving depth during its click turn', () => {
    const folder = navIconRestPose('projects');
    const play = navIconRestPose('runs');
    expect(Math.abs(folder.y)).toBeLessThan(Math.abs(play.y));
    expect(Math.abs(folder.x)).toBeLessThan(Math.abs(play.x));
    expect(folder.z).toBe(0);
  });
});

describe('navigation icon identity', () => {
  it('gives every rail destination and utility its own pictogram', () => {
    const ids = [
      'nav.projects',
      'nav.runs',
      'nav.docs',
      'nav.registry',
      'nav.skills',
      'nav.burnin',
      'nav.admin',
      'nav.journal',
      'nav.ledger',
      'nav.sentinel',
      'nav.announce',
      'tuning.toggle',
    ];
    const kinds = ids.map(navIconKind);
    expect(kinds.every(Boolean)).toBe(true);
    expect(new Set(kinds).size).toBe(ids.length);
    expect(NAV_ICON_RENDER_SIZE).toBe(34);
    expect(NAV_ICON_ASSET_PATHS).toHaveLength(ids.length);
    for (const path of NAV_ICON_ASSET_PATHS) {
      const glb = readFileSync(path);
      expect(glb.subarray(0, 4).toString('ascii'), path).toBe('glTF');
      expect(glb.readUInt32LE(4), path).toBe(2);
      expect(glb.readUInt32LE(8), path).toBe(glb.byteLength);
    }
    expect(NAV_ICON_SOURCE_SIZE).toBeGreaterThan(NAV_ICON_RENDER_SIZE);
  });

  it('ships a valid GitHub GLB beside its required attribution', () => {
    const glb = readFileSync(GITHUB_MESH_ASSET_PATH);
    expect(glb.subarray(0, 4).toString('ascii')).toBe('glTF');
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.byteLength);
    const license = readFileSync('src/viz/public/models/github/LICENSE.md', 'utf8');
    expect(license).toContain('pengedarseni');
    expect(license).toContain('Creative Commons Attribution 4.0');
  });
});
import {
  nextRunFilters,
  projectSelectionAfterActivate,
  previewTargetForRun,
  projectSelectionAfterProjects,
  useGpuStore,
} from '../src/viz/client-gl/store.js';

beforeEach(() => {
  useGpuStore.setState({
    view: 'runs',
    sceneCameraMode: 'overview',
    selectedRunId: null,
    selectedEventId: null,
    selectedAtomName: null,
    runFilters: { kind: 'all', role: 'all', branchId: 'all' },
    burninFamily: 'all',
    burninOutcome: 'all',
    burninPreset: 'all',
    burninPage: 1,
    selectedDocsTheme: 'quick',
    scrollY: { projects: 0, runs: 0, registry: 0, skills: 0, burnin: 0, docs: 0, admin: 0, journal: 0, ledger: 0, sentinel: 0, announce: 0, settings: 0 },
    entered: false,
  });
});

describe('full-GL Zustand scene state', () => {
  it('starts wide, focuses a destination and lets its active menu restore overview', () => {
    expect(useGpuStore.getState().sceneCameraMode).toBe('overview');
    useGpuStore.getState().activateView('skills');
    expect(useGpuStore.getState()).toMatchObject({
      view: 'skills',
      sceneCameraMode: 'focus',
    });
    useGpuStore.getState().activateView('skills');
    expect(useGpuStore.getState().sceneCameraMode).toBe('overview');
    useGpuStore.getState().setView('skills');
    useGpuStore.getState().setView('skills');
    expect(useGpuStore.getState().sceneCameraMode).toBe('focus');
    useGpuStore.getState().activateView('runs');
    expect(useGpuStore.getState().sceneCameraMode).toBe('focus');
  });

  it('starts behind the arrival gate and enter() admits the chrome', () => {
    expect(useGpuStore.getState().entered).toBe(false);
    useGpuStore.getState().enter();
    expect(useGpuStore.getState().entered).toBe(true);
  });

  it('can explicitly reopen Welcome without forgetting the completed admission', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    try {
      useGpuStore.getState().enter();
      expect(values.get('atoma.viz.entered')).toBe('1');
      useGpuStore.getState().activateCrystal();
      expect(useGpuStore.getState().entered).toBe(false);
      expect(values.get('atoma.viz.entered')).toBe('1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the focused crystal as the route back to overview', () => {
    useGpuStore.setState({
      view: 'skills',
      sceneCameraMode: 'focus',
      entered: true,
      accountMenuOpen: true,
    });
    useGpuStore.getState().activateCrystal();
    expect(useGpuStore.getState()).toMatchObject({
      view: 'skills',
      sceneCameraMode: 'overview',
      entered: true,
      accountMenuOpen: false,
    });
  });

  it('keeps event and atom selections mutually exclusive', () => {
    const store = useGpuStore.getState();
    store.selectEvent('event-1');
    expect(useGpuStore.getState()).toMatchObject({
      selectedEventId: 'event-1',
      selectedAtomName: null,
      runSummaryExpanded: false,
    });
    store.selectAtom('Water');
    expect(useGpuStore.getState()).toMatchObject({
      selectedEventId: null,
      selectedAtomName: 'Water',
      runSummaryExpanded: false,
    });
    store.selectEvent(null);
    expect(useGpuStore.getState().runSummaryExpanded).toBe(true);
  });

  it('toggles the branch heading and re-expands it when the branch changes', () => {
    const store = useGpuStore.getState();
    store.setRunFilters({ kind: 'all', role: 'all', branchId: 'phase-2' });
    store.toggleBranchHeading();
    expect(useGpuStore.getState().branchHeadingExpanded).toBe(false);
    store.setRunFilters({ kind: 'all', role: 'all', branchId: 'phase-1' });
    expect(useGpuStore.getState().branchHeadingExpanded).toBe(true);
  });

  it('opens the account menu and closes it on navigation', () => {
    const store = useGpuStore.getState();
    expect(store.accountMenuOpen).toBe(false);
    store.toggleAccountMenu();
    expect(useGpuStore.getState().accountMenuOpen).toBe(true);
    store.toggleAccountMenu();
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);

    store.toggleAccountMenu();
    // Navigating away must close it: the panel is anchored to the header orb
    // and would otherwise outlive the screen it was opened from.
    useGpuStore.getState().setView('settings');
    expect(useGpuStore.getState()).toMatchObject({
      view: 'settings',
      accountMenuOpen: false,
    });

    store.toggleAccountMenu();
    useGpuStore.getState().closeAccountMenu();
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);
  });

  it('resets dependent UI state and clamps GPU scrolling', () => {
    const store = useGpuStore.getState();
    store.setBurninPage(4);
    store.setBurninFilter('family', 'http');
    store.setScrollY('runs', -200);
    expect(useGpuStore.getState()).toMatchObject({
      burninFamily: 'http',
      burninPage: 1,
      scrollY: { runs: 0 },
    });
  });

  it('deselects the active project and selects a different one', () => {
    expect(projectSelectionAfterActivate('project-a', 'project-a')).toBeNull();
    expect(projectSelectionAfterActivate('project-a', 'project-b')).toBe('project-b');
    expect(projectSelectionAfterActivate(null, 'project-a')).toBe('project-a');
  });

  it('resets project scroll whenever selection changes shape', () => {
    useGpuStore.setState((state) => ({
      selectedProjectId: 'project-a',
      scrollY: { ...state.scrollY, projects: 380 },
    }));
    useGpuStore.getState().selectProject(null);
    expect(useGpuStore.getState()).toMatchObject({
      selectedProjectId: null,
      scrollY: { projects: 0 },
    });
  });

  it('opens the end-user guide on quick start and resets scroll between topics', () => {
    expect(useGpuStore.getState().selectedDocsTheme).toBe('quick');
    useGpuStore.setState((state) => ({
      scrollY: { ...state.scrollY, docs: 640 },
    }));
    useGpuStore.getState().selectDocsTheme('trust');
    expect(useGpuStore.getState()).toMatchObject({
      selectedDocsTheme: 'trust',
      scrollY: { docs: 0 },
    });
  });

  it('repairs a missing project without auto-selecting the first project', () => {
    expect(projectSelectionAfterProjects(null, ['project-a', 'project-b'])).toBeNull();
    expect(projectSelectionAfterProjects('project-b', ['project-a', 'project-b']))
      .toBe('project-b');
    expect(projectSelectionAfterProjects('project-gone', ['project-a', 'project-b']))
      .toBe('project-a');
    expect(projectSelectionAfterProjects('project-a', [])).toBe('project-a');
  });

  it('joins a selected TRACE back to the project run a preview is keyed by', () => {
    const runs = [
      { projectId: 'p1', projectRunId: 'run-1', traceId: 'trace-1' },
      // A run whose trace does not exist yet: the Projects view emits its
      // project-run id instead, so both must resolve.
      { projectId: 'p1', projectRunId: 'run-2', traceId: null },
    ];

    expect(previewTargetForRun(runs, 'trace-1')).toEqual({ projectId: 'p1', projectRunId: 'run-1' });
    expect(previewTargetForRun(runs, 'run-2')).toEqual({ projectId: 'p1', projectRunId: 'run-2' });
    // A run reached from the runs index, a burn-in row or a deep link has no
    // project run. Guessing one would offer a control that 404s.
    expect(previewTargetForRun(runs, 'trace-elsewhere')).toBeNull();
    expect(previewTargetForRun(runs, null)).toBeNull();
    expect(previewTargetForRun([], 'trace-1')).toBeNull();
  });
});

describe('full-GL event cards preserve trace metadata', () => {
  it('renders tool arguments, result facts, branch, duration and timestamp', () => {
    const copy = gpuEventCardCopy({
      id: 'tool-1',
      ts: Date.parse('2026-08-13T10:20:30.000Z'),
      kind: 'tool',
      name: 'read_file',
      actor: { tier: 1, name: 'Ammonia' },
      branchId: 'abcdef12-3456',
      args: { path: 'src/index.ts' },
      result: { ok: true },
      durationMs: 12,
    }, t);
    expect(copy).toMatchObject({
      title: 'Li · read_file',
      meta: expect.stringContaining('L1 Ammonia'),
      body: expect.stringContaining('src/index.ts'),
    });
    expect(copy.meta).toContain('⑂ abcdef');
    expect(copy.body).toContain('ok=true');
    expect(copy.footer).toContain('12ms');
    expect(copy.footer).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('renders LLM routing, model, cost, child and verdict decision', () => {
    const copy = gpuEventCardCopy({
      id: 'llm-1',
      ts: Date.parse('2026-08-13T10:20:30.000Z'),
      kind: 'llm',
      role: 'validate-result',
      actor: { tier: 3, name: 'Meristem' },
      child: { tier: 2, name: 'Erythrocyte' },
      model: 'zai:glm-4.5-air',
      response: JSON.stringify({ approved: true, reasoning: 'clean' }),
      durationMs: 1500,
      costUsd: 0.0123,
    }, t);
    expect(copy.title).toBe('validate-result');
    expect(copy.meta).toContain('L3 Meristem');
    expect(copy.meta).toContain('→ Erythrocyte');
    expect(copy.footer).toContain('zai:glm-4.5-air');
    expect(copy.footer).toContain('$0.0123');
    expect(copy.decision).toBe('✓ approved');
  });

});

describe('full-GL filter controls preserve semantic labels', () => {
  it('reserves a dedicated particle zone inside agent buttons', () => {
    expect(gpuAtomButtonWidth('Ammonia')).toBeGreaterThanOrEqual(92);
    expect(gpuAtomButtonWidth('VesselElement')).toBeGreaterThan(
      gpuAtomButtonWidth('Ammonia')
    );
  });

  it('puts kind and role filter blocks on one row when they fit', () => {
    const layout = layoutRunFilterBlocks({
      originX: 20,
      originY: 80,
      maxWidth: 920,
      kinds: [
        { id: 'run.filter.kind.all', label: 'ALL' },
        { id: 'run.filter.kind.llm', label: 'LLM' },
        { id: 'run.filter.kind.tool', label: 'TOOLS' },
        { id: 'run.filter.kind.trust', label: 'TRUST' },
        { id: 'run.filter.kind.skill', label: 'SKILL' },
        { id: 'run.filter.kind.registry', label: 'REGISTRY' },
      ],
      roles: [
        { id: 'run.filter.role.all', label: 'ALL ROLES' },
        { id: 'run.filter.role.prefilter', label: 'PREFILTER' },
        { id: 'run.filter.role.plan', label: 'PLAN' },
        { id: 'run.filter.role.execute', label: 'EXECUTE' },
      ],
    });
    expect(layout.roles).not.toBeNull();
    expect(layout.roles!.y).toBe(layout.kinds.y);
    expect(layout.roles!.x).toBeGreaterThan(layout.kinds.x + layout.kinds.width);
    expect(layout.bottom).toBe(layout.kinds.y + layout.kinds.height);
    expect(layout.roles!.chips.every((chip) => chip.height === FILTER_BUTTON_HEIGHT_COMPACT))
      .toBe(true);
  });

  it('puts atom lanes on one row when they fit and stacks them otherwise', () => {
    const compact = layoutAtomLaneBlocks({
      originX: 20,
      originY: 40,
      maxWidth: 920,
      lanes: [
        { tier: 3, label: 'L3 · tissues', names: ['Meristem'] },
        { tier: 2, label: 'L2 · cells', names: ['Sclereid'] },
        { tier: 1, label: 'L1 · molecules', names: ['Methane'] },
      ],
    });
    expect(compact.lanes).toHaveLength(3);
    expect(compact.lanes[1]!.y).toBe(compact.lanes[0]!.y);
    expect(compact.lanes[2]!.x).toBeGreaterThan(compact.lanes[1]!.x + compact.lanes[1]!.width);

    const stacked = layoutAtomLaneBlocks({
      originX: 20,
      originY: 40,
      maxWidth: 220,
      lanes: [
        { tier: 3, label: 'L3 · tissues', names: ['Meristem'] },
        { tier: 2, label: 'L2 · cells', names: ['Sclereid'] },
        { tier: 1, label: 'L1 · molecules', names: ['Methane'] },
      ],
    });
    expect(stacked.lanes[1]!.y).toBeGreaterThan(stacked.lanes[0]!.y + stacked.lanes[0]!.height);
  });

  it('frames a wrapping branch chip row as one block', () => {
    const chips = [
      { id: 'run.filter.branch.all', label: 'ALL BRANCHES' },
      { id: 'run.filter.branch.a', label: 'PARALLEL BRANCH 1 · CREATE' },
      { id: 'run.filter.branch.b', label: 'PARALLEL BRANCH 1 · VERIFY' },
    ];
    // Branch chips render compact — the production call in runs.ts.
    const block = layoutFilterChipBlock(20, 80, 240, chips, { size: 'compact' });
    expect(block.chips.length).toBe(3);
    expect(block.chips[2]!.y).toBeGreaterThan(block.chips[0]!.y);
    expect(block.height).toBeGreaterThan(block.chips[0]!.height);
    // The compact face is strictly smaller than the default one.
    const defaultBlock = layoutFilterChipBlock(20, 80, 240, chips);
    expect(block.chips[0]!.height).toBe(FILTER_BUTTON_HEIGHT_COMPACT);
    expect(defaultBlock.chips[0]!.height).toBe(FILTER_BUTTON_HEIGHT);
    for (const [index, chip] of block.chips.entries()) {
      expect(chip.width).toBeLessThan(defaultBlock.chips[index]!.width);
    }
  });

  it('stacks role filters when the pane cannot hold both frames', () => {
    const layout = layoutRunFilterBlocks({
      originX: 20,
      originY: 80,
      maxWidth: 260,
      kinds: [
        { id: 'run.filter.kind.all', label: 'ALL' },
        { id: 'run.filter.kind.llm', label: 'LLM' },
        { id: 'run.filter.kind.tool', label: 'TOOLS' },
        { id: 'run.filter.kind.trust', label: 'TRUST' },
        { id: 'run.filter.kind.skill', label: 'SKILL' },
        { id: 'run.filter.kind.registry', label: 'REGISTRY' },
      ],
      roles: [
        { id: 'run.filter.role.all', label: 'ALL ROLES' },
        { id: 'run.filter.role.execute', label: 'EXECUTE' },
      ],
    });
    expect(layout.roles!.y).toBeGreaterThan(layout.kinds.y + layout.kinds.height);
  });

  it('allocates enough width for every current kind, role and branch label', () => {
    for (const label of [
      'REGISTRY',
      'ALL ROLES',
      'PREFILTER',
      'VALIDATE-RESULT',
      'ALL BRANCHES',
      '⑂ c545fb',
    ]) {
      const availableCharacters = Math.floor((gpuFilterButtonWidth(label) - 16) / 6.2);
      expect(availableCharacters, label).toBeGreaterThanOrEqual(label.length);
    }
  });

  it('allocates enough compact width and side padding for role and branch labels', () => {
    // The fallback estimate, exercised when no renderer can measure: the 8px
    // face averages ~4.6px per uppercase glyph (6.2 scaled by 8/11).
    for (const label of [
      'ALL ROLES',
      'VALIDATE-RESULT',
      'ALL BRANCHES',
      'PARALLEL BRANCH 1.1 · WRITE INDEX',
      '⑂ c545fb',
    ]) {
      const availableCharacters = Math.floor((gpuFilterButtonWidthCompact(label) - 12) / 4.6);
      expect(availableCharacters, label).toBeGreaterThanOrEqual(label.length);
    }
  });

  it('sizes chips from an injected measurement, uniformly padded', () => {
    // With a real measurer (ctx.measureText in production) every chip carries
    // the same text padding regardless of label length — the estimate path
    // cannot promise that, which is why runs.ts injects the measurement.
    const measure = (label: string) => label.length * 5;
    const block = layoutFilterChipBlock(
      0,
      0,
      2000,
      [
        { id: 'a', label: 'ALL BRANCHES' },
        { id: 'b', label: 'PARALLEL BRANCH 1.1 · WRITE INDEX.HTML AND APP.JS' },
      ],
      { size: 'compact', measure }
    );
    for (const chip of block.chips) {
      expect(chip.width - measure(chip.label)).toBe(22);
    }
  });

  it('makes role filters LLM-exclusive and resets stale roles on kind changes', () => {
    const current = { kind: 'all', role: 'all', branchId: 'all' };
    expect(nextRunFilters(current, 'role', 'prefilter')).toEqual({
      kind: 'llm',
      role: 'prefilter',
      branchId: 'all',
    });
    expect(
      nextRunFilters(
        { kind: 'llm', role: 'prefilter', branchId: 'all' },
        'kind',
        'tool'
      )
    ).toEqual({ kind: 'tool', role: 'all', branchId: 'all' });
  });

  it('applies a kind filter and scroll reset in one store notification', () => {
    const store = useGpuStore.getState();
    store.setScrollY('runs', 120);
    let notifications = 0;
    const unsub = useGpuStore.subscribe(() => {
      notifications += 1;
    });
    store.setRunFilters(nextRunFilters(store.runFilters, 'kind', 'tool'));
    unsub();
    expect(notifications).toBe(1);
    expect(useGpuStore.getState()).toMatchObject({
      runFilters: { kind: 'tool', role: 'all', branchId: 'all' },
      scrollY: { runs: 0 },
    });
  });

  it('does not notify when GPU scroll is already at the clamped value', () => {
    let notifications = 0;
    const unsub = useGpuStore.subscribe(() => {
      notifications += 1;
    });
    useGpuStore.getState().setScrollY('runs', 0);
    unsub();
    expect(notifications).toBe(0);
  });
});
