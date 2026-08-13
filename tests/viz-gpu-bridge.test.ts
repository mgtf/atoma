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
    search: { run: '', registry: '', skills: '', launch: '' },
  });
});

afterEach(() => {
  cleanup();
});

function renderBridge(onSelectRun = vi.fn(), onCopy = vi.fn()) {
  render(
    createElement(DomBridge, {
      runs,
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
