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
  defaults: { l1: 'api:ollama:test', l2: 'api:ollama:test', l3: 'api:ollama:test' },
  catalog: [],
  personalSubscriptions: { claude: false, codex: false },
};

const ORG_MODELS: VizOrgModels = {
  models: { l1: null, l2: null, l3: null },
  keys: [{ provider: 'openai', configuredAt: '2026-09-02T08:00:00.000Z' }],
  encryptionReady: false,
  catalog: [
    {
      id: 'openai',
      label: 'OpenAI',
      selectorPrefix: 'api:openai',
      credentialEnvVar: 'OPENAI_API_KEY',
      suggestive: false,
      models: [{ id: 'gpt-test', label: 'GPT test' }],
    },
  ],
  operatorDefaults: { l1: 'api:ollama:test', l2: 'api:ollama:test', l3: 'api:ollama:test' },
};

function organisation(viewerRole: string): VizOrganisation {
  return {
    id: 'org-1',
    name: 'Example organisation',
    createdAt: '2026-09-04T10:00:00.000Z',
    viewerRole,
    members: [
      { principalId: 'p-1', displayName: 'Ada', role: 'org:owner', joinedAt: '2026-09-01T09:30:00.000Z' },
    ],
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

function orgModelsForm(
  viewerRole: string,
  enabled = true,
  children?: ReactNode,
  profile?: ReactNode
) {
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
          profile,
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

  it('splits the body into five tabs and keeps every panel mounted, hidden', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const user = userEvent.setup();
    const { container } = orgModelsForm(
      'org:member',
      true,
      createElement('p', { 'data-testid': 'settings-child' }, 'child')
    );

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'General',
      'LLM models',
      'Your AI subscriptions',
      'Your AI API keys',
      'Atoma MCP',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Every panel is in the DOM (a minted MCP token must survive a tab
    // switch); only the active one is visible.
    const panels = container.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(5);
    expect(Array.from(panels).filter((panel) => !panel.hasAttribute('hidden'))).toHaveLength(1);
    // Children land in the MCP tab, hidden until it is selected.
    const child = screen.getByTestId('settings-child');
    expect(child.closest('#settings-panel-mcp')).not.toBeNull();
    expect(child).not.toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Atoma MCP' }));
    expect(child).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Atoma MCP' })).toHaveAttribute('aria-selected', 'true');
    // Arrow keys move the selection and wrap.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Atoma MCP' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the profile and the organisation in General, with a formatted join date', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    orgModelsForm(
      'org:member',
      true,
      undefined,
      createElement('p', { 'data-testid': 'settings-profile' }, 'profile')
    );

    const profile = await screen.findByTestId('settings-profile');
    expect(profile.closest('#settings-panel-general')).not.toBeNull();
    expect(profile).toBeVisible();
    // The raw ISO slice ("2026-09-01") is what shipped; a date is expected.
    expect(screen.getByText(/joined September 1, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
  });

  it('orders personal pins before the organisation defaults, greyed for a plain member', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const user = userEvent.setup();
    orgModelsForm('org:member');

    await user.click(await screen.findByRole('tab', { name: 'LLM models' }));
    const selects = screen.getAllByRole('combobox');
    expect(selects.map((select) => select.id)).toEqual([
      'accountmodel-l1', 'accountmodel-l2', 'accountmodel-l3',
      'orgmodel-l1', 'orgmodel-l2', 'orgmodel-l3',
    ]);
    for (const select of selects.slice(0, 3)) expect(select).toBeEnabled();
    for (const select of selects.slice(3)) expect(select).toBeDisabled();
    expect(screen.getByText(/Only organisation owners and admins can change these defaults/))
      .toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Your AI API keys' }));
    expect(screen.getByText(/Provider keys are managed by organisation owners and admins/))
      .toBeInTheDocument();
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save key|Replace key/ })).not.toBeInTheDocument();
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
    ).toEqual(['own:openai']);
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
