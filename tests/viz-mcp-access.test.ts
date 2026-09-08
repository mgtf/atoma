// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { claudeMcpCommand, codexMcpCommand, codexMcpConfig, McpAccess, McpAccessPanel, type McpAccessPanelProps } from '../src/viz/client-gl/McpAccessPanel.js';

/**
 * The Settings panel that turns "atoma has an MCP" into a procedure. What it
 * holds: the address and the three steps are always shown; a token is created
 * from a label; the minted token and the exact Claude Code line appear ONCE
 * with copy buttons and disappear on dismiss; the list shows live tokens with
 * a revoke button and never the secret.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const noop = vi.fn(async () => undefined);

function panel(overrides: Partial<McpAccessPanelProps> = {}) {
  const props: McpAccessPanelProps = {
    t: (key, vars) => translate('en', key, vars),
    locale: 'en',
    mcpUrl: 'https://atoma.example.com/mcp',
    tokens: [],
    loading: false,
    error: null,
    busy: false,
    status: null,
    minted: null,
    onRetry: noop,
    onCreate: noop,
    onRevoke: noop,
    onCopy: noop,
    onDismissMinted: vi.fn(),
    ...overrides,
  };
  return { ...render(createElement(McpAccessPanel, props)), props };
}

async function openManual() {
  await userEvent.click(screen.getByText('Advanced · API tokens'));
}

describe('McpAccessPanel', () => {
  it('leads with the URL and browser sign-in, keeping client setup and manual tokens collapsed', async () => {
    const onCopy = vi.fn(async () => undefined);
    panel({ onCopy });
    expect(screen.getByTestId('mcp-url')).toHaveTextContent('https://atoma.example.com/mcp');
    expect(screen.getByText(/No API token is needed/)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-manual-access')).not.toHaveAttribute('open');
    expect(screen.getByTestId('mcp-oauth-config').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('No agent connected yet. Start the connection from your agent.')).toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('mcp-url').parentElement!).getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith('https://atoma.example.com/mcp');
  });

  it('creates a named or default token only through the advanced section', async () => {
    const onCreate = vi.fn(async () => undefined);
    panel({ onCreate });
    await openManual();
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(onCreate).toHaveBeenLastCalledWith('MCP token');
    await userEvent.type(screen.getByLabelText('Token name'), 'my laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(onCreate).toHaveBeenLastCalledWith('my laptop');
  });

  it('opens advanced access for a newly minted token and copies only on request', async () => {
    const onCopy = vi.fn(async () => undefined);
    const onDismissMinted = vi.fn();
    panel({ minted: { tokenId: 't1', token: 'atoma_secret' }, onCopy, onDismissMinted });
    const advanced = screen.getByTestId('mcp-manual-access');
    expect(advanced).toHaveAttribute('open');
    expect(screen.getByTestId('mcp-token')).toHaveTextContent('atoma_secret');
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    expect(onCopy).not.toHaveBeenCalled();
    await userEvent.click(within(advanced).getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith('atoma_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Done, I copied it' }));
    expect(onDismissMinted).toHaveBeenCalled();
  });

  it('lists authorized access without secrets and revokes through the handler', async () => {
    const onRevoke = vi.fn(async () => undefined);
    const { container } = panel({ tokens: [
      { tokenId: 'live', orgId: 'o', orgName: 'Org One', label: 'OAuth: Codex', createdAt: '2026-09-05T10:00:00.000Z', lastUsedAt: null, revokedAt: null },
      { tokenId: 'dead', orgId: 'o', orgName: 'Org One', label: 'old phone', createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null, revokedAt: '2026-09-02T10:00:00.000Z' },
    ], onRevoke });
    expect(screen.getByRole('list', { name: 'Authorized access' })).toHaveTextContent('OAuth: Codex');
    expect(screen.queryByText('old phone')).toBeNull();
    expect(screen.getByText(/Org One · created .* · last used never/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('atoma_');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onRevoke).toHaveBeenCalledWith('live');
  });

  it('reports a load failure without presenting an empty access list as success', async () => {
    panel({ error: 'HTTP 500', mcpUrl: null });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your connections: HTTP 500');
    expect(screen.getByText('This deployment did not publish an MCP address.')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-oauth-config')).toBeNull();
    await openManual();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.queryByText(/No agent connected yet/)).toBeNull();
  });

  it('provides token-free Codex and Claude setup on demand', async () => {
    const onCopy = vi.fn(async () => undefined);
    panel({ onCopy });
    await userEvent.click(screen.getByText('Setup help for Codex and Claude Code'));
    const codex = screen.getByTestId('mcp-oauth-config');
    expect(codex.textContent).toBe(codexMcpConfig('https://atoma.example.com/mcp'));
    await userEvent.click(within(codex.parentElement!).getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(codex.textContent);
    const command = screen.getByTestId('mcp-connect-command');
    expect(command.textContent).toBe(codexMcpCommand('https://atoma.example.com/mcp'));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'codex-macos');
    await userEvent.click(within(command.parentElement!).getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenLastCalledWith(codexMcpCommand('https://atoma.example.com/mcp', true));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'claude');
    expect(command.textContent).toBe(claudeMcpCommand('https://atoma.example.com/mcp'));
    expect(screen.getByText(/select this server and choose Authenticate/)).toBeInTheDocument();
  });

  it('keeps the local operator procedure free of authentication and token creation', async () => {
    panel({ mode: 'operator', mcpUrl: 'http://127.0.0.1:4111/mcp' });
    expect(screen.queryByTestId('mcp-manual-access')).toBeNull();
    expect(screen.getByTestId('mcp-connect-command')).not.toHaveTextContent('mcp login');
    await userEvent.click(screen.getByText('Setup help for Codex and Claude Code'));
    expect(screen.getByTestId('mcp-connect-command')).not.toHaveTextContent('--header');
    expect(screen.getByTestId('mcp-oauth-config').textContent).toBe('[mcp_servers.atoma-local]\nurl = "http://127.0.0.1:4111/mcp"');
  });
});

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const tokenList = { tokens: [], mcpUrl: 'https://atoma.example.com/mcp', mode: 'bearer' };
const minted = { tokenId: 'token-one', token: 'atoma_secret', createdAt: '2026-09-05T10:00:00.000Z', mcpUrl: tokenList.mcpUrl };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('McpAccess API lifecycle', () => {
  it('turns an API 404 into actionable guidance and recovers through Retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ error: 'not found' }, 404))
      .mockResolvedValueOnce(reply(tokenList));
    vi.stubGlobal('fetch', fetcher);
    render(createElement(McpAccess, { t, locale: 'en', onError: vi.fn() }));
    await openManual();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server did not find the token API (404)');
    expect(fetcher).toHaveBeenCalledWith('/api/tokens');
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.queryByText('No token yet.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('mcp-url')).toHaveTextContent(tokenList.mcpUrl);
  });

  it('retains the one-time token and canonical URL when creation succeeds but refresh fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(tokenList))
      .mockResolvedValueOnce(reply(minted, 201))
      .mockResolvedValueOnce(reply({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(reply(tokenList));
    vi.stubGlobal('fetch', fetcher);
    render(createElement(McpAccess, { t, locale: 'en', onError: vi.fn() }));
    await openManual();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    await userEvent.type(screen.getByLabelText('Token name'), 'laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('mcp-token')).toHaveTextContent(minted.token);
    expect(await screen.findByText(/The change was saved, but the token list/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tokens', expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'laptop' }) }));
    expect(screen.getByTestId('mcp-url')).toHaveTextContent(minted.mcpUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(/The change was saved, but the token list/)).toBeNull();
    expect(screen.getByTestId('mcp-token')).toHaveTextContent(minted.token);
    await userEvent.click(screen.getByRole('button', { name: 'Done, I copied it' }));
    expect(screen.queryByTestId('mcp-token')).toBeNull();
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('keeps a confirmed revocation removed when refreshing the list fails', async () => {
    const token = { tokenId: 't1', orgId: 'o', orgName: 'Org', label: 'laptop', createdAt: minted.createdAt, lastUsedAt: null, revokedAt: null };
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...tokenList, tokens: [token] }))
      .mockResolvedValueOnce(reply({ revoked: true }))
      .mockResolvedValueOnce(reply({ error: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetcher);
    render(createElement(McpAccess, { t, locale: 'en', onError: vi.fn() }));
    await openManual();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/The change was saved, but the token list/)).toBeInTheDocument();
    expect(screen.queryByText('laptop')).toBeNull();
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tokens/t1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('does not carry a newly minted secret into another organisation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(tokenList))
      .mockResolvedValueOnce(reply(minted, 201))
      .mockResolvedValueOnce(reply(tokenList))
      .mockResolvedValueOnce(reply(tokenList));
    vi.stubGlobal('fetch', fetcher);
    const props = { t, locale: 'en', onError: vi.fn() };
    const view = render(createElement(McpAccess, { ...props, key: 'principal:org-one' }));
    await openManual();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('mcp-token')).toHaveTextContent(minted.token);
    await screen.findByText('Token created — copy it now, it will not be shown again.');
    view.rerender(createElement(McpAccess, { ...props, key: 'principal:org-two' }));
    await openManual();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    expect(screen.queryByTestId('mcp-token')).toBeNull();
  });
});
