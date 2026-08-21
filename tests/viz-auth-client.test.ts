// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_COPY } from '../src/auth/copy.js';
import { translate } from '../src/viz/client/i18n.js';
import {
  AUTH_LOGIN_PATH,
  authLoginPath,
  loginBounceParams,
  providerLoginHref,
  redirectIfAuthenticationRequired,
} from '../src/viz/client/auth-session.js';
import { AuthControls, useAuthController } from '../src/viz/client-gl/AuthControls.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderControls(fetchMock: ReturnType<typeof vi.fn>, navigate = vi.fn()) {
  render(
    createElement(AuthControls, {
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      fetchImpl: fetchMock as unknown as typeof fetch,
      navigate,
    })
  );
  return { navigate };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('viz authentication session navigation', () => {
  it('returns to the app shell — the arrival gate is the login', () => {
    expect(authLoginPath('?view=runs')).toBe('/');
    // The server-owned no-JS selector keeps its canonical path for hrefs.
    expect(AUTH_LOGIN_PATH).toBe('/auth/login');

    const navigate = vi.fn();
    expect(redirectIfAuthenticationRequired(404, navigate, '?view=runs')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('parses only bounded bounce parameters and threads the invitation onto provider hrefs', () => {
    // The invitation is the bearer that admits the invitee: dropping it from
    // the shell-built href would refuse the login or found a stray org.
    const bounce = loginBounceParams('?authNotice=providerRefused&invite=tok%2Fwith%20space&x=1');
    expect(bounce).toEqual({ notice: 'providerRefused', invite: 'tok/with space' });
    expect(providerLoginHref('github', bounce.invite)).toBe(
      '/auth/login?provider=github&invite=tok%2Fwith%20space'
    );
    expect(providerLoginHref('github', null)).toBe('/auth/login?provider=github');

    // The notice is DISPLAY STEERING only: anything but a short letter code
    // is dropped, and an oversized invitation never rides a link.
    expect(loginBounceParams('?authNotice=<img%20src=x>').notice).toBeNull();
    expect(loginBounceParams('?authNotice=a1').notice).toBeNull();
    expect(loginBounceParams(`?invite=${'A'.repeat(513)}`).invite).toBeNull();
    expect(loginBounceParams('').notice).toBeNull();
  });

  it('preserves only the invitation when a 401 returns to the gate', () => {
    const navigate = vi.fn();

    expect(
      redirectIfAuthenticationRequired(
        401,
        navigate,
        '?view=runs&invite=invite%2Fwith%20spaces&state=discard-me'
      )
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/?invite=invite%2Fwith%20spaces');
  });
});

describe('server authentication copy', () => {
  it('keeps the product identity capitalized and invitation recovery actionable', () => {
    expect(AUTH_COPY.pageTitle).toBe('Atoma — sign in');
    expect(AUTH_COPY.brand).toBe('Atoma');
    expect(AUTH_COPY.providerFailure).toContain('reopen its original link');
    expect(AUTH_COPY.providerRefused).toContain('reopen its original link');
  });
});

describe('GPU authentication controls', () => {
  it('shows the authenticated viewer returned by whoami', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      authenticated: true,
      displayName: 'Ada Lovelace',
      role: 'org:owner',
      activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
      organisations: [{ id: 'org-a', name: 'Analytical Engines', role: 'org:owner' }],
    }));

    renderControls(fetchMock);

    const viewer = await screen.findByText('Signed in as Ada Lovelace');
    expect(viewer).toHaveAttribute(
      'title',
      'org:owner'
    );
    expect(viewer.closest('aside')).toHaveClass('gpu-a11y-bridge');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByText('Organisation: Analytical Engines')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/auth/whoami', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it('exposes the unauthenticated gate and its providers from a 200 whoami', async () => {
    // The arrival gate is the login: a 200 {enabled, authenticated:false}
    // whoami must set gate 'unauthenticated' and surface only well-shaped
    // providers — no redirect, no account aside.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      enabled: true,
      authenticated: false,
      providers: [
        { id: 'github', label: 'GitHub' },
        { id: 42, label: 'broken' },
        'garbage',
        { id: 'google' },
      ],
    }));
    function Probe() {
      const { gate, providers } = useAuthController();
      return createElement(
        'output',
        { 'data-testid': 'gate-probe' },
        `${gate}:${providers.map((provider) => provider.id).join(',')}`
      );
    }
    const navigate = vi.fn();
    render(
      createElement(
        AuthControls,
        {
          t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
          fetchImpl: fetchMock as unknown as typeof fetch,
          navigate,
        },
        createElement(Probe)
      )
    );

    await waitFor(() =>
      // Exact match: a mis-filtered provider list (e.g. the label-less
      // entry surviving) must fail, not hide behind substring semantics.
      expect(screen.getByTestId('gate-probe')).toHaveTextContent(/^unauthenticated:github$/)
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('stays hidden when authentication is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ enabled: false, authenticated: false }));
    const { navigate } = renderControls(fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('complementary', { name: 'Account' })).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns an expired session to login and keeps its invitation', async () => {
    window.history.replaceState({}, '', '/?invite=first-admission&view=runs');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ authenticated: false }, 401));
    const { navigate } = renderControls(fetchMock);

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/?invite=first-admission');
    });
    expect(screen.queryByRole('complementary', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('posts logout and returns to the arrival gate on success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        displayName: 'Grace Hopper',
        role: 'org:member',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { navigate } = renderControls(fetchMock);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('keeps the account control available when logout fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        displayName: 'Katherine Johnson',
        role: 'org:member',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const { navigate } = renderControls(fetchMock);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Account action failed');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('switches only to a membership returned by whoami and reloads the app', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        displayName: 'Dorothy Vaughan',
        role: 'org:owner',
        activeOrganisation: { id: 'org-a', name: 'West Area', role: 'org:owner' },
        organisations: [
          { id: 'org-a', name: 'West Area', role: 'org:owner' },
          { id: 'org-b', name: 'Flight Research', role: 'org:member' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        activeOrganisation: { id: 'org-b', name: 'Flight Research', role: 'org:member' },
      }));
    const { navigate } = renderControls(fetchMock);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Switch to Flight Research' }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/auth/organisations/org-b/activate',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
    );
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
