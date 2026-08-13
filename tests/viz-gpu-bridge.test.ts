// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n.js';
import { DomBridge } from '../src/viz/client-gl/DomBridge.js';
import { GpuErrorBoundary } from '../src/viz/client-gl/GpuErrorBoundary.js';
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
    search: { run: '', registry: '', skills: '', launch: '' },
  });
});

afterEach(() => {
  cleanup();
});

function renderBridge(
  onSelectRun = vi.fn(),
  onCopy = vi.fn(),
  runItems = runs
) {
  render(
    createElement(DomBridge, {
      runs: runItems,
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      onSelectRun,
      onCopy,
    })
  );
  return { onSelectRun, onCopy };
}

describe('full-GL minimal DOM bridge', () => {
  it('keeps all five canvas views reachable to assistive technology', async () => {
    const user = userEvent.setup();
    renderBridge();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    await user.click(screen.getByRole('tab', { name: 'Registry' }));
    expect(useGpuStore.getState().view).toBe('registry');
    expect(screen.getByText('Registry')).toBeInTheDocument();
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
