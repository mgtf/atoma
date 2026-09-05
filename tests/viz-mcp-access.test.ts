// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { claudeMcpCommand, McpAccessPanel, type McpAccessPanelProps } from '../src/viz/client-gl/McpAccessPanel.js';

/**
 * The Settings panel that turns "atoma has an MCP" into a procedure. What it
 * holds: the address and the three steps are always shown; a token is created
 * from a label; the minted token and the exact Claude Code line appear ONCE
 * with copy buttons and disappear on dismiss; the list shows live tokens with
 * a revoke button and never the secret.
 */

afterEach(() => cleanup());

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
    expect(command).toHaveTextContent('--transport http https://atoma.example.com/mcp --header "Authorization: Bearer atoma_secret"');
    // No creation form while the secret is on screen: one token at a time.
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
    const copies = screen.getAllByRole('button', { name: 'Copy' });
    await userEvent.click(copies[2]!); // the command's copy
    expect(onCopy).toHaveBeenCalledWith(expect.stringContaining('claude mcp add atoma'));
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
  });
});
