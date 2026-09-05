import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiHttpError } from '../client/data-api.js';
import { formatDateTime } from '../client/date-format.js';
import type { VizApiToken, VizApiTokens } from '../client/types.js';

/**
 * CONNECT YOUR AGENT — the Settings panel that turns "atoma has an MCP" into a
 * procedure a signed-in member can follow in a minute: what the MCP is, the
 * address, a token created here and shown ONCE, and the exact line to paste
 * into Claude Code. The panel is the client half of `/api/tokens`
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

export function claudeMcpCommand(mcpUrl: string, token?: string): string {
  const command = `claude mcp add --transport http --scope user atoma ${shellQuote(mcpUrl)}`;
  return token ? `${command} --header ${shellQuote(`Authorization: Bearer ${token}`)}` : command;
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
  const operator = mode === 'operator';
  const ready = !loading && !error && Boolean(mcpUrl);
  const live = tokens.filter((token) => token.revokedAt === null);
  const command = mcpUrl && (minted || operator)
    ? claudeMcpCommand(mcpUrl, operator ? undefined : minted?.token) : null;

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
        {!operator ? (
          <ol className="gpu-mcp-steps">
            <li>{t('settings.mcpStepCreate')}</li>
            <li>{t('settings.mcpStepCopy')}</li>
            <li>{t('settings.mcpStepRegister')}</li>
          </ol>
        ) : <p>{t('settings.mcpLocalSteps')}</p>}
        <p>{t('settings.mcpTransportHint')}</p>
        {!operator ? <p>{t('settings.mcpCompatibility')}</p> : null}
      </article>

      {minted || (operator && command) ? (
        <article className="gpu-subscription-card gpu-mcp-minted" role="status" aria-live="polite">
          {minted ? (
            <>
              <div className="gpu-subscription-card-head">
                <span className="gpu-subscription-name">{t('settings.mcpMintedTitle')}</span>
                <span className="gpu-subscription-state" data-state="connected">
                  {t('settings.mcpMintedOnce')}
                </span>
              </div>
              <p>{t('settings.mcpMintedHint')}</p>
              <div className="gpu-subscription-code-row">
                <code data-testid="mcp-token">{minted.token}</code>
                <button type="button" disabled={busy} onClick={() => void onCopy(minted.token)}>
                  {t('settings.mcpCopy')}
                </button>
              </div>
            </>
          ) : null}
          {command ? (
            <>
              <p>{t('settings.mcpClaudeCodeHint')}</p>
              <div className="gpu-subscription-code-row">
                <code className="gpu-mcp-command" data-testid="mcp-claude-command">{command}</code>
                <button type="button" disabled={busy} onClick={() => void onCopy(command)}>
                  {t('settings.mcpCopy')}
                </button>
              </div>
              {!operator ? <p>{t('settings.mcpOtherClientsHint')}</p> : null}
            </>
          ) : null}
          {minted ? <div className="gpu-subscription-actions">
            <button type="button" onClick={onDismissMinted}>
              {t('settings.mcpMintedDone')}
            </button>
          </div> : null}
        </article>
      ) : !operator ? (
        <form
          className="gpu-mcp-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            const trimmed = label.trim();
            void onCreate(trimmed.length > 0 ? trimmed : t('settings.mcpDefaultLabel'));
          }}
        >
          <label className="gpu-mcp-label">
            <span>{t('settings.mcpLabel')}</span>
            <input
              className="gpu-dom-input"
              type="text"
              maxLength={80}
              placeholder={t('settings.mcpLabelPlaceholder')}
              value={label}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div className="gpu-settings-actions">
            <button type="submit" disabled={busy || !ready}>
              {t('settings.mcpCreate')}
            </button>
          </div>
        </form>
      ) : null}

      {!operator ? <p className="gpu-subscription-message" role="note">
        {t('settings.mcpWarning')}
      </p> : null}

      <details className="gpu-subscription-card">
        <summary>{t('settings.mcpCheckTitle')}</summary>
        <p>{t('settings.mcpCheckSteps')}</p>
        <p>{t('settings.mcpCheckUsage')}</p>
        <p>{t('settings.mcpTroubleshootAuth')}</p>
        <p>{t('settings.mcpTroubleshoot404')}</p>
      </details>

      {live.length > 0 ? (
        <ul className="gpu-mcp-tokens" aria-label={t('settings.mcpTokens')}>
          {live.map((token) => (
            <li key={token.tokenId} className="gpu-subscription-card">
              <div className="gpu-subscription-card-head">
                <span className="gpu-subscription-name">{token.label}</span>
                <button type="button" disabled={busy} onClick={() => void onRevoke(token.tokenId)}>
                  {t('settings.mcpRevoke')}
                </button>
              </div>
              <p>
                {t('settings.mcpTokenFacts', {
                  org: token.orgName,
                  created: formatDateTime(token.createdAt, locale),
                  lastUsed: token.lastUsedAt ? formatDateTime(token.lastUsedAt, locale) : t('settings.mcpNeverUsed'),
                })}
              </p>
            </li>
          ))}
        </ul>
      ) : ready && !operator ? (
        <p className="gpu-subscription-message">{t('settings.mcpNoTokens')}</p>
      ) : null}

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
      onRetry={async () => { await refresh(); }}
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
