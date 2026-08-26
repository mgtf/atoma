// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementForm } from '../src/viz/client-gl/AnnouncementForm.js';
import { SUPPORTED_LOCALES } from '../src/contracts/locales.js';
import { DomBridge } from '../src/viz/client-gl/DomBridge.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
import { api } from '../src/viz/client/data-api.js';
import { translate } from '../src/viz/client/i18n-catalog.js';

const TEXTS = Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [
  locale,
  locale === 'fr'
    ? { title: 'Mise à jour du service', body: 'Tout est prêt.' }
    : { title: 'Service update', body: 'Everything is ready.' },
])) as Record<(typeof SUPPORTED_LOCALES)[number], { title: string; body: string }>;

function form(client: QueryClient, resetSignal: number) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(AnnouncementForm, {
      locale: 'en',
      resetSignal,
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    })
  );
}

function AnnouncementBridgeHarness({ client }: { client: QueryClient }) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(DomBridge, {
      runs: [],
      releaseVersion: 'test',
      views: ['announce'],
      announcementsEnabled: true,
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      onSelectRun: vi.fn(),
    })
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('announcement composer active-navigation reset', () => {
  it('returns a sent receipt to an empty composer when Announcements is re-activated', async () => {
    vi.spyOn(api, 'draftAnnouncement').mockResolvedValue({
      translated: true,
      reason: null,
      texts: TEXTS,
    });
    vi.spyOn(api, 'sendAnnouncement').mockResolvedValue({ segment: 'all', orgCount: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    useGpuStore.setState({
      view: 'announce',
      locale: 'en',
      entered: true,
      accountMenuOpen: false,
      announcementResetSignal: 0,
    });
    render(createElement(AnnouncementBridgeHarness, { client }));

    await user.type(screen.getByRole('textbox', { name: 'Title — English' }), TEXTS.en.title);
    await user.type(screen.getByRole('textbox', { name: 'Message — English' }), TEXTS.en.body);
    await user.click(screen.getByRole('button', { name: 'Translate' }));
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Confirm — this cannot be recalled' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Sent to every organisation.');
    await user.click(screen.getByRole('tab', { name: 'Announcements' }));

    expect(await screen.findByRole('button', { name: 'Translate' })).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title — English' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Message — English' })).toHaveValue('');
  });

  it('does not erase an in-progress message on the same re-activation', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const rendered = render(form(client, 0));
    const title = screen.getByRole('textbox', { name: 'Title — English' });
    const body = screen.getByRole('textbox', { name: 'Message — English' });
    await user.type(title, TEXTS.en.title);
    await user.type(body, TEXTS.en.body);

    rendered.rerender(form(client, 1));

    expect(title).toHaveValue(TEXTS.en.title);
    expect(body).toHaveValue(TEXTS.en.body);
    useGpuStore.setState({ view: 'runs', announcementResetSignal: 7 });
    useGpuStore.getState().setView('announce');
    expect(useGpuStore.getState().announcementResetSignal).toBe(7);
  });
});
