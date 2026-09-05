// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY } from '../src/core/providerCatalog.js';
import {
  OrgModelsForm,
  PersonalSubscriptionsPanel,
  personalSubscriptionFamilies,
  providerIsUnlocked,
  roleCanUsePersonalSubscriptions,
  type PersonalSubscriptionsPanelProps,
} from '../src/viz/client-gl/OrgModelsForm.js';
import { api } from '../src/viz/client/data-api.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type {
  VizAccountModels,
  VizAccountSubscriptions,
  VizOrganisation,
  VizOrgModels,
} from '../src/viz/client/types.js';

const CONNECTING: VizAccountSubscriptions = {
  claude: {
    provider: 'claude',
    state: 'unavailable',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: 'provider-approval-required',
  },
  codex: {
    provider: 'codex',
    state: 'connecting',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: null,
  },
  codexAttempt: {
    attemptId: 'a23ae0f6-f16a-4abc-84e1-6819d2f8d257',
    state: 'connecting',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    expiresAt: '2026-09-04T12:00:00.000Z',
    reason: null,
  },
};

const DISCONNECTED: VizAccountSubscriptions = {
  claude: CONNECTING.claude,
  codex: {
    provider: 'codex',
    state: 'disconnected',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: null,
  },
  codexAttempt: null,
};

const ACCOUNT_MODELS: VizAccountModels = {
  pins: { l1: null, l2: null, l3: null },
  defaults: { l1: 'ollama:test', l2: 'ollama:test', l3: 'ollama:test' },
  catalog: [],
  personalSubscriptions: { claude: false, codex: false },
};

const ORG_MODELS: VizOrgModels = {
  models: { l1: null, l2: null, l3: null },
  keys: [],
  encryptionReady: false,
  catalog: [],
  operatorDefaults: { l1: 'ollama:test', l2: 'ollama:test', l3: 'ollama:test' },
};

function organisation(viewerRole: string): VizOrganisation {
  return {
    id: 'org-1',
    name: 'Example organisation',
    createdAt: '2026-09-04T10:00:00.000Z',
    viewerRole,
    members: [],
    projectCount: 0,
    pendingInvitations: null,
  };
}

const noop = vi.fn(async () => undefined);

function panel(overrides: Partial<PersonalSubscriptionsPanelProps> = {}) {
  const props: PersonalSubscriptionsPanelProps = {
    t: (key, vars) => translate('en', key, vars),
    subscriptions: CONNECTING,
    loading: false,
    error: null,
    canUse: true,
    busy: false,
    status: null,
    onStartCodex: noop,
    onCancelCodex: noop,
    onDisconnectCodex: noop,
    onCopyCodex: noop,
    ...overrides,
  };
  return render(createElement(PersonalSubscriptionsPanel, props));
}

function orgModelsForm(viewerRole: string, enabled = true, children?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        OrgModelsForm,
        {
          t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
          locale: 'en',
          enabled,
          canManageOrg: false,
          platformAdmin: false,
          organisation: organisation(viewerRole),
          overlaysInert: false,
          onError: vi.fn(),
        },
        children
      )
    )
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('personal subscription settings', () => {
  it('shows the bounded Codex device flow with open, copy and cancel actions', async () => {
    const copy = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const user = userEvent.setup();
    panel({ onCopyCodex: copy, onCancelCodex: cancel });

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Personal Claude subscription login needs provider approval before Atoma can offer it here.')).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute(
      'href',
      CONNECTING.codexAttempt!.verificationUrl
    );

    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    await user.click(screen.getByRole('button', { name: 'Cancel login' }));
    expect(copy).toHaveBeenCalledWith('ABCD-EFGH');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps subscription actions unavailable to an organisation viewer', () => {
    panel({ canUse: false });

    expect(screen.getByRole('note')).toHaveTextContent(
      'Viewers cannot connect or use personal AI subscriptions.'
    );
    expect(screen.queryByRole('link', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel login' })).not.toBeInTheDocument();
    expect(
      ['org:owner', 'org:admin', 'org:member'].every(roleCanUsePersonalSubscriptions)
    ).toBe(true);
    expect(roleCanUsePersonalSubscriptions('org:viewer')).toBe(false);
  });

  it.each([
    ['org:viewer', true],
    ['org:member', false],
  ] as const)(
    'does not request the self-care subscription endpoint for %s when enabled=%s',
    async (role, enabled) => {
      vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
      vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
      const subscriptions = vi
        .spyOn(api, 'accountSubscriptions')
        .mockResolvedValue(DISCONNECTED);
      orgModelsForm(role, enabled);

      if (enabled) await waitFor(() => expect(api.accountModels).toHaveBeenCalledOnce());
      expect(subscriptions).not.toHaveBeenCalled();
    }
  );

  it('renders its children inside the Settings frame, above the subscriptions', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const { container } = orgModelsForm('org:member', true, createElement('p', { 'data-testid': 'settings-child' }, 'child'));

    const child = await screen.findByTestId('settings-child');
    const frame = container.querySelector('.gpu-org-models-form');
    expect(frame).not.toBeNull();
    expect(frame!.contains(child)).toBe(true);
    expect(frame!.firstElementChild).toBe(child);
  });

  it('requests the self-care subscription endpoint for an organisation member', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    const subscriptions = vi
      .spyOn(api, 'accountSubscriptions')
      .mockResolvedValue(DISCONNECTED);
    orgModelsForm('org:member');

    await waitFor(() => expect(subscriptions).toHaveBeenCalledOnce());
  });

  it.each(['error', 'unavailable'] as const)(
    'offers disconnect, not reconnect, for a retained %s subscription',
    async (state) => {
      const disconnect = vi.fn(async () => undefined);
      const user = userEvent.setup();
      panel({
        subscriptions: {
          ...DISCONNECTED,
          codex: {
            provider: 'codex',
            state,
            connectedAt: '2026-09-04T10:00:00.000Z',
            lastVerifiedAt: null,
            reason: state === 'error' ? 'login-failed' : 'codex-cli-unavailable',
          },
        },
        onDisconnectCodex: disconnect,
      });

      expect(screen.queryByRole('button', { name: 'Reconnect ChatGPT' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Disconnect' }));
      expect(disconnect).toHaveBeenCalledOnce();
    }
  );

  it('offers reconnect for a subscription that requires authentication again', () => {
    panel({
      subscriptions: {
        ...DISCONNECTED,
        codex: {
          provider: 'codex',
          state: 'reauth_required',
          connectedAt: '2026-09-04T10:00:00.000Z',
          lastVerifiedAt: null,
          reason: 'authentication-required',
        },
      },
    });

    expect(screen.getByRole('button', { name: 'Reconnect ChatGPT' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('offers personal Codex only while connected, but retains an armed disconnected pin', () => {
    const family = PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY;
    const states: VizAccountSubscriptions['codex']['state'][] = [
      'disconnected',
      'connecting',
      'connected',
      'reauth_required',
      'unavailable',
      'error',
    ];
    for (const state of states) {
      expect(
        providerIsUnlocked(family, new Set(), {
          billedKeyReady: true,
          ollamaAvailable: true,
          personalSubscriptions: { claude: false, codex: true },
          personalSubscriptionState: state,
        }),
        state
      ).toBe(state === 'connected');
    }
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: false },
        retainPersonalCodexFamily: true,
      }).map((entry) => entry.id)
    ).toEqual(['principal-chatgpt-subscription']);
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: true },
        personalSubscriptionState: 'connected',
        hostCodexSelected: true,
      })
    ).toEqual([]);
  });

  it('uses only the self-scoped account subscription endpoints', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.startCodexSubscriptionLogin();
    await api.cancelCodexSubscriptionLogin();
    await api.disconnectCodexSubscription();

    expect(
      fetchMock.mock.calls.map(([path, init]) => [path, (init as RequestInit).method])
    ).toEqual([
      ['/api/account/subscriptions/codex/login', 'POST'],
      ['/api/account/subscriptions/codex/login', 'DELETE'],
      ['/api/account/subscriptions/codex', 'DELETE'],
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: 'same-origin', body: '{}' });
    }
  });
});
