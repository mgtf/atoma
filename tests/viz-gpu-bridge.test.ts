// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n.js';
import { DomBridge } from '../src/viz/client-gl/DomBridge.js';
import type { VizGitHubInstallation } from '../src/viz/client/types.js';
import {
  ENTRY_FADE_IN_MS,
  ENTRY_FADE_OUT_MS,
  EntryVeilLayer,
  useEntryFade,
} from '../src/viz/client-gl/entry-fade.js';
import { GpuErrorBoundary } from '../src/viz/client-gl/GpuErrorBoundary.js';
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
    focusedInput: null,
    runPickerActiveIndex: 0,
    runPickerScrollY: 0,
    search: {
      run: '',
      registry: '',
      skills: '',
      launch: '',
      projectName: '',
      projectPrompt: '',
      projectRepository: '',
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
});

function renderBridge(
  onSelectRun = vi.fn(),
  onCopy = vi.fn(),
  runItems = runs,
  onEnter?: () => void,
  githubInstallations: VizGitHubInstallation[] = [],
  selectedProjectName: string | null = null
) {
  render(
    createElement(DomBridge, {
      runs: runItems,
      releaseVersion: '9.8.7',
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      onSelectRun,
      onCopy,
      onEnter,
      githubInstallations,
      selectedProjectName,
    })
  );
  return { onSelectRun, onCopy, onEnter };
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

  it('routes Continue through onEnter so the fade can own admission', async () => {
    useGpuStore.setState({ entered: false });
    const onEnter = vi.fn();
    const user = userEvent.setup();
    renderBridge(vi.fn(), vi.fn(), runs, onEnter);
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
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(useGpuStore.getState().view).toBe('projects');
    expect(screen.getByRole('tab', { name: 'Projects', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument();
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
    renderBridge(vi.fn(), vi.fn(), runs, undefined, [
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

  it('offers Start run only after a project is selected', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run on Weather Lab' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Run prompt' })).toBeInTheDocument();
    expect(screen.getByText(/This prompt is for the next run on Weather Lab/)).toBeInTheDocument();
  });

  it('uses a real text input for IME/search and a textarea for Launch', async () => {
    const user = userEvent.setup();
    const { onSelectRun } = renderBridge();
    const input = screen.getByRole('textbox', { name: /Search 1 runs/ });
    await user.click(input);
    await user.type(input, 'GPU');
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenCalledWith('run-1');

    useGpuStore.getState().setView('launch');
    expect(await screen.findByRole('textbox', { name: 'Goal' })).toBeInTheDocument();
  });

  it('navigates the complete run list with arrows and Enter', async () => {
    const user = userEvent.setup();
    const manyRuns = Array.from({ length: 20 }, (_, index) => ({
      id: `run-${index + 1}`,
      label: `build-app: Run ${index + 1}`,
      startedAt: '2026-08-13T10:00:00.000Z',
    }));
    const onSelectRun = vi.fn();
    renderBridge(onSelectRun, vi.fn(), manyRuns);
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
