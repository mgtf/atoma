// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { claudeMcpCommand, McpAccess, McpAccessPanel, type McpAccessPanelProps } from '../src/viz/client-gl/McpAccessPanel.js';

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

describe('McpAccessPanel', () => {
  it('shows the address, the three steps and a creation form when nothing is minted', async () => {
    const onCreate = vi.fn(async () => undefined);
    panel({ onCreate });
    expect(screen.getByTestId('mcp-url')).toHaveTextContent('https://atoma.example.com/mcp');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('No token yet.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Token name'), 'my laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(onCreate).toHaveBeenCalledWith('my laptop');
  });

  it('uses a default label when the field is left empty', async () => {
    const onCreate = vi.fn(async () => undefined);
    panel({ onCreate });
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(onCreate).toHaveBeenCalledWith('MCP token');
  });

  it('shows a minted token once, with the exact Claude Code line, and hides it on dismiss', async () => {
    const onCopy = vi.fn(async () => undefined);
    const onDismissMinted = vi.fn();
    panel({ minted: { tokenId: 't1', token: 'atoma_secret' }, onCopy, onDismissMinted });
    expect(screen.getByTestId('mcp-token')).toHaveTextContent('atoma_secret');
    const command = screen.getByTestId('mcp-claude-command');
    expect(command).toHaveTextContent(claudeMcpCommand('https://atoma.example.com/mcp', 'atoma_secret'));
    expect(command).toHaveTextContent("--transport http --scope user atoma 'https://atoma.example.com/mcp' --header 'Authorization: Bearer atoma_secret'");
    // No creation form while the secret is on screen: one token at a time.
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    const copies = screen.getAllByRole('button', { name: 'Copy' });
    await userEvent.click(copies[2]!); // the command's copy
    expect(onCopy).toHaveBeenCalledWith(expect.stringContaining('claude mcp add --transport http'));
    await userEvent.click(screen.getByRole('button', { name: 'Done, I copied it' }));
    expect(onDismissMinted).toHaveBeenCalled();
  });

  it('lists live tokens without any secret and revokes through the handler; revoked ones are hidden', async () => {
    const onRevoke = vi.fn(async () => undefined);
    const { container } = panel({
      tokens: [
        { tokenId: 'live', orgId: 'o', orgName: 'Org One', label: 'laptop', createdAt: '2026-09-05T10:00:00.000Z', lastUsedAt: null, revokedAt: null },
        { tokenId: 'dead', orgId: 'o', orgName: 'Org One', label: 'old phone', createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: null, revokedAt: '2026-09-02T10:00:00.000Z' },
      ],
      onRevoke,
    });
    expect(screen.getByText('laptop')).toBeInTheDocument();
    expect(screen.queryByText('old phone')).toBeNull();
    expect(screen.getByText(/Org One · created .* · last used never/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('atoma_');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onRevoke).toHaveBeenCalledWith('live');
  });

  it('reports a load failure and a missing address without hiding the procedure', () => {
    panel({ error: 'HTTP 500', mcpUrl: null });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your MCP tokens: HTTP 500');
    expect(screen.getByText('This deployment did not publish an MCP address.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.queryByText('No token yet.')).toBeNull();
  });

  it('explains Bearer compatibility, the terminal step and connection verification', () => {
    panel();
    expect(screen.getByText(/A client that only offers OAuth connection/)).toBeInTheDocument();
    expect(screen.getByText(/not a web page/)).toBeInTheDocument();
    expect(screen.getByText(/Creating a token alone does not establish a connection/)).toBeInTheDocument();
  });

  it('shows the local operator procedure without token creation or a Bearer header', () => {
    panel({ mode: 'operator', mcpUrl: 'http://127.0.0.1:4111/mcp' });
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    expect(screen.queryByText('No token yet.')).toBeNull();
    expect(screen.getByTestId('mcp-claude-command')).not.toHaveTextContent('--header');
    expect(screen.getByText(/A remote or cloud client cannot reach this loopback address/)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    await userEvent.type(screen.getByLabelText('Token name'), 'laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('mcp-token')).toHaveTextContent(minted.token);
    expect(await screen.findByText(/The change was saved, but the token list/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tokens', expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'laptop' }) }));
    expect(screen.getByTestId('mcp-claude-command')).toHaveTextContent(minted.mcpUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('mcp-token')).toHaveTextContent(minted.token);
    await screen.findByText('Token created — copy it now, it will not be shown again.');
    view.rerender(createElement(McpAccess, { ...props, key: 'principal:org-two' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled());
    expect(screen.queryByTestId('mcp-token')).toBeNull();
  });
});
