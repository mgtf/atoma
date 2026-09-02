// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/viz/client/App.js';
import { I18nProvider } from '../src/viz/client/i18n.js';
import { applyDocumentLocale, translate } from '../src/viz/client/i18n-catalog.js';
import { theme } from '../src/viz/client/theme.js';

vi.mock('../src/viz/client/burnin-chart.js', () => ({
  initBurninChart: () => ({
    setOption: vi.fn(),
    on: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const routes: Record<string, unknown> = {
  '/api/runs': [
    {
      id: 'run-1',
      label: 'build-app: Component migration',
      startedAt: '2026-08-13T10:00:00.000Z',
      endedAt: '2026-08-13T10:01:00.000Z',
      costUsd: 0.1,
      calls: 1,
    },
  ],
  '/api/runs/run-1': {
    id: 'run-1',
    label: 'build-app: Component migration',
    task: { description: 'Render a component application' },
    startedAt: '2026-08-13T10:00:00.000Z',
    endedAt: '2026-08-13T10:01:00.000Z',
    durationMs: 60_000,
    events: [
      {
        id: 'validation-1',
        ts: Date.parse('2026-08-13T10:00:30.000Z'),
        kind: 'llm',
        role: 'validate-result',
        actor: { tier: 3, name: 'Meristem' },
        child: { tier: 2, name: 'Tracheid' },
        model: 'zai:glm-test',
        systemPrompt: 'Validate the result.',
        userContent: 'Check the generated files.',
        response: JSON.stringify({
          approved: true,
          reasoning: 'Every requested document passed.',
          modifications: {
            preferredChild: 'Ammonia',
          },
        }),
        durationMs: 1000,
        costUsd: 0.01,
      },
    ],
    initialTypes: [],
    totals: {
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.1,
      perModel: [
        {
          model: 'zai:glm-test',
          calls: 1,
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.1,
        },
      ],
    },
  },
  '/api/registries': [
    { id: 'main', label: 'main', path: '/tmp/atoma.db', exists: true, counts: { 1: 1, 2: 0, 3: 0, total: 1 } },
  ],
  '/api/registry/main': {
    registry: { id: 'main', label: 'main', path: '/tmp/atoma.db', exists: true, counts: { 1: 1, 2: 0, 3: 0, total: 1 } },
    types: [
      {
        tier: 1,
        ordinal: 1,
        name: 'Water',
        description: 'Web component builder',
        systemPrompt: 'Build verified web components.',
        tools: ['write_file'],
        params: {},
        createdBy: 'test',
        createdAt: '2026-08-13T10:00:00.000Z',
        version: 1,
        successes: 3,
        failures: 0,
        history: [],
      },
    ],
  },
  '/api/skills': [{ l1Name: 'Water', count: 1 }],
  '/api/skills/Water': [
    {
      id: 'build-widget',
      description: 'Build a widget',
      whenToUse: 'The task asks for a widget',
      kind: 'llm',
      successes: 2,
      failures: 0,
      updatedAt: '2026-08-13T10:00:00.000Z',
    },
  ],
  '/api/skills/Water/build-widget': {
    id: 'build-widget',
    description: 'Build a widget',
    whenToUse: 'The task asks for a widget',
    kind: 'llm',
    successes: 2,
    failures: 0,
    updatedAt: '2026-08-13T10:00:00.000Z',
    body: 'Read the task and build the widget.',
    shareability: {
      verdict: 'review-required',
      blockers: [],
      warnings: [],
      humanMustCheck: 'A human must read the recipe.',
    },
  },
  '/api/burnin': {
    rows: [
      {
        ts: '2026-08-13T10:00:00.000Z',
        taskId: 'component-smoke',
        family: 'web',
        outcome: 'delivered',
        costUsd: 0.1,
        durationS: 60,
        llmCalls: 1,
        opusCalls: 0,
        sonnetCalls: 0,
        haikuCalls: 1,
        otherCalls: 0,
        deterministicPhases: 1,
        escalations: 0,
        learnedSkills: 0,
        learnedEventSkills: 0,
        promotions: 0,
        refusals: 0,
        compileErrors: 1,
        demotions: 0,
        dispatchFallbacks: 0,
        trace: 'run-1',
        provider: 'zai',
      },
    ],
    csvPath: '/tmp/results.csv',
  },
  '/api/profiles': {
    launchEnabled: false,
    profiles: [
      {
        id: 'build',
        npmScript: 'run:build',
        label: 'Build',
        help: 'Describe one runnable artifact.',
        examples: ['Build a tiny CLI', 'Build a tiny web page'],
      },
    ],
  },
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(requestUrl, 'http://localhost');
    const payload = routes[url.pathname];
    if (payload === undefined) return new Response('missing', { status: 404 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderApp() {
  return render(
    createElement(
      ThemeProvider,
      { theme },
      createElement(I18nProvider, null, createElement(App))
    )
  );
}

describe('the React visualizer shell', () => {
  it('renders recursive LLM JSON as localized semantic fields', async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByDisplayValue('Component migration');
    await waitFor(() => {
      expect(
        document.querySelector('[data-event-id="validation-1"]')
      ).toBeInstanceOf(HTMLButtonElement);
    });
    const eventCard = document.querySelector('[data-event-id="validation-1"]');
    if (!(eventCard instanceof HTMLButtonElement)) throw new Error('validation event missing');
    await user.click(eventCard);
    await user.click(screen.getByRole('tab', { name: 'Response' }));

    expect(await screen.findByText('Decision')).toBeInTheDocument();
    expect(screen.getByText('✓ Approved')).toBeInTheDocument();
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.getByText('Every requested document passed.')).toBeInTheDocument();
    expect(screen.getByText('Requested changes')).toBeInTheDocument();
    expect(screen.getByText('Preferred agent')).toBeInTheDocument();
    expect(screen.getByText('Ammonia')).toBeInTheDocument();
    expect(screen.queryByText(/"approved"/)).not.toBeInTheDocument();
  });

  it('navigates every API-backed view through accessible MUI tabs', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByDisplayValue('Component migration')).toBeInTheDocument();
    expect(
      (await screen.findAllByText('Render a component application')).length
    ).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText(/zai:glm-test/)).length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole('tab', { name: 'Registry' }));
    expect((await screen.findAllByText('Water')).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('Web component builder')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Skills' }));
    expect(await screen.findByText(/build-widget/)).toBeInTheDocument();
    expect(await screen.findByText('A human must read the recipe.')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Burn-in' }));
    expect(await screen.findByText('component-smoke')).toBeInTheDocument();
    expect(screen.getByText('⚠1')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Launch' }));
    expect(await screen.findByRole('textbox', { name: 'Goal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });

  it('keeps refresh scoped to the active component view', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByDisplayValue('Component migration');
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    const refreshedPaths = fetchMock.mock.calls.slice(before).map((call) => {
      const input = call[0];
      return typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    });
    expect(refreshedPaths).toContain('/api/runs');
    expect(refreshedPaths).toContain('/api/runs/run-1');
    expect(refreshedPaths.some((path) => path.startsWith('/api/registry'))).toBe(false);
  });
});

describe('the document itself speaks the viewer\'s language', () => {
  it('writes lang, dir and the TAB TITLE from one place, in the viewer\'s language', () => {
    // 2026-08-27, finding 3.13. The tab said "Atoma — run visualizer" in every
    // language: product copy outside the catalog, in a client that declares
    // itself entirely catalogued. Four hand-written copies set `lang` and
    // `dir` and none of them set the title, so adding it to one would have
    // made a fifth thing to keep in step.
    const root = document.documentElement;
    applyDocumentLocale('fr');
    expect(root.lang).toBe('fr');
    expect(root.dir).toBe('ltr');
    expect(document.title).toBe(translate('fr', 'app.documentTitle'));
    // RTL is the case `dir` exists for, and the title follows the locale too.
    applyDocumentLocale('ar');
    expect(root.dir).toBe('rtl');
    expect(document.title).toBe(translate('ar', 'app.documentTitle'));
    // Back to the source of truth.
    applyDocumentLocale('en');
    expect(document.title).toBe('Atoma — Inspectable AI Agent Orchestration');
  });
});
