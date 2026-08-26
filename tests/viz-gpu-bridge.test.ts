// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { DomBridge, GpuDomBridge } from '../src/viz/client-gl/DomBridge.js';
import type { VizGitHubInstallation } from '../src/viz/client/types.js';
import {
  ENTRY_FADE_IN_MS,
  ENTRY_FADE_OUT_MS,
  EntryVeilLayer,
  useEntryFade,
} from '../src/viz/client-gl/entry-fade.js';
import { GpuErrorBoundary } from '../src/viz/client-gl/GpuErrorBoundary.js';
import { SceneTuningPanel } from '../src/viz/client-gl/SceneTuningPanel.js';
import { readTuning, resetTuning } from '../src/viz/client-gl/tuning-live.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import {
  markBeadVisible,
  markClockIsPinned,
  pinMarkElapsedMs,
  pinMarkTurnDegrees,
  setMarkBeadVisible,
} from '../src/viz/client-gl/renderer/mark-clock.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

const runs = [
  {
    id: 'run-1',
    label: 'build-app: GPU dashboard',
    startedAt: '2026-08-13T10:00:00.000Z',
  },
];

beforeEach(() => {
  useGpuStore.setState({
    view: 'runs',
    locale: 'en',
    selectedRunId: 'run-1',
    selectedProjectId: null,
    focusedInput: null,
    runPickerActiveIndex: 0,
    runPickerScrollY: 0,
    accountMenuOpen: false,
    tuningPanelOpen: false,
    search: {
      run: '',
      registry: '',
      skills: '',
      projectName: '',
      projectPrompt: '',
      projectRepository: '',
      displayName: '',
    },
    entered: true,
  });
});

afterEach(() => {
  cleanup();
  setReducedMotionOverrideForTests(null);
  pinMarkElapsedMs(null);
  setMarkBeadVisible(true);
  vi.useRealTimers();
  resetTuning();
});

function renderBridge(
  onSelectRun = vi.fn(),
  runItems = runs,
  onEnter?: () => void,
  githubInstallations: VizGitHubInstallation[] = [],
  selectedProjectName: string | null = null
) {
  const selectedProjectId = selectedProjectName ? 'project-selected' : null;
  if (selectedProjectId) useGpuStore.setState({ selectedProjectId });
  render(
    createElement(DomBridge, {
      runs: runItems,
      releaseVersion: '9.8.7',
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      onSelectRun,
      onEnter,
      githubInstallations,
      projects: selectedProjectName
        ? [{ projectId: selectedProjectId!, name: selectedProjectName }]
        : [],
    })
  );
  return { onSelectRun, onEnter };
}

function EntryFadeProbe() {
  const { phase, begin } = useEntryFade();
  return createElement(
    'div',
    null,
    createElement('button', { onClick: begin }, 'go'),
    createElement(EntryVeilLayer, { phase }),
    createElement('span', { 'data-testid': 'phase' }, phase ?? 'idle')
  );
}

describe('full-GL minimal DOM bridge', () => {
  it('renders Scene Tuning above DOM forms and writes live slider values', () => {
    useGpuStore.setState({ tuningPanelOpen: true });
    render(createElement(SceneTuningPanel));
    expect(screen.getByLabelText('Scene tuning')).toHaveClass('gpu-panel-skin');
    // Eight knobs: six scene multipliers plus independent caustic structure
    // and spectral-dispersion controls.
    expect(screen.getAllByRole('slider')).toHaveLength(8);
    fireEvent.change(screen.getByRole('slider', { name: 'Light hue' }), {
      target: { value: '45' },
    });
    expect(readTuning().lightHue).toBe(45);
    fireEvent.change(screen.getByRole('slider', { name: 'Caustic detail' }), {
      target: { value: '0' },
    });
    expect(readTuning().causticDetail).toBe(0);
    fireEvent.change(screen.getByRole('slider', { name: 'Caustic dispersion' }), {
      target: { value: '2' },
    });
    expect(readTuning().causticDispersion).toBe(2);
  });

  it('exposes Continue on the arrival gate and admits the chrome', async () => {
    useGpuStore.setState({ entered: false });
    const user = userEvent.setup();
    renderBridge();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('v9.8.7')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('replaces Continue with real provider anchors when the gate is a login', () => {
    useGpuStore.setState({ entered: false });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        loginLinks: [
          { id: 'github', label: 'GitHub', href: '/auth/login?provider=github&invite=tok' },
        ],
      })
    );
    // Real anchors, so keyboard and assistive tech reach the provider flow
    // without the GL canvas — and the invitation rides the href.
    const anchor = screen.getByRole('link', { name: 'Continue with GitHub' });
    expect(anchor).toHaveAttribute('href', '/auth/login?provider=github&invite=tok');
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('routes Continue through onEnter so the fade can own admission', async () => {
    useGpuStore.setState({ entered: false });
    const onEnter = vi.fn();
    const user = userEvent.setup();
    renderBridge(vi.fn(), runs, onEnter);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(useGpuStore.getState().entered).toBe(false);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('keeps all six canvas views reachable to assistive technology', async () => {
    const user = userEvent.setup();
    renderBridge();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    // There is no Launch tab: starting a run belongs to Projects, and the
    // guidance that used to justify a describe-only tab now renders inside
    // the project run form.
    expect(screen.queryByRole('tab', { name: 'Launch' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(useGpuStore.getState().view).toBe('projects');
    expect(screen.getByRole('tab', { name: 'Projects', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveAttribute('maxlength', '120');
    expect(document.querySelector('.gpu-project-form')).toContainElement(
      screen.getByRole('textbox', { name: 'Project name' })
    );
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Name the project first/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Registry' }));
    expect(useGpuStore.getState().view).toBe('registry');
    expect(screen.getByText('Registry')).toBeInTheDocument();
  });

  it('hides Connect GitHub once an App installation is active', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [
      {
        installationId: '501',
        accountLogin: 'mgtf',
        targetType: 'User',
        status: 'active',
        repositorySelection: 'all',
      },
    ]);
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'GitHub installation' })).toHaveTextContent('mgtf');
  });

  // The project form is one form with two shapes, not one form that grows.
  // Creating a project and running on one are separate jobs: showing both sets
  // of fields at once asked the viewer which of two acts they were performing.
  it('offers the create fields while no project is selected', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], null);
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Repository name' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run/ })).not.toBeInTheDocument();
  });

  it('offers the audience beside the installation, and defaults to private', () => {
    // WHERE the repository goes and WHO can read it are one decision, so they
    // share one cell. Document order is tab order, and nothing but this holds
    // it to the visual order the stacked layout reads.
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], null);
    const install = screen.getByRole('combobox', { name: 'GitHub installation' });
    const visibility = screen.getByRole('combobox', { name: 'Repository visibility' });
    expect(visibility).toHaveValue('private');
    expect(
      install.compareDocumentPosition(visibility) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The consequence is prose beside the control, not a word in a dropdown:
    // the choice cannot be taken back, and nothing in this product reviews what
    // a run publishes.
    expect(screen.getByText(/cannot be changed later/)).toBeInTheDocument();
  });

  it('warns about the audience when public is chosen, in the form itself', () => {
    useGpuStore.setState({ view: 'projects', entered: true, projectVisibility: 'public' });
    renderBridge(vi.fn(), runs, undefined, [], null);
    expect(screen.getByRole('combobox', { name: 'Repository visibility' })).toHaveValue('public');
    expect(screen.getByText(/PUBLIC and permanent/)).toBeInTheDocument();
  });

  it('drops the audience control with the rest of the create fields', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(
      screen.queryByRole('combobox', { name: 'Repository visibility' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'GitHub installation' })
    ).not.toBeInTheDocument();
  });

  it('swaps in the run form once a project is selected', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(screen.getByRole('button', { name: 'Start run on Weather Lab' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Run prompt' })).toBeInTheDocument();
    expect(screen.getByText(/This prompt is for the next run on Weather Lab/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).not.toBeInTheDocument();
  });

  it('bounds a valid long project name inside the run controls', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    const name = 'A'.repeat(120);
    renderBridge(vi.fn(), runs, undefined, [], name);
    const start = screen.getByRole('button', { name: /Start run on/ });
    expect(start).toHaveAttribute('title', name);
    expect(start.textContent?.length).toBeLessThan(80);
    expect(screen.getByText(/This prompt is for the next run/)).not.toHaveTextContent(name);
  });

  it('mirrors project selection for keyboard and assistive navigation', async () => {
    useGpuStore.setState({ view: 'projects', entered: true, selectedProjectId: null });
    const user = userEvent.setup();
    render(
      createElement(DomBridge, {
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        projects: [
          { projectId: 'project-weather', name: 'Weather Lab' },
          { projectId: 'project-notes', name: 'Notes Lab' },
        ],
      })
    );

    const weather = screen.getByRole('button', { name: 'Weather Lab' });
    expect(weather).toHaveAttribute('aria-pressed', 'false');
    await user.click(weather);
    expect(useGpuStore.getState().selectedProjectId).toBe('project-weather');
    expect(screen.getByRole('textbox', { name: 'Run prompt' })).toBeInTheDocument();
    expect(weather).toHaveAttribute('aria-pressed', 'true');

    await user.click(weather);
    expect(useGpuStore.getState().selectedProjectId).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument();
  });

  it('keeps the GitHub connect flow reachable in either shape', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('removes DOM view overlays while the Pixi account menu is open', () => {
    useGpuStore.setState({ view: 'projects', entered: true, accountMenuOpen: true });
    renderBridge();
    expect(document.querySelector('.gpu-project-form')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).not.toBeInTheDocument();
  });

  it('removes every other view overlay while the Pixi account menu is open', () => {
    const cases = [
      ['runs', '.gpu-run-input'],
      ['registry', '.gpu-view-search'],
      ['skills', '.gpu-view-search'],
      ['settings', '.gpu-settings-form'],
    ] as const;
    for (const [view, selector] of cases) {
      cleanup();
      useGpuStore.setState({ view, entered: true, accountMenuOpen: true });
      renderBridge();
      expect(document.querySelector(selector), view).not.toBeInTheDocument();
    }
  });

  it('does not offer project mutations on the ungated developer surface', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
      })
    );
    expect(document.querySelector('.gpu-project-form')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  it('describes the curated admin alert stream without promising every run', () => {
    render(
      createElement(GpuDomBridge, {
        authSnapshot: {
          viewer: {
            displayName: 'Operator',
            role: 'org:owner',
            activeOrganisation: null,
            organisations: [],
            platformAdmin: true,
            principalId: 'principal-admin',
            avatarUrl: null,
            displayNameSource: 'provider',
          },
          failure: false,
          signingOut: false,
          switchingOrganisationId: null,
        },
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        pushPrompt: 'offer',
      })
    );
    const dialog = screen.getByRole('dialog', { name: 'Platform alerts' });
    expect(dialog).toHaveTextContent('critical platform events');
    expect(dialog).not.toHaveTextContent('runs and events across the instance');
  });

  it('uses a real text input for IME/search and a textarea for the run prompt', async () => {
    const user = userEvent.setup();
    const { onSelectRun } = renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    const input = screen.getByRole('textbox', { name: /Search 1 runs/ });
    await user.click(input);
    await user.type(input, 'GPU');
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenCalledWith('run-1');

    // The multi-line goal input is the project's run prompt — the only place
    // the browser starts a run from.
    useGpuStore.getState().setView('projects');
    const prompt = await screen.findByRole('textbox', { name: 'Run prompt' });
    expect(prompt.tagName).toBe('TEXTAREA');
  });

  it('navigates the complete run list with arrows and Enter', async () => {
    const user = userEvent.setup();
    const manyRuns = Array.from({ length: 20 }, (_, index) => ({
      id: `run-${index + 1}`,
      label: `build-app: Run ${index + 1}`,
      startedAt: '2026-08-13T10:00:00.000Z',
    }));
    const onSelectRun = vi.fn();
    renderBridge(onSelectRun, manyRuns);
    const input = screen.getByRole('textbox', { name: /Search 20 runs/ });
    await user.click(input);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelectRun).toHaveBeenCalledWith('run-4');
  });
});

describe('arrival entry fade', () => {
  it('covers the welcome, then admits the app, then lifts the veil', () => {
    vi.useFakeTimers();
    setReducedMotionOverrideForTests(false);
    useGpuStore.setState({ entered: false });
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState().entered).toBe(false);
    expect(screen.getByTestId('phase')).toHaveTextContent('out');
    expect(document.querySelector('.gpu-entry-veil')?.getAttribute('data-phase')).toBe('out');
    act(() => {
      vi.advanceTimersByTime(ENTRY_FADE_OUT_MS);
    });
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getByTestId('phase')).toHaveTextContent('in');
    act(() => {
      vi.advanceTimersByTime(ENTRY_FADE_IN_MS);
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
    expect(document.querySelector('.gpu-entry-veil')?.getAttribute('data-phase')).toBeNull();
  });

  it('jumps to the app under reduced motion', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.setState({ entered: false });
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
  });

  it('clears welcome inspect knobs so the header mark is not left frozen', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.setState({ entered: false });
    pinMarkTurnDegrees(90);
    setMarkBeadVisible(false);
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(markClockIsPinned()).toBe(false);
    expect(markBeadVisible()).toBe(true);
  });

  it('keeps both beats short', () => {
    expect(ENTRY_FADE_OUT_MS).toBeLessThanOrEqual(180);
    expect(ENTRY_FADE_IN_MS).toBeLessThanOrEqual(200);
  });
});

describe('full-GL recovery boundary', () => {
  it('offers a reload instead of leaving a blank canvas', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('shader pipeline failed');
    }
    render(
      createElement(
        GpuErrorBoundary,
        null,
        createElement(Broken)
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('shader pipeline failed');
    expect(screen.getByRole('button', { name: 'Reload visualizer' })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
