import { useCallback, useEffect, useState } from 'react';
import { api } from '../client/data-api.js';
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

export function claudeMcpCommand(mcpUrl: string, token: string): string {
  return `claude mcp add atoma --transport http ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

export function McpAccessPanel({
  t,
  locale,
  mcpUrl,
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
  const live = tokens.filter((token) => token.revokedAt === null);
  const command = minted && mcpUrl ? claudeMcpCommand(mcpUrl, minted.token) : null;

  return (
    <section className="gpu-mcp-access" aria-labelledby="mcp-access-title">
      <p id="mcp-access-title" className="gpu-org-models-title">
        {t('settings.mcpTitle')}
      </p>
      <p className="gpu-org-models-hint">{t('settings.mcpHint')}</p>
      {error ? (
        <p className="gpu-subscription-message gpu-subscription-error" role="alert">
          {t('settings.mcpLoadFailed')}: {error}
        </p>
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
        <ol className="gpu-mcp-steps">
          <li>{t('settings.mcpStepCreate')}</li>
          <li>{t('settings.mcpStepCopy')}</li>
          <li>{t('settings.mcpStepRegister')}</li>
        </ol>
      </article>

      {minted ? (
        <article className="gpu-subscription-card gpu-mcp-minted" role="status" aria-live="polite">
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
          {command ? (
            <>
              <p>{t('settings.mcpClaudeCodeHint')}</p>
              <div className="gpu-subscription-code-row">
                <code className="gpu-mcp-command" data-testid="mcp-claude-command">{command}</code>
                <button type="button" disabled={busy} onClick={() => void onCopy(command)}>
                  {t('settings.mcpCopy')}
                </button>
              </div>
              <p>{t('settings.mcpOtherClientsHint')}</p>
            </>
          ) : null}
          <div className="gpu-subscription-actions">
            <button type="button" onClick={onDismissMinted}>
              {t('settings.mcpMintedDone')}
            </button>
          </div>
        </article>
      ) : (
        <form
          className="gpu-mcp-create"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = label.trim();
            void onCreate(trimmed.length > 0 ? trimmed : t('settings.mcpDefaultLabel')).then(() => setLabel(''));
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
            <button type="submit" disabled={busy || loading}>
              {t('settings.mcpCreate')}
            </button>
          </div>
        </form>
      )}

      <p className="gpu-subscription-message" role="note">
        {t('settings.mcpWarning')}
      </p>

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
      ) : !loading ? (
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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await api.apiTokens());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('settings.actionFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<void>, successKey: string): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await work();
      await refresh();
      setStatus(t(successKey));
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <McpAccessPanel
      t={t}
      locale={locale}
      mcpUrl={data?.mcpUrl ?? null}
      tokens={data?.tokens ?? []}
      loading={loading}
      error={error}
      busy={busy}
      status={status}
      minted={minted}
      onCreate={(label) =>
        run(async () => {
          const created = await api.createApiToken(label);
          setMinted({ tokenId: created.tokenId, token: created.token });
        }, 'settings.mcpCreated')
      }
      onRevoke={(tokenId) =>
        run(async () => {
          await api.revokeApiToken(tokenId);
          if (minted?.tokenId === tokenId) setMinted(null);
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
