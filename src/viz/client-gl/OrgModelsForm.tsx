import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  orgHasBilledProviderKey,
  orgProviderIsReady,
  PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  tierModelSelectionLabel,
} from '../../core/providerCatalog.js';
import { formatDateTime } from '../client/date-format.js';
import { api } from '../client/data-api.js';
import {
  CHATGPT_SUBSCRIPTION_PREFIX,
  HOST_SUBSCRIPTION_PREFIX,
  PRINCIPAL_CHATGPT_SUBSCRIPTION_PREFIX,
  chatGptSubscriptionModel,
  principalChatGptSubscriptionModel,
} from '../../contracts/runPayers.js';
import type {
  VizAccountModels,
  VizAccountSubscriptions,
  VizLlmCatalogEntry,
  VizOrganisation,
  VizOrgModels,
} from '../client/types.js';
import { useAccountSubscriptions } from './queries.js';

/**
 * SETTINGS BODY — BYO-keys first, then org defaults, account pins, and the
 * organisation directory. One DOM scroll inside the Settings frame so GPU
 * never paints a second copy of the directory through the form.
 *
 * SaaS members need a billed-provider key before anyone can pick a model.
 *
 * PLATFORM ADMINS ARE THE EXCEPTION, AND THE REASON WAS WRONG UNTIL
 * 2026-08-28. The unlock was justified by "their runs use the host CLI
 * subscription", which is false on any deployment whose `ATOMA_LLM` asks for
 * anthropic: there, an admin's unlocked pick of a billed model resolves
 * against the HOST's own API key and bills the operator's account, under a
 * comment claiming the subscription paid. The unlock now follows DECLARED
 * FACTS — a stored billed key, or an offered host subscription — and the
 * subscription is a named choice rather than an implied one.
 */
export function OrgModelsForm({
  t,
  locale,
  enabled,
  canManageOrg,
  platformAdmin,
  organisation,
  overlaysInert,
  onError,
  children,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: string;
  enabled: boolean;
  canManageOrg: boolean;
  platformAdmin: boolean;
  organisation: VizOrganisation | null;
  overlaysInert: boolean;
  onError: (message: string | null) => void;
  /**
   * Settings-body content placed ABOVE the subscriptions, inside this frame.
   * The frame is `position: fixed` and is the ONE scroll container of the
   * Settings body; a sibling rendered beside it lands under the rename form.
   */
  children?: ReactNode;
}) {
  const [account, setAccount] = useState<VizAccountModels | null>(null);
  const [org, setOrg] = useState<VizOrgModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const canUsePersonalSubscriptions =
    organisation !== null && roleCanUsePersonalSubscriptions(organisation.viewerRole);
  const subscriptions = useAccountSubscriptions(enabled && canUsePersonalSubscriptions);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const [nextAccount, nextOrg] = await Promise.all([
        api.accountModels(),
        api.orgModels(),
      ]);
      setAccount(nextAccount);
      setOrg(nextOrg);
      onError(null);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
      return false;
    }
  }, [onError, t]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (subscriptions.data?.codex.state !== 'connected') return;
    void refresh();
  }, [refresh, subscriptions.data?.codex.state]);

  const apply = async (action: () => Promise<unknown>, successKey: string): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      if (await refresh()) setStatus(t(successKey));
    } catch (error) {
      setStatus(null);
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const applySubscription = async (
    action: () => Promise<void>,
    successKey: string
  ): Promise<void> => {
    setBusy(true);
    setSubscriptionStatus(null);
    try {
      await action();
      const [subscriptionResult, modelsReady] = await Promise.all([
        subscriptions.refetch(),
        refresh(),
      ]);
      if (subscriptionResult.error) throw subscriptionResult.error;
      if (modelsReady) setSubscriptionStatus(t(successKey));
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodexCode = async (code: string): Promise<void> => {
    setSubscriptionStatus(null);
    try {
      await navigator.clipboard.writeText(code);
      setSubscriptionStatus(t('settings.subscriptionCodeCopied'));
      onError(null);
    } catch {
      onError(t('settings.subscriptionCopyFailed'));
    }
  };

  if (!enabled || !account || !org) return null;

  const catalog = org.catalog.length > 0 ? org.catalog : account.catalog;
  // Ollama runs on the PLATFORM's own infrastructure — an org picks its
  // models, never its endpoint — so the family is offered only where the
  // deployment declared one. An older server omits the flag: treat unknown
  // as available rather than refusing what might work.
  const ollamaAvailable = (org.ollamaAvailable ?? account.ollamaAvailable) !== false;
  const configuredProviders = new Set(org.keys.map((key) => key.provider));
  const billedKeyReady = orgHasBilledProviderKey(configuredProviders);
  // The operator's own login, offered per REQUESTER by the server. Absent
  // means not offered at all; a `reason` means offered-but-unusable, which is
  // shown greyed rather than hidden — hiding it would make an already-armed
  // pin invisible in the very select that must be used to clear it.
  const hostSubscriptions =
    account.hostSubscriptions ?? (account.hostSubscription ? [account.hostSubscription] : []);
  const subscriptionUsable = hostSubscriptions.some((subscription) => !subscription.reason);
  const canPickModels = billedKeyReady || subscriptionUsable;
  const personalSubscriptionState =
    canUsePersonalSubscriptions && subscriptions.error === null
      ? subscriptions.data?.codex.state
      : undefined;
  const personalSubscriptionUsable =
    account.personalSubscriptions?.codex === true && personalSubscriptionState === 'connected';
  const canPickAccountModels = canPickModels || personalSubscriptionUsable;
  const retainPersonalCodexFamily = Object.values(account.pins).some((selection) =>
    selection?.startsWith(`${PRINCIPAL_CHATGPT_SUBSCRIPTION_PREFIX}:`)
  );
  const hostCodexSelected = Object.values(account.pins).some(
    (selection) => Boolean(selection && chatGptSubscriptionModel(selection))
  );
  const personalCodexSelected = Object.values(account.pins).some(
    (selection) => Boolean(selection && principalChatGptSubscriptionModel(selection))
  );
  const tierIds = ['l1', 'l2', 'l3'] as const;

  const inheritLabel = (tier: (typeof tierIds)[number]): string => {
    const orgDefault = org.models[tier];
    if (!orgDefault) return t('settings.orgModelRequired');
    return t('settings.inheritOrg', { fallback: tierModelSelectionLabel(orgDefault) });
  };

  return (
    <div
      className={`gpu-panel-skin gpu-org-models-form${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
      inert={overlaysInert}
    >
      {children}
      <PersonalSubscriptionsPanel
        t={t}
        subscriptions={subscriptions.data ?? null}
        loading={canUsePersonalSubscriptions && subscriptions.isPending}
        error={subscriptions.error instanceof Error ? subscriptions.error.message : null}
        canUse={canUsePersonalSubscriptions}
        busy={busy}
        status={subscriptionStatus}
        onStartCodex={() =>
          applySubscription(
            api.startCodexSubscriptionLogin,
            'settings.subscriptionLoginStarted'
          )
        }
        onCancelCodex={() =>
          applySubscription(
            api.cancelCodexSubscriptionLogin,
            'settings.subscriptionLoginCancelled'
          )
        }
        onDisconnectCodex={() =>
          applySubscription(
            api.disconnectCodexSubscription,
            'settings.subscriptionDisconnected'
          )
        }
        onCopyCodex={copyCodexCode}
      />

      {canManageOrg ? (
        <>
          <p className="gpu-org-models-title">{t('settings.orgProviderKeys')}</p>
          <p className="gpu-org-models-hint">
            {t(platformAdmin ? 'settings.orgKeysHintPlatform' : 'settings.orgKeysHint')}
          </p>
          {!org.encryptionReady ? (
            <p className="gpu-org-models-hint" role="note">
              {t('settings.orgKeysUnavailable')}
            </p>
          ) : null}
          <form
            className="gpu-org-keys-form"
            autoComplete="off"
            onSubmit={(event) => event.preventDefault()}
          >
          {catalog
            .filter((provider) => provider.credentialEnvVar !== null)
            .map((provider) => {
              const configured = org.keys.find((key) => key.provider === provider.id) ?? null;
              const draft = draftKeys[provider.id] ?? '';
              const keyId = `orgkey-${provider.id}`;
              return (
                <div className="gpu-org-models-row" key={keyId}>
                  <label htmlFor={keyId}>{provider.label}</label>
                  <input
                    id={keyId}
                    className="gpu-dom-input gpu-org-key-input"
                    type="text"
                    name={keyId}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    placeholder={
                      configured
                        ? t('settings.keyConfigured', { date: configured.configuredAt.slice(0, 10) })
                        : t('settings.keyMissing')
                    }
                    disabled={busy}
                    value={draft}
                    onChange={(event) =>
                      setDraftKeys((previous) => ({ ...previous, [provider.id]: event.target.value }))
                    }
                  />
                  <div className="gpu-settings-actions">
                    <button
                      type="button"
                      disabled={busy || !org.encryptionReady || draft.trim().length === 0}
                      onClick={() => {
                        const value = draft.trim();
                        void apply(
                          () => api.saveOrgProviderKey(provider.id, value),
                          'settings.keySaved'
                        ).then(() =>
                          setDraftKeys((previous) => ({ ...previous, [provider.id]: '' }))
                        );
                      }}
                    >
                      {t(configured ? 'settings.keyReplace' : 'settings.keySave')}
                    </button>
                    {configured ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void apply(
                            () => api.removeOrgProviderKey(provider.id),
                            'settings.keyRemoved'
                          );
                        }}
                      >
                        {t('settings.keyRemove')}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </form>

          <p className="gpu-org-models-title">{t('settings.orgDefaults')}</p>
          {!canPickModels ? (
            <p className="gpu-org-models-hint" role="note">
              {t('settings.orgModelsNeedKey')}
            </p>
          ) : (
            <p className="gpu-org-models-hint">{t('settings.orgModelsHint')}</p>
          )}
          {tierIds.map((tier, index) => (
            <div className="gpu-org-models-row" key={`org-${tier}`}>
              <label htmlFor={`orgmodel-${tier}`}>{t(`settings.tier${index + 1}`)}</label>
              <select
                id={`orgmodel-${tier}`}
                className="gpu-dom-input gpu-dom-select"
                disabled={busy}
                value={org.models[tier] ?? ''}
                onChange={(event) => {
                  const value = event.target.value === '' ? null : event.target.value;
                  if (!canPickModels || value === null) return;
                  void apply(
                    () => api.saveOrgModels({ ...org.models, [tier]: value }),
                    'settings.orgSaved'
                  );
                }}
              >
                <option value="" disabled>
                  {t('settings.orgModelRequired')}
                </option>
                {/* NO `hostSubscription` HERE. An org default is inherited by
                    every member by construction, so the subscription is an
                    ACCOUNT pin and the server refuses it at this level too. */}
                {catalogOptions(t, catalog, configuredProviders, org.models[tier], {
                  billedKeyReady,
                  ollamaAvailable,
                }, index + 1 as 1 | 2 | 3)}
              </select>
            </div>
          ))}
        </>
      ) : null}

      <p className="gpu-org-models-title">{t('settings.models')}</p>
      <p className="gpu-org-models-hint">{t('settings.modelsHint')}</p>
      {!canPickAccountModels && !canManageOrg ? (
        <p className="gpu-org-models-hint" role="note">
          {t('settings.modelsNeedKey')}
        </p>
      ) : null}
      {tierIds.map((tier, index) => (
        <div className="gpu-org-models-row" key={`account-${tier}`}>
          <label htmlFor={`accountmodel-${tier}`}>{t(`settings.tier${index + 1}`)}</label>
          <select
            id={`accountmodel-${tier}`}
            className="gpu-dom-input gpu-dom-select"
            disabled={busy}
            value={account.pins[tier] ?? ''}
            onChange={(event) => {
              const value = event.target.value === '' ? null : event.target.value;
              if (!canPickAccountModels && value !== null) return;
              if (value === null && !org.models[tier]) return;
              void apply(
                () => api.saveAccountModels({ ...account.pins, [tier]: value }),
                'settings.saved'
              );
            }}
          >
            <option value="" disabled={!org.models[tier]}>
              {inheritLabel(tier)}
            </option>
            {catalogOptions(t, catalog, configuredProviders, account.pins[tier], {
              billedKeyReady,
              ollamaAvailable,
              hostSubscriptions,
              personalSubscriptions: account.personalSubscriptions,
              personalSubscriptionState,
              retainPersonalCodexFamily,
              hostCodexSelected,
              personalCodexSelected,
            }, index + 1 as 1 | 2 | 3)}
          </select>
        </div>
      ))}

      {status ? (
        <span role="status" className="gpu-org-models-status">
          {status}
        </span>
      ) : null}

      {organisation ? (
        <section className="gpu-org-directory" aria-label={organisation.name}>
          <p className="gpu-org-models-title">{organisation.name}</p>
          <dl className="gpu-org-directory-facts">
            <div>
              <dt>{t('settings.orgId')}</dt>
              <dd>{organisation.id}</dd>
            </div>
            <div>
              <dt>{t('settings.orgCreated')}</dt>
              <dd>{formatDateTime(organisation.createdAt, locale)}</dd>
            </div>
            <div>
              <dt>{t('settings.yourRole')}</dt>
              <dd>{t(`auth.role.${organisation.viewerRole}`)}</dd>
            </div>
            <div>
              <dt>{t('settings.projects')}</dt>
              <dd>{organisation.projectCount}</dd>
            </div>
            {organisation.pendingInvitations !== null ? (
              <div>
                <dt>{t('settings.pendingInvitations')}</dt>
                <dd>{organisation.pendingInvitations}</dd>
              </div>
            ) : null}
          </dl>
          <p className="gpu-org-models-hint">
            {t('settings.members', { count: organisation.members.length })}
          </p>
          <ul className="gpu-org-directory-members">
            {organisation.members.map((member) => (
              <li key={member.principalId}>
                <span>{member.displayName}</span>
                <span className="gpu-org-directory-meta">
                  {t(`auth.role.${member.role}`)}
                  {member.platformAdmin ? ` · ${t('auth.platformAdmin')}` : ''}
                  {member.joinedAt
                    ? ` · ${t('settings.joined', { date: member.joinedAt.slice(0, 10) })}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export interface PersonalSubscriptionsPanelProps {
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly subscriptions: VizAccountSubscriptions | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canUse: boolean;
  readonly busy: boolean;
  readonly status: string | null;
  readonly onStartCodex: () => Promise<void>;
  readonly onCancelCodex: () => Promise<void>;
  readonly onDisconnectCodex: () => Promise<void>;
  readonly onCopyCodex: (code: string) => Promise<void>;
}

export function roleCanUsePersonalSubscriptions(role: string): boolean {
  return role === 'org:owner' || role === 'org:admin' || role === 'org:member';
}

/**
 * ACCOUNT-OWNED LOGIN CARDS. They live inside the one existing Settings DOM
 * scroll, not in a new overlay. Device codes are rendered only from the
 * short-lived GET projection and are never put into component persistence.
 */
export function PersonalSubscriptionsPanel({
  t,
  subscriptions,
  loading,
  error,
  canUse,
  busy,
  status,
  onStartCodex,
  onCancelCodex,
  onDisconnectCodex,
  onCopyCodex,
}: PersonalSubscriptionsPanelProps) {
  const codex = subscriptions?.codex ?? null;
  const attempt = subscriptions?.codexAttempt ?? null;
  const connecting = codex?.state === 'connecting' || attempt?.state === 'connecting';
  const codexUnavailable =
    error !== null || codex?.state === 'unavailable' || codex?.state === 'error';
  const reconnect = codex?.state === 'reauth_required';
  const disconnect =
    codex?.state === 'connected' ||
    (Boolean(codex?.connectedAt) &&
      (error !== null || codex?.state === 'error' || codex?.state === 'unavailable'));
  const codexReason = attempt?.reason ?? codex?.reason ?? null;
  const displayedCodexState = error
    ? 'unavailable'
    : loading && !codex
      ? 'loading'
      : (codex?.state ?? 'disconnected');

  return (
    <section className="gpu-personal-subscriptions" aria-labelledby="personal-subscriptions-title">
      <p id="personal-subscriptions-title" className="gpu-org-models-title">
        {t('settings.personalSubscriptions')}
      </p>
      <p className="gpu-org-models-hint">{t('settings.personalSubscriptionsHint')}</p>
      {!canUse ? (
        <p className="gpu-org-models-hint" role="note">
          {t('settings.personalSubscriptionsViewer')}
        </p>
      ) : null}
      {error ? (
        <p className="gpu-subscription-message gpu-subscription-error" role="alert">
          {t('settings.personalSubscriptionsLoadFailed')}: {error}
        </p>
      ) : null}

      <div className="gpu-subscription-grid">
        <article className="gpu-subscription-card">
          <div className="gpu-subscription-card-head">
            <span className="gpu-subscription-name">{t('settings.subscriptionClaude')}</span>
            <span className="gpu-subscription-state" data-state="unavailable">
              {t('settings.subscriptionState.unavailable')}
            </span>
          </div>
          <p>{t('settings.subscriptionClaudeApproval')}</p>
        </article>

        <article className="gpu-subscription-card">
          <div className="gpu-subscription-card-head">
            <span className="gpu-subscription-name">{t('settings.subscriptionCodex')}</span>
            <span
              className="gpu-subscription-state"
              data-state={displayedCodexState}
            >
              {t(`settings.subscriptionState.${displayedCodexState}`)}
            </span>
          </div>
          <p>{t('settings.subscriptionCodexHint')}</p>

          {codexReason ? (
            <p className="gpu-subscription-message" role="note">
              {t(`settings.subscriptionReason.${codexReason}`)}
            </p>
          ) : null}

          {canUse && attempt?.state === 'connecting' ? (
            <div className="gpu-subscription-device">
              <p>{t('settings.subscriptionDeviceInstructions')}</p>
              {attempt.userCode ? (
                <div className="gpu-subscription-code-row">
                  <code>{attempt.userCode}</code>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (attempt.userCode) void onCopyCodex(attempt.userCode);
                    }}
                  >
                    {t('settings.subscriptionCopyCode')}
                  </button>
                </div>
              ) : null}
              <div className="gpu-subscription-actions">
                {attempt.verificationUrl ? (
                  <a
                    className="gpu-subscription-link"
                    href={attempt.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.subscriptionOpenLogin')}
                  </a>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void onCancelCodex()}>
                  {t('settings.subscriptionCancelLogin')}
                </button>
              </div>
            </div>
          ) : null}

          {canUse ? (
            <div className="gpu-subscription-actions">
              {disconnect ? (
                <button type="button" disabled={busy} onClick={() => void onDisconnectCodex()}>
                  {t('settings.subscriptionDisconnect')}
                </button>
              ) : !connecting && !codexUnavailable ? (
                <button type="button" disabled={busy || loading} onClick={() => void onStartCodex()}>
                  {t(
                    reconnect
                      ? 'settings.subscriptionReconnect'
                      : 'settings.subscriptionConnect'
                  )}
                </button>
              ) : null}
              {attempt && attempt.state !== 'connecting' ? (
                <button type="button" disabled={busy} onClick={() => void onCancelCodex()}>
                  {t('settings.subscriptionDismissAttempt')}
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
      </div>

      {status ? (
        <p className="gpu-subscription-message" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

/**
 * PURE, AND THAT IS THE POINT. Every unlock decision is computed here from
 * declared facts, so what the picker offers can be proven without a browser —
 * the browser smoke cannot run in CI, and "who may spend which payer" is not a
 * property to leave to a manual check.
 */
export interface CatalogueUnlocks {
  readonly billedKeyReady: boolean;
  readonly ollamaAvailable: boolean;
  /** The operator's login, when the server offered it to THIS requester. */
  readonly hostSubscriptions?: VizAccountModels['hostSubscriptions'];
  /** The requester's own provider login, usable only by that account. */
  readonly personalSubscriptions?: VizAccountModels['personalSubscriptions'];
  /** Detailed state independently read from the account self-care endpoint. */
  readonly personalSubscriptionState?: VizAccountSubscriptions['codex']['state'];
  /** Keep a disconnected selected family visible so its pin can be cleared. */
  readonly retainPersonalCodexFamily?: boolean;
  /** Hide choices that would mix two credential homes in one run process. */
  readonly hostCodexSelected?: boolean;
  readonly personalCodexSelected?: boolean;
}

export function providerIsUnlocked(
  provider: { readonly id: string },
  configuredProviders: ReadonlySet<string>,
  opts: CatalogueUnlocks
): boolean {
  if (provider.id === 'ollama') return opts.ollamaAvailable;
  if (
    provider.id === HOST_SUBSCRIPTION_PREFIX ||
    provider.id === CHATGPT_SUBSCRIPTION_PREFIX
  ) {
    return Boolean(
      opts.hostSubscriptions?.some(
        (subscription) => subscription.family.id === provider.id && !subscription.reason
      )
    );
  }
  if (provider.id === PRINCIPAL_CHATGPT_SUBSCRIPTION_PREFIX) {
    return (
      opts.personalSubscriptions?.codex === true && opts.personalSubscriptionState === 'connected'
    );
  }
  // NO BLANKET ADMIN UNLOCK. A platform admin picking a billed model still
  // needs the key that pays for it; the subscription is its own family, named.
  return (
    opts.billedKeyReady &&
    orgProviderIsReady(
      provider as { id: string; credentialEnvVar: string | null },
      configuredProviders
    )
  );
}

function catalogOptions(
  t: (key: string, vars?: Record<string, unknown>) => string,
  catalog: VizLlmCatalogEntry[],
  configuredProviders: ReadonlySet<string>,
  selected: string | null,
  opts: CatalogueUnlocks,
  tier: 1 | 2 | 3
): ReactNode {
  const families = [
    ...catalog,
    ...(opts.hostSubscriptions ?? []).map((subscription) => subscription.family),
    ...personalSubscriptionFamilies(opts),
  ].filter((provider) => {
    if (provider.id === CHATGPT_SUBSCRIPTION_PREFIX && opts.personalCodexSelected) return false;
    if (provider.id === PRINCIPAL_CHATGPT_SUBSCRIPTION_PREFIX && opts.hostCodexSelected) return false;
    return true;
  });
  return families.map((provider) => {
    // The honest label: ollama compute is the platform's, and where the
    // deployment declared no endpoint the family stays visible but locked —
    // hiding it would make the operator's choice look like a client bug.
    const isOllama = provider.id === 'ollama';
    const isSubscription =
      provider.id === HOST_SUBSCRIPTION_PREFIX || provider.id === CHATGPT_SUBSCRIPTION_PREFIX;
    const isPersonalSubscription = provider.id === PRINCIPAL_CHATGPT_SUBSCRIPTION_PREFIX;
    const unlocked = providerIsUnlocked(provider, configuredProviders, opts);
    const label = isOllama
      ? t(opts.ollamaAvailable ? 'settings.ollamaHosted' : 'settings.ollamaUnavailable', {
          label: provider.label,
        })
      : isSubscription
        ? t(unlocked ? 'settings.hostSubscription' : 'settings.hostSubscriptionUnavailable', {
            label: provider.label,
          })
        : isPersonalSubscription
          ? t(
              unlocked
                ? 'settings.personalSubscription'
                : 'settings.personalSubscriptionUnavailable',
              { label: provider.label }
            )
        : provider.label;
    return (
      <optgroup key={provider.id} label={label}>
        {provider.models.filter((model) => !model.tiers || model.tiers.includes(tier)).map((model) => {
          const value = `${provider.id}:${model.id}`;
          return (
            <option
              key={model.id}
              value={value}
              disabled={!unlocked && value !== selected}
            >
              {model.label}
            </option>
          );
        })}
      </optgroup>
    );
  });
}

/** The personal Codex family appears when usable, or while one of its pins remains selected. */
export function personalSubscriptionFamilies(opts: CatalogueUnlocks): VizLlmCatalogEntry[] {
  if (opts.hostCodexSelected) return [];
  if (!opts.personalSubscriptions?.codex && !opts.retainPersonalCodexFamily) return [];
  return [PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY as unknown as VizLlmCatalogEntry];
}
