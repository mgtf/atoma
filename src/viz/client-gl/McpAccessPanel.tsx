import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiHttpError } from '../client/data-api.js';
import { formatDateTime } from '../client/date-format.js';
import type { VizApiToken, VizApiTokens } from '../client/types.js';

/**
 * CONNECT YOUR AGENT — the Settings panel that turns "atoma has an MCP" into a
 * short browser-sign-in procedure. Client-specific commands are selected in place; manual API
 * tokens remain in an advanced disclosure.
 * The panel is the client half of `/api/tokens`
 * (`src/viz/AGENTS.md`); the tiering — what the agent will actually see — is
 * decided server-side from the role and never described here as a promise.
 *
 * The plaintext token lives in component state for the life of this view and
 * nowhere else: the server never returns it again, and the list below shows
 * labels and dates only.
 */

export interface McpAccessPanelProps {
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly locale: string;
  readonly mcpUrl: string | null;
  readonly mode?: 'bearer' | 'operator';
  readonly onRetry: () => Promise<void>;
  readonly tokens: readonly VizApiToken[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly status: string | null;
  /** The token just minted, plaintext, shown once. */
  readonly minted: { tokenId: string; token: string } | null;
  readonly onCreate: (label: string) => Promise<void>;
  readonly onRevoke: (tokenId: string) => Promise<void>;
  readonly onCopy: (text: string) => Promise<void>;
  readonly onDismissMinted: () => void;
}

/** POSIX shell quoting keeps a deployment URL from becoming shell syntax. */
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

type McpClient = 'codex' | 'codex-macos' | 'claude';

function serverName(mcpUrl: string): string {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(mcpUrl).hostname) ? 'atoma-local' : 'atoma';
}

export function codexMcpCommand(mcpUrl: string, desktop = false, oauth = true): string {
  const executable = desktop ? shellQuote('/Applications/ChatGPT.app/Contents/Resources/codex') : 'codex';
  const name = serverName(mcpUrl);
  const add = `${executable} mcp add ${name} --url ${shellQuote(mcpUrl)}`;
  return oauth ? `${add} &&\n${executable} mcp login ${name}` : add;
}

export function claudeMcpCommand(mcpUrl: string): string {
  return `claude mcp add --transport http --scope user ${serverName(mcpUrl)} ${shellQuote(mcpUrl)}`;
}

/** Both browser OAuth and the local operator endpoint need only the URL. */
export function codexMcpConfig(mcpUrl: string): string {
  return [`[mcp_servers.${serverName(mcpUrl)}]`, `url = ${JSON.stringify(mcpUrl)}`].join('\n');
}

function errorMessage(failure: unknown, t: McpAccessPanelProps['t']): string {
  if (failure instanceof ApiHttpError) {
    if (failure.status === 404) return t('settings.mcpApiMissing');
    if (failure.status === 401) return t('settings.mcpSignInAgain');
    if (failure.status === 403) return t('settings.mcpForbidden');
  }
  return t('settings.mcpUnavailable');
}

export function McpAccessPanel({
  t,
  locale,
  mcpUrl,
  mode = 'bearer',
  onRetry,
  tokens,
  loading,
  error,
  busy,
  status,
  minted,
  onCreate,
  onRevoke,
  onCopy,
  onDismissMinted,
}: McpAccessPanelProps) {
  const [label, setLabel] = useState('');
  const [client, setClient] = useState<McpClient>('codex');
  const operator = mode === 'operator';
  const ready = !loading && !error && Boolean(mcpUrl);
  const live = tokens.filter((token) => token.revokedAt === null);

  return (
    <section className="gpu-mcp-access" aria-labelledby="mcp-access-title">
      <p id="mcp-access-title" className="gpu-org-models-title">
        {t('settings.mcpTitle')}
      </p>
      <p className="gpu-org-models-hint">{t(operator ? 'settings.mcpLocalHint' : 'settings.mcpHint')}</p>
      {error ? (
        <div className="gpu-subscription-message gpu-subscription-error" role="alert">
          <p>{t('settings.mcpLoadFailed')}: {error}</p>
          <button type="button" disabled={busy || loading} onClick={() => void onRetry()}>
            {t('settings.mcpRetry')}
          </button>
        </div>
      ) : null}

      <article className="gpu-subscription-card">
        <div className="gpu-subscription-card-head">
          <span className="gpu-subscription-name">{t('settings.mcpAddress')}</span>
        </div>
        {mcpUrl ? (
          <div className="gpu-subscription-code-row">
            <code data-testid="mcp-url">{mcpUrl}</code>
            <button type="button" disabled={busy} onClick={() => void onCopy(mcpUrl)}>
              {t('settings.mcpCopy')}
            </button>
          </div>
        ) : (
          <p>{loading ? t('settings.subscriptionState.loading') : t('settings.mcpAddressUnknown')}</p>
        )}
        <p>{t(operator ? 'settings.mcpLocalSteps' : 'settings.mcpConnectSteps')}</p>
      </article>

      {ready && mcpUrl ? (
        <article className="gpu-subscription-card">
          <label className="gpu-mcp-label">
            <span>{t('settings.mcpChooseClient')}</span>
            <select className="gpu-dom-input" value={client} onChange={event => setClient(event.target.value as McpClient)}>
              <option value="codex">Codex CLI</option>
              <option value="codex-macos">{t('settings.mcpCodexMac')}</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <p>{t('settings.mcpRunTerminal')}</p>
          <div className="gpu-subscription-code-row">
            <code className="gpu-mcp-command" data-testid="mcp-connect-command">{
              client === 'claude' ? claudeMcpCommand(mcpUrl) : codexMcpCommand(mcpUrl, client === 'codex-macos', !operator)
            }</code>
            <button type="button" disabled={busy} onClick={() => void onCopy(
              client === 'claude' ? claudeMcpCommand(mcpUrl) : codexMcpCommand(mcpUrl, client === 'codex-macos', !operator)
            )}>{t('settings.mcpCopy')}</button>
          </div>
          {client === 'codex-macos' ? <p>{t('settings.mcpMacHint')}</p> : null}
          {!operator ? <p>{t(client === 'claude' ? 'settings.mcpClaudeFinish' : 'settings.mcpCodexFinish')}</p> : null}
          <p>{t('settings.mcpVerify')}</p>
          <details>
            <summary>{t('settings.mcpClientSetup')}</summary>
            <p>{t('settings.mcpCodexSetup')}</p>
            <div className="gpu-subscription-code-row">
              <code className="gpu-mcp-command" data-testid="mcp-oauth-config">{codexMcpConfig(mcpUrl)}</code>
              <button type="button" disabled={busy} onClick={() => void onCopy(codexMcpConfig(mcpUrl))}>
                {t('settings.mcpCopy')}
              </button>
            </div>
            {!operator ? <p>{t('settings.mcpOAuthMigration')}</p> : null}
          </details>
        </article>
      ) : null}

      {!operator ? (
        <>
          <p className="gpu-org-models-title">{t('settings.mcpConnections')}</p>
          {live.length > 0 ? (
            <ul className="gpu-mcp-tokens" aria-label={t('settings.mcpConnections')}>
              {live.map((token) => (
                <li key={token.tokenId} className="gpu-subscription-card">
                  <div className="gpu-subscription-card-head">
                    <span className="gpu-subscription-name">{token.label}</span>
                    <button type="button" disabled={busy} onClick={() => void onRevoke(token.tokenId)}>
                      {t('settings.mcpRevoke')}
                    </button>
                  </div>
                  <p>{t('settings.mcpTokenFacts', {
                    org: token.orgName,
                    created: formatDateTime(token.createdAt, locale),
                    lastUsed: token.lastUsedAt ? formatDateTime(token.lastUsedAt, locale) : t('settings.mcpNeverUsed'),
                  })}</p>
                </li>
              ))}
            </ul>
          ) : ready ? <p className="gpu-subscription-message">{t('settings.mcpNoConnections')}</p> : null}

          <details className="gpu-subscription-card" open={minted ? true : undefined} data-testid="mcp-manual-access">
            <summary>{t('settings.mcpAdvancedTokens')}</summary>
            <p>{t('settings.mcpAdvancedHint')}</p>
            {minted ? (
              <div className="gpu-mcp-minted" role="status" aria-live="polite">
                <p>{t('settings.mcpMintedHint')}</p>
                <div className="gpu-subscription-code-row">
                  <code data-testid="mcp-token">{minted.token}</code>
                  <button type="button" disabled={busy} onClick={() => void onCopy(minted.token)}>
                    {t('settings.mcpCopy')}
                  </button>
                </div>
                <p>{t('settings.mcpManualHeader')}</p>
                <button type="button" onClick={onDismissMinted}>{t('settings.mcpMintedDone')}</button>
              </div>
            ) : (
              <form className="gpu-mcp-create" onSubmit={(event) => {
                event.preventDefault();
                if (!ready || busy) return;
                void onCreate(label.trim() || t('settings.mcpDefaultLabel'));
              }}>
                <label className="gpu-mcp-label">
                  <span>{t('settings.mcpLabel')}</span>
                  <input className="gpu-dom-input" type="text" maxLength={80}
                    placeholder={t('settings.mcpLabelPlaceholder')} value={label} disabled={busy}
                    onChange={(event) => setLabel(event.target.value)} />
                </label>
                <div className="gpu-settings-actions">
                  <button type="submit" disabled={busy || !ready}>{t('settings.mcpCreate')}</button>
                </div>
              </form>
            )}
          </details>
        </>
      ) : null}

      <details className="gpu-subscription-card">
        <summary>{t('settings.mcpHelpTitle')}</summary>
        <p>{t('settings.mcpHelpHint')}</p>
      </details>

      {status ? (
        <p className="gpu-subscription-message" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

export interface McpAccessProps {
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly locale: string;
  readonly onError: (message: string | null) => void;
}

/** The container: loads `/api/tokens`, mints, revokes, copies. */
export function McpAccess({ t, locale, onError }: McpAccessProps) {
  const [data, setData] = useState<VizApiTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ tokenId: string; token: string } | null>(null);

  const mounted = useRef(false);
  const locked = useRef(false);
  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const next = await api.apiTokens();
      if (!mounted.current) return false;
      setData(next);
      setError(null);
      return true;
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure, t));
      return false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const run = async (work: () => Promise<void>, successKey: string): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setStatus(null);
    onError(null);
    try {
      await work();
      if (!mounted.current) return;
      const refreshed = await refresh();
      if (mounted.current) setStatus(refreshed ? t(successKey) : t('settings.mcpChangedRefreshFailed'));
    } catch (failure) {
      if (mounted.current) onError(errorMessage(failure, t));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <McpAccessPanel
      t={t}
      locale={locale}
      mcpUrl={data?.mcpUrl ?? null}
      mode={data?.mode ?? 'bearer'}
      onRetry={async () => {
        setStatus(null);
        await refresh();
      }}
      tokens={data?.tokens ?? []}
      loading={loading}
      error={error}
      busy={busy}
      status={status}
      minted={minted}
      onCreate={(label) =>
        run(async () => {
          const created = await api.createApiToken(label);
          if (!mounted.current) return;
          setMinted({ tokenId: created.tokenId, token: created.token });
          // The POST already succeeded: retain its canonical URL if GET fails.
          setData((previous) => ({ ...previous, tokens: previous?.tokens ?? [], mcpUrl: created.mcpUrl }));
        }, 'settings.mcpCreated')
      }
      onRevoke={(tokenId) =>
        run(async () => {
          await api.revokeApiToken(tokenId);
          if (!mounted.current) return;
          if (minted?.tokenId === tokenId) setMinted(null);
          setData((previous) => previous ? {
            ...previous, tokens: previous.tokens.filter((token) => token.tokenId !== tokenId),
          } : previous);
        }, 'settings.mcpRevoked')
      }
      onCopy={async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus(t('settings.mcpCopied'));
        } catch {
          setStatus(t('settings.mcpCopyFailed'));
        }
      }}
      onDismissMinted={() => setMinted(null)}
    />
  );
}
