import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  orgHasBilledProviderKey,
  orgProviderIsReady,
  tierModelSelectionLabel,
} from '../../core/providerCatalog.js';
import { formatDateTime } from '../client/date-format.js';
import { api } from '../client/data-api.js';
import {
  CHATGPT_SUBSCRIPTION_PREFIX,
  HOST_SUBSCRIPTION_PREFIX,
} from '../../contracts/runPayers.js';
import type { VizAccountModels, VizLlmCatalogEntry, VizOrganisation, VizOrgModels } from '../client/types.js';

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
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: string;
  enabled: boolean;
  canManageOrg: boolean;
  platformAdmin: boolean;
  organisation: VizOrganisation | null;
  overlaysInert: boolean;
  onError: (message: string | null) => void;
}) {
  const [account, setAccount] = useState<VizAccountModels | null>(null);
  const [org, setOrg] = useState<VizOrgModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});

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
      {!canPickModels && !canManageOrg ? (
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
              if (!canPickModels && value !== null) return;
              if (value === '' && !org.models[tier]) return;
              void apply(
                () => api.saveAccountModels({ ...account.pins, [tier]: value }),
                'settings.saved'
              );
            }}
          >
            <option value="" disabled={!canPickModels || !org.models[tier]}>
              {inheritLabel(tier)}
            </option>
            {catalogOptions(t, catalog, configuredProviders, account.pins[tier], {
              billedKeyReady,
              ollamaAvailable,
              hostSubscriptions,
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
  ];
  return families.map((provider) => {
    // The honest label: ollama compute is the platform's, and where the
    // deployment declared no endpoint the family stays visible but locked —
    // hiding it would make the operator's choice look like a client bug.
    const isOllama = provider.id === 'ollama';
    const isSubscription =
      provider.id === HOST_SUBSCRIPTION_PREFIX || provider.id === CHATGPT_SUBSCRIPTION_PREFIX;
    const unlocked = providerIsUnlocked(provider, configuredProviders, opts);
    const label = isOllama
      ? t(opts.ollamaAvailable ? 'settings.ollamaHosted' : 'settings.ollamaUnavailable', {
          label: provider.label,
        })
      : isSubscription
        ? t(unlocked ? 'settings.hostSubscription' : 'settings.hostSubscriptionUnavailable', {
            label: provider.label,
          })
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
