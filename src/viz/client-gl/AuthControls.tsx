import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  redirectIfAuthenticationRequired,
  type AuthNavigator,
} from '../client/auth-session.js';
import { clearSessionPushDismissal } from '../client/push.js';
import {
  AuthContext,
  type AuthController,
  type AuthGateStatus,
  type AuthOrganisation,
  type AuthProviderOption,
  type AuthUiSnapshot,
  type AuthViewer,
} from './auth-controller.js';
import { useGpuStore } from './store.js';

export type {
  AuthController,
  AuthGateStatus,
  AuthOrganisation,
  AuthProviderOption,
  AuthUiSnapshot,
  AuthViewer,
};

function replaceLocation(path: string): void {
  globalThis.location.replace(path);
}

export function AuthControls({
  active = true,
  children,
  t,
  fetchImpl = fetch,
  navigate = replaceLocation,
}: {
  active?: boolean;
  children?: ReactNode;
  t: (key: string, vars?: Record<string, unknown>) => string;
  fetchImpl?: typeof fetch;
  navigate?: AuthNavigator;
}) {
  const [viewer, setViewer] = useState<AuthViewer | null>(null);
  const [gate, setGate] = useState<AuthGateStatus>('unknown');
  const [providers, setProviders] = useState<AuthProviderOption[]>([]);
  const [failure, setFailure] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [switchingOrganisationId, setSwitchingOrganisationId] = useState<string | null>(null);
  const signingOutRef = useRef(false);

  useEffect(() => {
    let active = true;
    void fetchImpl('/auth/whoami', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        // Compiled servers older than the shell-as-login change answered an
        // unauthenticated whoami with 401 — the server-owned selector is the
        // right landing there.
        if (redirectIfAuthenticationRequired(response.status, navigate)) return;
        if (!response.ok) return;
        const body = await response.json() as Record<string, unknown>;
        if (active && body['enabled'] === false) {
          setGate('off');
          return;
        }
        if (active && body['enabled'] === true && body['authenticated'] === false) {
          // The arrival gate becomes the login: remember which providers to
          // offer. The server remains the authority on every /api call.
          setGate('unauthenticated');
          setProviders(
            Array.isArray(body['providers'])
              ? body['providers'].flatMap((candidate): AuthProviderOption[] => {
                  if (
                    candidate === null ||
                    typeof candidate !== 'object' ||
                    typeof (candidate as Record<string, unknown>)['id'] !== 'string' ||
                    typeof (candidate as Record<string, unknown>)['label'] !== 'string'
                  ) return [];
                  return [candidate as AuthProviderOption];
                })
              : []
          );
          return;
        }
        if (
          active &&
          body['authenticated'] === true &&
          typeof body['displayName'] === 'string' &&
          typeof body['role'] === 'string'
        ) {
          setGate('authenticated');
          const organisations = Array.isArray(body['organisations'])
            ? body['organisations'].flatMap((candidate): AuthOrganisation[] => {
                if (
                  candidate === null ||
                  typeof candidate !== 'object' ||
                  typeof (candidate as Record<string, unknown>)['id'] !== 'string' ||
                  typeof (candidate as Record<string, unknown>)['name'] !== 'string' ||
                  typeof (candidate as Record<string, unknown>)['role'] !== 'string'
                ) return [];
                return [candidate as AuthOrganisation];
              })
            : [];
          const active = body['activeOrganisation'];
          const activeOrganisation =
            active !== null &&
            typeof active === 'object' &&
            typeof (active as Record<string, unknown>)['id'] === 'string' &&
            typeof (active as Record<string, unknown>)['name'] === 'string' &&
            typeof (active as Record<string, unknown>)['role'] === 'string'
              ? active as AuthOrganisation
              : null;
          setViewer({
            displayName: body['displayName'],
            role: body['role'],
            activeOrganisation,
            organisations,
            platformAdmin: body['platformAdmin'] === true,
            principalId: typeof body['principalId'] === 'string' ? body['principalId'] : '',
            // A compiled server older than the avatar change omits both; the
            // orb falls back to its procedural interior and the profile panel
            // treats the name as imported, which is what it was.
            avatarUrl: typeof body['avatarUrl'] === 'string' ? body['avatarUrl'] : null,
            displayNameSource: body['displayNameSource'] === 'user' ? 'user' : 'provider',
          });
        }
      })
      .catch(() => {
        // A 404 is the normal auth-disabled developer path. Data queries own
        // general connectivity errors, so this optional control stays quiet.
      });
    return () => {
      active = false;
    };
  }, [fetchImpl, navigate]);

  const switchOrganisation = useCallback(async (orgId: string): Promise<void> => {
    if (switchingOrganisationId || signingOutRef.current) return;
    setFailure(false);
    setSwitchingOrganisationId(orgId);
    try {
      const response = await fetchImpl(
        `/auth/organisations/${encodeURIComponent(orgId)}/activate`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }
      );
      if (!response.ok) throw new Error('organisation switch failed');
      navigate('/');
    } catch {
      setFailure(true);
    } finally {
      setSwitchingOrganisationId(null);
    }
  }, [fetchImpl, navigate, switchingOrganisationId]);

  const signOut = useCallback(async (): Promise<void> => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setFailure(false);
    setSigningOut(true);
    try {
      const response = await fetchImpl('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'text/html' },
      });
      if (!response.ok) throw new Error('logout failed');
      // An admin's "not now" is session-scoped, and signing out ends that
      // grace: without this a same-tab re-login would inherit the dismissal
      // and never re-offer notifications.
      clearSessionPushDismissal();
      // Back to the arrival gate: signed out, it offers the providers again.
      navigate('/');
    } catch {
      setFailure(true);
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  }, [fetchImpl, navigate]);

  const activate = useCallback((id: string): void => {
    if (id === 'auth.signOut') void signOut();
    else if (id.startsWith('org.switch.')) void switchOrganisation(id.slice('org.switch.'.length));
  }, [signOut, switchOrganisation]);

  const snapshot = useMemo<AuthUiSnapshot | null>(() => viewer ? {
    viewer,
    failure,
    signingOut,
    switchingOrganisationId,
  } : null, [failure, signingOut, switchingOrganisationId, viewer]);
  const controller = useMemo<AuthController>(
    () => ({ snapshot, gate, providers, activate }),
    [activate, gate, providers, snapshot]
  );

  return (
    <AuthContext.Provider value={controller}>
      {children}
      {viewer && active ? <AccountBridge
        viewer={viewer}
        t={t}
        failure={failure}
        signingOut={signingOut}
        switchingOrganisationId={switchingOrganisationId}
        activate={activate}
      /> : null}
    </AuthContext.Provider>
  );
}

/**
 * The ACCESSIBLE TWIN of the GL account menu.
 *
 * The orb and its dropdown are Pixi objects: a keyboard or a screen reader
 * cannot reach either. This is the same account surface as real DOM — the
 * toggle, the identity, the role, the organisations, Settings and Sign out —
 * and it is what the GPU smokes drive too. It reads the SAME store state as
 * the GL menu, so the two cannot disagree about whether the menu is open.
 */
function AccountBridge({
  viewer,
  t,
  failure,
  signingOut,
  switchingOrganisationId,
  activate,
}: {
  viewer: AuthViewer;
  t: (key: string, vars?: Record<string, unknown>) => string;
  failure: boolean;
  signingOut: boolean;
  switchingOrganisationId: string | null;
  activate: (id: string) => void;
}) {
  const open = useGpuStore((state) => state.accountMenuOpen);
  const toggleAccountMenu = useGpuStore((state) => state.toggleAccountMenu);
  const setView = useGpuStore((state) => state.setView);
  const roleKey = `auth.role.${viewer.role}`;
  const role = t(roleKey);
  return (
    <aside className="gpu-a11y-bridge" aria-label={t('auth.account')}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t('auth.closeMenu') : t('auth.openMenu')}
        onClick={() => toggleAccountMenu()}
      >
        {t('auth.signedInAs', { name: viewer.displayName })}
      </button>
      <span>{role === roleKey ? viewer.role : role}</span>
      {viewer.platformAdmin ? <span>{t('auth.platformAdmin')}</span> : null}
      {viewer.activeOrganisation ? (
        <span>{t('auth.organisation', { name: viewer.activeOrganisation.name })}</span>
      ) : null}
      {open ? (
        <>
          {viewer.organisations
            .filter((organisation) => organisation.id !== viewer.activeOrganisation?.id)
            .map((organisation) => (
              <button
                key={organisation.id}
                type="button"
                disabled={switchingOrganisationId !== null}
                onClick={() => activate(`org.switch.${organisation.id}`)}
              >
                {t('auth.switchToOrganisation', { name: organisation.name })}
              </button>
            ))}
          <button type="button" onClick={() => setView('settings')}>
            {t('nav.settings')}
          </button>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => activate('auth.signOut')}
          >
            {t('auth.signOut')}
          </button>
        </>
      ) : null}
      {failure ? <span role="alert">{t('auth.actionFailed')}</span> : null}
    </aside>
  );
}
